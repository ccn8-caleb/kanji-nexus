// Map switcher (header) and "Manage maps" dialog — shared by every page.
//
// A map is a separate graph: its own words, kanji, links and layout. Drill progress
// is shared by spelling, so the same word in two maps is one card.

import { store } from './store.js';
import { t } from './prefs.js';
import { escapeHtml } from './util.js';
import { icon } from './icons.js';
import { toast, openModal, closeModal, toggleMenu } from './ui.js';
import { BUILD } from './version.js';
import { bundleText } from './schema.js';

// Anki import loads on demand (it brings a SQLite reader).
export function openAnkiImport(options = {}) {
  import(`../import/anki-ui.js?v=${BUILD}`)
    .then((m) => m.openAnkiImport(options))
    .catch((err) => {
      console.error(err);
      toast(t('インポート機能を読み込めませんでした', 'Could not load the importer'));
    });
}

// Clean-up tool loads on demand too.
export function openCleanup() {
  import(`../cleanup/ui.js?v=${BUILD}`)
    .then((m) => m.openCleanup())
    .catch((err) => {
      console.error(err);
      toast(t('整理ツールを読み込めませんでした', 'Could not load the clean-up tool'));
    });
}

export function renderMapSwitcher() {
  const brand = document.querySelector('.brand-group');
  if (!brand) return;
  let btn = document.getElementById('map-switcher');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'map-switcher';
    btn.className = 'map-switcher';
    btn.setAttribute('data-menu-anchor', '');
    btn.setAttribute('aria-haspopup', 'menu');
    brand.querySelector('.brand-title')?.after(btn);
    btn.addEventListener('click', () => toggleMenu({ anchor: btn, items: switcherItems() }));
  }
  const name = store.currentMap?.name || '';
  btn.title = t('マップを切り替え', 'Switch map');
  btn.innerHTML = `<span class="map-switcher-name">${escapeHtml(name)}</span>${icon('chevronDown')}`;
}

function switcherItems() {
  const current = store.currentMap?.id;
  return [
    { heading: t('マップ', 'Maps') },
    ...store.maps.map((m) => ({
      label: `${escapeHtml(m.name)} <span class="menu-count">${m.words}</span>`,
      checked: m.id === current,
      run: () => store.switchMap(m.id),
    })),
    { separator: true },
    { label: t('新しいマップ', 'New map'), icon: 'add', run: newMap },
    { label: t('Ankiデッキを読み込む…', 'Import Anki deck…'), icon: 'fileUp', run: () => openAnkiImport() },
    { label: t('このマップを整理…', 'Clean up this map…'), icon: 'tidy', run: openCleanup },
    { label: t('マップを管理…', 'Manage maps…'), icon: 'tools', run: openManageMaps },
  ];
}

async function newMap() {
  const name = prompt(t('新しいマップの名前', 'Name for the new map'), t('新しいマップ', 'New map'));
  if (name === null) return;
  await store.createMap(name);
  toast(t(`「${store.currentMap.name}」を作成しました`, `Created "${store.currentMap.name}"`));
}

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export const fileStamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
export const safeFileName = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'map';

export async function downloadMap(id) {
  const meta = store.maps.find((m) => m.id === id);
  const doc = await store.getMapDoc(id);
  download(`kanji_nexus_${safeFileName(meta.name)}_${fileStamp()}.json`, bundleText(doc, { name: meta.name }));
}

export async function downloadAllMaps() {
  const ws = await store.exportWorkspace();
  download(`kanji_nexus_all_maps_${fileStamp()}.json`, JSON.stringify(ws));
}

// ---------------------------------------------------------------------------
// Manage maps dialog
// ---------------------------------------------------------------------------
export function openManageMaps() {
  let el = document.getElementById('maps-dialog');
  if (!el) {
    el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.id = 'maps-dialog';
    document.body.appendChild(el);
    el.addEventListener('click', onClick);
    el.addEventListener('change', onRename);
    el.addEventListener('keydown', (e) => e.key === 'Enter' && e.target.matches('[data-rename]') && e.target.blur());
  }
  renderManage(el);
  openModal('maps-dialog');
}

