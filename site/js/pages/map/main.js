// Map page entry: view state, toolbar, add-modals, link mode, keyboard, startup.

import { GRAMMAR_TAGS, LINK_TYPES } from '../../core/constants.js';
import { escapeHtml, extractKanji, splitReadings, labelOf } from '../../core/util.js';
import { kanjiId, wordId, buildGraph as buildGraphFor } from '../../core/graph.js';
import * as ops from '../../core/ops.js';
import { t, tr, onPrefsChange, applyStaticText } from '../../core/prefs.js';
import { toast, openModal, closeModal, bindImeField, isTyping, anyModalOpen } from '../../core/ui.js';
import { initPage, registerDataAction } from '../../core/hub.js';
import { createCanvas } from './canvas.js';
import { renderInspector } from './inspector.js';
import { placeMissing, autoArrange, findFreePosition, wordAnchor, getPos, setPos } from './layout.js';

const VIEW_PREFS_KEY = 'kanji_nexus_map_view';
const $ = (id) => document.getElementById(id);

const { store, focusId } = await initPage('map');

// ---------------------------------------------------------------------------
// View state (not part of the data; toggles persist per browser)
// ---------------------------------------------------------------------------
const view = {
  selectedId: null,
  revealAll: false,
  showReadings: true,
  autoLink: true, // auto-link derivatives (魅力 ↔ 魅力的) when adding words
  autoCreateKanji: true, // register missing kanji when adding words
  linkMode: false,
  linkSourceId: null,
  activeLinkType: 'antonym',
  tagFilter: 'all',
  search: '',
};
const PERSISTED = ['revealAll', 'showReadings', 'autoLink', 'autoCreateKanji'];
try {
  Object.assign(view, JSON.parse(localStorage.getItem(VIEW_PREFS_KEY) || '{}'));
} catch (_) {}
const saveViewPrefs = () => {
  try {
    localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(Object.fromEntries(PERSISTED.map((k) => [k, view[k]]))));
  } catch (_) {}
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const canvas = createCanvas({
  store,
  view,
  onTap: handleNodeTap,
  onBackgroundTap: () => {
    if (view.selectedId) select(null);
  },
});
const ctx = { store, view, canvas, select };

function renderFilterBar() {
  const pills = [{ id: 'all', ja: 'すべて', en: 'All' }, ...GRAMMAR_TAGS];
  $('tag-filter-pills').innerHTML = pills
    .map((p) => `<button type="button" class="filter-pill${view.tagFilter === p.id ? ' active' : ''}" data-filter-tag="${p.id}">${tr(p)}</button>`)
    .join('');
  const g = store.graph;
  $('map-stats-summary').textContent = t(`${g.kanji.size} 漢字 · ${g.words.size} 熟語`, `${g.kanji.size} Kanji · ${g.words.size} Compounds`);
}

// Toggle buttons carry both labels so prefs.applyStaticText() can translate them.
function setToggle(id, active, [ja, en], [jaOff, enOff] = [ja, en]) {
  const el = $(id);
  el.classList.toggle('active', active);
  el.dataset.ja = active ? ja : jaOff;
  el.dataset.en = active ? en : enOff;
}

function renderToolbar() {
  setToggle('btn-toggle-reveal', view.revealAll, ['全体表示', 'Reveal All'], ['集中表示', 'Focus Mode']);
  setToggle('btn-toggle-readings', view.showReadings, ['読み表示', 'Readings On'], ['読み非表示', 'Readings Off']);
  setToggle('btn-toggle-autolink', view.autoLink, ['自動リンク', 'Auto-Link']);
  setToggle('btn-toggle-autocreate', view.autoCreateKanji, ['未登録漢字自動作成', 'Auto-Create Kanji']);
  $('btn-toggle-link-mode').classList.toggle('link-active', view.linkMode);
  $('btn-undo').disabled = !store.canUndo;
  $('btn-redo').disabled = !store.canRedo;
  applyStaticText($('top-bar'));
}

function renderAll({ inspector = true } = {}) {
  renderToolbar();
  renderFilterBar();
  canvas.render();
  if (inspector) renderInspector(ctx);
}

function select(id, { center = false } = {}) {
  view.selectedId = id && store.graph.node(id) ? id : null;
  renderAll();
  if (center && view.selectedId) {
    const pos = getPos(store.doc, view.selectedId);
    if (pos) canvas.focusOn(pos[0], pos[1]);
  }
}

store.subscribe(({ reason }) => {
  // Hand-edited or imported data may lack positions: place them (not an undo step).
  if (placeMissing(store.doc, canvas.viewportCenter())) {
    store.commit('layout');
    return;
  }
  if (reason === 'replace') {
    view.selectedId = null;
    canvas.fit();
  }
  // Typing in the inspector must not rebuild the inspector under the cursor.
  renderAll({ inspector: reason !== 'field' });
});

onPrefsChange(() => {
  renderAll();
  renderLinkModeBar();
});

