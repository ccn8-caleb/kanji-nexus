// Sync plugin: keeps every map in the user's Google Drive (hidden app folder, scope
// drive.appdata). No server, no account on our side.
//
// Drive layout
//   kanji-nexus-index.json      { version, maps: { id: { name, fileId, updatedAt } }, deleted: { id: time } }
//   kanji-nexus-map-<id>.json   one bundle per map (only changed maps upload)
//   kanji-nexus.json            0.6.0–0.6.2 single file: adopted as the migrated map's file
//
// Flow
//   Connect     click → Google popup (consent the first time) → first sync
//   Auto-sync   while a token is valid: a few seconds after each edit, and when the
//               tab becomes visible again (to pick up changes from other devices)
//   Expired     tokens last ~1h and can't renew without a click; the Data button
//               shows an alert badge and "Sync now" signs in again
//   Conflicts   decided by content (see logic.js); when both sides changed the user
//               chooses which copy wins. Pulling is undoable with Ctrl+Z on the map.
//
// Drill (SRS) progress is not synced yet — only the maps.

import { GOOGLE_CLIENT_ID } from '../config.js';
import { normalize, bundleText } from '../../core/schema.js';
import { newMapId } from '../../core/store.js';
import { choose } from '../../core/ui.js';
import { onPrefsChange } from '../../core/prefs.js';
import { cachedToken, requestToken, revoke, clearToken, loadGis, AuthError } from './auth.js';
import * as drive from './drive.js';
import { decide, sha256 } from './logic.js';

const STATE_KEY = 'kanji_nexus_gdrive';
const AUTO_SYNC_DELAY_MS = 3000;

// state: { enabled, lastSync, indexFileId, maps: { mapId: { fileId, remoteVersion, baseHash } } }
// (0.6.x state { fileId, remoteVersion, baseHash } is migrated onto the migrated map.)
function loadState(store) {
  let raw = {};
  try {
    raw = JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {};
  } catch (_) {}
  const state = { enabled: Boolean(raw.enabled), lastSync: raw.lastSync || 0, indexFileId: raw.indexFileId || null, maps: raw.maps || {} };
  if (raw.fileId && !raw.maps) {
    const legacyId = store.workspace.legacyMapId || (store.maps.length === 1 ? store.maps[0].id : null);
    if (legacyId) state.maps[legacyId] = { fileId: raw.fileId, remoteVersion: raw.remoteVersion, baseHash: raw.baseHash };
  }
  return state;
}

const isSecureOrigin = () => location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

