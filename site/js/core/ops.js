// Mutations on a doc. Pages call these inside store.edit(...) so undo/redo,
// persistence and change notifications happen in one place.
//
// All functions take the mutable doc as first argument and return a small result
// object (or nothing). They never touch the DOM or storage.

import { LINK_TYPES } from './constants.js';
import { extractKanji, labelOf, hasKana, toKatakana, toHiragana } from './util.js';
import { orderPair, linkKey } from './schema.js';

// ---------------------------------------------------------------------------
// Kanji
// ---------------------------------------------------------------------------
export function addKanji(doc, ch, { on = [], kun = [], notes = '' } = {}) {
  if (!ch || doc.kanji[ch]) return { ok: false, exists: Boolean(doc.kanji[ch]) };
  doc.kanji[ch] = { on, kun, notes };
  return { ok: true };
}

export function updateKanji(doc, ch, patch) {
  if (!doc.kanji[ch]) return;
  Object.assign(doc.kanji[ch], patch);
}

export function renameKanji(doc, from, to) {
  if (!doc.kanji[from] || !to || from === to || doc.kanji[to]) return { ok: false };
  doc.kanji[to] = doc.kanji[from];
  delete doc.kanji[from];
  moveKey(doc.layout.kanji, from, to);
  return { ok: true };
}

// Words that contain the kanji keep existing; they simply lose that parent.
export function deleteKanji(doc, ch) {
  delete doc.kanji[ch];
  delete doc.layout.kanji[ch];
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------
// Kanji in the word's label that are not registered yet.
export const missingKanji = (doc, key) => extractKanji(labelOf(key)).filter((ch) => !doc.kanji[ch]);

export function addWord(doc, key, { reading = '', meaning = '', tags = [], notes = '' } = {}, { createKanji = true, linkDerivatives = true } = {}) {
  if (!key || doc.words[key]) return { ok: false, exists: Boolean(doc.words[key]), createdKanji: [] };
  doc.words[key] = { reading, meaning, tags, notes, examples: [] };
  const createdKanji = createKanji ? missingKanji(doc, key) : [];
  for (const ch of createdKanji) addKanji(doc, ch);
  const derivatives = linkDerivatives ? autoLinkDerivatives(doc, key) : [];
  return { ok: true, createdKanji, derivatives };
}

export function updateWord(doc, key, patch) {
  if (!doc.words[key]) return;
  Object.assign(doc.words[key], patch);
}

export function renameWord(doc, from, to) {
  if (!doc.words[from] || !to || from === to || doc.words[to]) return { ok: false };
  doc.words[to] = doc.words[from];
  delete doc.words[from];
  moveKey(doc.layout.words, from, to);
  doc.links = doc.links
    .map(([a, b, t]) => [a === from ? to : a, b === from ? to : b, t])
    .filter(([a, b]) => a !== b)
    .map(([a, b, t]) => orderPair(a, b).concat(t));
  dedupeLinks(doc);
  return { ok: true };
}

export function deleteWord(doc, key) {
  delete doc.words[key];
  delete doc.layout.words[key];
  doc.links = doc.links.filter(([a, b]) => a !== key && b !== key);
}

export function toggleTag(doc, key, tag) {
  const w = doc.words[key];
  if (!w) return;
  w.tags = w.tags.includes(tag) ? w.tags.filter((t) => t !== tag) : [...w.tags, tag];
}

// ---------------------------------------------------------------------------
// Lateral links (undirected)
// ---------------------------------------------------------------------------
export function findLink(doc, a, b) {
  const k = linkKey(a, b);
  return doc.links.find(([x, y]) => linkKey(x, y) === k) || null;
}

export function setLink(doc, a, b, type = 'related') {
  if (!a || !b || a === b || !doc.words[a] || !doc.words[b]) return { ok: false };
  const t = LINK_TYPES[type] ? type : 'related';
  const existing = findLink(doc, a, b);
  if (existing) existing[2] = t;
  else doc.links.push(orderPair(a, b).concat(t));
  return { ok: true };
}

export function removeLink(doc, a, b) {
  const k = linkKey(a, b);
  doc.links = doc.links.filter(([x, y]) => linkKey(x, y) !== k);
}

function dedupeLinks(doc) {
  const seen = new Set();
  doc.links = doc.links.filter(([a, b]) => {
    const k = linkKey(a, b);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Morphological derivatives by prefix, e.g. 魅力 <-> 魅力的. Existing links are kept as-is.
export function autoLinkDerivatives(doc, key) {
  const label = labelOf(key);
  if (!extractKanji(label).length) return [];
  const added = [];
  for (const other of Object.keys(doc.words)) {
    if (other === key) continue;
    const ol = labelOf(other);
    const isDerivative = (ol.length > label.length && ol.startsWith(label)) || (label.length > ol.length && label.startsWith(ol));
    if (isDerivative && !findLink(doc, key, other)) {
      setLink(doc, key, other, 'derivative');
      added.push(other);
    }
  }
  return added;
}

// Re-run automatic maintenance across every word: create missing kanji, link derivatives.
export function rescanAll(doc, { createKanji = true } = {}) {
  let kanjiCreated = 0;
  let linksAdded = 0;
  for (const key of Object.keys(doc.words)) {
    if (createKanji) {
      for (const ch of missingKanji(doc, key)) {
        addKanji(doc, ch);
        kanjiCreated++;
      }
    }
    linksAdded += autoLinkDerivatives(doc, key).length;
  }
  return { kanjiCreated, linksAdded };
}

// ---------------------------------------------------------------------------
// Read-only analysis
// ---------------------------------------------------------------------------
// Guess on/kun readings for a kanji from the words attached to it.
export function suggestReadings(graph, kid) {
  const k = graph.kanji.get(kid);
  if (!k) return { on: [], kun: [] };
  const on = new Set();
  const kun = new Set();
  for (const wid of graph.children.get(kid) || []) {
    const w = graph.words.get(wid);
    if (!w?.reading) continue;
    const chars = [...w.label];
    if (hasKana(w.label) && chars[0] === k.label) {
      kun.add(w.reading);
    } else if (!hasKana(w.label) && chars.length === 2) {
      const idx = chars.indexOf(k.label);
      // Skip words a known reading already explains (対称 たいしょう with タイ saved).
      const known = k.on.map(toHiragana);
      if (known.some((r) => (idx === 0 ? w.reading.startsWith(r) : w.reading.endsWith(r)))) continue;
      const half = Math.ceil(w.reading.length / 2);
      const slice = idx === 0 ? w.reading.slice(0, half) : w.reading.slice(half);
      if (slice) on.add(toKatakana(slice));
    }
  }
  const bare = (r) => toHiragana(r).replace(/[.\-]/g, '');
  const drop = (set, have) => [...set].filter((r) => !have.map(bare).includes(bare(r))).slice(0, 4);
  return { on: drop(on, k.on), kun: drop(kun, k.kun) };
}

function moveKey(obj, from, to) {
  if (from in obj) {
    obj[to] = obj[from];
    delete obj[from];
  }
}