// ---------------------------------------------------------------------------
// Taps & link mode
// ---------------------------------------------------------------------------
function handleNodeTap(id) {
  if (!view.linkMode) return select(view.selectedId === id ? null : id);

  const graph = store.graph;
  if (!graph.words.has(id)) return toast(t('熟語ノードを選択してください', 'Select a compound node to link'));
  if (!view.linkSourceId || view.linkSourceId === id) {
    view.linkSourceId = id;
    renderLinkModeBar();
    return select(id);
  }
  const src = graph.words.get(view.linkSourceId);
  const dst = graph.words.get(id);
  view.linkSourceId = null;
  view.selectedId = dst.id;
  store.edit((doc) => ops.setLink(doc, src.key, dst.key, view.activeLinkType));
  renderLinkModeBar();
  toast(t(`${src.label} ↔ ${dst.label} を接続しました`, `Linked ${src.label} ↔ ${dst.label}`));
}

function renderLinkModeBar() {
  $('link-mode-bar').classList.toggle('visible', view.linkMode);
  if (!view.linkMode) return;
  const src = store.graph.words.get(view.linkSourceId);
  $('link-mode-status').textContent = src
    ? t(`「${src.label}」→ 2つ目の熟語を選択`, `"${src.label}" → select the second compound`)
    : t('1つ目の熟語を選択', 'Select the first compound');
  $('link-mode-types').innerHTML = Object.entries(LINK_TYPES)
    .map(([k, m]) => {
      const active = view.activeLinkType === k;
      return `<button type="button" class="link-type-chip${active ? ' active' : ''}" data-lm-type="${k}" style="${active ? `background:${m.color};` : ''}">${m.short}·${tr(m)}</button>`;
    })
    .join('');
}

function setLinkMode(on) {
  view.linkMode = on;
  view.linkSourceId = null;
  if (on) view.revealAll = true;
  renderLinkModeBar();
  renderAll();
}

// ---------------------------------------------------------------------------
// Add kanji / add word modals
// ---------------------------------------------------------------------------
$('btn-open-add-primary').addEventListener('click', () => {
  ['new-primary-label', 'new-primary-onyomi', 'new-primary-kunyomi', 'new-primary-notes'].forEach((id) => ($(id).value = ''));
  openModal('modal-add-primary');
  setTimeout(() => $('new-primary-label').focus(), 50);
});

$('btn-confirm-add-primary').addEventListener('click', () => {
  const ch = $('new-primary-label').value.trim();
  if (!ch) return;
  closeModal('modal-add-primary');
  if (store.doc.kanji[ch]) {
    select(kanjiId(ch), { center: true });
    return toast(t(`「${ch}」は既に登録されています`, `"${ch}" already exists`));
  }
  const center = canvas.viewportCenter();
  store.edit((doc) => {
    ops.addKanji(doc, ch, {
      on: splitReadings($('new-primary-onyomi').value),
      kun: splitReadings($('new-primary-kunyomi').value),
      notes: $('new-primary-notes').value.trim(),
    });
    const pos = findFreePosition(doc, center.x, center.y);
    setPos(doc, kanjiId(ch), pos.x, pos.y);
  });
  select(kanjiId(ch), { center: true });
  toast(t(`親漢字「${ch}」を追加しました`, `Added kanji "${ch}"`));
});

let modalTags = new Set();
function renderModalTags() {
  $('new-sec-tags').innerHTML = GRAMMAR_TAGS.map(
    (tg) => `<button type="button" class="tag-toggle${modalTags.has(tg.id) ? ' active' : ''}" data-mtag="${tg.id}">${tr(tg)}</button>`
  ).join('');
}
$('new-sec-tags').addEventListener('click', (e) => {
  const id = e.target.closest('[data-mtag]')?.dataset.mtag;
  if (!id) return;
  modalTags.has(id) ? modalTags.delete(id) : modalTags.add(id);
  renderModalTags();
});

$('new-sec-label').addEventListener('input', (e) => {
  $('new-sec-kanji-preview').innerHTML = extractKanji(e.target.value)
    .map((ch) => {
      const state = store.doc.kanji[ch] ? t('登録済', 'exists') : view.autoCreateKanji ? t('新規作成', 'will create') : t('未登録', 'not registered');
      return `<span class="kanji-chip small">${escapeHtml(ch)} · ${state}</span>`;
    })
    .join('');
});

$('btn-open-add-secondary').addEventListener('click', () => {
  ['new-sec-label', 'new-sec-reading', 'new-sec-notes'].forEach((id) => ($(id).value = ''));
  $('new-sec-kanji-preview').innerHTML = '';
  modalTags = new Set();
  renderModalTags();
  openModal('modal-add-secondary');
  setTimeout(() => $('new-sec-label').focus(), 50);
});

