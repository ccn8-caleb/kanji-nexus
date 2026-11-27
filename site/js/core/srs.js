// Spaced-repetition progress (SM-2 variant), keyed by graph node id ("k:構", "w:構造").
// Kept in its own localStorage key so the vocabulary data stays clean and portable.
//
// Record: { reps, interval, ease, due, lapses, at? }. `at` is when the card was last
// reviewed (records from before 0.6.4 have none). It lets two devices' progress merge
// card by card: the later review already contains the earlier history.
// A reset is remembered as `resetAt` so a sync can't bring older reviews back.

import { STORAGE_KEYS } from './constants.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const META_KEY = 'kanji_nexus_srs_meta'; // { resetAt }

export function loadSrs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.SRS) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

export function loadSrsMeta() {
  try {
    return { resetAt: 0, ...JSON.parse(localStorage.getItem(META_KEY) || '{}') };
  } catch (_) {
    return { resetAt: 0 };
  }
}

// ---------------------------------------------------------------------------
// Change notifications: this tab (custom event) and other tabs (storage event).
// source: 'drill' | 'import' | 'reset' | 'sync' | 'other-tab' | …
// ---------------------------------------------------------------------------
const EVENT = 'kanji-nexus:srs';
export function onSrsChange(fn) {
  window.addEventListener(EVENT, (e) => fn(e.detail));
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEYS.SRS || e.key === META_KEY) fn({ source: 'other-tab' });
  });
}

export function saveSrs(records, { source = 'other', resetAt } = {}) {
  try {
    localStorage.setItem(STORAGE_KEYS.SRS, JSON.stringify(records));
    if (resetAt !== undefined) localStorage.setItem(META_KEY, JSON.stringify({ resetAt }));
  } catch (_) {}
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { source } }));
}

export function resetSrs() {
  saveSrs({}, { source: 'reset', resetAt: Date.now() });
}

// Re-key progress after ids change (legacy migration or renames). Unmapped ids are kept.
export function remapSrs(idMap) {
  const entries = Object.entries(idMap || {});
  if (!entries.length) return;
  const records = loadSrs();
  let changed = false;
  for (const [from, to] of entries) {
    if (from in records && from !== to) {
      if (!(to in records)) records[to] = records[from];
      delete records[from];
      changed = true;
    }
  }
  if (changed) saveSrs(records, { source: 'remap' });
}

export const freshRecord = () => ({ reps: 0, interval: 0, ease: 2.5, due: 0, lapses: 0 });

// Further along: longer interval, then more reviews.
export const moreAdvanced = (a, b) => (!a ? b : !b ? a : b.interval > a.interval || (b.interval === a.interval && b.reps > a.reps) ? b : a);

// Which of two records for the same card wins: the later review; records without a
// review time are older than any that have one; neither has one → further along.
export function newerRecord(a, b) {
  if (!a || !b) return a || b;
  if (a.at || b.at) return (b.at || 0) > (a.at || 0) ? b : a;
  return moreAdvanced(a, b);
}

// Merge two progress sets (e.g. this device and Drive). Pure.
//   → { records, resetAt }: the later reset wins and drops every review before it.
export function mergeSrs(a, b) {
  const resetAt = Math.max(a.resetAt || 0, b.resetAt || 0);
  const records = {};
  for (const id of new Set([...Object.keys(a.records || {}), ...Object.keys(b.records || {})])) {
    const rec = newerRecord(a.records?.[id], b.records?.[id]);
    if (rec && (!resetAt || (rec.at || 0) >= resetAt)) records[id] = rec;
  }
  return { records, resetAt };
}

// quality: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy
export function nextSm2(record, quality, now = Date.now()) {
  let { reps, interval, ease, lapses } = record;

  if (quality === 1) {
    return { reps: 0, interval: 0, ease: Math.max(1.3, ease - 0.2), lapses: (lapses || 0) + 1, due: now, at: now };
  }

  if (reps === 0) interval = quality === 4 ? 4 : 1;
  else if (reps === 1) interval = quality === 2 ? 2 : quality === 3 ? 6 : 8;
  else {
    const mult = quality === 2 ? 1.2 : quality === 3 ? ease : ease * 1.3;
    interval = Math.max(interval + 1, Math.round(interval * mult));
  }

  if (quality === 2) ease = Math.max(1.3, ease - 0.15);
  if (quality === 4) ease += 0.15;

  return { reps: reps + 1, interval, ease: Number(ease.toFixed(2)), lapses: lapses || 0, due: now + interval * DAY_MS, at: now };
}
