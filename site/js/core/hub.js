// Page shell shared by every mini-app: navigation hotbar, language/theme controls,
// the Data panel (backup, transfer/sync plugins, reset), and deep-link focus.
//
// Every page's entry module starts with:
//   const { source, focusId } = await initPage('map');
//
// To add a mini-app, add it to APPS and create <file> with the same header slots.
// To add a sync/transfer method, add a plugin to js/sync/index.js.

import { store } from './store.js';
import { t, tr, isEn, setLang, getLang, toggleTheme, onPrefsChange, applyStaticText } from './prefs.js';
import { toast, openModal, closeModal, initTooltips } from './ui.js';
import { registerServiceWorker, installAvailable, promptInstall, onInstallAvailable } from './pwa.js';
import plugins from '../sync/index.js';
import { APP_VERSION, BUILD, CHANGELOG_URL, versionLabel } from './version.js';

export const APPS = [
  { id: 'map', ja: 'マップ', en: 'Map', tipJa: '漢字・熟語ネットワーク図', tipEn: 'Kanji & Compound Network Map', file: 'index.html', icon: '🕸️' },
  { id: 'stats', ja: '統計・索引', en: 'Stats & Index', tipJa: '統計ダッシュボードと五十音索引', tipEn: 'Statistics & Kana Index', file: 'stats.html', icon: '📊' },
  { id: 'drill', ja: '復習ドリル', en: 'SRS Drill', tipJa: '間隔反復フラッシュカード練習', tipEn: 'Spaced Repetition Flashcard Drill', file: 'drill.html', icon: '🎴' },
];

let currentApp = null;

// ---------------------------------------------------------------------------
// Navigation & deep links (?focus=<node id>)
// ---------------------------------------------------------------------------
export function navigate(appId, { focusId } = {}) {
  const app = APPS.find((a) => a.id === appId) || APPS[0];
  location.href = focusId ? `${app.file}?focus=${encodeURIComponent(focusId)}` : app.file;
}

