// The one owner of the vocabulary on a page: a workspace of maps (separate graphs),
// stored in IndexedDB, with the current map's doc held in memory.
//
//   await store.load();                 // IndexedDB → (first run) migrate localStorage / starter
//   store.doc / store.graph             // current map (graph is a cached, derived index)
//   store.edit((doc) => ops.addWord(doc, '構造', {...}));   // undoable change
//   store.subscribe(({ reason }) => render());
//     reasons: edit | field | layout | undo | redo | replace | switch | maps | external
//
//   store.maps / store.currentMap       // [{ id, name, kanji, words, updatedAt }]
//   await store.switchMap(id) / createMap(name, doc?) / renameMap / duplicateMap / deleteMap
//   await store.getMapDoc(id) / putMapDoc(id, doc, { name? })   (other maps: drill, sync)
//
// Sync plugins and import/export only ever see whole snapshots.

import { STORAGE_KEYS, DATA_FILES } from './constants.js';
import { normalize, emptyDoc, fromAny, migrateLegacy, bundleText } from './schema.js';
import { buildGraph } from './graph.js';
import { remapSrs } from './srs.js';
import { db, requestPersistence } from './db.js';

const JOURNAL_KEY = 'kanji_nexus_unsaved'; // see persistence below

const HISTORY_LIMIT = 50;
const WORKSPACE = 'workspace';

