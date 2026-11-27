// Anki import, the pure part: text exports, field guessing, field cleanup and how
// notes become words/kanji (and Anki scheduling becomes drill progress).
// No DOM, no storage — anki-ui.js does those; tests can import this directly.
//
// A "source" (from anki-worker.js or parseText) looks like:
//   { format, crt, noteTypes: [{ id, name, fields, count }], decks: [{ id, name, count }],
//     notes: [{ id, mid, did, flds }], sched: { [noteId]: card } }

import { addWord, addKanji } from '../core/ops.js';
import { toHiragana, toKatakana, extractKanji, labelOf } from '../core/util.js';

// ---------------------------------------------------------------------------
// Field cleanup
// ---------------------------------------------------------------------------
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

export function stripHtml(value) {
  return String(value || '')
    .replace(/\[sound:[^\]]*\]/g, '')
    .replace(/<br\s*\/?>|<\/(div|p|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t　]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .trim();
}

// Anki furigana syntax: "日本[にほん]語[ご]", "食[た]べる", " 今日[きょう]".
// Readings may carry pitch annotations after ";" (日本[にほん;k2]).
const FURIGANA = / ?([^ >[\]]+?)\[([^\]]+?)\]/g;
export const hasFurigana = (text) => /\[[^\]]*\p{Script=Hiragana}|\[[^\]]*\p{Script=Katakana}/u.test(text);

export function parseFurigana(text) {
  const s = String(text || '');
  return {
    base: s.replace(FURIGANA, '$1').replace(/\s+/g, ''),
    reading: s.replace(FURIGANA, (_, base, r) => r.split(/[;；]/)[0]).replace(/\s+/g, ''),
  };
}

const JAPANESE_WORD = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆ヶ〇・～〜０-９Ａ-Ｚａ-ｚ]+$/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
// "見る、観る" / "行く; 往く" → the first spelling
const firstVariant = (s) => String(s).split(/[、,;，；/／|｜\n]/)[0].trim();
const onlyKana = (s) => [...String(s)].filter((c) => KANA.test(c)).join('');
const splitList = (s) => stripHtml(s).split(/[、,;，；・/／\s]+/).map((x) => x.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Text exports (File → Export → "Notes in Plain Text" / CSV / TSV)
// ---------------------------------------------------------------------------
const SEPARATORS = { tab: '\t', comma: ',', semicolon: ';', space: ' ', pipe: '|', colon: ':' };

export function parseText(text, name = 'text') {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const header = {};
  while (lines.length && lines[0].startsWith('#')) {
    const m = lines.shift().match(/^#([^:]+):(.*)$/);
    if (m) header[m[1].trim().toLowerCase()] = m[2];
  }
  const body = lines.join('\n');
  let sep = header.separator !== undefined ? (SEPARATORS[header.separator.toLowerCase()] ?? header.separator) : null;
  if (!sep) {
    const sample = lines.slice(0, 20).join('\n');
    const count = (c) => sample.split(c).length;
    sep = ['\t', ';', ','].reduce((a, b) => (count(b) > count(a) ? b : a), '\t');
  }
  const rows = parseDelimited(body, sep).filter((r) => r.some((c) => c.trim()));
  const width = Math.max(0, ...rows.map((r) => r.length));

  // Column names: #columns header, a header-looking first row, or "Column n".
  const special = {};
  for (const [key, label] of [['tags column', 'Tags'], ['notetype column', 'Note type'], ['deck column', 'Deck'], ['guid column', 'GUID']]) {
    if (header[key]) special[Number(header[key]) - 1] = label;
  }
  let fields = Array.from({ length: width }, (_, i) => special[i] || `Column ${i + 1}`);
  if (header.columns) {
    header.columns.split(sep).forEach((c, i) => (fields[i] = c.trim() || fields[i]));
  } else if (rows.length > 1 && rows[0].every((c) => !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(c)) && rows.slice(1, 6).some((r) => r.some((c) => /[\p{Script=Han}\p{Script=Hiragana}]/u.test(c)))) {
    fields = fields.map((f, i) => rows[0][i]?.trim() || f);
    rows.shift();
  }
  const notes = rows.map((r, i) => ({ id: String(i), mid: 'text', did: '', flds: fields.map((_, j) => r[j] ?? '') }));
  return {
    format: 'text',
    crt: 0,
    noteTypes: [{ id: 'text', name, fields, count: notes.length }],
    decks: [],
    notes,
    sched: {},
    html: header.html ? header.html.trim() === 'true' : true,
  };
}

// RFC 4180-ish: quotes around fields, "" inside quotes, newlines inside quotes.
function parseDelimited(text, sep) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') (cell += '"'), i++;
        else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) row.push(cell), (cell = '');
    else if (c === '\n') row.push(cell), rows.push(row), (row = []), (cell = '');
    else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows;
}

