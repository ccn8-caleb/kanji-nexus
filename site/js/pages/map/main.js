// Map page entry: view state, toolbar, add-modals, link mode, keyboard, startup.

import { GRAMMAR_TAGS, LINK_TYPES } from '../../core/constants.js';
import { escapeHtml, splitReadings, fold, joinReadings, debounce } from '../../core/util.js';
import { kanjiId } from '../../core/graph.js';
import * as ops from '../../core/ops.js';
import { t, tr, onPrefsChange, applyStaticText } from '../../core/prefs.js';
import { toast, openModal, closeModal, bindImeField, isTyping, anyModalOpen, isCompact } from '../../core/ui.js';
import { initPage, registerDataAction } from '../../core/hub.js';
import { bindEnterFlow } from '../../core/ime.js';
import { initAddWord } from './add-word.js';
import { createCanvas } from './canvas.js';
import { renderInspector, initInspectorGestures } from './inspector.js';
import { placeMissing, autoArrange, findFreePosition, getPos, setPos } from './layout.js';

const VIEW_PREFS_KEY = 'kanji_nexus_map_view';
const CAMERA_KEY = 'kanji_nexus_map_camera';
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
  inspectorMode: 'summary', // phones: 'summary' (read-first) | 'edit'
  sheetFull: false, // phones: bottom sheet expanded
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
    closeFabMenu();
    if (view.selectedId) select(null);
  },
  // Remember where the map was so it reopens there.
  onCameraChange: debounce((cam) => {
    try {
      localStorage.setItem(CAMERA_KEY, JSON.stringify(cam));
    } catch (_) {}
  }, 400),
});
const ctx = { store, view, canvas, select, startLink };
initInspectorGestures(ctx);

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
  $('m-btn-undo').disabled = !store.canUndo;
  applyStaticText($('top-bar'));
}

function renderAll({ inspector = true } = {}) {
  renderToolbar();
  renderFilterBar();
  canvas.render();
  if (inspector) renderInspector(ctx);
}

