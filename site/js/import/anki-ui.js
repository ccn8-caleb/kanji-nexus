// "Import Anki deck" dialog. Loaded on demand (core/maps-ui.js → openAnkiImport).
//
//   1. pick a file: .apkg / .colpkg (read in anki-worker.js) or a text export (.txt/.tsv/.csv)
//   2. check which field is the word / reading / meaning (guessed, with a live preview)
//   3. import into a new map (laid out before it opens) or merge into the open map,
//      optionally carrying over review progress and filling gaps from the dictionary
//
// Everything happens on this device; the file is never uploaded anywhere.

import { store } from '../core/store.js';
import { t } from '../core/prefs.js';
import { escapeHtml, extractKanji } from '../core/util.js';
import { icon } from '../core/icons.js';
import { toast, openModal, closeModal } from '../core/ui.js';
import { BUILD } from '../core/version.js';
import { emptyDoc } from '../core/schema.js';
import { loadSrs, saveSrs, moreAdvanced } from '../core/srs.js';
import { lookup, pickEntry, meaningText, tagsFor } from '../core/dict.js';
import { tidyAsync } from '../pages/map/layout.js';
import { parseText, guessMapping, noteToEntry, schedToSrs, applyEntries } from './anki-parse.js';

const ID = 'anki-dialog';
let el = null;
let s = null; // dialog state

const fresh = () => ({ step: 'pick', source: null, fileName: '', typeId: '', deckId: 'all', mapping: null, target: 'new', name: '', progress: true, dict: true, kana: true, status: '', error: '' });

export function openAnkiImport({ file } = {}) {
  if (!el) {
    el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.id = ID;
    document.body.appendChild(el);
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', (e) => e.target.matches('[data-name]') && (s.name = e.target.value));
    el.addEventListener('dragover', (e) => {
      if (s.step !== 'pick') return;
      e.preventDefault();
      el.querySelector('.anki-drop')?.classList.add('over');
    });
    el.addEventListener('dragleave', () => el.querySelector('.anki-drop')?.classList.remove('over'));
    el.addEventListener('drop', (e) => {
      if (s.step !== 'pick') return;
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) readFile(f);
    });
  }
  if (!s || s.step !== 'importing') s = fresh();
  render();
  openModal(ID);
  if (file) readFile(file);
}

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------
const STEP_TEXT = {
  unzip: ['パッケージを展開中…', 'Unpacking…'],
  zstd: ['展開中…', 'Decompressing…'],
  sqlite: ['データベースを開いています…', 'Opening the collection…'],
  read: ['ノートを読み込み中…', 'Reading notes…'],
};

function readPackage(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`./anki-worker.js?v=${BUILD}`, import.meta.url));
    const done = (fn, v) => (worker.terminate(), fn(v));
    worker.onmessage = ({ data }) => {
      if (data.progress) setStatus(t(...STEP_TEXT[data.progress]));
      else if (data.error) done(reject, new Error(data.error));
      else done(resolve, data.result);
    };
    worker.onerror = (e) => done(reject, new Error(e.message || 'worker failed'));
    worker.postMessage({ file });
  });
}

async function readFile(file) {
  s = { ...fresh(), step: 'reading', fileName: file.name, status: t('読み込み中…', 'Reading…') };
  render();
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isZip = head[0] === 0x50 && head[1] === 0x4b;
    const source = isZip ? await readPackage(file) : parseText(await file.text(), file.name.replace(/\.[^.]+$/, ''));
    if (!source.notes.length) throw new Error(t('ノートが見つかりませんでした', 'No notes found'));
    s.source = source;
    const main = [...source.noteTypes].sort((a, b) => b.count - a.count)[0];
    selectType(main.id);
    const deck = source.decks.filter((d) => d.name !== 'Default').sort((a, b) => b.count - a.count)[0];
    s.name = (deck?.name.split('::').pop() || main.name || file.name.replace(/\.[^.]+$/, '')).trim();
    s.step = 'map';
  } catch (err) {
    console.warn('[anki] read failed', err);
    s = { ...fresh(), error: t(`読み込めませんでした: ${err.message}`, `Could not read the file: ${err.message}`) };
  }
  render();
}

function selectType(id) {
  s.typeId = id;
  const type = s.source.noteTypes.find((nt) => nt.id === id);
  s.mapping = guessMapping(type, s.source.notes);
}