function readLocal(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export async function fetchStarter() {
  const parts = await Promise.all(
    DATA_FILES.map(async (name) => {
      const res = await fetch(new URL(`../../data/${name}.json`, import.meta.url), { cache: 'no-cache' });
      if (!res.ok) throw new Error(`data/${name}.json: HTTP ${res.status}`);
      return [name, await res.json()];
    })
  );
  return normalize(Object.fromEntries(parts));
}

async function hashText(text) {
  if (!globalThis.crypto?.subtle) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const newMapId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const counts = (doc) => ({ kanji: Object.keys(doc.kanji).length, words: Object.keys(doc.words).length });

function createStore() {
  let doc = emptyDoc();
  let graph = null;
  let ws = { currentId: null, order: [], deleted: {} };
  let metas = new Map(); // id → { id, name, kanji, words, createdAt, updatedAt }
  const histories = new Map(); // id → { history, future } (per map, this tab only)
  const listeners = new Set();
  const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('kanji-nexus') : null;

  const hist = () => {
    if (!histories.has(ws.currentId)) histories.set(ws.currentId, { history: [], future: [] });
    return histories.get(ws.currentId);
  };
  const snapshot = () => JSON.stringify(doc);

  function emit(reason) {
    for (const fn of listeners) {
      try {
        fn({ reason });
      } catch (err) {
        console.error('[store] listener failed', err);
      }
    }
  }

  // ---- persistence (coalesced: many edits in one tick → one write) ----
  // IndexedDB writes are asynchronous: one still pending when the page goes away (an
  // edit, then straight to another page) can be dropped. So on pagehide an unsaved doc
  // is also written synchronously to localStorage (JOURNAL_KEY); the next load replays
  // it if it is newer than what IndexedDB has, then clears it.
  let writeTimer = null;
  let writing = Promise.resolve();
  let version = 0; // bumped by every change
  let savedVersion = 0; // last version IndexedDB has confirmed
  function persist() {
    const meta = metas.get(ws.currentId);
    if (meta) Object.assign(meta, counts(doc), { updatedAt: Date.now() });
    version++;
    clearTimeout(writeTimer);
    writeTimer = setTimeout(flush, 0);
  }
  function flush() {
    clearTimeout(writeTimer);
    writeTimer = null;
    const meta = metas.get(ws.currentId);
    if (!meta) return writing;
    const record = { ...meta, doc: structuredClone(doc) };
    const v = version;
    writing = writing
      .then(() => db.putMap(record))
      .then(() => {
        savedVersion = Math.max(savedVersion, v);
        if (savedVersion === version) clearJournal();
      })
      .then(() => saveWorkspace({ broadcast: false })) // keep list counts / dates current
      .then(() => channel?.postMessage({ type: 'map', id: record.id, at: record.updatedAt }))
      .catch((err) => console.warn('[store] could not save', err));
    return writing;
  }
  addEventListener('pagehide', () => {
    if (version !== savedVersion) {
      const meta = metas.get(ws.currentId);
      try {
        if (meta) localStorage.setItem(JOURNAL_KEY, JSON.stringify({ id: meta.id, updatedAt: meta.updatedAt, doc }));
      } catch (_) {} // too big for localStorage: the IndexedDB write below is all we have
    }
    flush();
  });
  function clearJournal() {
    try {
      if (localStorage.getItem(JOURNAL_KEY)) localStorage.removeItem(JOURNAL_KEY);
    } catch (_) {}
  }
  // Replays an unsaved doc left by a page that closed mid-write (see above).
  async function replayJournal() {
    let j = null;
    try {
      j = JSON.parse(localStorage.getItem(JOURNAL_KEY) || 'null');
    } catch (_) {}
    if (!j?.id || !metas.has(j.id)) return clearJournal();
    const rec = await db.getMap(j.id);
    if (!rec || (rec.updatedAt || 0) < j.updatedAt) {
      const meta = Object.assign(metas.get(j.id), counts(normalize(j.doc)), { updatedAt: j.updatedAt });
      await db.putMap({ ...meta, doc: normalize(j.doc) });
      await saveWorkspace({ broadcast: false });
    }
    clearJournal();
  }

  async function saveWorkspace({ broadcast = true } = {}) {
    await db.putMeta(WORKSPACE, { ...ws, maps: [...metas.values()] });
    if (broadcast) channel?.postMessage({ type: 'workspace' });
  }

  function setDoc(next, reason) {
    doc = next;
    graph = null;
    persist();
    emit(reason);
  }

  async function loadWorkspace() {
    const saved = await db.getMeta(WORKSPACE);
    if (!saved) return false;
    ws = { ...saved, currentId: saved.currentId, order: saved.order || [], deleted: saved.deleted || {} };
    delete ws.maps;
    metas = new Map((saved.maps || []).map((m) => [m.id, m]));
    ws.order = ws.order.filter((id) => metas.has(id));
    for (const id of metas.keys()) if (!ws.order.includes(id)) ws.order.push(id);
    if (!metas.has(ws.currentId)) ws.currentId = ws.order[0];
    return ws.order.length > 0;
  }

  async function addMap(name, mapDoc, { id = newMapId() } = {}) {
    const now = Date.now();
    const meta = { id, name: uniqueName(name), createdAt: now, updatedAt: now, ...counts(mapDoc) };
    await db.putMap({ ...meta, doc: mapDoc });
    metas.set(id, meta);
    ws.order.push(id);
    delete ws.deleted[id];
    return meta;
  }

  function uniqueName(name, exceptId = null) {
    const base = String(name || '').trim() || 'マップ';
    const taken = new Set([...metas.values()].filter((m) => m.id !== exceptId).map((m) => m.name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base} (${i})`)) return `${base} (${i})`;
  }

  // First run of the multi-map version: build the workspace from what this browser had.
  async function migrateFirstRun() {
    const saved = readLocal(STORAGE_KEYS.DATA);
    if (saved) {
      const meta = await addMap('マイマップ', normalize(saved));
      ws.currentId = meta.id;
      ws.legacyMapId = meta.id; // the map that used to be "the" data (Drive sync adopts it)
      return 'local';
    }
    const legacy = readLocal(STORAGE_KEYS.LEGACY_DATA);
    if (legacy?.primaryNodes?.length) {
      const { doc: migrated, idMap } = migrateLegacy(legacy);
      remapSrs(idMap);
      const meta = await addMap('マイマップ', migrated);
      ws.currentId = meta.id;
      ws.legacyMapId = meta.id;
      return 'legacy';
    }
    try {
      const sample = await fetchStarter();
      const meta = await addMap('サンプル', sample);
      ws.currentId = meta.id;
      // Remember the untouched sample so sync doesn't upload a copy from every new device.
      ws.sampleMapId = meta.id;
      ws.sampleHash = await hashText(bundleText(sample));
      return 'starter';
    } catch (err) {
      console.warn('[store] starter sample unavailable', err);
      const meta = await addMap('マイマップ', emptyDoc());
      ws.currentId = meta.id;
      return 'empty';
    }
  }

  async function openCurrent() {
    const rec = await db.getMap(ws.currentId);
    doc = normalize(rec?.doc || emptyDoc());
    graph = null;
  }

  const store = {
    get doc() {
      return doc;
    },
    get graph() {
      return (graph ||= buildGraph(doc));
    },
    get canUndo() {
      return hist().history.length > 0;
    },
    get canRedo() {
      return hist().future.length > 0;
    },
    get maps() {
      return ws.order.map((id) => metas.get(id)).filter(Boolean);
    },
    get currentMap() {
      return metas.get(ws.currentId) || null;
    },
    get workspace() {
      return ws;
    },

    // Resolves to where the data came from: 'workspace' | 'local' | 'legacy' | 'starter' | 'empty'.
    async load() {
      requestPersistence();
      let source = 'workspace';
      if (!(await loadWorkspace())) {
        source = await migrateFirstRun();
        await saveWorkspace();
      } else await replayJournal();
      await openCurrent();
      return source;
    },

    // ---- edits on the current map ----
    checkpoint() {
      const h = hist();
      h.history.push(snapshot());
      if (h.history.length > HISTORY_LIMIT) h.history.shift();
      h.future = [];
    },
    commit(reason = 'edit') {
      graph = null;
      persist();
      emit(reason);
    },
    edit(fn, reason = 'edit') {
      this.checkpoint();
      const result = fn(doc);
      this.commit(reason);
      return result;
    },
    undo() {
      const h = hist();
      if (!h.history.length) return false;
      h.future.push(snapshot());
      setDoc(JSON.parse(h.history.pop()), 'undo');
      return true;
    },
    redo() {
      const h = hist();
      if (!h.future.length) return false;
      h.history.push(snapshot());
      setDoc(JSON.parse(h.future.pop()), 'redo');
      return true;
    },
    // Replace the current map's contents with an imported bundle (either schema). Undoable.
    importData(raw) {
      const { doc: next, idMap } = fromAny(raw);
      if (idMap) remapSrs(idMap);
      this.checkpoint();
      setDoc(next, 'replace');
    },
    async resetToStarter() {
      const next = await fetchStarter();
      this.checkpoint();
      setDoc(next, 'replace');
    },
    wipe() {
      this.checkpoint();
      setDoc(emptyDoc(), 'replace');
    },
    exportText({ withName = false } = {}) {
      return bundleText(doc, withName ? { name: this.currentMap?.name } : undefined);
    },

    // ---- maps ----
    async switchMap(id) {
      if (!metas.has(id) || id === ws.currentId) return;
      await flush();
      ws.currentId = id;
      await openCurrent();
      await saveWorkspace({ broadcast: false });
      emit('switch');
    },
    async createMap(name, mapDoc = emptyDoc(), { switchTo = true } = {}) {
      const meta = await addMap(name, normalize(mapDoc));
      await saveWorkspace();
      if (switchTo) await this.switchMap(meta.id);
      else emit('maps');
      return meta;
    },
    // Import a bundle (or legacy file) as a new map. Returns the new map's meta.
    async importAsNewMap(raw, name, { switchTo = true } = {}) {
      const { doc: next, idMap } = fromAny(raw);
      if (idMap) remapSrs(idMap);
      return this.createMap(name || raw?.name || 'インポート', next, { switchTo });
    },
    async renameMap(id, name) {
      const meta = metas.get(id);
      if (!meta || !String(name).trim()) return;
      meta.name = uniqueName(name, id);
      meta.updatedAt = Date.now();
      const rec = await db.getMap(id);
      if (rec) await db.putMap({ ...rec, name: meta.name, updatedAt: meta.updatedAt });
      await saveWorkspace();
      emit('maps');
    },
    async duplicateMap(id) {
      const rec = id === ws.currentId ? { doc } : await db.getMap(id);
      const meta = metas.get(id);
      if (!rec || !meta) return null;
      return this.createMap(`${meta.name} のコピー`, structuredClone(rec.doc), { switchTo: false }); // stay where you are
    },
    // record: false = local-only removal (sync dropping an untouched sample), not propagated.
    async deleteMap(id, { record = true } = {}) {
      if (!metas.has(id)) return;
      await flush();
      metas.delete(id);
      ws.order = ws.order.filter((x) => x !== id);
      if (record) ws.deleted[id] = Date.now(); // lets sync delete it on other devices too
      if (ws.sampleMapId === id) delete ws.sampleMapId;
      histories.delete(id);
      await db.deleteMap(id);
      if (!ws.order.length) await addMap('マイマップ', emptyDoc());
      if (ws.currentId === id) {
        ws.currentId = ws.order[0];
        await openCurrent();
        await saveWorkspace();
        emit('switch');
      } else {
        await saveWorkspace();
        emit('maps');
      }
    },
    async moveMap(id, toIndex) {
      const from = ws.order.indexOf(id);
      if (from < 0) return;
      ws.order.splice(from, 1);
      ws.order.splice(Math.max(0, Math.min(toIndex, ws.order.length)), 0, id);
      await saveWorkspace();
      emit('maps');
    },
    async getMapDoc(id) {
      if (id === ws.currentId) return structuredClone(doc);
      const rec = await db.getMap(id);
      return rec ? normalize(rec.doc) : null;
    },
    // Write another map's contents (sync pulls). The current map goes through the undo stack.
    async putMapDoc(id, mapDoc, { name } = {}) {
      const next = normalize(mapDoc);
      if (!metas.has(id)) {
        await addMap(name || 'マップ', next, { id });
        await saveWorkspace();
        emit('maps');
        return;
      }
      const meta = metas.get(id);
      if (name && name !== meta.name) meta.name = name;
      if (id === ws.currentId) {
        this.checkpoint();
        setDoc(next, 'replace');
        await flush();
      } else {
        Object.assign(meta, counts(next), { updatedAt: Date.now() });
        await db.putMap({ ...meta, doc: next });
      }
      await saveWorkspace();
      emit('maps');
    },
    // Everything, for "save all maps" backups.
    async exportWorkspace() {
      await flush();
      const maps = [];
      for (const meta of this.maps) maps.push({ name: meta.name, ...(await this.getMapDoc(meta.id)) });
      return { kind: 'kanji-nexus-workspace', version: 1, exportedAt: new Date().toISOString(), maps };
    },
    flush,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  // Another tab changed something: adopt it.
  channel?.addEventListener('message', async ({ data }) => {
    try {
      if (data.type === 'workspace') {
        const current = ws.currentId;
        await loadWorkspace();
        ws.currentId = current && metas.has(current) ? current : ws.order[0];
        if (ws.currentId !== current) {
          await openCurrent();
          emit('switch');
        } else emit('maps');
      } else if (data.type === 'map' && data.id === ws.currentId) {
        await openCurrent();
        emit('external');
      }
    } catch (_) {}
  });

  return store;
}

export const store = createStore();