function select(id, { center = false } = {}) {
  const next = id && store.graph.node(id) ? id : null;
  if (next !== view.selectedId) {
    view.inspectorMode = 'summary';
    view.sheetFull = false;
  }
  view.selectedId = next;
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
  closeFabMenu();
  // Phones: the sheet covers the lower half, so bring the tapped node into view.
  if (!view.linkMode) return select(view.selectedId === id ? null : id, { center: isCompact() });

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

// From the phone summary's 🔗 button: start link mode with this word as the source.
function startLink(wid) {
  setLinkMode(true);
  view.linkSourceId = wid;
  view.selectedId = null; // close the sheet so the map is visible
  renderLinkModeBar();
  renderAll();
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
  $('new-primary-label').focus(); // synchronous: iOS only opens the keyboard during the tap
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

bindEnterFlow([$('new-primary-label'), $('new-primary-onyomi'), $('new-primary-kunyomi'), $('new-primary-notes')], () => $('btn-confirm-add-primary').click());
initAddWord(ctx);

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

const undo = () => store.undo() && toast(t('操作を元に戻しました', 'Undid last action'));
$('btn-undo').addEventListener('click', undo);
$('m-btn-undo').addEventListener('click', undo);
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

// ---------------------------------------------------------------------------
// Phone controls: ＋ button, tools sheet, search overlay
// ---------------------------------------------------------------------------
function closeFabMenu() {
  $('fab-menu').hidden = true;
  $('fab').classList.remove('open');
}
$('fab').addEventListener('click', () => {
  const open = $('fab-menu').hidden;
  $('fab-menu').hidden = !open;
  $('fab').classList.toggle('open', open);
});
$('fab-menu').addEventListener('click', (e) => {
  const which = e.target.closest('[data-fab]')?.dataset.fab;
  if (!which) return;
  closeFabMenu();
  $(which === 'word' ? 'btn-open-add-secondary' : 'btn-open-add-primary').click();
});

const TOOL_TOGGLES = [
  ['revealAll', '全体表示（すべての熟語を表示）', 'Reveal all words'],
  ['showReadings', '読みを表示', 'Show readings'],
  ['autoLink', '派生語を自動リンク', 'Auto-link derivatives'],
  ['autoCreateKanji', '未登録の漢字を自動作成', 'Auto-create missing kanji'],
];
function renderToolsSheet() {
  const toggles = TOOL_TOGGLES.map(
    ([key, ja, en]) => `<button type="button" class="menu-row${view[key] ? ' on' : ''}" data-tool-toggle="${key}"><span>${t(ja, en)}</span><span class="switch"></span></button>`
  ).join('');
  $('map-tools-list').innerHTML = `${toggles}
    <button type="button" class="menu-row" data-tool="link"><span>🔗 ${t('リンク接続モード', 'Link mode')}</span></button>
    <button type="button" class="menu-row" data-tool="fit"><span>⤢ ${t('全体を表示', 'Show everything')}</span></button>
    <button type="button" class="menu-row" data-tool="arrange"><span>✨ ${t('自動整列', 'Auto-arrange')}</span></button>
    <button type="button" class="menu-row" data-tool="redo" ${store.canRedo ? '' : 'disabled'}><span>↪ ${t('やり直す', 'Redo')}</span></button>`;
}
$('m-btn-tools').addEventListener('click', () => {
  renderToolsSheet();
  openModal('modal-map-tools');
});
$('map-tools-list').addEventListener('click', (e) => {
  const key = e.target.closest('[data-tool-toggle]')?.dataset.toolToggle;
  if (key) {
    toggle(key)();
    return renderToolsSheet();
  }
  const tool = e.target.closest('[data-tool]')?.dataset.tool;
  if (!tool) return;
  closeModal('modal-map-tools');
  if (tool === 'link') setLinkMode(true);
  else if (tool === 'fit') canvas.fit();
  else if (tool === 'arrange') $('btn-auto-arrange').click();
  else if (tool === 'redo') store.redo();
});

function renderSearchResults() {
  const q = fold($('m-search-input').value.trim());
  const g = store.graph;
  if (!q) {
    $('m-search-results').innerHTML = `<div class="muted pad">${t('漢字・熟語・読み・意味・メモで検索できます', 'Search by kanji, word, reading, meaning or notes')}</div>`;
    return;
  }
  const rows = [];
  for (const k of g.kanji.values()) {
    const hay = fold(`${k.label} ${joinReadings(k.on)} ${joinReadings(k.kun)} ${k.notes}`);
    if (hay.includes(q)) rows.push({ node: k, sub: [joinReadings(k.on), joinReadings(k.kun)].filter(Boolean).join(' ／ '), exact: k.label === q, kind: t('漢字', 'Kanji') });
  }
  for (const w of g.words.values()) {
    const hay = fold(`${w.label} ${w.reading} ${w.meaning} ${w.notes}`);
    if (hay.includes(q)) rows.push({ node: w, sub: [w.reading, w.meaning].filter(Boolean).join(' · '), exact: w.label === q || fold(w.reading) === q, kind: t('語', 'Word') });
  }
  rows.sort((a, b) => Number(b.exact) - Number(a.exact));
  $('m-search-results').innerHTML = rows.length
    ? rows
        .slice(0, 40)
        .map(({ node, sub, kind }) => `<button type="button" class="m-result" data-result="${escapeHtml(node.id)}">
            <span class="m-result-label">${escapeHtml(node.label)}</span><span class="m-result-sub">${escapeHtml(sub || '')}</span><span class="m-result-kind">${kind}</span></button>`)
        .join('')
    : `<div class="muted pad">${t('見つかりません', 'No matches')}</div>`;
}
function closeSearch() {
  $('m-search').hidden = true;
  $('m-search-input').blur();
}
$('m-btn-search').addEventListener('click', () => {
  $('m-search').hidden = false;
  renderSearchResults();
  $('m-search-input').focus();
});
$('m-search-close').addEventListener('click', closeSearch);
bindImeField($('m-search-input'), renderSearchResults);
$('m-search-results').addEventListener('click', (e) => {
  const id = e.target.closest('[data-result]')?.dataset.result;
  if (!id) return;
  closeSearch();
  view.search = '';
  view.tagFilter = 'all';
  select(id, { center: true });
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

// Where the map opens: a deep link wins, then the last position on this device; on a
// first phone visit, the biggest cluster at a zoom where nodes are easy to tap.
function savedCamera() {
  try {
    const cam = JSON.parse(localStorage.getItem(CAMERA_KEY) || 'null');
    return cam && [cam.cx, cam.cy, cam.scale].every(Number.isFinite) ? cam : null;
  } catch (_) {
    return null;
  }
}
function readableStart() {
  const biggest = store.graph.clusters()[0];
  const hub = biggest?.kanji.slice().sort((a, b) => store.graph.children.get(b.id).length - store.graph.children.get(a.id).length)[0];
  const pos = hub && getPos(store.doc, hub.id);
  if (pos) canvas.centerOn(pos[0], pos[1] + 120, 0.85, false);
  else canvas.fit({ animate: false });
}

if (focusId) {
  canvas.fit({ animate: false });
  view.search = '';
  view.tagFilter = 'all';
  select(focusId, { center: true });
} else if (savedCamera()) {
  canvas.restoreView(savedCamera());
} else if (isCompact()) {
  readableStart();
} else {
  canvas.fit({ animate: false });
}
