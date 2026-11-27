// Map page entry: view state, header controls & menus, context menu, link mode,
// keyboard shortcuts, phone controls, startup.

import { GRAMMAR_TAGS, LINK_TYPES } from '../../core/constants.js';
import { escapeHtml, fold, joinReadings, debounce } from '../../core/util.js';
import * as ops from '../../core/ops.js';
import { t, tr, onPrefsChange, applyStaticText } from '../../core/prefs.js';
import { toast, openModal, closeModal, bindImeField, isTyping, anyModalOpen, isCompact, isTouch, toggleMenu, openMenu, closeMenu } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { initPage, registerDataAction } from '../../core/hub.js';
import { initAddWord } from './add-word.js';
import { initAddKanji } from './add-kanji.js';
import { createCanvas } from './canvas.js';
import { renderInspector, initInspectorGestures, deleteNode } from './inspector.js';
import { placeMissing, tidy, tidyAsync, getPos, isPinned, setPinned, unpinAll } from './layout.js';

const VIEW_PREFS_KEY = 'kanji_nexus_map_view';
const CAMERA_KEY = 'kanji_nexus_map_camera'; // + ':<map id>' — each map remembers its view
const cameraKey = () => `${CAMERA_KEY}:${store.currentMap?.id}`;
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
  inspectorMode: 'summary', // touch devices: 'summary' (read-first) | 'edit'
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
  onContextMenu: showContextMenu,
  // Remember where the map was so it reopens there.
  onCameraChange: debounce((cam) => {
    try {
      localStorage.setItem(cameraKey(), JSON.stringify(cam));
    } catch (_) {}
  }, 400),
});
const ctx = { store, view, canvas, select, startLink };
initInspectorGestures(ctx);
const addWord = initAddWord(ctx);
const addKanji = initAddKanji(ctx);

function renderFilterBar() {
  const pills = [{ id: 'all', ja: 'すべて', en: 'All' }, ...GRAMMAR_TAGS];
  $('tag-filter-pills').innerHTML = pills
    .map((p) => `<button type="button" class="filter-pill${view.tagFilter === p.id ? ' active' : ''}" data-filter-tag="${p.id}">${tr(p)}</button>`)
    .join('');
  const g = store.graph;
  $('map-stats-summary').textContent = t(`${g.kanji.size} 漢字 · ${g.words.size} 熟語`, `${g.kanji.size} kanji · ${g.words.size} words`);
}

function renderToolbar() {
  for (const id of ['btn-undo', 'm-btn-undo']) $(id).disabled = !store.canUndo;
  $('btn-redo').disabled = !store.canRedo;
  $('btn-view-menu').classList.toggle('active', view.linkMode);
  applyStaticText($('top-bar'));
}

function renderAll({ inspector = true } = {}) {
  renderToolbar();
  renderFilterBar();
  canvas.render();
  if (inspector) renderInspector(ctx);
}

function select(id, { center = false, edit = false } = {}) {
  const next = id && store.graph.node(id) ? id : null;
  if (next !== view.selectedId) {
    view.inspectorMode = 'summary';
    view.sheetFull = false;
  }
  if (edit) view.inspectorMode = 'edit';
  view.selectedId = next;
  renderAll();
  if (center && view.selectedId) {
    const pos = getPos(store.doc, view.selectedId);
    if (pos) canvas.focusOn(pos[0], pos[1]);
  }
}