// ---------------------------------------------------------------------------
// Guessing which field is which
// ---------------------------------------------------------------------------
const norm = (name) => String(name).toLowerCase().replace(/[\s_\-:.()]/g, '');
const IGNORE = /sentence|example|audio|sound|image|picture|pitch|frequency|freq|tags?$|guid|deck|notetype|sort|stroke|mnemonic|hint|note$|notes$|^id$|number|index|order|context/;
const NAME_RULES = {
  word: [/^(word|expression|vocab|vocabulary|vocabkanji|vocabularykanji|term|japanese|front|focus|target|key|単語|語彙|言葉|表現|見出し)$/, /(?<!key)word|expression|vocab|単語|語彙/],
  kanji: [/^(kanji|character|char|漢字)$/],
  reading: [/^(reading|kana|hiragana|yomi|読み|よみ|かな|ひらがな)$/, /reading|kana|yomi|読み|よみ/],
  furigana: [/furigana|ふりがな|ruby/],
  meaning: [/^(meaning|english|definition|gloss|glossary|translation|keyword|back|意味|英訳|英語)$/, /meaning|english|definition|gloss|translation|意味/],
  on: [/^(onyomi|on|音読み|音)$/, /onyomi|音読/],
  kun: [/^(kunyomi|kun|訓読み|訓)$/, /kunyomi|訓読/],
};

function fieldStats(notes, index) {
  const s = { kanji: 0, kanaOnly: 0, latin: 0, single: 0, furigana: 0, filled: 0, len: 0 };
  for (const n of notes) {
    const raw = n.flds[index] || '';
    const v = stripHtml(raw);
    if (!v) continue;
    s.filled++;
    s.len += v.length;
    if (hasFurigana(v)) s.furigana++;
    if (/\p{Script=Han}/u.test(v)) s.kanji++;
    if (JAPANESE_WORD.test(v) && !/\p{Script=Han}/u.test(v)) s.kanaOnly++;
    if (/^[\x20-\x7e‘-”]+$/.test(v) && /[a-z]/i.test(v)) s.latin++;
    if ([...v].length === 1 && /\p{Script=Han}/u.test(v)) s.single++;
  }
  const f = s.filled || 1;
  return { kanji: s.kanji / f, kanaOnly: s.kanaOnly / f, latin: s.latin / f, single: s.single / f, furigana: s.furigana / f, filled: s.filled / Math.max(notes.length, 1), avgLen: s.len / f };
}

