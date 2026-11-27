// Minimal promise wrapper around IndexedDB — where maps live (localStorage is capped
// at ~5 MB per site, too small for several imported decks).
//
//   maps  { id, name, doc, createdAt, updatedAt }   one record per map
//   meta  key/value: "workspace" → { currentId, order: [ids], deleted: { id: time } }
//
// Falls back to an in-memory store if IndexedDB is unavailable (very old or locked-
// down browsers), so the app still runs for the session.

const DB_NAME = 'kanji-nexus';
const DB_VERSION = 1;

let dbPromise = null;
let memory = null; // fallback: { maps: Map, meta: Map }

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (!('indexedDB' in globalThis)) return resolve(null);
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (_) {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('maps')) db.createObjectStore('maps', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  }).then((db) => {
    if (!db) {
      console.warn('[db] IndexedDB unavailable — data lives only for this session');
      memory = { maps: new Map(), meta: new Map() };
    }
    return db;
  });
  return dbPromise;
}

function request(storeName, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (!db) return resolve(fn(null));
        const tx = db.transaction(storeName, mode);
        const req = fn(tx.objectStore(storeName));
        let result;
        if (req) req.onsuccess = () => (result = req.result);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
      })
  );
}

const clone = (v) => (v === undefined ? v : structuredClone(v));

export const db = {
  async getMap(id) {
    return request('maps', 'readonly', (s) => (s ? s.get(id) : null)).then((r) => r ?? clone(memory?.maps.get(id)) ?? null);
  },
  async putMap(record) {
    if (memory) return void memory.maps.set(record.id, clone(record));
    return request('maps', 'readwrite', (s) => s.put(record));
  },
  async deleteMap(id) {
    if (memory) return void memory.maps.delete(id);
    return request('maps', 'readwrite', (s) => s.delete(id));
  },
  async allMaps() {
    if (memory) return [...memory.maps.values()].map(clone);
    return request('maps', 'readonly', (s) => s.getAll());
  },
  async getMeta(key) {
    if (memory) return clone(memory.meta.get(key)) ?? null;
    return request('meta', 'readonly', (s) => s.get(key)).then((r) => r ?? null);
  },
  async putMeta(key, value) {
    if (memory) return void memory.meta.set(key, clone(value));
    return request('meta', 'readwrite', (s) => s.put(value, key));
  },
  get persistent() {
    return !memory;
  },
};

// Ask the browser not to evict our data under storage pressure (best effort).
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}