// ---------------------------------------------------------------------------
// Notes → entries for the current choices
// ---------------------------------------------------------------------------
function selectedNotes() {
  return s.source.notes.filter((n) => n.mid === s.typeId && (s.deckId === 'all' || n.did === s.deckId));
}

function entriesFor(notes) {
  return notes.map((n) => {
    const e = noteToEntry(n, s.mapping);
    if (e?.kind === 'word' && !s.kana && !extractKanji(e.label).length) return null;
    return e;
  });
}

const reviewedCount = (notes) => notes.filter((n) => s.source.sched[n.id] && s.source.sched[n.id].type !== 0).length;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function setStatus(text) {
  s.status = text;
  const node = el?.querySelector('.anki-status-text');
  if (node) node.textContent = text;
}

function render() {
  const title = `<div class="modal-title"><span class="title-with-icon">${icon('fileUp')}${t('Ankiデッキを読み込む', 'Import an Anki deck')}</span>
    <button type="button" class="icon-btn small" data-close-modal="${ID}" aria-label="Close">${icon('close')}</button></div>`;
  let body = '';
  if (s.step === 'pick') body = pickView();
  else if (s.step === 'reading' || s.step === 'importing') body = `<div class="anki-status">${icon('loading')}<span class="anki-status-text">${escapeHtml(s.status)}</span></div>`;
  else body = mapView();
  el.innerHTML = `<div class="modal-card wide anki-card">${title}${body}</div>`;
}

function pickView() {
  return `
    <p class="panel-note">${t(
      'Ankiのデッキ（.apkg）、コレクション（.colpkg）、または「ノートをプレーンテキストで書き出し」したファイル（.txt / .tsv / .csv）を選んでください。ファイルはこの端末の中だけで読み込まれます。',
      'Choose an Anki deck package (.apkg), a collection (.colpkg), or a “Notes in Plain Text” export (.txt / .tsv / .csv). The file is read on this device only — nothing is uploaded.'
    )}</p>
    ${s.error ? `<p class="form-status" data-kind="error">${escapeHtml(s.error)}</p>` : ''}
    <label class="anki-drop">
      ${icon('fileUp')}
      <span>${t('ここにファイルをドロップ、またはクリックして選択', 'Drop a file here, or click to choose')}</span>
      <input type="file" data-file accept=".apkg,.colpkg,.txt,.tsv,.csv,text/plain,text/csv,text/tab-separated-values">
    </label>`;
}

function fieldSelect(role, label, { optional = true } = {}) {
  const type = s.source.noteTypes.find((nt) => nt.id === s.typeId);
  const value = s.mapping[role];
  return `<label class="field-group"><span class="field-label">${label}</span>
    <select class="field-select" data-role="${role}">
      ${optional ? `<option value="-1"${value < 0 ? ' selected' : ''}>${t('（なし）', '(none)')}</option>` : ''}
      ${type.fields.map((f, i) => `<option value="${i}"${i === value ? ' selected' : ''}>${escapeHtml(f)}</option>`).join('')}
    </select></label>`;
}

