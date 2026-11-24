// Map layout: pure functions over doc.layout (no DOM), so they can also run in Node
// (e.g. to regenerate data/layout.json for the starter sample).

import { buildGraph, keyOf } from '../../core/graph.js';

const section = (id) => (id.startsWith('k:') ? 'kanji' : 'words');
export const getPos = (doc, id) => doc.layout[section(id)][keyOf(id)] || null;
export const setPos = (doc, id, x, y) => {
  doc.layout[section(id)][keyOf(id)] = [Math.round(x), Math.round(y)];
};

export function occupied(doc, excludeId = null) {
  const out = [];
  for (const sec of ['kanji', 'words']) {
    const prefix = sec === 'kanji' ? 'k:' : 'w:';
    for (const [key, [x, y]] of Object.entries(doc.layout[sec])) {
      if (prefix + key !== excludeId) out.push({ x, y });
    }
  }
  return out;
}

// Nearest spot to (tx, ty) at least `clearance` away from every other node (spiral search).
export function findFreePosition(doc, tx, ty, { excludeId = null, clearance = 105 } = {}) {
  const occ = occupied(doc, excludeId);
  const clear = (x, y) => occ.every((o) => Math.hypot(o.x - x, o.y - y) >= clearance);
  if (clear(tx, ty)) return { x: Math.round(tx), y: Math.round(ty) };
  for (let step = 1; step <= 80; step++) {
    const angle = step * 0.65;
    const radius = 36 + step * 14;
    const x = Math.round(tx + Math.cos(angle) * radius * 1.25);
    const y = Math.round(ty + Math.sin(angle) * radius * 0.9);
    if (clear(x, y)) return { x, y };
  }
  return { x: Math.round(tx + 120), y: Math.round(ty + 120) };
}

function centroid(points) {
  return {
    x: points.reduce((a, p) => a + p[0], 0) / points.length,
    y: points.reduce((a, p) => a + p[1], 0) / points.length,
  };
}

// Natural resting spot for a word: between its parent kanji (or below a single parent).
export function wordAnchor(doc, graph, wid, fallback) {
  const pts = (graph.parents.get(wid) || []).map((pid) => getPos(doc, pid)).filter(Boolean);
  if (!pts.length) return fallback;
  const c = centroid(pts);
  return { x: c.x, y: c.y + (pts.length === 1 ? 110 : 0) };
}

// Kanji with no position go beside a sibling kanji (one sharing a word); words go
// between their parents. Returns how many nodes were placed.
export function placeMissing(doc, center = { x: 0, y: 0 }) {
  const graph = buildGraph(doc);
  let placed = 0;

  for (const k of graph.kanji.values()) {
    if (getPos(doc, k.id)) continue;
    let anchor = null;
    for (const wid of graph.children.get(k.id)) {
      for (const pid of graph.parents.get(wid)) {
        if (pid !== k.id && getPos(doc, pid)) anchor ||= getPos(doc, pid);
      }
    }
    const base = anchor ? { x: anchor[0] + 240, y: anchor[1] } : center;
    const pos = findFreePosition(doc, base.x, base.y);
    setPos(doc, k.id, pos.x, pos.y);
    placed++;
  }

  for (const w of graph.words.values()) {
    if (getPos(doc, w.id)) continue;
    const base = wordAnchor(doc, graph, w.id, center);
    const pos = findFreePosition(doc, base.x, base.y, { excludeId: w.id, clearance: 95 });
    setPos(doc, w.id, pos.x, pos.y);
    placed++;
  }
  return placed;
}

// 3-tier cluster arrangement:
//   top    — clusters with 3+ kanji, hub kanji in the middle, others on a ring
//   middle — 2-kanji pairs in a 6-column grid
//   bottom — single-kanji islands, then words with no registered kanji
export function autoArrange(doc) {
  const graph = buildGraph(doc);
  doc.layout = { kanji: {}, words: {} };
  const clusters = graph.clusters();
  const degree = (kid) => graph.children.get(kid).length;

  const multi = clusters.filter((c) => c.kanji.length >= 3);
  const pairs = clusters.filter((c) => c.kanji.length === 2);
  const singles = clusters.filter((c) => c.kanji.length <= 1);
  const orphans = [...graph.words.values()].filter((w) => !graph.parents.get(w.id).length);

  // Zone 1
  let zoneX = -((multi.length - 1) * 620) / 2;
  const zoneY = -620;
  for (const { kanji, words } of multi) {
    const sorted = [...kanji].sort((a, b) => degree(b.id) - degree(a.id));
    const [hub, ...satellites] = sorted;
    setPos(doc, hub.id, zoneX, zoneY);
    const radius = Math.max(240, satellites.length * 46);
    satellites.forEach((k, i) => {
      const angle = (2 * Math.PI * i) / satellites.length - Math.PI / 2;
      setPos(doc, k.id, zoneX + Math.cos(angle) * radius, zoneY + Math.sin(angle) * radius);
    });
    words.forEach((w, i) => {
      const parents = graph.parents.get(w.id).map((pid) => getPos(doc, pid));
      let target;
      if (parents.length >= 2) target = centroid(parents);
      else {
        const angle = i * 0.9 + Math.PI / 3;
        target = { x: parents[0][0] + Math.cos(angle) * 125, y: parents[0][1] + Math.sin(angle) * 125 };
      }
      const pos = findFreePosition(doc, target.x, target.y, { excludeId: w.id, clearance: 95 });
      setPos(doc, w.id, pos.x, pos.y);
    });
    zoneX += Math.max(620, radius * 2 + 220);
  }

  // Zone 2
  const cols = 6;
  const startX = -((cols - 1) * 480) / 2;
  const pairY = multi.length ? 40 : -320;
  pairs.forEach(({ kanji, words }, idx) => {
    const cx = startX + (idx % cols) * 480;
    const cy = pairY + Math.floor(idx / cols) * 240;
    setPos(doc, kanji[0].id, cx - 115, cy);
    setPos(doc, kanji[1].id, cx + 115, cy);
    let shared = 0;
    const below = new Map();
    for (const w of words) {
      const parents = graph.parents.get(w.id);
      if (parents.length >= 2) setPos(doc, w.id, cx, cy + shared++ * 68);
      else {
        const p = getPos(doc, parents[0]);
        const n = below.get(parents[0]) || 0;
        below.set(parents[0], n + 1);
        setPos(doc, w.id, p[0], p[1] + 105 + n * 60);
      }
    }
  });

  // Zone 3
  const pairRows = Math.ceil(pairs.length / cols);
  const singleY = pairY + pairRows * 240 + (pairRows ? 80 : 0);
  singles.forEach(({ kanji, words }, idx) => {
    const cx = startX + (idx % cols) * 480;
    const cy = singleY + Math.floor(idx / cols) * 230;
    if (kanji[0]) setPos(doc, kanji[0].id, cx, cy - 45);
    words.forEach((w, i) => setPos(doc, w.id, cx + i * 110, cy + 65));
  });

  const singleRows = Math.ceil(singles.length / cols);
  const orphanY = singleY + singleRows * 230 + 40;
  orphans.forEach((w, i) => setPos(doc, w.id, startX + (i % cols) * 160, orphanY + Math.floor(i / cols) * 80));
}
