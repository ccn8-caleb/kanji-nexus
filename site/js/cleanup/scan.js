// Map clean-up, the pure part: find things worth fixing in a doc and describe a fix
// for each. Nothing here changes the doc until apply() runs (inside store.edit, so the
// whole clean-up is one undo step). cleanup/ui.js shows the suggestions.
//
// Groups (each item: { id, key, …suggestion }):
//   sentences    word nodes that are really sentences → examples of the words they contain
//   kanjiWords   one kanji read in katakana (借 シャク) → that kanji's on'yomi
//   readings     readings that don't fit the spelling → the part that fits / the dictionary's
//   fill         empty readings / meanings / tags → from the dictionary (choice when ambiguous)
//   kanjiReadings kanji with no readings → suggested from their words' readings

import { buildGraph } from '../core/graph.js';
import * as ops from '../core/ops.js';
import { extractKanji, labelOf, toHiragana } from '../core/util.js';
import { looksLikeSentence, wordsInSentence, addExample } from '../core/examples.js';
import { pickReading } from '../import/anki-parse.js';

const KATAKANA = /^[ァ-ヺー]+$/;
const hasKanji = (s) => extractKanji(s).length > 0;

// lookup(word) → entries[] | null (dictionary missing). meaningText/tagsFor from core/dict.js.
export async function scan(doc, { lookup, meaningText, tagsFor, onProgress = () => {} }) {
  const groups = { sentences: [], kanjiWords: [], readings: [], fill: [], kanjiReadings: [] };
  const taken = new Set(); // word keys already claimed by an earlier group

  // 1. Sentences
  const sentenceKeys = Object.keys(doc.words).filter((k) => looksLikeSentence(labelOf(k), doc.words[k].meaning));
  const sentenceSet = new Set(sentenceKeys);
  for (const key of sentenceKeys) {
    const w = doc.words[key];
    const ja = labelOf(key);
    const targets = wordsInSentence(doc, ja, { limit: 3 }).filter((k) => !sentenceSet.has(k));
    groups.sentences.push({ id: `s:${key}`, key, ja, reading: w.reading, en: w.meaning, targets });
    taken.add(key);
  }

  // 2. One kanji with a katakana reading
  for (const [key, w] of Object.entries(doc.words)) {
    const label = labelOf(key);
    if (taken.has(key) || [...label].length !== 1 || !hasKanji(label) || !KATAKANA.test(w.reading || '')) continue;
    groups.kanjiWords.push({ id: `k:${key}`, key, ch: label, on: w.reading, meaning: w.meaning, exists: Boolean(doc.kanji[label]) });
    taken.add(key);
  }

  // 3/4. Readings that don't fit, and empty fields — both may need the dictionary.
  const needs = [];
  for (const [key, w] of Object.entries(doc.words)) {
    if (taken.has(key)) continue;
    const label = labelOf(key);
    const kanji = hasKanji(label);
    const badReading = kanji && w.reading && pickReading(label, [w.reading]) !== w.reading;
    const empty = (kanji && !w.reading) || !w.meaning;
    if (badReading || empty) needs.push({ key, label, w, badReading });
  }
  const results = new Map();
  let dictionary = true;
  for (let i = 0; i < needs.length; i += 40) {
    onProgress(i, needs.length);
    const chunk = needs.slice(i, i + 40);
    const found = await Promise.all(chunk.map((n) => lookup(n.label).catch(() => [])));
    if (found.includes(null)) {
      dictionary = false;
      break;
    }
    chunk.forEach((n, j) => results.set(n.key, found[j] || []));
  }
  onProgress(needs.length, needs.length);

  for (const { key, label, w, badReading } of needs) {
    const entries = results.get(key) || [];
    if (badReading) {
      // The start of the stored reading that fits, else the dictionary's.
      const fit = pickReading(label, [w.reading]);
      const dict = entries.map((e) => e.r[0]).find((r) => pickReading(label, [r]) === r);
      const next = fit || dict;
      if (next && next !== w.reading) groups.readings.push({ id: `r:${key}`, key, from: w.reading, to: next, source: fit ? 'trim' : 'dictionary' });
      continue;
    }
    if (!entries.length) continue;
    // Choices: the entries whose reading fits (or all, for kana words), best first.
    const want = toHiragana(w.reading || '');
    const choices = entries
      .filter((e) => !hasKanji(label) || e.r.some((r) => pickReading(label, [r]) === r))
      .sort((a, b) => Number(b.r.some((r) => toHiragana(r) === want)) - Number(a.r.some((r) => toHiragana(r) === want)))
      .slice(0, 5)
      .map((e) => ({
        reading: hasKanji(label) && !w.reading ? (e.r.find((r) => toHiragana(r) === want) || e.r[0]) : '',
        meaning: w.meaning ? '' : meaningText(e),
        tags: w.tags.length ? [] : tagsFor(e),
      }))
      .filter((c) => c.reading || c.meaning);
    if (choices.length) groups.fill.push({ id: `f:${key}`, key, label, reading: w.reading, choices, choice: 0 });
  }

  // 5. Kanji with no readings: from the readings of their words (as the inspector suggests).
  const graph = buildGraph(doc);
  for (const [ch, k] of Object.entries(doc.kanji)) {
    if (k.on.length || k.kun.length) continue;
    const s = ops.suggestReadings(graph, `k:${ch}`);
    if (s.on.length || s.kun.length) groups.kanjiReadings.push({ id: `y:${ch}`, ch, on: s.on, kun: s.kun });
  }

  return { groups, dictionary };
}

// Apply the selected items (ids) to doc. Returns counts per group.
export function apply(doc, result, selected) {
  const counts = { sentences: 0, examples: 0, kanjiWords: 0, readings: 0, fill: 0, kanjiReadings: 0 };
  const removed = []; // word keys deleted (for drill progress)
  const pick = (g) => result.groups[g].filter((it) => selected.has(it.id));

  for (const it of pick('sentences')) {
    if (!doc.words[it.key]) continue;
    for (const target of it.targets) if (doc.words[target] && addExample(doc, target, { ja: it.ja, reading: it.reading, en: it.en })) counts.examples++;
    ops.deleteWord(doc, it.key);
    removed.push(it.key);
    counts.sentences++;
  }
  for (const it of pick('kanjiWords')) {
    if (!doc.words[it.key]) continue;
    if (!doc.kanji[it.ch]) ops.addKanji(doc, it.ch);
    const k = doc.kanji[it.ch];
    if (!k.on.includes(it.on)) k.on.push(it.on);
    if (!k.notes && it.meaning) k.notes = it.meaning;
    ops.deleteWord(doc, it.key);
    removed.push(it.key);
    counts.kanjiWords++;
  }
  for (const it of pick('readings')) {
    if (!doc.words[it.key]) continue;
    doc.words[it.key].reading = it.to;
    counts.readings++;
  }
  for (const it of pick('fill')) {
    const w = doc.words[it.key];
    const c = it.choices[it.choice] || it.choices[0];
    if (!w || !c) continue;
    if (!w.reading && c.reading) w.reading = c.reading;
    if (!w.meaning && c.meaning) w.meaning = c.meaning;
    if (!w.tags.length && c.tags.length) w.tags = c.tags;
    counts.fill++;
  }
  for (const it of pick('kanjiReadings')) {
    const k = doc.kanji[it.ch];
    if (!k || k.on.length || k.kun.length) continue;
    k.on = it.on;
    k.kun = it.kun;
    counts.kanjiReadings++;
  }
  return { counts, removed };
}
