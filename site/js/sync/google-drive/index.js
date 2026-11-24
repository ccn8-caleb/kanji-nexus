// Sync plugin: keeps the whole dataset in one file in the user's Google Drive
// (hidden app folder, scope drive.appdata). No server, no account on our side.
//
// Flow
//   Connect     click → Google popup (consent the first time) → first sync
//   Auto-sync   while a token is valid: a few seconds after each edit, and when the
//               tab becomes visible again (to pick up changes from other devices)
//   Expired     tokens last ~1h and can't renew without a click; the Data button
//               shows "☁!" and "Sync now" signs in again
//   Conflicts   decided by content (see logic.js); when both sides changed the user
//               chooses which copy wins. Pulling is undoable with Ctrl+Z on the map.
//
// Drill (SRS) progress is not synced yet — only the vocabulary bundle.

import { GOOGLE_CLIENT_ID } from '../config.js';
import { normalize, bundleText } from '../../core/schema.js';
import { choose } from '../../core/ui.js';
import { onPrefsChange } from '../../core/prefs.js';
import { cachedToken, requestToken, revoke, clearToken, loadGis, AuthError } from './auth.js';
import * as drive from './drive.js';
import { decide, sha256 } from './logic.js';

const STATE_KEY = 'kanji_nexus_gdrive';
const AUTO_SYNC_DELAY_MS = 3000;

function loadState() {
  try {
    return { enabled: false, fileId: null, remoteVersion: null, baseHash: null, lastSync: 0, ...JSON.parse(localStorage.getItem(STATE_KEY) || '{}') };
  } catch (_) {
    return { enabled: false, fileId: null, remoteVersion: null, baseHash: null, lastSync: 0 };
  }
}

const isSecureOrigin = () => location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

export function install(ctx) {
  const { store, t, toast, registerDataAction, setSyncStatus } = ctx;
  if (!GOOGLE_CLIENT_ID) return; // not configured for this deployment: show nothing

  if (!isSecureOrigin()) {
    registerDataAction({
      id: 'gdrive-https',
      section: 'sync',
      ja: '☁ Google Drive同期（HTTPSで開く）',
      en: '☁ Google Drive sync (open over HTTPS)',
      run: () => (location.href = location.href.replace(/^http:/, 'https:')),
    });
    return;
  }

  let state = loadState();
  let running = false;
  let again = false;
  let applyingRemote = false;
  let timer = null;

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
    ok: () => setSyncStatus({ badge: '☁✓', tone: 'ok', detail: t(`Google Driveと同期済み（${time(state.lastSync)}）`, `Synced with Google Drive at ${time(state.lastSync)}`) }),
    busy: () => setSyncStatus({ badge: '☁…', tone: 'busy', detail: t('同期中…', 'Syncing…') }),
    signIn: () => setSyncStatus({ badge: '☁!', tone: 'warn', detail: t('ログインの有効期限が切れました。「今すぐ同期」で再開します。', 'Google sign-in expired. Press "Sync now" to continue syncing.') }),
    conflict: () => setSyncStatus({ badge: '☁!', tone: 'warn', detail: t('同期が保留中です：どちらのデータを残すか選んでください（「今すぐ同期」）。', 'Sync paused: choose which copy to keep ("Sync now").') }),
    error: (err) => setSyncStatus({ badge: '☁×', tone: 'error', detail: navigator.onLine === false ? t('オフラインです。接続後に再同期します。', 'Offline — will sync when you are back online.') : t(`同期エラー: ${err.message}`, `Sync error: ${err.message}`) }),
  };

  for (const k of Object.keys(status)) status[k] = show(status[k]);

  function record(meta, hash) {
    state = { ...state, fileId: meta.id, remoteVersion: String(meta.version), baseHash: hash, lastSync: Date.now() };
    save();
    status.ok();
  }

  async function pull(remoteText, meta) {
    applyingRemote = true;
    try {
      store.importData(JSON.parse(remoteText));
    } finally {
      applyingRemote = false;
    }
    record(meta, await sha256(store.exportText()));
  }

  async function push(token, meta, localText, localHash) {
    const saved = meta ? await drive.update(token, meta.id, localText) : await drive.create(token, localText);
    record(saved, localHash);
  }

  // Returns 'drive' | 'local' | null
  async function askWhichWins(kind, remoteDoc) {
    const local = counts(store.doc);
    const remote = counts(remoteDoc);
    const message =
      kind === 'first'
        ? t(
            `Google Driveに既にデータがあります（${remote}）。\nこの端末のデータ（${local}）とは内容が異なります。`,
            `Google Drive already has Kanji Nexus data (${remote}).\nIt differs from this device's data (${local}).`
          )
        : t(
            `前回の同期以降、この端末（${local}）とGoogle Drive（${remote}）の両方で変更がありました。`,
            `Both this device (${local}) and Google Drive (${remote}) changed since the last sync.`
          );
    return choose({
      title: t('どちらのデータを使いますか？', 'Which copy should win?'),
      message: message + t('\n\nDriveのデータを使う場合、マップで Ctrl+Z を押すと元に戻せます。', '\n\nIf you use Drive\'s copy, Ctrl+Z on the map undoes it.'),
      options: [
        { id: 'drive', label: t('Driveのデータを使う', "Use Drive's copy"), tone: 'primary' },
        { id: 'local', label: t('この端末のデータでDriveを上書き', "Overwrite Drive with this device's"), tone: 'danger' },
      ],
    });
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

      let meta = state.fileId ? await drive.getMeta(token, state.fileId) : null;
      meta ||= await drive.findFile(token);

      const localText = store.exportText();
      const localHash = await sha256(localText);
      let remoteText = null;
      let remoteHash = null;
      if (meta) {
        const unchanged = meta.id === state.fileId && String(meta.version) === state.remoteVersion && state.baseHash;
        if (unchanged) remoteHash = state.baseHash;
        else {
          remoteText = await drive.download(token, meta.id);
          remoteHash = await sha256(bundleText(normalize(JSON.parse(remoteText))));
        }
      }

      const action = decide({ localHash, remoteHash, baseHash: meta?.id === state.fileId ? state.baseHash : null });
      if (action === 'adopt') record(meta, localHash);
      else if (action === 'push') await push(token, meta, localText, localHash);
      else if (action === 'pull') await pull(remoteText, meta);
      else {
        const choice = await askWhichWins(action, normalize(JSON.parse(remoteText)));
        if (choice === 'drive') await pull(remoteText, meta);
        else if (choice === 'local') await push(token, meta, store.exportText(), await sha256(store.exportText()));
        else status.conflict();
      }
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
    state = { enabled: false, fileId: null, remoteVersion: null, baseHash: null, lastSync: 0 };
    save();
    status.off();
    ctx.refreshPanel();
  }

  // ---- Data panel buttons ----
  registerDataAction({
    id: 'gdrive-connect',
    section: 'sync',
    ja: '☁ Google Driveと同期',
    en: '☁ Sync with Google Drive',
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
    ja: '☁ 今すぐ同期',
    en: '☁ Sync now',
    hidden: () => !state.enabled,
    run: () => sync({ interactive: true }),
  });
  registerDataAction({
    id: 'gdrive-disconnect',
    section: 'sync',
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
