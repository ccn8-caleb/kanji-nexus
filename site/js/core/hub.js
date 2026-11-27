// Page shell shared by every mini-app: navigation hotbar, language/theme controls,
// the Data panel (backup, transfer/sync plugins, reset), and deep-link focus.
//
// Every page's entry module starts with:
//   const { source, focusId } = await initPage('map');
//
// To add a mini-app, add it to APPS and create <file> with the same header slots.
// To add a sync/transfer method, add a plugin to js/sync/index.js.

import { store } from './store.js';
import { escapeHtml } from './util.js';
import { t, tr, isEn, setLang, getLang, toggleTheme, onPrefsChange, applyStaticText } from './prefs.js';
import { toast, openModal, closeModal, initTooltips } from './ui.js';
import { registerServiceWorker, installAvailable, promptInstall, onInstallAvailable } from './pwa.js';
import plugins from '../sync/index.js';
import { icon, hydrateIcons } from './icons.js';
import { renderMapSwitcher, openManageMaps, openAnkiImport, downloadMap, downloadAllMaps } from './maps-ui.js';
import { choose } from './ui.js';
import { APP_VERSION, BUILD, CHANGELOG_URL, versionLabel } from './version.js';

export const APPS = [
  { id: 'map', ja: 'マップ', en: 'Map', tipJa: '漢字・熟語ネットワーク図', tipEn: 'Kanji & Compound Network Map', file: 'index.html', icon: 'map' },
  { id: 'stats', ja: '統計・索引', en: 'Stats & Index', tipJa: '統計ダッシュボードと五十音索引', tipEn: 'Statistics & Kana Index', file: 'stats.html', icon: 'stats' },
  { id: 'drill', ja: '復習ドリル', en: 'SRS Drill', tipJa: '間隔反復フラッシュカード練習', tipEn: 'Spaced Repetition Flashcard Drill', file: 'drill.html', icon: 'drill' },
];

let currentApp = null;

// ---------------------------------------------------------------------------
// Navigation & deep links (?focus=<node id>)
// ---------------------------------------------------------------------------
export function navigate(appId, { focusId, from } = {}) {
  const app = APPS.find((a) => a.id === appId) || APPS[0];
  const params = new URLSearchParams();
  if (focusId) params.set('focus', focusId);
  if (from) params.set('from', from);
  location.href = params.size ? `${app.file}?${params}` : app.file;
}

// from: 'drill' → the map shows a "Return to drill" button.
export const openInMap = (nodeId, { from } = {}) => navigate('map', { focusId: nodeId, from });

// ---------------------------------------------------------------------------
// "Return to drill": a map opened from a drill card keeps a button back to the same
// card (the drill saves its session). It lasts while you stay on the map, reloads
// included; opening any other page ends it.
// ---------------------------------------------------------------------------
const RETURN_KEY = 'kanji_nexus_return_to'; // sessionStorage (per tab)
export const DRILL_SESSION_KEY = 'kanji_nexus_drill_session';

function handleReturnTo(appId) {
  const url = new URL(location.href);
  const from = url.searchParams.get('from');
  if (from) {
    url.searchParams.delete('from');
    history.replaceState(null, '', url);
  }
  try {
    if (appId !== 'map') return sessionStorage.removeItem(RETURN_KEY);
    if (from === 'drill') sessionStorage.setItem(RETURN_KEY, 'drill');
    if (sessionStorage.getItem(RETURN_KEY) === 'drill') renderReturnToDrill();
  } catch (_) {}
}

function renderReturnToDrill() {
  let progress = '';
  try {
    const s = JSON.parse(localStorage.getItem(DRILL_SESSION_KEY) || 'null');
    if (s?.queue?.length) progress = ` <span class="return-progress">${s.done} / ${s.done + s.queue.length}</span>`;
  } catch (_) {}
  document.getElementById('return-to-drill')?.remove();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'return-to-drill';
  btn.className = 'return-to-drill';
  btn.innerHTML = `${icon('drill')}<span>${t('ドリルに戻る', 'Back to drill')}</span>${progress}`;
  btn.addEventListener('click', () => navigate('drill'));
  document.body.appendChild(btn);
}