$('btn-confirm-add-secondary').addEventListener('click', () => {
  const label = $('new-sec-label').value.trim();
  if (!label) return;
  const reading = $('new-sec-reading').value.trim();
  closeModal('modal-add-secondary');

  // Same spelling, different reading → homograph key "label#reading".
  let key = label;
  const existing = store.doc.words[key];
  if (existing && (existing.reading === reading || !reading)) {
    select(wordId(key), { center: true });
    return toast(t(`「${label}」は既に登録されています`, `"${label}" already exists`));
  }
  if (existing) key = `${label}#${reading}`;
  if (store.doc.words[key]) return select(wordId(key), { center: true });

  // New kanji go beside an existing sibling (or the selected kanji, or the viewport centre).
  const center = canvas.viewportCenter();
  const selectedKanji = store.graph.kanji.get(view.selectedId);
  const result = store.edit((doc) => {
    const siblings = extractKanji(labelOf(key)).filter((ch) => doc.kanji[ch]);
    const res = ops.addWord(doc, key, { reading, tags: [...modalTags], notes: $('new-sec-notes').value.trim() }, {
      createKanji: view.autoCreateKanji,
      linkDerivatives: view.autoLink,
    });
    const anchor = siblings.length ? getPos(doc, kanjiId(siblings[0])) : selectedKanji ? [selectedKanji.x, selectedKanji.y] : null;
    for (const ch of res.createdKanji) {
      const base = anchor ? { x: anchor[0] + 240, y: anchor[1] } : center;
      const pos = findFreePosition(doc, base.x, base.y);
      setPos(doc, kanjiId(ch), pos.x, pos.y);
    }
    // wordAnchor needs parents, which a fresh graph provides.
    const base = wordAnchor(doc, buildGraphFor(doc), wordId(key), center);
    const pos = findFreePosition(doc, base.x, base.y, { excludeId: wordId(key), clearance: 95 });
    setPos(doc, wordId(key), pos.x, pos.y);
    return res;
  });
  select(wordId(key), { center: true });
  const extra = result.derivatives?.length ? t(`（派生語リンク ${result.derivatives.length}）`, ` (${result.derivatives.length} derivative links)`) : '';
  toast(t(`熟語「${label}」を追加しました`, `Added "${label}"`) + extra);
});

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
const toggle = (key) => () => {
  view[key] = !view[key];
  saveViewPrefs();
  renderAll();
};
$('btn-toggle-reveal').addEventListener('click', toggle('revealAll'));
$('btn-toggle-readings').addEventListener('click', toggle('showReadings'));
$('btn-toggle-autolink').addEventListener('click', toggle('autoLink'));
$('btn-toggle-autocreate').addEventListener('click', toggle('autoCreateKanji'));
$('btn-toggle-link-mode').addEventListener('click', () => setLinkMode(!view.linkMode));
$('btn-exit-link-mode').addEventListener('click', () => setLinkMode(false));
$('link-mode-types').addEventListener('click', (e) => {
  const type = e.target.closest('[data-lm-type]')?.dataset.lmType;
  if (type) {
    view.activeLinkType = type;
    renderLinkModeBar();
  }
});

$('btn-auto-arrange').addEventListener('click', () => {
  store.edit((doc) => autoArrange(doc), 'layout');
  canvas.fit();
  toast(t('クラスター別に自動整列しました', 'Auto-arranged clusters'));
});

$('btn-undo').addEventListener('click', () => store.undo() && toast(t('操作を元に戻しました', 'Undid last action')));
$('btn-redo').addEventListener('click', () => store.redo() && toast(t('操作をやり直しました', 'Redid action')));

$('tag-filter-pills').addEventListener('click', (e) => {
  const tag = e.target.closest('[data-filter-tag]')?.dataset.filterTag;
  if (tag) {
    view.tagFilter = tag;
    renderAll();
  }
});

bindImeField($('map-search-input'), (value) => {
  view.search = value;
  canvas.render();
});

$('btn-zoom-in').addEventListener('click', () => canvas.zoomBy(1.2));
$('btn-zoom-out').addEventListener('click', () => canvas.zoomBy(0.82));
$('zoom-level-text').addEventListener('click', () => canvas.resetZoom());
$('btn-zoom-fit').addEventListener('click', () => canvas.fit());
$('btn-close-inspector').addEventListener('click', () => select(null));

document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !isTyping()) {
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      store.undo();
    } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
      e.preventDefault();
      store.redo();
    }
  } else if (e.key === 'Escape' && !anyModalOpen()) {
    if (view.linkMode) setLinkMode(false);
    else if (view.selectedId) select(null);
  }
});

registerDataAction({
  id: 'rescan',
  section: 'tools',
  ja: '🔄 未登録漢字・派生語リンクを再スキャン',
  en: '🔄 Rescan missing kanji & derivative links',
  run({ closePanel }) {
    const res = store.edit((doc) => ops.rescanAll(doc, { createKanji: view.autoCreateKanji }));
    closePanel();
    toast(t(`漢字 ${res.kanjiCreated} 件作成・リンク ${res.linksAdded} 件追加`, `Created ${res.kanjiCreated} kanji · added ${res.linksAdded} links`));
  },
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
const hadLayout = Object.keys(store.doc.layout.kanji).length > 0;
if (!hadLayout && Object.keys(store.doc.kanji).length) {
  autoArrange(store.doc);
  store.commit('layout');
} else if (placeMissing(store.doc, { x: 0, y: 0 })) {
  store.commit('layout');
}
renderAll();
renderLinkModeBar();
canvas.fit({ animate: false });
if (focusId) {
  view.search = '';
  view.tagFilter = 'all';
  select(focusId, { center: true });
}
