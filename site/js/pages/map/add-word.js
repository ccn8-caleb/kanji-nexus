// "Add words" form: kanji preview, tags, IME reading capture, dictionary auto-fill,
// built for back-to-back entry — Enter saves and clears the form for the next word
// (waiting a moment for the dictionary if it's still looking up), Done / Esc closes
// it and shows the last word added. The reading field formats to hiragana and
// accepts romaji.
//
// As you type the word, JMdict is looked up and fills in the meaning, the reading
// and matching grammar tags. Anything you edit yourself is never overwritten. When a
// spelling has several entries (生物: せいぶつ / なまもの) the one matching the IME
// reading is picked, and chips let you switch.

import { icon } from '../../core/icons.js';
import { GRAMMAR_TAGS } from '../../core/constants.js';
import { escapeHtml, extractKanji, labelOf, debounce } from '../../core/util.js';
import { kanjiId, wordId } from '../../core/graph.js';
import * as ops from '../../core/ops.js';
import { t, tr } from '../../core/prefs.js';
import { openModal, onModalClose, bindImeField } from '../../core/ui.js';
import { trackImeReading } from '../../core/ime.js';
import { attachKanaInput } from '../../core/kana.js';
import { lookup, pickEntry, meaningText, tagsFor, DICT_CREDIT } from '../../core/dict.js';
import { settle, findFreeSpot, setPos } from './layout.js';

const $ = (id) => document.getElementById(id);

