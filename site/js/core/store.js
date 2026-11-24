// The one owner of the vocabulary doc on a page.
//
//   await store.load();                 // localStorage -> legacy v1 migration -> starter sample
//   store.graph                         // derived read-only index (cached)
//   store.edit((doc) => ops.addWord(doc, '構造', {...}));   // undoable change
//   store.subscribe(({ reason }) => render());
//
// Sync plugins and import/export only ever see whole snapshots (exportText / replace),
// so they never need to know how pages edit data.

import { STORAGE_KEYS, DATA_FILES } from './constants.js';
import { normalize, emptyDoc, fromAny, migrateLegacy, bundleText } from './schema.js';
import { buildGraph } from './graph.js';
import { remapSrs } from './srs.js';

const HISTORY_LIMIT = 50;

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

function createStore() {
  let doc = emptyDoc();
  let graph = null;
  let history = [];
  let future = [];
  const listeners = new Set();

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

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEYS.DATA, JSON.stringify(doc));
      return true;
    } catch (err) {
      console.warn('[store] could not save to localStorage', err);
      return false;
    }
  }

  function setDoc(next, reason) {
    doc = next;
    graph = null;
    persist();
    emit(reason);
  }

  const store = {
    get doc() {
      return doc;
    },
    get graph() {
      return (graph ||= buildGraph(doc));
    },
    get canUndo() {
      return history.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },

    // Resolves to where the data came from: 'local' | 'legacy' | 'starter' | 'empty'.
    async load() {
      const saved = readLocal(STORAGE_KEYS.DATA);
      if (saved) {
        doc = normalize(saved);
        graph = null;
        return 'local';
      }
      const legacy = readLocal(STORAGE_KEYS.LEGACY_DATA);
      if (legacy?.primaryNodes?.length) {
        const { doc: migrated, idMap } = migrateLegacy(legacy);
        remapSrs(idMap);
        doc = migrated;
        graph = null;
        persist(); // the v1 key is left untouched as a backup
        return 'legacy';
      }
      try {
        doc = await fetchStarter();
        graph = null;
        persist();
        return 'starter';
      } catch (err) {
        console.warn('[store] starter sample unavailable', err);
        return 'empty';
      }
    },

    // Record the current state for undo. Use directly for multi-step gestures (drag),
    // otherwise prefer edit().
    checkpoint() {
      history.push(snapshot());
      if (history.length > HISTORY_LIMIT) history.shift();
      future = [];
    },

    // Persist and notify after in-place changes made since the last checkpoint.
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
      if (!history.length) return false;
      future.push(snapshot());
      setDoc(JSON.parse(history.pop()), 'undo');
      return true;
    },

    redo() {
      if (!future.length) return false;
      history.push(snapshot());
      setDoc(JSON.parse(future.pop()), 'redo');
      return true;
    },

    // Replace everything with an imported bundle (either schema). Undoable.
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

    exportText() {
      return bundleText(doc);
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  // Another tab changed the data: adopt it.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEYS.DATA || !e.newValue) return;
    try {
      doc = normalize(JSON.parse(e.newValue));
      graph = null;
      emit('external');
    } catch (_) {}
  });

  return store;
}

export const store = createStore();