// → { mode: 'word'|'kanji', word, reading, furigana, meaning, on, kun } (field indexes, -1 = none)
export function guessMapping(noteType, notes) {
  const sample = notes.filter((n) => n.mid === noteType.id).slice(0, 300);
  const names = noteType.fields.map(norm);
  const stats = noteType.fields.map((_, i) => fieldStats(sample, i));
  const used = new Set();
  // Fields named like the word field ("Vocabulary-Kanji" → "Vocabulary-Kana") come first:
  // decks often have a second, sentence-level "Reading"/"Meaning".
  let prefix = '';
  const byName = (role, rules = NAME_RULES[role]) => {
    if (prefix) {
      const i = names.findIndex((n, j) => !used.has(j) && n.startsWith(prefix) && NAME_RULES[role].some((r) => r.test(n.slice(prefix.length))) && stats[j].filled > 0);
      if (i >= 0) return i;
    }
    for (const rule of rules) {
      const i = names.findIndex((n, j) => !used.has(j) && rule.test(n) && !(IGNORE.test(n) && !NAME_RULES[role][0].test(n)) && stats[j].filled > 0);
      if (i >= 0) return i;
    }
    return -1;
  };
  const best = (score, min) => {
    let pick = -1;
    let top = min;
    stats.forEach((s, i) => {
      if (used.has(i) || IGNORE.test(names[i])) return;
      const v = score(s);
      if (v > top) (top = v), (pick = i);
    });
    return pick;
  };
  const take = (i) => (i >= 0 && used.add(i), i);

  const m = { mode: 'word', word: -1, reading: -1, furigana: -1, meaning: -1, on: -1, kun: -1 };
  // exact word name > exact kanji name > word-ish name
  m.word = take(byName('word', NAME_RULES.word.slice(0, 1)));
  if (m.word < 0) m.word = take(byName('kanji'));
  if (m.word < 0) m.word = take(byName('word'));
  const namedWord = m.word >= 0 && NAME_RULES.word.some((r) => r.test(names[m.word]));
  if (m.word < 0) m.word = take(best((s) => (s.avgLen <= 16 ? s.kanji + s.kanaOnly * 0.5 : 0), 0.3));
  // A kanji deck: one character per note, in a field not named like a vocabulary field.
  if (m.word >= 0 && !namedWord && stats[m.word].single >= 0.8) m.mode = 'kanji';
  if (namedWord) prefix = names[m.word].replace(/(kanji|expression|word)$/, '') || names[m.word];

  if (m.mode === 'kanji') {
    m.on = take(byName('on'));
    m.kun = take(byName('kun'));
  }
  m.furigana = take(byName('furigana'));
  m.reading = take(byName('reading'));
  if (m.reading < 0 && m.mode === 'word') m.reading = take(best((s) => s.kanaOnly + s.furigana, 0.5));
  m.meaning = take(byName('meaning'));
  if (m.meaning < 0) m.meaning = take(best((s) => (s.avgLen < 200 ? s.latin : 0), 0.5));
  return m;
}

// ---------------------------------------------------------------------------
// Note → entry
// ---------------------------------------------------------------------------
// Word mode → { kind: 'word', label, reading, meaning } ; kanji mode → { kind: 'kanji', ch, on, kun, meaning }
// null when the note has no usable Japanese in the main field (e.g. a "welcome" note).
export function noteToEntry(note, m) {
  const get = (i) => (i >= 0 ? note.flds[i] ?? '' : '');
  const meaning = stripHtml(get(m.meaning)).replace(/\n+/g, '; ').slice(0, 300);
  let main = stripHtml(get(m.word));
  let readingFromMain = '';
  if (hasFurigana(main)) {
    const f = parseFurigana(main);
    main = f.base;
    readingFromMain = f.reading;
  }
  main = firstVariant(main).replace(/\s+/g, '');

  if (m.mode === 'kanji') {
    const ch = extractKanji(main)[0];
    if (!ch) return null;
    return { kind: 'kanji', ch, on: splitList(get(m.on)).map((x) => toKatakana(onlyKana(x))).filter(Boolean), kun: splitList(get(m.kun)).map((x) => toHiragana(x.replace(/[^\p{Script=Hiragana}\p{Script=Katakana}ー.\-]/gu, ''))).filter(Boolean), meaning };
  }

  if (!main || [...main].length > 16 || !JAPANESE_WORD.test(main)) return null;
  let reading = '';
  const readingField = stripHtml(get(m.reading));
  if (readingField) reading = onlyKana(firstVariant(hasFurigana(readingField) ? parseFurigana(readingField).reading : readingField));
  if (!reading && m.furigana >= 0) {
    const f = parseFurigana(firstVariant(stripHtml(get(m.furigana))));
    if (f.base.replace(/\s/g, '') === main || !extractKanji(f.base).length || extractKanji(main).every((k) => f.base.includes(k))) reading = onlyKana(f.reading);
  }
  if (!reading && readingFromMain) reading = onlyKana(readingFromMain);
  if (!reading && !extractKanji(main).length) reading = main; // kana word
  return { kind: 'word', label: main, reading, meaning };
}

