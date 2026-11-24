// Spaced-repetition progress (SM-2 variant), keyed by graph node id ("k:構", "w:構造").
// Kept in its own localStorage key so the vocabulary data stays clean and portable.

import { STORAGE_KEYS } from './constants.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function loadSrs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.SRS) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

export function saveSrs(records) {
  try {
    localStorage.setItem(STORAGE_KEYS.SRS, JSON.stringify(records));
  } catch (_) {}
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
  if (changed) saveSrs(records);
}

export const freshRecord = () => ({ reps: 0, interval: 0, ease: 2.5, due: 0, lapses: 0 });

// quality: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy
export function nextSm2(record, quality, now = Date.now()) {
  let { reps, interval, ease, lapses } = record;

  if (quality === 1) {
    return { reps: 0, interval: 0, ease: Math.max(1.3, ease - 0.2), lapses: (lapses || 0) + 1, due: now };
  }

  if (reps === 0) interval = quality === 4 ? 4 : 1;
  else if (reps === 1) interval = quality === 2 ? 2 : quality === 3 ? 6 : 8;
  else {
    const mult = quality === 2 ? 1.2 : quality === 3 ? ease : ease * 1.3;
    interval = Math.max(interval + 1, Math.round(interval * mult));
  }

  if (quality === 2) ease = Math.max(1.3, ease - 0.15);
  if (quality === 4) ease += 0.15;

  return { reps: reps + 1, interval, ease: Number(ease.toFixed(2)), lapses: lapses || 0, due: now + interval * DAY_MS };
}