function consumeFocusId() {
  const url = new URL(location.href);
  const id = url.searchParams.get('focus');
  if (id) {
    url.searchParams.delete('focus');
    history.replaceState(null, '', url);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Header: nav pills into #nexus-hub-slot, global controls into #nexus-hub-controls
// ---------------------------------------------------------------------------
function renderNav() {
  const slot = document.getElementById('nexus-hub-slot');
  if (!slot) return;
  slot.innerHTML = `<nav class="hub-nav" aria-label="Kanji Nexus">${APPS.map((app) => {
    const active = app.id === currentApp;
    return `<a class="hub-pill${active ? ' active' : ''}" href="${app.file}" ${active ? 'aria-current="page"' : ''}
      data-tip-ja="${app.tipJa}" data-tip-en="${app.tipEn}" aria-label="${tr(app)}">${icon(app.icon)}<span class="hub-pill-label">${tr(app)}</span></a>`;
  }).join('')}</nav>`;
  renderTabbar();
}

// Phones: navigation lives in a bottom tab bar; Data / language / theme in the ⋯ sheet.
function renderTabbar() {
  let bar = document.getElementById('hub-tabbar');
  if (!bar) {
    bar = document.createElement('nav');
    bar.id = 'hub-tabbar';
    bar.className = 'hub-tabbar';
    bar.setAttribute('aria-label', 'Kanji Nexus');
    document.body.appendChild(bar);
    bar.addEventListener('click', (e) => e.target.closest('#hub-tab-more') && openMoreSheet());
  }
  bar.innerHTML =
    APPS.map((app) => {
      const active = app.id === currentApp;
      return `<a class="hub-tab${active ? ' active' : ''}" href="${app.file}" ${active ? 'aria-current="page"' : ''}>
        <span class="hub-tab-icon">${icon(app.icon)}</span><span class="hub-tab-label">${tr(app)}</span></a>`;
    }).join('') +
    `<button type="button" class="hub-tab" id="hub-tab-more" aria-label="${t('その他', 'More')}">
       <span class="hub-tab-icon">${icon('more')}</span><span class="hub-tab-label">${t('その他', 'More')}</span></button>`;
  renderBadge();
}

function openMoreSheet() {
  let el = document.getElementById('hub-more-sheet');
  if (!el) {
    el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.id = 'hub-more-sheet';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-more]');
      if (!b) return;
      const what = b.dataset.more;
      if (what === 'data') {
        closeModal('hub-more-sheet');
        openDataPanel();
      } else if (what === 'theme') toggleTheme();
      else if (what === 'ja' || what === 'en') setLang(what);
      else if (what === 'install') promptInstall().then(() => closeModal('hub-more-sheet'));
      if (what !== 'data' && what !== 'install') openMoreSheet(); // re-render state
    });
  }
  el.innerHTML = `
    <div class="modal-card">
      <div class="modal-title"><span>${t('その他', 'More')}</span><button type="button" class="icon-btn small" data-close-modal="hub-more-sheet" aria-label="Close">${icon('close')}</button></div>
      <div class="menu-list">
        <button type="button" class="menu-row" data-more="data"><span class="row-label">${icon('data')}${t('データ・同期・バックアップ', 'Data, sync & backup')}</span>${badgeHtml()}</button>
        <div class="menu-row static"><span class="row-label">${icon('language')}${t('表示言語', 'Language')}</span>
          <div class="lang-switch"><button type="button" data-more="ja" class="${getLang() === 'ja' ? 'active' : ''}">日本語</button><button type="button" data-more="en" class="${getLang() === 'en' ? 'active' : ''}">EN</button></div>
        </div>
        <button type="button" class="menu-row" data-more="theme"><span class="row-label">${icon('theme')}${t('ライト/ダーク切替', 'Light / dark theme')}</span></button>
        ${installAvailable() ? `<button type="button" class="menu-row" data-more="install"><span class="row-label">${icon('install')}${t('ホーム画面に追加', 'Install app')}</span></button>` : ''}
      </div>
      ${versionFooter()}
    </div>`;
  openModal('hub-more-sheet');
}