export const openInMap = (nodeId) => navigate('map', { focusId: nodeId });

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
      data-tip-ja="${app.tipJa}" data-tip-en="${app.tipEn}"><span aria-hidden="true">${app.icon}</span><span>${tr(app)}</span></a>`;
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
        <span class="hub-tab-icon" aria-hidden="true">${app.icon}</span><span class="hub-tab-label">${tr(app)}</span></a>`;
    }).join('') +
    `<button type="button" class="hub-tab" id="hub-tab-more" aria-label="${t('その他', 'More')}">
       <span class="hub-tab-icon" aria-hidden="true">⋯</span><span class="hub-tab-label">${t('その他', 'More')}</span></button>`;
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
      <div class="modal-title"><span>${t('その他', 'More')}</span><button type="button" class="tb-btn" data-close-modal="hub-more-sheet">✕</button></div>
      <div class="menu-list">
        <button type="button" class="menu-row" data-more="data"><span>💾 ${t('データ・同期・バックアップ', 'Data, sync & backup')}</span>${syncStatus?.badge ? `<span class="sync-badge ${syncStatus.tone || ''}">${syncStatus.badge}</span>` : ''}</button>
        <div class="menu-row static"><span>🌐 ${t('表示言語', 'Language')}</span>
          <div class="lang-switch"><button type="button" data-more="ja" class="${getLang() === 'ja' ? 'active' : ''}">日本語</button><button type="button" data-more="en" class="${getLang() === 'en' ? 'active' : ''}">EN</button></div>
        </div>
        <button type="button" class="menu-row" data-more="theme"><span>🌓 ${t('ライト/ダーク切替', 'Light / dark theme')}</span></button>
        ${installAvailable() ? `<button type="button" class="menu-row" data-more="install"><span>📲 ${t('ホーム画面に追加', 'Install app')}</span></button>` : ''}
      </div>
      ${versionFooter()}
    </div>`;
  openModal('hub-more-sheet');
}

function renderControls() {
  const slot = document.getElementById('nexus-hub-controls');
  if (!slot) return;
  slot.innerHTML = `
    <button type="button" class="tb-btn" id="hub-btn-data" data-tip-ja="バックアップ・転送・リセット" data-tip-en="Backup, Transfer & Reset">💾 ${t('データ', 'Data')}</button>
    <div class="lang-switch" data-tip-ja="表示言語切替" data-tip-en="Switch Interface Language">
      <button type="button" data-set-lang="ja" class="${getLang() === 'ja' ? 'active' : ''}">日本語</button>
      <button type="button" data-set-lang="en" class="${getLang() === 'en' ? 'active' : ''}">EN</button>
    </div>
    <button type="button" class="tb-btn" id="hub-btn-theme" data-tip-ja="ライト/ダークテーマ切替" data-tip-en="Toggle Light / Dark Theme">🌓</button>`;
  slot.querySelector('#hub-btn-data').addEventListener('click', openDataPanel);
  renderBadge();
  slot.querySelector('#hub-btn-theme').addEventListener('click', toggleTheme);
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

function renderBadge() {
  for (const btn of [document.getElementById('hub-btn-data'), document.getElementById('hub-tab-more')]) {
    if (!btn) continue;
    btn.querySelector('.sync-badge')?.remove();
    if (!syncStatus?.badge) continue;
    const badge = document.createElement('span');
    badge.className = `sync-badge ${syncStatus.tone || ''}`;
    badge.textContent = syncStatus.badge;
    badge.title = syncStatus.detail || '';
    btn.appendChild(badge);
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

function downloadBackup() {
  const blob = new Blob([store.exportText()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kanji_nexus_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importText(text, { confirmFirst = false } = {}) {
  try {
    const parsed = JSON.parse(text);
    if (confirmFirst && !confirm(t('現在のデータを置き換えますか？', 'Replace your current data?'))) return false;
    store.importData(parsed);
    toast(t('データを読み込みました', 'Data loaded'));
    return true;
  } catch (err) {
    alert(t('JSONの解析に失敗しました: ', 'Could not parse JSON: ') + err.message);
    return false;
  }
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
    .map((a) => `<button type="button" class="tb-btn${a.primary?.() ? ' primary' : ''}" data-hub-action="${a.id}">${a.label ? a.label() : tr(a)}</button>`)
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
        <span>💾 ${t('データ管理', 'Your Data')}</span>
        <button type="button" class="tb-btn" data-close-modal="hub-data-panel">✕</button>
      </div>
      <p class="panel-note">${t(
        `データはこのブラウザに保存されています（漢字 ${g.kanji.size}・語彙 ${g.words.size}）。他の端末へ移すにはクラウド同期・転送リンク・バックアップファイルを使ってください。`,
        `Your data lives in this browser (${g.kanji.size} kanji · ${g.words.size} words). Use cloud sync, a transfer link, or a backup file to move it to another device.`
      )}</p>

      <div class="field-group">
        <label class="field-label">${t('バックアップ', 'Backup')}</label>
        <div class="chip-row">
          <button type="button" class="tb-btn primary" id="hub-export">⬇ ${t('ファイルに保存', 'Download .json')}</button>
          <label class="tb-btn">⬆ ${t('ファイルから読込', 'Load .json')}<input type="file" id="hub-import-file" accept=".json,application/json" hidden></label>
        </div>
      </div>

      ${SECTIONS.map(sectionHtml).join('')}

      <div class="field-group">
        <label class="field-label">${t('サンプル・初期化', 'Sample & reset')}</label>
        <div class="chip-row">
          <button type="button" class="tb-btn" id="hub-reset-starter">🌱 ${t('サンプルに戻す', 'Reset to sample')}</button>
          <button type="button" class="tb-btn danger" id="hub-wipe">🗑 ${t('すべて消去して空から始める', 'Erase all & start empty')}</button>
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
  el.querySelector('#hub-json-apply').addEventListener('click', () => {
    if (importText(textArea.value)) closeModal('hub-data-panel');
  });
  el.querySelector('#hub-export').addEventListener('click', downloadBackup);
  el.querySelector('#hub-import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file && importText(await file.text(), { confirmFirst: true })) closeModal('hub-data-panel');
  });
  el.querySelector('#hub-reset-starter').addEventListener('click', async () => {
    if (!confirm(t('サンプルデータに戻しますか？（現在のデータは置き換えられます）', 'Reset to the sample data? Your current data will be replaced.'))) return;
    try {
      await store.resetToStarter();
      closeModal('hub-data-panel');
      toast(t('サンプルデータを読み込みました', 'Sample data loaded'));
    } catch (err) {
      alert(err.message);
    }
  });
  el.querySelector('#hub-wipe').addEventListener('click', () => {
    if (!confirm(t('すべての漢字と語彙を消去しますか？', 'Erase all kanji and words?'))) return;
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
  return `<div class="app-version">Kanji Nexus ${versionLabel()} · <a href="${CHANGELOG_URL}" target="_blank" rel="noopener noreferrer">${t('変更履歴', 'Changelog')}</a></div>`;
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
  };
  render();
  onPrefsChange((what) => what === 'lang' && render());
  onInstallAvailable(() => document.getElementById('hub-more-sheet')?.classList.contains('open') && openMoreSheet());
  initTooltips();
  registerServiceWorker();
  announceUpdate();

  const source = await store.load();
  if (source === 'legacy') toast(t('以前のデータを新しい形式に移行しました', 'Migrated your data to the new format'));
  if (source === 'empty') toast(t('サンプルデータを読み込めませんでした', 'Could not load the sample data'));

  for (const plugin of plugins) {
    try {
      await plugin.install?.({ ...pluginCtx, registerDataAction, isEn });
    } catch (err) {
      console.warn(`[hub] plugin ${plugin.id} failed`, err);
    }
  }

  return { source, focusId: consumeFocusId(), store };
}
