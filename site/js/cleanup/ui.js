// "Clean up map" dialog. Loaded on demand (core/maps-ui.js → openCleanup).
// Scans the open map (cleanup/scan.js), lists suggestions in groups with checkboxes,
// and applies the checked ones as one undoable edit. Nothing changes before Apply.

import { store } from '../core/store.js';
import { t } from '../core/prefs.js';
import { escapeHtml, labelOf } from '../core/util.js';
import { icon } from '../core/icons.js';
import { toast, openModal, closeModal } from '../core/ui.js';
import { lookup, meaningText, tagsFor } from '../core/dict.js';
import { scan, apply } from './scan.js';

const ID = 'cleanup-dialog';
const ROW_LIMIT = 200; // rows shown per group (the rest still apply when the group is checked)
let el = null;
let result = null;
let selected = new Set();
let mapId = null;

const GROUPS = [
  {
    id: 'sentences',
    on: true,
    title: () => t('文になっている語', 'Sentences stored as words'),
    note: () => t('例文として、含まれる語に移します（ノードは削除）。', 'Moved into the examples of the words they contain; the node is removed.'),
    row: (it) =>
      `<span class="jp">${escapeHtml(it.ja)}</span> → ${
        it.targets.length ? it.targets.map((k) => `<span class="cleanup-chip">${escapeHtml(labelOf(k))}</span>`).join('') : `<span class="muted">${t('該当する語なし（削除のみ）', 'no matching word (removed only)')}</span>`
      }`,
  },
  {
    id: 'kanjiWords',
    on: true,
    title: () => t('カタカナ読みの一字の語', 'One kanji read in katakana'),
    note: () => t('漢字の音読みにまとめます（語のノードは削除）。', "Merged into the kanji as its on'yomi; the word node is removed."),
    row: (it) => `<span class="jp">${escapeHtml(it.ch)}</span> <span class="muted">${escapeHtml(it.on)}</span> → ${t(`漢字「${escapeHtml(it.ch)}」の音読み`, `on'yomi of ${escapeHtml(it.ch)}`)}${it.exists ? '' : t('（漢字を作成）', ' (kanji created)')}`,
  },
  {
    id: 'readings',
    on: true,
    title: () => t('表記に合わない読み', "Readings that don't fit the spelling"),
    note: () => t('合う部分、または辞書の読みに置き換えます。', 'Replaced by the part that fits, or by the dictionary reading.'),
    row: (it) => `<span class="jp">${escapeHtml(labelOf(it.key))}</span> <s class="muted">${escapeHtml(it.from.length > 24 ? `${it.from.slice(0, 24)}…` : it.from)}</s> → <strong class="jp">${escapeHtml(it.to)}</strong>`,
  },
  {
    id: 'fill',
    on: true,
    title: () => t('空の読み・意味（辞書から）', 'Empty readings and meanings (from the dictionary)'),
    note: () => t('空の欄だけを埋めます。候補が複数ある語は選べます。', 'Only empty fields are filled. Pick the right entry where there are several.'),
    row: (it) => {
      const c = it.choices[it.choice];
      const describe = (x) => [x.reading, x.meaning].filter(Boolean).join(' — ');
      const pickHtml =
        it.choices.length > 1
          ? `<select class="field-select compact" data-choice="${escapeHtml(it.id)}">${it.choices.map((x, i) => `<option value="${i}"${i === it.choice ? ' selected' : ''}>${escapeHtml(describe(x).slice(0, 80))}</option>`).join('')}</select>`
          : `<span>${c.reading ? `<strong class="jp">${escapeHtml(c.reading)}</strong> ` : ''}${escapeHtml(c.meaning.slice(0, 120))}</span>`;
      return `<span class="jp">${escapeHtml(it.label)}</span>${it.reading ? ` <span class="muted">${escapeHtml(it.reading)}</span>` : ''} → ${pickHtml}`;
    },
  },
  {
    id: 'kanjiReadings',
    on: false, // guesses: opt in
    title: () => t('読みのない漢字（語の読みから推定）', 'Kanji without readings (guessed from their words)'),
    note: () => t('語の読みからの推定です。確認してから選んでください。', "Guessed from the words' readings — check before applying."),
    row: (it) => `<span class="jp">${escapeHtml(it.ch)}</span> → ${[it.on.join('・'), it.kun.join('・')].filter(Boolean).map(escapeHtml).join(' ／ ')}`,
  },
];

export async function openCleanup() {
  if (!el) {
    el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.id = ID;
    document.body.appendChild(el);
    el.addEventListener('change', onChange);
    el.addEventListener('click', onClick);
  }
  mapId = store.currentMap?.id;
  result = null;
  render(t('確認しています…', 'Checking the map…'));
  openModal(ID);
  try {
    result = await scan(JSON.parse(JSON.stringify(store.doc)), {
      lookup,
      meaningText,
      tagsFor,
      onProgress: (i, n) => n && setStatus(t(`辞書で確認中… ${i}/${n}`, `Looking up the dictionary… ${i}/${n}`)),
    });
    selected = new Set(GROUPS.filter((g) => g.on).flatMap((g) => result.groups[g.id].map((it) => it.id)));
    render();
  } catch (err) {
    console.error('[cleanup] scan failed', err);
    closeModal(ID);
    toast(t('確認できませんでした', 'Could not check the map'));
  }
}