function renderControls() {
  const slot = document.getElementById('nexus-hub-controls');
  if (!slot) return;
  slot.innerHTML = `
    <button type="button" class="tb-btn wide-only" id="hub-btn-data" data-tip-ja="同期・バックアップ・リセット" data-tip-en="Sync, backup & reset">${icon('data')}<span>${t('データ', 'Data')}</span></button>
    <div class="lang-switch wide-only" data-tip-ja="表示言語切替" data-tip-en="Switch Interface Language">
      <button type="button" data-set-lang="ja" class="${getLang() === 'ja' ? 'active' : ''}">日本語</button>
      <button type="button" data-set-lang="en" class="${getLang() === 'en' ? 'active' : ''}">EN</button>
    </div>
    <button type="button" class="icon-btn wide-only" id="hub-btn-theme" aria-label="Theme" data-tip-ja="ライト/ダークテーマ切替" data-tip-en="Toggle Light / Dark Theme">${icon('theme')}</button>
    <button type="button" class="icon-btn narrow-only" id="hub-btn-more" aria-label="${t('その他', 'More')}" data-tip-ja="データ・言語・テーマ" data-tip-en="Data, language & theme">${icon('more')}</button>`;
  slot.querySelector('#hub-btn-data').addEventListener('click', openDataPanel);
  renderBadge();
  slot.querySelector('#hub-btn-theme').addEventListener('click', toggleTheme);
  slot.querySelector('#hub-btn-more').addEventListener('click', openMoreSheet);
  slot.querySelectorAll('[data-set-lang]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.setLang)));
}

// ---------------------------------------------------------------------------
// Data panel
// ---------------------------------------------------------------------------
// Pages and plugins contribute buttons:
//   { id, section: 'sync' | 'transfer' | 'tools', ja, en, run(ctx),
//     label?(): string,     // dynamic text instead of ja/en
//     hidden?(): boolean,   // e.g. "Disconnect" only while connected
//     primary?(): boolean }
const dataActions = [];
export function registerDataAction(action) {
  dataActions.push(action);
}

const SECTIONS = [
  { id: 'sync', ja: 'クラウド同期', en: 'Cloud sync' },
  { id: 'import', ja: 'インポート', en: 'Import' },
  { id: 'transfer', ja: '端末間の転送', en: 'Move to another device' },
  { id: 'tools', ja: 'メンテナンス', en: 'Maintenance' },
];

// Sync status shown on the Data button (badge) and in the panel (detail).
// tone: 'ok' | 'busy' | 'warn' | 'error'
let syncStatus = null;
export function setSyncStatus(status) {
  syncStatus = status;
  renderBadge();
  refreshDataPanel();
}

// Status icon per tone: synced, syncing (spins), needs attention, error/offline.
const BADGE_ICONS = { ok: 'cloudOk', busy: 'loading', warn: 'alert', error: 'cloudOff' };
function badgeHtml() {
  if (!syncStatus?.tone) return '';
  return `<span class="sync-badge ${syncStatus.tone}" data-state="${syncStatus.tone}" title="${(syncStatus.detail || '').replace(/"/g, '&quot;')}">${icon(BADGE_ICONS[syncStatus.tone] || 'cloud')}</span>`;
}
function renderBadge() {
  for (const id of ['hub-btn-data', 'hub-tab-more', 'hub-btn-more']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.querySelector('.sync-badge')?.remove();
    btn.insertAdjacentHTML('beforeend', badgeHtml());
  }
}

export function refreshDataPanel() {
  if (document.getElementById('hub-data-panel')?.classList.contains('open')) openDataPanel();
}

const pluginCtx = {
  store,
  toast,
  t,
  closePanel: () => closeModal('hub-data-panel'),
  refreshPanel: refreshDataPanel,
  setSyncStatus,
};

// Loading data: a file with all maps adds each as a new map; a single map (or an old
// backup) asks whether to add it as a new map or replace the open one.
export async function importBundle(parsed, { fallbackName = '', ask = true } = {}) {
  if (parsed?.kind === 'kanji-nexus-workspace' && Array.isArray(parsed.maps)) {
    for (const m of parsed.maps) await store.importAsNewMap(m, m.name, { switchTo: false });
    toast(t(`${parsed.maps.length} 個のマップを追加しました`, `Added ${parsed.maps.length} map(s)`));
    return true;
  }
  const name = parsed?.name || fallbackName || t('インポート', 'Import');
  const choice = ask
    ? await choose({
        title: t('データの読み込み', 'Load data'),
        message: t(`「${name}」をどう読み込みますか？`, `How should "${name}" be loaded?`),
        options: [
          { id: 'new', label: t('新しいマップとして追加', 'Add as a new map'), tone: 'primary' },
          { id: 'replace', label: t(`「${store.currentMap?.name}」を置き換え`, `Replace "${store.currentMap?.name}"`), tone: 'danger' },
        ],
      })
    : 'new';
  if (choice === 'new') {
    await store.importAsNewMap(parsed, name);
    toast(t(`マップ「${store.currentMap.name}」を追加しました`, `Added map "${store.currentMap.name}"`));
  } else if (choice === 'replace') {
    store.importData(parsed);
    toast(t('データを読み込みました（元に戻せます）', 'Data loaded (undo available)'));
  } else return false;
  return true;
}

async function importText(text, opts) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    alert(t('JSONの解析に失敗しました: ', 'Could not parse JSON: ') + err.message);
    return false;
  }
  return importBundle(parsed, opts);
}