export function install(ctx) {
  const { store, t, toast, registerDataAction, setSyncStatus } = ctx;
  if (!GOOGLE_CLIENT_ID) return; // not configured for this deployment: show nothing

  if (!isSecureOrigin()) {
    registerDataAction({
      id: 'gdrive-https',
      section: 'sync',
      icon: 'cloud',
      ja: 'Google Drive同期（HTTPSで開く）',
      en: 'Google Drive sync (open over HTTPS)',
      run: () => (location.href = location.href.replace(/^http:/, 'https:')),
    });
    return;
  }

  let state = loadState(store);
  let running = false;
  let again = false;
  let applyingRemote = false;
  let timer = null;
  let untouchedSample = null;
  let pulled = [];

  const save = () => {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (_) {}
  };
  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const counts = (doc) => t(`漢字 ${Object.keys(doc.kanji).length}・語彙 ${Object.keys(doc.words).length}`, `${Object.keys(doc.kanji).length} kanji · ${Object.keys(doc.words).length} words`);

  // Remember the last status so it can be re-rendered in the new language.
  let lastStatus = () => setSyncStatus(null);
  const show = (fn) => (...args) => {
    lastStatus = () => fn(...args);
    lastStatus();
  };
  onPrefsChange((what) => what === 'lang' && lastStatus());

  const status = {
    off: () => setSyncStatus(null),
    ok: () => setSyncStatus({ tone: 'ok', detail: t(`Google Driveと同期済み（${time(state.lastSync)}）`, `Synced with Google Drive at ${time(state.lastSync)}`) }),
    busy: () => setSyncStatus({ tone: 'busy', detail: t('同期中…', 'Syncing…') }),
    signIn: () => setSyncStatus({ tone: 'warn', detail: t('ログインの有効期限が切れました。「今すぐ同期」で再開します。', 'Google sign-in expired. Press "Sync now" to continue syncing.') }),
    conflict: () => setSyncStatus({ tone: 'warn', detail: t('同期が保留中です：どちらのデータを残すか選んでください（「今すぐ同期」）。', 'Sync paused: choose which copy to keep ("Sync now").') }),
    error: (err) => setSyncStatus({ tone: 'error', detail: navigator.onLine === false ? t('オフラインです。接続後に再同期します。', 'Offline — will sync when you are back online.') : t(`同期エラー: ${err.message}`, `Sync error: ${err.message}`) }),
  };

  for (const k of Object.keys(status)) status[k] = show(status[k]);

  const docHash = (doc) => sha256(bundleText(normalize(doc))); // content only (not the name)
  const nameOf = (id) => store.maps.find((m) => m.id === id)?.name || '';

  // Returns 'drive' | 'local' | null
  async function askWhichWins(kind, mapName, localDoc, remoteDoc) {
    const local = counts(localDoc);
    const remote = counts(remoteDoc);
    const message =
      kind === 'first'
        ? t(
            `マップ「${mapName}」はGoogle Driveにも既にあります（${remote}）。\nこの端末のデータ（${local}）とは内容が異なります。`,
            `The map "${mapName}" already exists in Google Drive (${remote}).\nIt differs from this device's copy (${local}).`
          )
        : t(
            `マップ「${mapName}」は前回の同期以降、この端末（${local}）とGoogle Drive（${remote}）の両方で変更されました。`,
            `The map "${mapName}" changed both on this device (${local}) and in Google Drive (${remote}) since the last sync.`
          );
    return choose({
      title: t('どちらのデータを使いますか？', 'Which copy should win?'),
      message: message + t('\n\nDriveのデータを使う場合、マップで Ctrl+Z を押すと元に戻せます。', "\n\nIf you use Drive's copy, Ctrl+Z on the map undoes it."),
      options: [
        { id: 'drive', label: t('Driveのデータを使う', "Use Drive's copy"), tone: 'primary' },
        { id: 'local', label: t('この端末のデータでDriveを上書き', "Overwrite Drive with this device's"), tone: 'danger' },
      ],
    });
  }

  // Store changes made by sync itself must not schedule another sync.
  async function quietly(fn) {
    applyingRemote = true;
    try {
      return await fn();
    } finally {
      applyingRemote = false;
    }
  }
  const writeLocal = (id, doc, name) => quietly(() => store.putMapDoc(id, doc, { name }));

  // One map: three-way decision by content (logic.js), like the single-file version.
  // Returns false if a conflict was left unresolved.
  async function syncMap(token, id, entry, index) {
    const mine = state.maps[id] || {};
    const local = store.maps.find((m) => m.id === id);
    const localDoc = local ? await store.getMapDoc(id) : null;
    let meta = entry?.fileId ? await drive.getMeta(token, entry.fileId) : null;

    // Not in Drive yet → upload (except an untouched sample when Drive already has maps).
    if (!meta) {
      if (!localDoc) {
        delete index.maps[id];
        return true;
      }
      const ws = store.workspace;
      if (id === ws.sampleMapId && Object.keys(index.maps).length && (await docHash(localDoc)) === ws.sampleHash) {
        untouchedSample = id;
        return true;
      }
      const created = await drive.create(token, bundleText(localDoc, { name: local.name }), drive.mapFileName(id));
      state.maps[id] = { fileId: created.id, remoteVersion: String(created.version), baseHash: await docHash(localDoc) };
      index.maps[id] = { name: local.name, fileId: created.id, updatedAt: local.updatedAt };
      return true;
    }

    // Only in Drive → bring it here.
    if (!localDoc) {
      const remote = JSON.parse(await drive.download(token, meta.id));
      await writeLocal(id, remote, entry.name || remote.name || 'マップ');
      pulled.push(id);
      state.maps[id] = { fileId: meta.id, remoteVersion: String(meta.version), baseHash: await docHash(remote) };
      return true;
    }

    // Both: decide by content.
    const localHash = await docHash(localDoc);
    let remoteText = null;
    let remoteHash = mine.fileId === meta.id && String(meta.version) === mine.remoteVersion ? mine.baseHash : null;
    if (!remoteHash) {
      remoteText = await drive.download(token, meta.id);
      remoteHash = await docHash(JSON.parse(remoteText));
    }
    const record = (m, hash) => (state.maps[id] = { fileId: m.id, remoteVersion: String(m.version), baseHash: hash });
    const pushIt = async () => record(await drive.update(token, meta.id, bundleText(localDoc, { name: local.name })), localHash);
    const pullIt = async () => {
      const remote = JSON.parse(remoteText ?? (await drive.download(token, meta.id)));
      await writeLocal(id, remote, undefined);
      record(meta, await docHash(remote));
    };
    const action = decide({ localHash, remoteHash, baseHash: mine.fileId === meta.id ? mine.baseHash : null });
    if (action === 'adopt') record(meta, localHash);
    else if (action === 'push') await pushIt();
    else if (action === 'pull') await pullIt();
    else {
      const remoteDoc = normalize(JSON.parse(remoteText ?? (await drive.download(token, meta.id))));
      const choice = await askWhichWins(action, local.name, localDoc, remoteDoc);
      if (choice === 'drive') await pullIt();
      else if (choice === 'local') await pushIt();
      else return false;
    }

    // Names: whichever side changed more recently wins.
    if (entry && entry.name && entry.name !== local.name) {
      if ((entry.updatedAt || 0) > (local.updatedAt || 0)) await quietly(() => store.renameMap(id, entry.name));
      else index.maps[id] = { ...entry, name: local.name, updatedAt: local.updatedAt };
    }
    index.maps[id] = { ...(index.maps[id] || entry), name: nameOf(id) || entry?.name, fileId: state.maps[id].fileId, updatedAt: Math.max(entry?.updatedAt || 0, local.updatedAt || 0) };
    return true;
  }

  // retry: a click whose cached token Google rejects gets one fresh sign-in.
  async function sync({ interactive = false, retry = true } = {}) {
    if (!state.enabled) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    let reauth = false;
    try {
      let token = cachedToken();
      if (!token) {
        if (!interactive) return status.signIn();
        token = await requestToken(GOOGLE_CLIENT_ID);
      }
      status.busy();
      await store.flush();

      // 1. The index (or a fresh one).
      let idxMeta = state.indexFileId ? await drive.getMeta(token, state.indexFileId) : null;
      idxMeta ||= await drive.findFile(token, drive.INDEX_FILE);
      const index = idxMeta ? JSON.parse(await drive.download(token, idxMeta.id)) : { version: 1, maps: {}, deleted: {} };
      index.maps ||= {};
      index.deleted ||= {};
      const before = JSON.stringify(index);

      // 2. First multi-map sync: adopt the 0.6.x single file.
      if (!idxMeta) {
        const legacy = await drive.findFile(token, drive.LEGACY_FILE);
        if (legacy) {
          const mapped = Object.keys(state.maps).find((id) => state.maps[id].fileId === legacy.id);
          const localId = mapped || store.workspace.legacyMapId;
          if (localId && store.maps.some((m) => m.id === localId)) index.maps[localId] = { name: nameOf(localId), fileId: legacy.id, updatedAt: 0 };
          else index.maps[newMapId()] = { name: 'マイマップ', fileId: legacy.id, updatedAt: 0 };
        }
      }

      // 3. Deletions both ways.
      for (const [id, at] of Object.entries(store.workspace.deleted || {})) {
        if (index.maps[id]) {
          await drive.remove(token, index.maps[id].fileId).catch(() => {});
          delete index.maps[id];
        }
        index.deleted[id] = Math.max(index.deleted[id] || 0, at);
        delete state.maps[id];
      }
      for (const id of Object.keys(index.deleted)) {
        if (!store.maps.some((m) => m.id === id)) continue;
        // Deleted on another device: follow, unless this device changed it since the last sync.
        const base = state.maps[id]?.baseHash;
        if (base && (await docHash(await store.getMapDoc(id))) === base) {
          await quietly(() => store.deleteMap(id));
          delete state.maps[id];
        } else {
          delete index.deleted[id];
        }
      }

      // 4. Every map, local or remote.
      const ids = [...new Set([...store.maps.map((m) => m.id), ...Object.keys(index.maps)])].filter((id) => !index.deleted[id]);
      let unresolved = false;
      untouchedSample = null;
      pulled = [];
      for (const id of ids) if (!(await syncMap(token, id, index.maps[id], index))) unresolved = true;
      // A new device joining: its untouched sample map gives way to the maps from Drive.
      if (untouchedSample && store.maps.length > 1) {
        await quietly(() => store.deleteMap(untouchedSample, { record: false }));
        // …and a pulled map renamed "名前 (2)" to dodge it gets its own name back.
        for (const id of pulled) if (index.maps[id]?.name && nameOf(id) !== index.maps[id].name) await quietly(() => store.renameMap(id, index.maps[id].name));
      }

      // 5. Save the index if anything changed.
      if (JSON.stringify(index) !== before) {
        const text = JSON.stringify(index, null, 1);
        const saved = idxMeta ? await drive.update(token, idxMeta.id, text) : await drive.create(token, text, drive.INDEX_FILE);
        state.indexFileId = saved.id;
      } else if (idxMeta) state.indexFileId = idxMeta.id;
      state.lastSync = Date.now();
      save();
      unresolved ? status.conflict() : status.ok();
    } catch (err) {
      if (err instanceof drive.TokenExpiredError) {
        clearToken();
        if (interactive && retry) reauth = true;
        else status.signIn();
      } else if (err instanceof AuthError) {
        if (err.code === 'popup_failed_to_open') toast(t('ポップアップがブロックされました。もう一度押してください。', 'The sign-in popup was blocked — press the button again.'));
        else if (err.code === 'scope_denied') toast(t('Google Driveへのアクセスが許可されませんでした。', 'Google Drive access was not granted.'));
        if (!state.lastSync) disconnectLocal();
        else status.signIn();
      } else {
        console.warn('[gdrive] sync failed', err);
        status.error(err);
      }
    } finally {
      running = false;
      if (reauth) {
        again = false;
        sync({ interactive: true, retry: false });
      } else if (again) {
        again = false;
        sync();
      }
    }
  }

  function disconnectLocal() {
    state = { enabled: false, lastSync: 0, indexFileId: null, maps: {} };
    save();
    status.off();
    ctx.refreshPanel();
  }

  // ---- Data panel buttons ----
  registerDataAction({
    id: 'gdrive-connect',
    section: 'sync',
    icon: 'cloud',
    ja: 'Google Driveと同期',
    en: 'Sync with Google Drive',
    hidden: () => state.enabled,
    primary: () => true,
    run: async () => {
      state.enabled = true;
      save();
      await sync({ interactive: true });
      ctx.refreshPanel();
    },
  });
  registerDataAction({
    id: 'gdrive-sync',
    section: 'sync',
    icon: 'sync',
    ja: '今すぐ同期',
    en: 'Sync now',
    hidden: () => !state.enabled,
    run: () => sync({ interactive: true }),
  });
  registerDataAction({
    id: 'gdrive-disconnect',
    section: 'sync',
    icon: 'cloudOff',
    ja: '接続を解除',
    en: 'Disconnect',
    hidden: () => !state.enabled,
    run: async () => {
      if (!confirm(t('Google Driveとの同期を解除しますか？（この端末とDriveのデータはどちらも残ります）', 'Stop syncing with Google Drive? (Data stays on this device and in Drive.)'))) return;
      await revoke();
      disconnectLocal();
    },
  });

  // ---- Automatic sync ----
  store.subscribe(({ reason }) => {
    if (!state.enabled || applyingRemote || reason === 'external') return;
    clearTimeout(timer);
    timer = setTimeout(() => sync(), AUTO_SYNC_DELAY_MS);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.enabled) sync();
  });
  window.addEventListener('online', () => state.enabled && sync());

  if (state.enabled) {
    loadGis().catch(() => {}); // warm up so a later "Sync now" click opens the popup immediately
    if (cachedToken()) sync(); // not awaited: never delay page start-up
    else status.signIn();
  }
}

export default { id: 'google-drive', install };