function setStatus(text) {
  const n = el.querySelector('.anki-status-text');
  if (n) n.textContent = text;
}

function render(status) {
  const title = `<div class="modal-title"><span class="title-with-icon">${icon('tidy')}${t('マップを整理', 'Clean up map')}</span>
    <button type="button" class="icon-btn small" data-close-modal="${ID}" aria-label="Close">${icon('close')}</button></div>`;
  if (!result) {
    el.innerHTML = `<div class="modal-card wide anki-card">${title}<div class="anki-status">${icon('loading')}<span class="anki-status-text">${escapeHtml(status || '')}</span></div></div>`;
    return;
  }
  const total = GROUPS.reduce((a, g) => a + result.groups[g.id].length, 0);
  const body = GROUPS.filter((g) => result.groups[g.id].length)
    .map((g) => {
      const items = result.groups[g.id];
      const n = items.filter((it) => selected.has(it.id)).length;
      const all = n === items.length;
      return `<details class="cleanup-group"${g.on ? ' open' : ''}>
        <summary><label class="anki-check"><input type="checkbox" data-group="${g.id}"${all ? ' checked' : ''}${n && !all ? ' data-mixed' : ''}> <strong>${g.title()}</strong></label> <span class="menu-count">${n} / ${items.length}</span></summary>
        <p class="panel-note">${g.note()}</p>
        <ul class="cleanup-list">${items
          .slice(0, ROW_LIMIT)
          .map((it) => `<li><label class="anki-check"><input type="checkbox" data-item="${escapeHtml(it.id)}"${selected.has(it.id) ? ' checked' : ''}> <span class="cleanup-row">${g.row(it)}</span></label></li>`)
          .join('')}${items.length > ROW_LIMIT ? `<li class="muted">${t(`ほか ${items.length - ROW_LIMIT} 件（グループを選ぶと含まれます）`, `${items.length - ROW_LIMIT} more (included when the whole group is checked)`)}</li>` : ''}</ul>
      </details>`;
    })
    .join('');
  const count = selected.size;
  el.innerHTML = `<div class="modal-card wide anki-card">${title}
    ${result.dictionary ? '' : `<p class="form-status" data-kind="error">${t('辞書を利用できないため、辞書を使う提案は含まれていません。', "The dictionary isn't available, so suggestions that need it are missing.")}</p>`}
    ${total ? body : `<p class="panel-note">${t(`「${escapeHtml(store.currentMap?.name || '')}」に整理が必要な項目はありません。`, `Nothing to clean up in “${escapeHtml(store.currentMap?.name || '')}”.`)}</p>`}
    <div class="modal-actions">
      <button type="button" class="tb-btn" data-close-modal="${ID}">${t('閉じる', 'Close')}</button>
      ${total ? `<button type="button" class="tb-btn primary" data-apply${count ? '' : ' disabled'}>${icon('check')}${t(`${count} 件を適用`, `Apply ${count}`)}</button>` : ''}
    </div></div>`;
  el.querySelectorAll('[data-mixed]').forEach((x) => (x.indeterminate = true));
}

function onChange(e) {
  const x = e.target;
  if (!result) return;
  if (x.dataset.group) {
    for (const it of result.groups[x.dataset.group]) x.checked ? selected.add(it.id) : selected.delete(it.id);
  } else if (x.dataset.item) {
    x.checked ? selected.add(x.dataset.item) : selected.delete(x.dataset.item);
  } else if (x.dataset.choice) {
    const it = result.groups.fill.find((i) => i.id === x.dataset.choice);
    if (it) it.choice = Number(x.value);
    return;
  } else return;
  const open = [...el.querySelectorAll('.cleanup-group')].map((d) => d.open);
  const scroll = el.querySelector('.modal-card')?.scrollTop;
  render();
  el.querySelectorAll('.cleanup-group').forEach((d, i) => (d.open = open[i] ?? true));
  if (scroll) el.querySelector('.modal-card').scrollTop = scroll;
}

function onClick(e) {
  if (!e.target.closest('[data-apply]') || !result) return;
  if (store.currentMap?.id !== mapId) {
    toast(t('別のマップが開かれています。もう一度確認してください。', 'Another map is open now — run the check again.'));
    return closeModal(ID);
  }
  // Drill progress of removed nodes is left alone, so Undo brings them back intact.
  const { counts } = store.edit((doc) => apply(doc, result, selected));
  closeModal(ID);
  const parts = [
    counts.sentences && t(`例文に移動 ${counts.sentences}`, `${counts.sentences} sentences → examples`),
    counts.kanjiWords && t(`音読みに統合 ${counts.kanjiWords}`, `${counts.kanjiWords} merged into kanji`),
    counts.readings && t(`読みを修正 ${counts.readings}`, `${counts.readings} readings fixed`),
    counts.fill && t(`辞書で補完 ${counts.fill}`, `${counts.fill} filled from the dictionary`),
    counts.kanjiReadings && t(`漢字の読み ${counts.kanjiReadings}`, `${counts.kanjiReadings} kanji readings`),
  ].filter(Boolean);
  toast(parts.join(t('・', ' · ')) || t('変更なし', 'No changes'), { action: { label: t('元に戻す', 'Undo'), run: () => store.undo() } });
}
