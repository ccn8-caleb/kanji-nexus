// Data schema: normalisation, canonical serialisation, and legacy migration.
//
// A "doc" (also the portable "bundle"/"snapshot") looks like:
//   {
//     schema: 2,
//     kanji:  { "構": { on: ["コウ"], kun: ["かま.える"], notes?, color? } },
//     words:  { "構造": { reading: "こうぞう", meaning?: "structure; …", tags?: [], notes?, color? } },
//     links:  [ ["構造", "構成", "synonym"] ],             // undirected
//     layout: { kanji: { "構": [x, y] }, words: { "構造": [x, y, 1] } }   // 3rd value 1 = pinned
//   }
// Parent kanji of a word are never stored: they are derived from its characters.
//
// The text format (one record per line, sorted) is mirrored by tools/ (Go). Keep them in sync.

import { SCHEMA_VERSION, LINK_TYPES, TAG_IDS, DEFAULT_COLORS } from './constants.js';
import { splitReadings } from './util.js';

const str = (v) => (v == null ? '' : String(v));
const strList = (v) => (Array.isArray(v) ? v.map(str).map((s) => s.trim()).filter(Boolean) : splitReadings(v));
const isPos = (v) => Array.isArray(v) && (v.length === 2 || v.length === 3) && v.every(Number.isFinite);

export function emptyDoc() {
  return { schema: SCHEMA_VERSION, kanji: {}, words: {}, links: [], layout: { kanji: {}, words: {} } };
}

export const isLegacy = (raw) => Boolean(raw && Array.isArray(raw.primaryNodes));