store.subscribe(({ reason }) => {
  if (reason === 'switch') {
    // Another map: fresh selection/link state, and that map's own remembered view.
    view.selectedId = null;
    view.linkMode = false;
    view.linkSourceId = null;
    renderLinkModeBar();
    const hasLayout = Object.keys(store.doc.layout.kanji).length + Object.keys(store.doc.layout.words).length > 0;
    if (!hasLayout && Object.keys(store.doc.kanji).length) {
      tidy(store.doc); // a map that has never been laid out
      store.commit('layout');
    } else if (placeMissing(store.doc, { x: 0, y: 0 })) store.commit('layout');
    renderAll();
    const cam = savedCamera();
    if (cam) canvas.restoreView(cam);
    else if (isTouch()) readableStart();
    else canvas.fit({ animate: false });
    return;
  }
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

// Link mode starting from a given word (summary "Link" button, context menu).
function startLink(wid) {
  setLinkMode(true);
  view.linkSourceId = wid;
  view.selectedId = null; // close the panel so the map is visible
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
// Commands shared by the header menus, the phone tools sheet and the context menu
// ---------------------------------------------------------------------------
const toggle = (key) => {
  view[key] = !view[key];
  saveViewPrefs();
  renderAll();
};
const undo = () => store.undo() && toast(t('操作を元に戻しました', 'Undid last action'));
const redo = () => store.redo() && toast(t('操作をやり直しました', 'Redid action'));
// Tidy up: organic layout per cluster, clusters packed together; pinned nodes stay.
// Big maps lay out in a background thread, so the page never freezes.
let tidying = false;
async function arrange() {
  if (tidying) return;
  tidying = true;
  const big = Object.keys(store.doc.words).length + Object.keys(store.doc.kanji).length > 400;
  if (big) toast(t('整えています…', 'Tidying up…'));
  try {
    const draft = JSON.parse(JSON.stringify(store.doc));
    const from = await tidyAsync(draft);
    store.edit((doc) => (doc.layout = draft.layout), 'layout');
    canvas.fit();
    canvas.animateFrom(from, 600);
    toast(t('マップを整えました', 'Map tidied up'), { action: { label: t('元に戻す', 'Undo'), run: undo } });
  } catch (err) {
    console.error(err);
    toast(t('整えられませんでした', 'Could not tidy the map'));
  } finally {
    tidying = false;
  }
}

function togglePin(id) {
  const on = !isPinned(store.doc, id);
  store.edit((doc) => setPinned(doc, id, on), 'layout');
  toast(on ? t('固定しました（整えても動きません）', 'Pinned — tidy-up won’t move it') : t('固定を解除しました', 'Unpinned'));
}

const VIEW_TOGGLES = [
  ['revealAll', 'reveal', '全体表示（すべての熟語）', 'Reveal all words'],
  ['showReadings', 'readings', '読みを表示', 'Show readings'],
  ['autoLink', 'autoLink', '派生語を自動リンク', 'Auto-link derivatives'],
  ['autoCreateKanji', 'autoCreate', '未登録の漢字を自動作成', 'Auto-create missing kanji'],
];

function viewMenuItems() {
  return [
    { heading: t('表示', 'View') },
    ...VIEW_TOGGLES.slice(0, 2).map(([key, , ja, en]) => ({ label: t(ja, en), checked: view[key], run: () => toggle(key) })),
    { heading: t('追加時', 'When adding') },
    ...VIEW_TOGGLES.slice(2).map(([key, , ja, en]) => ({ label: t(ja, en), checked: view[key], run: () => toggle(key) })),
    { separator: true },
    { label: view.linkMode ? t('リンク接続モードを終了', 'Exit link mode') : t('リンク接続モード', 'Link mode'), icon: 'link', run: () => setLinkMode(!view.linkMode) },
    { label: t('全体を表示', 'Show everything'), icon: 'fit', run: () => canvas.fit() },
    { label: t('マップを整える', 'Tidy up'), icon: 'tidy', run: arrange },
    { label: t('すべての固定を解除', 'Unpin all'), icon: 'unpin', disabled: !hasPins(), run: unpinEverything },
  ];
}

const hasPins = () => ['kanji', 'words'].some((sec) => Object.values(store.doc.layout[sec]).some((p) => p[2]));
function unpinEverything() {
  const n = store.edit((doc) => unpinAll(doc), 'layout');
  toast(t(`${n} 個の固定を解除しました`, `Unpinned ${n} node(s)`), { action: { label: t('元に戻す', 'Undo'), run: undo } });
}

function addMenuItems(at = null) {
  return [
    { label: t('熟語・語彙', 'Word'), icon: 'add', hint: 'N', run: () => addWord.open(at) },
    { label: t('親漢字', 'Kanji'), icon: 'add', hint: 'K', run: () => addKanji.open(at) },
  ];
}

// Right-click (mouse) or long-press (touch) on a node or on empty map.
function showContextMenu(nodeId, clientX, clientY, world) {
  const node = nodeId && store.graph.node(nodeId);
  let items;
  if (node) {
    items = [
      { heading: escapeHtml(node.label) },
      { label: t('詳細を表示', 'Open'), icon: 'search', run: () => select(node.id, { center: isCompact() }) },
      { label: t('編集', 'Edit'), icon: 'edit', run: () => select(node.id, { edit: true }) },
      ...(node.kind === 'word' ? [{ label: t('ここからリンク接続', 'Link from here'), icon: 'link', run: () => startLink(node.id) }] : []),
      { label: t('中央に表示', 'Center'), icon: 'center', run: () => canvas.focusOn(node.x, node.y) },
      isPinned(store.doc, node.id)
        ? { label: t('固定を解除', 'Unpin'), icon: 'unpin', run: () => togglePin(node.id) }
        : { label: t('ここに固定', 'Pin here'), icon: 'pin', run: () => togglePin(node.id) },
      { separator: true },
      { label: t('削除', 'Delete'), icon: 'delete', danger: true, run: () => deleteNode(ctx, node) },
    ];
  } else {
    items = [
      { label: t('ここに熟語を追加', 'Add word here'), icon: 'add', hint: 'N', run: () => addWord.open(world) },
      { label: t('ここに漢字を追加', 'Add kanji here'), icon: 'add', hint: 'K', run: () => addKanji.open(world) },
      { separator: true },
      { label: t('全体を表示', 'Show everything'), icon: 'fit', run: () => canvas.fit() },
      { label: t('マップを整える', 'Tidy up'), icon: 'tidy', run: arrange },
    ];
  }
  openMenu({ x: clientX, y: clientY, items });
}

// ---------------------------------------------------------------------------
// Header (desktop & tablet)
// ---------------------------------------------------------------------------
$('btn-add-menu').addEventListener('click', (e) => toggleMenu({ anchor: e.currentTarget, items: addMenuItems() }));
$('btn-view-menu').addEventListener('click', (e) => toggleMenu({ anchor: e.currentTarget, items: viewMenuItems(), align: 'end' }));
$('btn-undo').addEventListener('click', undo);
$('m-btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);

$('btn-exit-link-mode').addEventListener('click', () => setLinkMode(false));
$('link-mode-types').addEventListener('click', (e) => {
  const type = e.target.closest('[data-lm-type]')?.dataset.lmType;
  if (type) {
    view.activeLinkType = type;
    renderLinkModeBar();
  }
});

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

// Keyboard: Ctrl/⌘+Z / Y undo-redo, "/" search, N add word, K add kanji, Esc back out.
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
    return;
  }
  if (isTyping() || anyModalOpen() || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === '/' && !isCompact()) {
    e.preventDefault();
    $('map-search-input').focus();
  } else if (k === 'n') {
    e.preventDefault();
    addWord.open();
  } else if (k === 'k') {
    e.preventDefault();
    addKanji.open();
  } else if (e.key === 'Escape') {
    closeMenu();
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
  (which === 'word' ? addWord : addKanji).open();
});

// Same commands as the desktop View menu, as a bottom sheet.
function renderToolsSheet() {
  const toggles = VIEW_TOGGLES.map(
    ([key, ic, ja, en]) =>
      `<button type="button" class="menu-row${view[key] ? ' on' : ''}" data-tool-toggle="${key}"><span class="row-label">${icon(ic)}${t(ja, en)}</span><span class="switch"></span></button>`
  ).join('');
  const action = (id, ic, ja, en, disabled = false) =>
    `<button type="button" class="menu-row" data-tool="${id}" ${disabled ? 'disabled' : ''}><span class="row-label">${icon(ic)}${t(ja, en)}</span></button>`;
  $('map-tools-list').innerHTML =
    toggles +
    action('link', 'link', 'リンク接続モード', 'Link mode') +
    action('fit', 'fit', '全体を表示', 'Show everything') +
    action('arrange', 'tidy', 'マップを整える', 'Tidy up') +
    action('unpin', 'unpin', 'すべての固定を解除', 'Unpin all', !hasPins()) +
    action('redo', 'redo', 'やり直す', 'Redo', !store.canRedo);
}
$('m-btn-tools').addEventListener('click', () => {
  renderToolsSheet();
  openModal('modal-map-tools');
});
$('map-tools-list').addEventListener('click', (e) => {
  const key = e.target.closest('[data-tool-toggle]')?.dataset.toolToggle;
  if (key) {
    toggle(key);
    return renderToolsSheet();
  }
  const tool = e.target.closest('[data-tool]')?.dataset.tool;
  if (!tool) return;
  closeModal('modal-map-tools');
  if (tool === 'link') setLinkMode(true);
  else if (tool === 'fit') canvas.fit();
  else if (tool === 'arrange') arrange();
  else if (tool === 'unpin') unpinEverything();
  else if (tool === 'redo') redo();
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
  icon: 'sync',
  ja: '未登録漢字・派生語リンクを再スキャン',
  en: 'Rescan missing kanji & derivative links',
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
  tidy(store.doc);
  store.commit('layout');
} else if (placeMissing(store.doc, { x: 0, y: 0 })) {
  store.commit('layout');
}
renderAll();
renderLinkModeBar();

// Where the map opens: a deep link wins, then the last position on this device; on a
// first visit on a touch device, the biggest cluster at a zoom where nodes are easy to tap.
function savedCamera() {
  try {
    // (falls back to the pre-maps single key for the migrated map)
    const cam = JSON.parse(localStorage.getItem(cameraKey()) || (store.currentMap?.id === store.workspace.legacyMapId ? localStorage.getItem(CAMERA_KEY) : null) || 'null');
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
} else if (isTouch()) {
  readableStart(); // phones and tablets: tappable nodes beat seeing everything
} else {
  canvas.fit({ animate: false });
}
