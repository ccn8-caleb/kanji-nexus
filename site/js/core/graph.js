// Read-only graph index derived from a doc. Every page builds its view from this,
// so relationships are computed in exactly one place.
//
// Node ids: "k:<char>" for kanji, "w:<key>" for words.

import { DEFAULT_COLORS, LINK_TYPES } from './constants.js';
import { extractKanji, labelOf } from './util.js';

export const kanjiId = (ch) => `k:${ch}`;
export const wordId = (key) => `w:${key}`;
export const kindOf = (id) => (String(id).startsWith('k:') ? 'kanji' : String(id).startsWith('w:') ? 'word' : null);
export const keyOf = (id) => String(id).slice(2);

export function buildGraph(doc) {
  const kanji = new Map();
  const words = new Map();
  const parents = new Map(); // wordId -> [kanjiId]
  const children = new Map(); // kanjiId -> [wordId]
  const linksOf = new Map(); // wordId -> [{ id, type }]
  const links = []; // [{ a, b, type }] with both ends present

  for (const [ch, k] of Object.entries(doc.kanji)) {
    const id = kanjiId(ch);
    const pos = doc.layout.kanji[ch];
    kanji.set(id, {
      id, kind: 'kanji', key: ch, label: ch,
      on: k.on, kun: k.kun, notes: k.notes,
      color: k.color || DEFAULT_COLORS.kanji,
      x: pos ? pos[0] : null, y: pos ? pos[1] : null,
    });
    children.set(id, []);
  }

  for (const [key, w] of Object.entries(doc.words)) {
    const id = wordId(key);
    const pos = doc.layout.words[key];
    const label = labelOf(key);
    words.set(id, {
      id, kind: 'word', key, label,
      reading: w.reading, tags: w.tags, notes: w.notes,
      color: w.color || DEFAULT_COLORS.word,
      x: pos ? pos[0] : null, y: pos ? pos[1] : null,
    });
    const pids = extractKanji(label).map(kanjiId).filter((pid) => kanji.has(pid));
    parents.set(id, pids);
    for (const pid of pids) children.get(pid).push(id);
    linksOf.set(id, []);
  }

  for (const [a, b, type] of doc.links) {
    const ia = wordId(a);
    const ib = wordId(b);
    if (!words.has(ia) || !words.has(ib)) continue;
    const t = LINK_TYPES[type] ? type : 'related';
    links.push({ a: ia, b: ib, type: t });
    linksOf.get(ia).push({ id: ib, type: t });
    linksOf.get(ib).push({ id: ia, type: t });
  }

  const node = (id) => kanji.get(id) || words.get(id) || null;

  let clusterCache = null;
  // Connected components over kanji<->word parent edges (lateral links excluded),
  // largest first. Words without any registered kanji are not part of a cluster.
  function clusters() {
    if (clusterCache) return clusterCache;
    const seen = new Set();
    const out = [];
    for (const start of kanji.keys()) {
      if (seen.has(start)) continue;
      const comp = { kanji: [], words: [] };
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const cur = stack.pop();
        const next = kanji.has(cur) ? (comp.kanji.push(kanji.get(cur)), children.get(cur)) : (comp.words.push(words.get(cur)), parents.get(cur));
        for (const n of next) {
          if (!seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
      }
      out.push(comp);
    }
    out.sort((x, y) => y.kanji.length - x.kanji.length || y.words.length - x.words.length);
    return (clusterCache = out);
  }

  return { kanji, words, parents, children, links, linksOf, node, clusters };
}