// Coerce anything bundle-shaped into a fully-populated doc. Unknown fields are dropped.
export function normalize(raw) {
  const doc = emptyDoc();
  if (!raw || typeof raw !== 'object') return doc;

  for (const [ch, k] of Object.entries(raw.kanji || {})) {
    const key = ch.trim();
    if (!key) continue;
    doc.kanji[key] = {
      on: strList(k?.on),
      kun: strList(k?.kun),
      notes: str(k?.notes),
      ...(k?.color ? { color: str(k.color) } : {}),
    };
  }

  for (const [wk, w] of Object.entries(raw.words || {})) {
    const key = wk.trim();
    if (!key) continue;
    doc.words[key] = {
      reading: str(w?.reading).trim(),
      meaning: str(w?.meaning).trim(),
      tags: [...new Set(strList(w?.tags).filter((t) => TAG_IDS.has(t)))],
      notes: str(w?.notes),
      ...(w?.color ? { color: str(w.color) } : {}),
    };
  }

  const seen = new Set();
  for (const l of Array.isArray(raw.links) ? raw.links : []) {
    if (!Array.isArray(l) || l.length < 2) continue;
    const [a, b] = [str(l[0]).trim(), str(l[1]).trim()];
    if (!a || !b || a === b) continue;
    const type = LINK_TYPES[l[2]] ? l[2] : 'related';
    const pair = linkKey(a, b);
    if (seen.has(pair)) continue;
    seen.add(pair);
    doc.links.push(orderPair(a, b).concat(type));
  }

  const lay = raw.layout || {};
  for (const section of ['kanji', 'words']) {
    for (const [key, pos] of Object.entries(lay[section] || {})) {
      if (isPos(pos)) doc.layout[section][key] = pos[2] ? [Math.round(pos[0]), Math.round(pos[1]), 1] : [Math.round(pos[0]), Math.round(pos[1])];
    }
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Links helpers (undirected pairs are stored in canonical order)
// ---------------------------------------------------------------------------
export function cmpCodepoints(a, b) {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}
export const orderPair = (a, b) => (cmpCodepoints(a, b) <= 0 ? [a, b] : [b, a]);
export const linkKey = (a, b) => orderPair(a, b).join('\u0000');

// ---------------------------------------------------------------------------
// Canonical text serialisation
// ---------------------------------------------------------------------------
function compactKanji(k) {
  const o = {};
  if (k.on?.length) o.on = k.on;
  if (k.kun?.length) o.kun = k.kun;
  if (k.notes) o.notes = k.notes;
  if (k.color && k.color !== DEFAULT_COLORS.kanji) o.color = k.color;
  return o;
}

function compactWord(w) {
  const o = { reading: w.reading || '' };
  if (w.meaning) o.meaning = w.meaning;
  if (w.tags?.length) o.tags = w.tags;
  if (w.notes) o.notes = w.notes;
  if (w.color && w.color !== DEFAULT_COLORS.word) o.color = w.color;
  return o;
}

const j = (v) => JSON.stringify(v);
// [x, y] or [x, y, 1] (pinned), always whole numbers.
const posOut = (p) => (p[2] ? [Math.round(p[0]), Math.round(p[1]), 1] : [Math.round(p[0]), Math.round(p[1])]);

function block(open, close, lines, indent) {
  if (!lines.length) return open + close;
  const pad = '  '.repeat(indent + 1);
  return `${open}\n${lines.map((l) => pad + l).join(',\n')}\n${'  '.repeat(indent)}${close}`;
}

const sortedKeys = (obj) => Object.keys(obj).sort(cmpCodepoints);

function wordOrder(words) {
  return Object.keys(words).sort(
    (a, b) => cmpCodepoints(words[a].reading || '', words[b].reading || '') || cmpCodepoints(a, b)
  );
}

// Each section serialiser returns the text of that section at the given indent level.
export const sectionText = {
  kanji: (doc, ind = 0) =>
    block('{', '}', sortedKeys(doc.kanji).map((k) => `${j(k)}: ${j(compactKanji(doc.kanji[k]))}`), ind),
  words: (doc, ind = 0) =>
    block('{', '}', wordOrder(doc.words).map((k) => `${j(k)}: ${j(compactWord(doc.words[k]))}`), ind),
  links: (doc, ind = 0) =>
    block(
      '[',
      ']',
      [...doc.links]
        .sort((x, y) => cmpCodepoints(x[0], y[0]) || cmpCodepoints(x[1], y[1]))
        .map((l) => j(l)),
      ind
    ),
  layout: (doc, ind = 0) => {
    const sec = (name) =>
      block('{', '}', sortedKeys(doc.layout[name]).map((k) => `${j(k)}: ${j(posOut(doc.layout[name][k]))}`), ind + 1);
    return block('{', '}', [`"kanji": ${sec('kanji')}`, `"words": ${sec('words')}`], ind);
  },
};

// Text of a standalone data file (site/data/<section>.json).
export const fileText = (doc, section) => sectionText[section](doc, 0) + '\n';

// Text of a whole bundle (export file / JSON editor / share payload).
export function bundleText(doc) {
  const parts = [`"schema": ${SCHEMA_VERSION}`];
  for (const s of ['kanji', 'words', 'links', 'layout']) parts.push(`${j(s)}: ${sectionText[s](doc, 1)}`);
  return block('{', '}', parts, 0) + '\n';
}

// ---------------------------------------------------------------------------
// Legacy (v1 primaryNodes) migration
// ---------------------------------------------------------------------------
// Returns { doc, idMap } where idMap maps old node ids ("p-kou", "s-kouzou") to
// new ids ("k:構", "w:構造") so per-node state such as SRS progress can follow.
export function migrateLegacy(raw) {
  const doc = emptyDoc();
  const idMap = {};
  const primaries = Array.isArray(raw?.primaryNodes) ? raw.primaryNodes : [];
  const pendingLinks = [];

  for (const p of primaries) {
    const label = str(p?.label).trim();
    if (!label) continue;
    idMap[p.id] = `k:${label}`;
    if (doc.kanji[label]) continue;
    const notes = p.notes === '自動作成された親漢字' ? '' : str(p.notes);
    doc.kanji[label] = { on: splitReadings(p.onyomi), kun: splitReadings(p.kunyomi), notes };
    if (p.color && p.color !== DEFAULT_COLORS.kanji) doc.kanji[label].color = p.color;
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) doc.layout.kanji[label] = [Math.round(p.x), Math.round(p.y)];
  }

  for (const p of primaries) {
    for (const c of Array.isArray(p?.connections) ? p.connections : []) {
      if (!c || !c.id) continue; // { refId } stubs carry nothing: parents are derived now
      const label = str(c.label).trim();
      if (!label) continue;
      const reading = str(c.reading).trim();
      let key = label;
      if (doc.words[key] && doc.words[key].reading !== reading) key = `${label}#${reading}`;
      idMap[c.id] = `w:${key}`;
      if (!doc.words[key]) {
        doc.words[key] = {
          reading,
          tags: (Array.isArray(c.tags) ? c.tags : []).filter((t) => TAG_IDS.has(t)),
          notes: str(c.notes),
        };
        if (c.color && c.color !== DEFAULT_COLORS.word) doc.words[key].color = c.color;
        if (Number.isFinite(c.x) && Number.isFinite(c.y)) doc.layout.words[key] = [Math.round(c.x), Math.round(c.y)];
      }
      for (const l of Array.isArray(c.linksTo) ? c.linksTo : []) {
        const target = typeof l === 'string' ? l : l?.targetId;
        if (target) pendingLinks.push([c.id, target, typeof l === 'object' ? l.type : 'related']);
      }
    }
  }

  const raw2 = { ...doc, links: [] };
  for (const [a, b, type] of pendingLinks) {
    const ka = idMap[a]?.slice(2);
    const kb = idMap[b]?.slice(2);
    if (ka && kb && idMap[a].startsWith('w:') && idMap[b].startsWith('w:')) raw2.links.push([ka, kb, type]);
  }
  return { doc: normalize(raw2), idMap };
}

// Accept either format; always returns { doc, idMap|null }.
export function fromAny(raw) {
  if (isLegacy(raw)) return migrateLegacy(raw);
  return { doc: normalize(raw), idMap: null };
}