// ctx: { store, view, canvas, select }. Returns { open(atWorldPoint?) }.
export function initAddWord(ctx) {
  const { store, view, canvas, select } = ctx;
  const els = {
    label: $('new-sec-label'),
    reading: $('new-sec-reading'),
    readingHint: $('new-sec-reading-hint'),
    meaning: $('new-sec-meaning'),
    notes: $('new-sec-notes'),
    tags: $('new-sec-tags'),
    preview: $('new-sec-kanji-preview'),
    candidates: $('dict-candidates'),
    status: $('dict-status'),
    list: $('word-added-list'),
    formStatus: $('word-form-status'),
  };
  let added = [];
  let at = null;
  attachKanaInput(els.reading, { script: 'hiragana' });

  // Where each field's value came from: 'none' | 'ime' | 'stale' (IME gave up) | 'dict' | 'user'.
  let readingFrom = 'none';
  let meaningFrom = 'none';
  let imeReading = '';
  let tags = new Set();
  let autoTags = new Set(); // tags added by the dictionary (removed again if the entry changes)
  let entries = [];
  let chosen = -1;
  let lookupSeq = 0;

  // ---- rendering ----
  function renderTags() {
    els.tags.innerHTML = GRAMMAR_TAGS.map(
      (tg) => `<button type="button" class="tag-toggle${tags.has(tg.id) ? ' active' : ''}" data-mtag="${tg.id}">${tr(tg)}</button>`
    ).join('');
  }

  function renderReadingHint() {
    const text = readingFrom === 'ime' ? t('入力時のかなから自動入力（編集できます）', 'Filled from what you typed (editable)') : readingFrom === 'dict' ? t('辞書から自動入力（編集できます）', 'Filled from the dictionary (editable)') : '';
    els.readingHint.textContent = text;
    els.readingHint.hidden = !text;
  }

  function renderCandidates() {
    els.candidates.innerHTML =
      entries.length > 1
        ? entries
            .map((e, i) => `<button type="button" class="hint-chip${i === chosen ? ' active' : ''}" data-entry="${i}">${escapeHtml(e.r[0])} · ${escapeHtml(e.s[0].g.split(';')[0])}</button>`)
            .join('')
        : '';
  }

  function setStatus(kind) {
    const credit = `<a href="${DICT_CREDIT.url}" target="_blank" rel="noopener noreferrer">${DICT_CREDIT.name}</a>`;
    els.status.innerHTML =
      kind === 'found' ? `${icon('dictionary')}${credit}` : kind === 'none' ? t('辞書に見つかりません', 'Not in the dictionary') : kind === 'loading' ? t('辞書を検索中…', 'Looking up…') : kind === 'offline' ? t('辞書を読み込めません（オフライン）', 'Dictionary unavailable offline') : '';
  }

  // ---- dictionary ----
  function apply(index) {
    chosen = index;
    const entry = entries[index];
    if (!entry) return;
    if (readingFrom !== 'user') {
      const keepIme = readingFrom === 'ime' && entry.r.includes(imeReading);
      if (!keepIme) {
        els.reading.value = entry.r[0];
        readingFrom = 'dict';
      }
    }
    if (meaningFrom !== 'user') {
      els.meaning.value = meaningText(entry);
      meaningFrom = 'dict';
    }
    for (const tag of autoTags) tags.delete(tag);
    autoTags = new Set(tagsFor(entry).filter((tag) => !tags.has(tag)));
    for (const tag of autoTags) tags.add(tag);
    renderReadingHint();
    renderTags();
    renderCandidates();
  }

  function clearDictionaryFill() {
    entries = [];
    chosen = -1;
    if (meaningFrom === 'dict') {
      els.meaning.value = '';
      meaningFrom = 'none';
    }
    if (readingFrom === 'dict') {
      els.reading.value = imeReading;
      readingFrom = imeReading ? 'ime' : 'none';
    }
    for (const tag of autoTags) tags.delete(tag);
    autoTags = new Set();
    renderReadingHint();
    renderTags();
    renderCandidates();
  }

  // The current lookup (word + promise), so saving can wait for it.
  let inflight = { word: null, promise: Promise.resolve() };
  const lookupNow = () => {
    const word = labelOf(els.label.value.trim());
    if (inflight.word !== word) inflight = { word, promise: doLookup() };
    return inflight.promise;
  };
  const runLookup = debounce(lookupNow, 250);

  async function doLookup() {
    const seq = ++lookupSeq;
    const word = labelOf(els.label.value.trim());
    if (!word) {
      clearDictionaryFill();
      return setStatus('');
    }
    setStatus('loading');
    let found;
    try {
      found = await lookup(word);
    } catch (_) {
      if (seq === lookupSeq) setStatus('offline');
      return;
    }
    if (seq !== lookupSeq) return; // the word changed meanwhile
    if (found === null) return setStatus(''); // no dictionary installed (local dev)
    if (!found.length) {
      clearDictionaryFill();
      return setStatus('none');
    }
    entries = found;
    setStatus('found');
    const reading = readingFrom === 'user' ? els.reading.value : imeReading;
    apply(entries.indexOf(pickEntry(entries, reading)));
  }

  // ---- events ----
  els.tags.addEventListener('click', (e) => {
    const id = e.target.closest('[data-mtag]')?.dataset.mtag;
    if (!id) return;
    tags.has(id) ? tags.delete(id) : tags.add(id);
    autoTags.delete(id); // the user owns this tag now
    renderTags();
  });
  els.candidates.addEventListener('click', (e) => {
    const i = e.target.closest('[data-entry]')?.dataset.entry;
    if (i == null) return;
    if (readingFrom === 'dict' || readingFrom === 'ime') readingFrom = 'none'; // follow the chosen entry
    apply(Number(i));
  });

  els.label.addEventListener('input', () => {
    els.preview.innerHTML = extractKanji(els.label.value)
      .map((ch) => {
        const state = store.doc.kanji[ch] ? t('登録済', 'exists') : view.autoCreateKanji ? t('新規作成', 'will create') : t('未登録', 'not registered');
        return `<span class="kanji-chip small">${escapeHtml(ch)} · ${state}</span>`;
      })
      .join('');
  });
  bindImeField(els.label, runLookup);

  // Reading from the IME's kana; a dictionary entry with that reading wins.
  const ime = trackImeReading(els.label, (reading) => {
    imeReading = reading || '';
    if (readingFrom === 'user') return;
    // null = capture gave up (word edited by hand): keep the text, but it no longer
    // counts as an IME reading, so a dictionary match may replace it.
    if (reading == null && els.label.value) {
      if (readingFrom === 'ime') readingFrom = 'stale';
      return renderReadingHint();
    }
    if (readingFrom !== 'dict' || (reading && entries.length)) {
      els.reading.value = reading || '';
      readingFrom = reading ? 'ime' : 'none';
    }
    const match = reading && entries.length > 1 ? entries.indexOf(pickEntry(entries, reading)) : -1;
    if (match >= 0 && match !== chosen) apply(match);
    renderReadingHint();
  });

  els.reading.addEventListener('input', () => {
    readingFrom = els.reading.value ? 'user' : 'none';
    renderReadingHint();
  });
  els.meaning.addEventListener('input', () => (meaningFrom = els.meaning.value ? 'user' : 'none'));

  // Enter in any field saves this word and starts the next (Tab moves between fields).
  for (const el of [els.label, els.reading, els.meaning, els.notes]) {
    el.setAttribute('enterkeyhint', 'done');
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      save();
    });
  }
  $('btn-confirm-add-secondary').addEventListener('click', () => save());

  // ---- open / save ----
  function resetForm() {
    for (const el of [els.label, els.reading, els.meaning, els.notes]) el.value = '';
    readingFrom = meaningFrom = 'none';
    imeReading = '';
    tags = new Set();
    autoTags = new Set();
    entries = [];
    chosen = -1;
    lookupSeq++;
    inflight = { word: null, promise: Promise.resolve() };
    ime.reset();
    els.preview.innerHTML = '';
    setStatus('');
    renderReadingHint();
    renderTags();
    renderCandidates();
  }

  const setFormStatus = (text, kind = 'ok') => {
    els.formStatus.textContent = text;
    els.formStatus.dataset.kind = kind;
  };
  function renderAdded() {
    els.list.hidden = !added.length;
    els.list.innerHTML = `<span class="added-label">${t('追加済み', 'Added')}</span>${added
      .map((key) => `<span class="added-chip">${escapeHtml(labelOf(key))}</span>`)
      .join('')}`;
  }

  let saving = false;
  async function save() {
    if (saving) return;
    const label = els.label.value.trim();
    if (!label) return els.label.focus();
    saving = true;
    try {
      // Pressed Enter right after typing? Give the dictionary a moment to fill in.
      await Promise.race([lookupNow(), new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
      if (els.label.value.trim() !== label) return; // the word changed while we waited
      commit(label);
    } finally {
      saving = false;
    }
  }

  function commit(label) {
    const reading = els.reading.value.trim();
    // Same spelling, different reading → homograph key "label#reading".
    let key = label;
    const existing = store.doc.words[key];
    if (existing && (existing.reading === reading || !reading)) {
      setFormStatus(t(`「${label}」は既に登録されています`, `"${label}" already exists`), 'error');
      return els.label.select();
    }
    if (existing) key = `${label}#${reading}`;
    if (store.doc.words[key]) {
      setFormStatus(t(`「${label}」（${reading}）は既に登録されています`, `"${label}" (${reading}) already exists`), 'error');
      return els.label.select();
    }

    // Placement (layout.js settle): the word goes between its kanji, new kanji beside a
    // related one, and nearby nodes shift aside to make room. "Add here" pins the word
    // where you clicked — like dragging it there.
    const center = at || canvas.viewportCenter();
    let from;
    const result = store.edit((doc) => {
      const res = ops.addWord(
        doc,
        key,
        { reading, meaning: els.meaning.value.trim(), tags: [...tags], notes: els.notes.value.trim() },
        { createKanji: view.autoCreateKanji, linkDerivatives: view.autoLink }
      );
      if (at) {
        const spot = findFreeSpot(doc, at.x, at.y);
        setPos(doc, wordId(key), spot.x, spot.y, { pin: true });
      }
      from = settle(doc, [wordId(key), ...res.createdKanji.map(kanjiId)], { center });
      return res;
    });
    canvas.animateFrom(from);
    added.push(key);
    renderAdded();
    const extra = result.derivatives?.length ? t(`・派生語リンク ${result.derivatives.length}`, ` · ${result.derivatives.length} derivative link(s)`) : '';
    setFormStatus(t(`✓「${label}」を追加しました`, `✓ Added "${label}"`) + extra);
    resetForm();
    els.label.focus();
  }

  // Closing shows the last word added.
  onModalClose('modal-add-secondary', () => {
    const last = added.at(-1);
    if (last && store.doc.words[last]) select(wordId(last), { center: true });
  });

  return {
    open(point = null) {
      at = point;
      added = [];
      resetForm();
      renderAdded();
      setFormStatus('');
      openModal('modal-add-secondary');
      els.label.focus(); // synchronous: iOS only opens the keyboard during the tap
    },
  };
}