function renderManage(el = document.getElementById('maps-dialog')) {
  if (!el) return;
  const current = store.currentMap?.id;
  const date = (ms) => new Date(ms).toLocaleDateString();
  el.innerHTML = `
    <div class="modal-card wide">
      <div class="modal-title">
        <span class="title-with-icon">${icon('map')}${t('マップを管理', 'Manage maps')}</span>
        <button type="button" class="icon-btn small" data-close-modal="maps-dialog" aria-label="Close">${icon('close')}</button>
      </div>
      <p class="panel-note">${t(
        '各マップは独立したグラフです。復習ドリルの進捗は表記ごとに共有されるので、同じ語が複数のマップにあっても1枚のカードになります。',
        'Each map is a separate graph. Drill progress is shared by spelling, so a word that appears in several maps is still one card.'
      )}</p>
      <div class="map-list">${store.maps
        .map(
          (m) => `
        <div class="map-row${m.id === current ? ' current' : ''}" data-map="${m.id}">
          <div class="map-row-main">
            <input class="field-input map-name" data-rename="${m.id}" value="${escapeHtml(m.name)}" aria-label="${t('名前', 'Name')}">
            <span class="muted">${t(`漢字 ${m.kanji}・語彙 ${m.words}・${date(m.updatedAt)}`, `${m.kanji} kanji · ${m.words} words · ${date(m.updatedAt)}`)}</span>
          </div>
          <div class="map-row-actions">
            ${m.id === current ? `<span class="current-badge">${t('表示中', 'Open')}</span>` : `<button type="button" class="tb-btn small" data-open="${m.id}">${t('開く', 'Open')}</button>`}
            <button type="button" class="icon-btn small" data-duplicate="${m.id}" title="${t('複製', 'Duplicate')}" aria-label="${t('複製', 'Duplicate')}">${icon('copy')}</button>
            <button type="button" class="icon-btn small" data-download="${m.id}" title="${t('ファイルに保存', 'Download')}" aria-label="${t('ファイルに保存', 'Download')}">${icon('fileDown')}</button>
            <button type="button" class="icon-btn small danger" data-delete="${m.id}" title="${t('削除', 'Delete')}" aria-label="${t('削除', 'Delete')}">${icon('delete')}</button>
          </div>
        </div>`
        )
        .join('')}</div>
      <div class="modal-actions">
        <button type="button" class="tb-btn" data-anki>${icon('fileUp')}${t('Ankiデッキを読み込む', 'Import Anki deck')}</button>
        <button type="button" class="tb-btn" data-all>${icon('fileDown')}${t('すべて保存', 'Download all')}</button>
        <button type="button" class="tb-btn primary" data-new>${icon('add')}${t('新しいマップ', 'New map')}</button>
      </div>
    </div>`;
}

async function onClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.open) {
    await store.switchMap(b.dataset.open);
    closeModal('maps-dialog');
  } else if (b.dataset.duplicate) {
    await store.duplicateMap(b.dataset.duplicate);
    renderManage();
  } else if (b.dataset.download) {
    downloadMap(b.dataset.download);
  } else if (b.dataset.delete) {
    const meta = store.maps.find((m) => m.id === b.dataset.delete);
    if (!confirm(t(`マップ「${meta.name}」を削除しますか？（元に戻せません。必要なら先にファイルに保存してください）`, `Delete the map "${meta.name}"? This can't be undone — download it first if you want a copy.`))) return;
    await store.deleteMap(meta.id);
    toast(t(`「${meta.name}」を削除しました`, `Deleted "${meta.name}"`));
    renderManage();
  } else if ('new' in b.dataset) {
    closeModal('maps-dialog');
    newMap();
  } else if ('all' in b.dataset) {
    downloadAllMaps();
  } else if ('anki' in b.dataset) {
    closeModal('maps-dialog');
    openAnkiImport();
  }
}

async function onRename(e) {
  const id = e.target.dataset.rename;
  if (!id) return;
  await store.renameMap(id, e.target.value);
  renderManage();
}

// Keep the switcher label and an open dialog current.
store.subscribe(({ reason }) => {
  if (['switch', 'maps', 'replace', 'external'].includes(reason)) {
    renderMapSwitcher();
    if (document.getElementById('maps-dialog')?.classList.contains('open')) renderManage();
  }
});