// ---------------------------------------------------------------------------
// Anki scheduling → drill progress (core/srs.js record), or null for new cards.
// card: { type, queue, due, ivl, factor, reps, lapses }; crt = collection creation (unix s)
// ---------------------------------------------------------------------------
const DAY_MS = 86_400_000;
export function schedToSrs(card, crt, now = Date.now()) {
  if (!card || card.type === 0) return null;
  const ease = card.factor ? Math.min(3.5, Math.max(1.3, card.factor / 1000)) : 2.5;
  const lapses = card.lapses || 0;
  if (card.type === 2) {
    const due = (crt + card.due * 86_400) * 1000;
    return { reps: Math.max(2, Math.min(card.reps || 0, 99)), interval: Math.max(1, card.ivl), ease: Number(ease.toFixed(2)), lapses, due: Number.isFinite(due) ? due : now };
  }
  // learning (1) / relearning (3): due is a timestamp in the intraday queue, else a day number
  const due = card.queue === 1 ? card.due * 1000 : (crt + card.due * 86_400) * 1000;
  return { reps: 0, interval: 0, ease: Number(ease.toFixed(2)), lapses, due: Number.isFinite(due) && due > 0 ? Math.min(due, now + DAY_MS) : now };
}

// Keep whichever record is further along.
export const moreAdvanced = (a, b) => (!a ? b : !b ? a : b.interval > a.interval || (b.interval === a.interval && b.reps > a.reps) ? b : a);

// ---------------------------------------------------------------------------
// Entries → doc. Mutates doc; returns counts and, per entry, the node id it became
// (for drill progress). Same spelling + same (or unknown) reading = same word;
// same spelling with another reading = a homograph keyed "label#reading".
// ---------------------------------------------------------------------------
export function applyEntries(doc, entries, { linkDerivatives = true } = {}) {
  const stats = { added: 0, updated: 0, kanjiAdded: 0, homographs: 0 };
  const ids = [];
  const byLabel = new Map();
  for (const key of Object.keys(doc.words)) {
    const label = labelOf(key);
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(key);
  }
  const kanjiBefore = Object.keys(doc.kanji).length;
  const created = new Set(); // words made by this import: a second note with the same word adds its sense
  for (const e of entries) {
    if (!e) {
      ids.push(null);
      continue;
    }
    if (e.kind === 'kanji') {
      const k = doc.kanji[e.ch];
      if (k) {
        if (!k.on.length) k.on = e.on;
        if (!k.kun.length) k.kun = e.kun;
        if (!k.notes && e.meaning) k.notes = e.meaning;
        stats.updated++;
      } else {
        addKanji(doc, e.ch, { on: e.on, kun: e.kun, notes: e.meaning });
        stats.added++;
      }
      ids.push(`k:${e.ch}`);
      continue;
    }
    const keys = byLabel.get(e.label) || [];
    const same = (r) => !r || !e.reading || toHiragana(r) === toHiragana(e.reading);
    const match = keys.find((k) => same(doc.words[k].reading));
    if (match) {
      const w = doc.words[match];
      if (!w.reading && e.reading) w.reading = e.reading;
      if (!w.meaning && e.meaning) w.meaning = e.meaning;
      else if (created.has(match) && e.meaning && !w.meaning.split('; ').includes(e.meaning)) w.meaning = `${w.meaning}; ${e.meaning}`;
      if (!w.tags.length && e.tags?.length) w.tags = e.tags;
      stats.updated++;
      ids.push(`w:${match}`);
      continue;
    }
    const key = keys.length ? `${e.label}#${e.reading}` : e.label;
    if (keys.length) stats.homographs++;
    addWord(doc, key, { reading: e.reading, meaning: e.meaning, tags: e.tags || [] }, { createKanji: true, linkDerivatives });
    byLabel.set(e.label, [...keys, key]);
    created.add(key);
    stats.added++;
    ids.push(`w:${key}`);
  }
  stats.kanjiAdded = Object.keys(doc.kanji).length - kanjiBefore - (entries.some((e) => e?.kind === 'kanji') ? stats.added : 0);
  return { stats, ids };
}