function mapView() {
  const src = s.source;
  const notes = selectedNotes();
  const entries = entriesFor(notes);
  const usable = entries.filter(Boolean).length;
  const reviewed = reviewedCount(notes);
  const m = s.mapping;
  const kanjiMode = m.mode === 'kanji';
  const preview = entries
    .map((e, i) => [e, notes[i]])
    .filter(([e]) => e)
    .slice(0, 6);
  const fmt = { 'collection.anki21b': 'Anki 2.1.50+', 'collection.anki21': 'Anki 2.1', 'collection.anki2': 'Anki 2.0', text: t('テキスト', 'text') }[src.format] || src.format;
  const current = store.currentMap?.name || '';
  return `
    <p class="panel-note anki-summary">${escapeHtml(s.fileName)} · ${fmt} · ${t(`ノート ${src.notes.length}`, `${src.notes.length} notes`)}</p>
    <div class="anki-grid">
      ${src.noteTypes.length > 1 ? `<label class="field-group"><span class="field-label">${t('ノートタイプ', 'Note type')}</span><select class="field-select" data-type>${src.noteTypes.map((nt) => `<option value="${escapeHtml(nt.id)}"${nt.id === s.typeId ? ' selected' : ''}>${escapeHtml(nt.name)} (${nt.count})</option>`).join('')}</select></label>` : ''}
      ${src.decks.length > 1 ? `<label class="field-group"><span class="field-label">${t('デッキ', 'Deck')}</span><select class="field-select" data-deck><option value="all">${t('すべて', 'All decks')}</option>${src.decks.map((d) => `<option value="${escapeHtml(d.id)}"${d.id === s.deckId ? ' selected' : ''}>${escapeHtml(d.name)} (${d.count})</option>`).join('')}</select></label>` : ''}
      <div class="field-group"><span class="field-label">${t('内容', 'Contents')}</span>
        <div class="seg-group"><button type="button" class="seg-btn${kanjiMode ? '' : ' active'}" data-mode="word">${t('語彙', 'Vocabulary')}</button><button type="button" class="seg-btn${kanjiMode ? ' active' : ''}" data-mode="kanji">${t('漢字', 'Kanji')}</button></div></div>
    </div>
    <div class="anki-grid">
      ${fieldSelect('word', kanjiMode ? t('漢字', 'Kanji') : t('語（表記）', 'Word'), { optional: false })}
      ${kanjiMode ? fieldSelect('on', t('音読み', 'On reading')) + fieldSelect('kun', t('訓読み', 'Kun reading')) : fieldSelect('reading', t('読み', 'Reading')) + fieldSelect('furigana', t('ふりがな', 'Furigana'))}
      ${fieldSelect('meaning', t('意味', 'Meaning'))}
    </div>
    <div class="anki-preview-wrap"><table class="anki-preview">
      <thead><tr><th>${kanjiMode ? t('漢字', 'Kanji') : t('語', 'Word')}</th><th>${kanjiMode ? t('音・訓', 'On · Kun') : t('読み', 'Reading')}</th><th>${t('意味', 'Meaning')}</th>${src.format === 'text' ? '' : `<th>${t('進捗', 'Progress')}</th>`}</tr></thead>
      <tbody>${preview
        .map(([e, n]) => {
          const rec = schedToSrs(src.sched[n.id], src.crt);
          const prog = !rec ? t('新規', 'new') : rec.interval ? t(`${rec.interval}日`, `${rec.interval}d`) : t('学習中', 'learning');
          const reading = e.kind === 'kanji' ? [e.on.join('・'), e.kun.join('・')].filter(Boolean).join(' / ') : e.reading;
          return `<tr><td class="jp">${escapeHtml(e.kind === 'kanji' ? e.ch : e.label)}</td><td class="jp">${escapeHtml(reading) || '<span class="muted">—</span>'}</td><td>${escapeHtml(e.meaning) || '<span class="muted">—</span>'}</td>${src.format === 'text' ? '' : `<td class="muted">${prog}</td>`}</tr>`;
        })
        .join('')}</tbody></table></div>
    <p class="field-hint">${t(`${notes.length} ノート → ${usable} 件を取り込み${notes.length - usable ? `（${notes.length - usable} 件は日本語の${kanjiMode ? '漢字' : '語'}がないため除外）` : ''}`, `${notes.length} notes → ${usable} to import${notes.length - usable ? ` (${notes.length - usable} skipped: no Japanese ${kanjiMode ? 'kanji' : 'word'})` : ''}`)}</p>

    <div class="anki-options">
      <label class="anki-check"><input type="radio" name="anki-target" value="new"${s.target === 'new' ? ' checked' : ''}> ${t('新しいマップ', 'New map')}
        <input class="field-input anki-name" data-name value="${escapeHtml(s.name)}" aria-label="${t('マップ名', 'Map name')}"></label>
      <label class="anki-check"><input type="radio" name="anki-target" value="merge"${s.target === 'merge' ? ' checked' : ''}> ${t(`「${escapeHtml(current)}」に追加`, `Add to “${escapeHtml(current)}”`)}</label>
      ${src.format === 'text' ? '' : `<label class="anki-check"><input type="checkbox" data-opt="progress"${s.progress && reviewed ? ' checked' : ''}${reviewed ? '' : ' disabled'}> ${t(`復習の進捗も取り込む（学習済み ${reviewed}）`, `Bring review progress into the drill (${reviewed} studied)`)}</label>`}
      ${kanjiMode ? '' : `<label class="anki-check"><input type="checkbox" data-opt="dict"${s.dict ? ' checked' : ''}> ${t('空の読み・意味を辞書で補う', 'Fill empty readings and meanings from the dictionary')}</label>
      <label class="anki-check"><input type="checkbox" data-opt="kana"${s.kana ? ' checked' : ''}> ${t('かなだけの語も含める', 'Include kana-only words')}</label>`}
    </div>
    <div class="modal-actions">
      <button type="button" class="tb-btn" data-back>${t('別のファイル', 'Another file')}</button>
      <button type="button" class="tb-btn primary" data-import${usable ? '' : ' disabled'}>${icon('fileUp')}${t(`${usable} 件を読み込む`, `Import ${usable}`)}</button>
    </div>`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function onChange(e) {
  const x = e.target;
  if (x.matches('[data-file]') && x.files[0]) return readFile(x.files[0]);
  if (s.step !== 'map') return;
  if (x.matches('[data-type]')) selectType(x.value);
  else if (x.matches('[data-deck]')) s.deckId = x.value;
  else if (x.matches('[data-role]')) s.mapping = { ...s.mapping, [x.dataset.role]: Number(x.value) };
  else if (x.name === 'anki-target') s.target = x.value;
  else if (x.dataset.opt) s[x.dataset.opt] = x.checked;
  else return;
  render();
}

function onClick(e) {
  const b = e.target.closest('button');
  if (!b || s.step !== 'map') return;
  if (b.dataset.mode) {
    s.mapping = { ...s.mapping, mode: b.dataset.mode };
    render();
  } else if ('back' in b.dataset) {
    s = fresh();
    render();
  } else if ('import' in b.dataset) runImport();
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
const pause = () => new Promise((r) => setTimeout(r, 0));

async function fillFromDictionary(entries) {
  const todo = entries.filter((e) => e?.kind === 'word' && (!e.meaning || !e.reading) && extractKanji(e.label).length);
  for (let i = 0; i < todo.length; i += 40) {
    setStatus(t(`辞書で補完中… ${i}/${todo.length}`, `Looking up the dictionary… ${i}/${todo.length}`));
    const chunk = todo.slice(i, i + 40);
    const results = await Promise.all(chunk.map((e) => lookup(e.label).catch(() => [])));
    if (results.includes(null)) return; // no dictionary on this deployment
    chunk.forEach((e, j) => {
      const entry = pickEntry(results[j], e.reading);
      if (!entry) return;
      e.reading ||= entry.r[0];
      e.meaning ||= meaningText(entry);
      if (!e.tags?.length) e.tags = tagsFor(entry);
    });
  }
}

async function runImport() {
  const src = s.source;
  const notes = selectedNotes();
  const entries = entriesFor(notes);
  const opts = { target: s.target, name: s.name.trim() || 'Anki', progress: s.progress && src.format !== 'text', dict: s.dict && s.mapping.mode === 'word' };
  s.step = 'importing';
  s.status = t('準備中…', 'Preparing…');
  render();
  try {
    if (opts.dict) await fillFromDictionary(entries);
    setStatus(t('マップを作成中…', 'Building the map…'));
    await pause();
    const doc = opts.target === 'new' ? emptyDoc() : null;
    const result = doc ? applyEntries(doc, entries) : store.edit((d) => applyEntries(d, entries));

    // Progress first, so the new map opens with its drill state already in place.
    let carried = 0;
    if (opts.progress) {
      const records = loadSrs();
      const now = Date.now(); // counts as a review now, so it syncs like one
      entries.forEach((e, i) => {
        const id = result.ids[i];
        const sched = id && schedToSrs(src.sched[notes[i].id], src.crt);
        if (!sched) return;
        const rec = { ...sched, at: now };
        const next = moreAdvanced(records[id], rec);
        if (next !== records[id]) (records[id] = next), carried++;
      });
      saveSrs(records, { source: 'import' });
    }

    if (doc) {
      setStatus(t('配置を整えています…', 'Laying out the map…'));
      await pause();
      await tidyAsync(doc);
      await store.createMap(opts.name, doc);
    }

    s = fresh();
    closeModal(ID);
    const { added, updated, homographs } = result.stats;
    toast(
      t(
        `${added} 件を追加${updated ? `・${updated} 件を更新` : ''}${homographs ? `（同表記異読 ${homographs}）` : ''}${carried ? `・進捗 ${carried} 件` : ''}`,
        `Added ${added}${updated ? `, updated ${updated}` : ''}${homographs ? ` (${homographs} homographs)` : ''}${carried ? ` · progress for ${carried}` : ''}`
      )
    );
  } catch (err) {
    console.error('[anki] import failed', err);
    s.step = 'map';
    render();
    toast(t(`読み込みに失敗しました: ${err.message}`, `Import failed: ${err.message}`));
  }
}
