// Example sentences on words: { ja, reading?, en? } (Japanese, kana reading, translation).
// Shared by the schema, the inspector, the drill, the Anki import and the clean-up tool.

import { escapeHtml, extractKanji, labelOf } from './util.js';

const MAX_EXAMPLES = 8; // per word

const str = (v) => (v == null ? '' : String(v).trim());

// Anything example-shaped → clean list (no empty sentences, no duplicates).
export function normalizeExamples(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const e of raw) {
    const ja = str(typeof e === 'string' ? e : e?.ja);
    if (!ja || seen.has(ja)) continue;
    seen.add(ja);
    const ex = { ja };
    const reading = str(e?.reading);
    const en = str(e?.en);
    if (reading) ex.reading = reading;
    if (en) ex.en = en;
    out.push(ex);
    if (out.length >= MAX_EXAMPLES) break;
  }
  return out;
}

// The part of a word that survives conjugation: 食べる → 食べ, 高い → 高, 学校 → 学校.
function stemOf(label) {
  if (!extractKanji(label).length) return label;
  return label.replace(/[\p{Script=Hiragana}]$/u, '');
}

// Where the word appears in the sentence (as written, else its stem), or null.
function findIn(ja, label) {
  let i = ja.indexOf(label);
  if (i >= 0) return [i, label.length];
  const stem = stemOf(label);
  if (stem !== label && [...stem].length >= 2) {
    i = ja.indexOf(stem);
    if (i >= 0) return [i, stem.length];
  }
  return null;
}

// Sentence HTML with the word in it highlighted.
export function highlightHtml(ja, label) {
  const at = label ? findIn(ja, label) : null;
  if (!at) return escapeHtml(ja);
  const [i, n] = at;
  return `${escapeHtml(ja.slice(0, i))}<mark>${escapeHtml(ja.slice(i, i + n))}</mark>${escapeHtml(ja.slice(i + n))}`;
}

// Read-only list (inspector summary, drill answer).
export function examplesHtml(list, label, { limit = 3 } = {}) {
  if (!list?.length) return '';
  return `<ul class="example-list">${list
    .slice(0, limit)
    .map(
      (e) => `<li class="example">
        <div class="example-ja" lang="ja">${highlightHtml(e.ja, label)}</div>
        ${e.reading ? `<div class="example-reading" lang="ja">${escapeHtml(e.reading)}</div>` : ''}
        ${e.en ? `<div class="example-en" lang="en">${escapeHtml(e.en)}</div>` : ''}
      </li>`
    )
    .join('')}</ul>`;
}

// Adds an example to a word (mutates doc). false if it was already there.
export function addExample(doc, key, ex) {
  const w = doc.words[key];
  if (!w || !ex?.ja) return false;
  w.examples ||= [];
  if (w.examples.some((e) => e.ja === ex.ja) || w.examples.length >= MAX_EXAMPLES) return false;
  w.examples.push(normalizeExamples([ex])[0]);
  return true;
}

// Which of the doc's words a sentence is an example of: words with kanji that appear in
// it, longest first, leaving out words inside a longer match (日本 inside 日本人).
export function wordsInSentence(doc, ja, { limit = 3 } = {}) {
  const hits = [];
  for (const key of Object.keys(doc.words)) {
    const label = labelOf(key);
    if (!extractKanji(label).length || label === ja) continue;
    if (findIn(ja, label)) hits.push(key);
  }
  hits.sort((a, b) => labelOf(b).length - labelOf(a).length);
  const kept = [];
  for (const key of hits) {
    const label = labelOf(key);
    if (kept.some((k) => labelOf(k).includes(label))) continue;
    kept.push(key);
    if (kept.length >= limit) break;
  }
  return kept;
}

// Does this look like a sentence rather than a word? Sentence punctuation; or a long
// run with a particle between kanji (山下先生は日本人で); or a short-ish one whose
// meaning reads like an English sentence ("Professor Yamashita is Japanese.").
const PARTICLE_BETWEEN = /[\p{Script=Han}々][はがをにでとへもや][\p{Script=Han}\p{Script=Katakana}]/u;
export function looksLikeSentence(label, meaning = '') {
  const s = String(label);
  const len = [...s].length;
  if (/[。！？!?「」『』]/.test(s)) return true;
  if (len >= 9 && PARTICLE_BETWEEN.test(s)) return true;
  const en = String(meaning).trim();
  const englishSentence = /^[A-Z"'(].*[.!?]["')]?$/.test(en) && en.split(/\s+/).length >= 4;
  return len >= 5 && englishSentence && PARTICLE_BETWEEN.test(s);
}