function buildDataPanel() {
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.id = 'hub-data-panel';
  document.body.appendChild(el);
  return el;
}

const visibleActions = (section) => dataActions.filter((a) => a.section === section && !a.hidden?.());

function sectionHtml(section) {
  const actions = visibleActions(section.id);
  if (!actions.length) return '';
  const detail = section.id === 'sync' && syncStatus?.detail ? `<p class="panel-note sync-detail ${syncStatus.tone || ''}">${syncStatus.detail}</p>` : '';
  const buttons = actions
    .map((a) => `<button type="button" class="tb-btn${a.primary?.() ? ' primary' : ''}" data-hub-action="${a.id}">${a.icon ? icon(a.icon) : ''}${a.label ? a.label() : tr(a)}</button>`)
    .join('');
  return `
      <div class="field-group">
        <label class="field-label">${tr(section)}</label>
        ${detail}
        <div class="chip-row">${buttons}</div>
      </div>`;
}

export function openDataPanel() {
  const el = document.getElementById('hub-data-panel') || buildDataPanel();
  const g = store.graph;
  el.innerHTML = `
    <div class="modal-card wide">
      <div class="modal-title">
        <span class="title-with-icon">${icon('data')}${t('データ管理', 'Your Data')}</span>
        <button type="button" class="icon-btn small" data-close-modal="hub-data-panel" aria-label="Close">${icon('close')}</button>
      </div>
      <p class="panel-note">${t(
        `データはこのブラウザに保存されています。表示中のマップ「${escapeHtml(store.currentMap?.name || '')}」：漢字 ${g.kanji.size}・語彙 ${g.words.size}（全 ${store.maps.length} マップ）。他の端末へ移すにはクラウド同期・転送リンク・バックアップファイルを使ってください。`,
        `Your data lives in this browser. Open map "${escapeHtml(store.currentMap?.name || '')}": ${g.kanji.size} kanji · ${g.words.size} words (${store.maps.length} map(s) in total). Use cloud sync, a transfer link, or a backup file to move it to another device.`
      )}</p>

      <div class="field-group">
        <label class="field-label">${t('バックアップ', 'Backup')}</label>
        <div class="chip-row">
          <button type="button" class="tb-btn primary" id="hub-export">${icon('fileDown')}${t('このマップを保存', 'Download this map')}</button>
          <button type="button" class="tb-btn" id="hub-export-all">${icon('fileDown')}${t('すべてのマップを保存', 'Download all maps')}</button>
          <label class="tb-btn">${icon('fileUp')}${t('ファイルから読込', 'Load .json')}<input type="file" id="hub-import-file" accept=".json,application/json" hidden></label>
          <button type="button" class="tb-btn" id="hub-manage-maps">${icon('map')}${t('マップを管理', 'Manage maps')}</button>
        </div>
      </div>

      ${SECTIONS.map(sectionHtml).join('')}

      <div class="field-group">
        <label class="field-label">${t('サンプル・初期化', 'Sample & reset')}</label>
        <div class="chip-row">
          <button type="button" class="tb-btn" id="hub-reset-starter">${icon('reset')}${t('このマップをサンプルに戻す', 'Reset this map to the sample')}</button>
          <button type="button" class="tb-btn danger" id="hub-wipe">${icon('delete')}${t('このマップを空にする', 'Empty this map')}</button>
        </div>
      </div>

      <details class="field-group">
        <summary class="field-label">${t('生JSONを直接編集', 'Edit raw JSON')}</summary>
        <textarea id="hub-json-text" class="field-textarea mono" spellcheck="false"></textarea>
        <div class="modal-actions"><button type="button" class="tb-btn primary" id="hub-json-apply">${t('テキストから適用', 'Apply text')}</button></div>
      </details>
      ${versionFooter()}
    </div>`;

  const textArea = el.querySelector('#hub-json-text');
  el.querySelector('details').addEventListener('toggle', (e) => {
    if (e.target.open) textArea.value = store.exportText();
  });
  el.querySelector('#hub-json-apply').addEventListener('click', async () => {
    if (await importText(textArea.value)) closeModal('hub-data-panel');
  });
  el.querySelector('#hub-export').addEventListener('click', () => downloadMap(store.currentMap.id));
  el.querySelector('#hub-export-all').addEventListener('click', downloadAllMaps);
  el.querySelector('#hub-manage-maps').addEventListener('click', () => {
    closeModal('hub-data-panel');
    openManageMaps();
  });
  el.querySelector('#hub-import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file && (await importText(await file.text(), { fallbackName: file.name.replace(/\.json$/i, '') }))) closeModal('hub-data-panel');
  });
  el.querySelector('#hub-reset-starter').addEventListener('click', async () => {
    if (!confirm(t('このマップをサンプルデータに戻しますか？（元に戻せます）', 'Reset this map to the sample data? (Undo is available.)'))) return;
    try {
      await store.resetToStarter();
      closeModal('hub-data-panel');
      toast(t('サンプルデータを読み込みました', 'Sample data loaded'));
    } catch (err) {
      alert(err.message);
    }
  });
  el.querySelector('#hub-wipe').addEventListener('click', () => {
    if (!confirm(t('このマップの漢字と語彙をすべて消去しますか？', 'Erase all kanji and words in this map?'))) return;
    store.wipe();
    closeModal('hub-data-panel');
    toast(t('データを消去しました', 'All data erased'));
  });
  el.querySelectorAll('[data-hub-action]').forEach((btn) => {
    const action = dataActions.find((a) => a.id === btn.dataset.hubAction);
    btn.addEventListener('click', () => action.run(pluginCtx));
    // Note: plugin run() may be async; errors are the plugin's to report.
  });
  openModal('hub-data-panel');
}

// ---------------------------------------------------------------------------
// Version: footer line, one-time "updated" notice, debugging handle
// ---------------------------------------------------------------------------
function versionFooter() {
  return `<div class="app-version">Kanji Nexus ${versionLabel()} · <a href="${CHANGELOG_URL}" target="_blank" rel="noopener noreferrer">${t('変更履歴', 'Changelog')}</a>
    <br>${t('辞書データ', 'Dictionary data')}: <a href="https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project" target="_blank" rel="noopener noreferrer">JMdict</a> © <a href="https://www.edrdg.org/edrdg/licence.html" target="_blank" rel="noopener noreferrer">EDRDG, CC BY-SA 4.0</a></div>`;
}

const SEEN_VERSION_KEY = 'kanji_nexus_seen_version';
function announceUpdate() {
  window.KANJI_NEXUS_VERSION = { version: APP_VERSION, build: BUILD };
  console.info(`Kanji Nexus ${versionLabel()}`);
  if (BUILD === 'dev') return;
  let previous = null;
  try {
    previous = localStorage.getItem(SEEN_VERSION_KEY);
    localStorage.setItem(SEEN_VERSION_KEY, APP_VERSION);
  } catch (_) {}
  // First visit ever: nothing to announce. Only a change of app version is news.
  if (previous && previous !== APP_VERSION) {
    toast(t(`v${APP_VERSION} に更新されました`, `Updated to v${APP_VERSION}`), {
      action: { label: t('変更点', "What's new"), run: () => window.open(CHANGELOG_URL, '_blank', 'noopener') },
    });
  }
}

// ---------------------------------------------------------------------------
// Page bootstrap
// ---------------------------------------------------------------------------
export async function initPage(appId) {
  currentApp = appId;
  const render = () => {
    renderNav();
    renderControls();
    applyStaticText();
    hydrateIcons();
    if (store.currentMap) renderMapSwitcher();
    if (document.getElementById('return-to-drill')) renderReturnToDrill(); // new language
  };
  render();
  onPrefsChange((what) => what === 'lang' && render());
  onInstallAvailable(() => document.getElementById('hub-more-sheet')?.classList.contains('open') && openMoreSheet());
  initTooltips();
  registerServiceWorker();
  announceUpdate();

  const source = await store.load();
  window.KANJI_NEXUS = { ...(window.KANJI_NEXUS || {}), store }; // console/debugging handle
  renderMapSwitcher();
  registerDataAction({ id: 'anki', section: 'import', icon: 'fileUp', ja: 'Ankiデッキを読み込む（.apkg / テキスト）', en: 'Import Anki deck (.apkg / text)', run: ({ closePanel }) => (closePanel(), openAnkiImport()) });
  if (source === 'legacy') toast(t('以前のデータを新しい形式に移行しました', 'Migrated your data to the new format'));
  if (source === 'local') toast(t('データを「マイマップ」に移しました（複数マップに対応）', 'Your data is now the map "マイマップ" (multiple maps supported)'));
  if (source === 'empty') toast(t('サンプルデータを読み込めませんでした', 'Could not load the sample data'));

  for (const plugin of plugins) {
    try {
      await plugin.install?.({ ...pluginCtx, registerDataAction, isEn });
    } catch (err) {
      console.warn(`[hub] plugin ${plugin.id} failed`, err);
    }
  }

  handleReturnTo(appId);
  return { source, focusId: consumeFocusId(), store };
}
