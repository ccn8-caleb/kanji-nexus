// Map layout: pure functions over doc.layout (no DOM), so they also run in Node
// (e.g. to regenerate data/layout.json for the starter sample).
//
// Positions are [x, y] or [x, y, 1] — the third value pins a node: automatic
// layout never moves it. Dragging a node pins it.
//
//   settle(doc, ids)  place new nodes and nudge their neighbours to make room
//   tidy(doc)         organic layout per cluster, clusters packed with even gaps
//
// Both use a force simulation (d3-force): links act as springs, nodes repel each
// other (Barnes–Hut, so it scales), and collisions use each node's real size.

import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from '../../vendor/d3-force.js';
import { buildGraph, keyOf } from '../../core/graph.js';
import { BUILD } from '../../core/version.js';

const section = (id) => (id.startsWith('k:') ? 'kanji' : 'words');
const entryOf = (doc, id) => doc.layout[section(id)][keyOf(id)];

export const getPos = (doc, id) => entryOf(doc, id) || null;
export const isPinned = (doc, id) => Boolean(entryOf(doc, id)?.[2]);

// Keeps an existing pin unless `pin` is given explicitly.
export function setPos(doc, id, x, y, { pin } = {}) {
  const pinned = pin ?? isPinned(doc, id);
  doc.layout[section(id)][keyOf(id)] = pinned ? [Math.round(x), Math.round(y), 1] : [Math.round(x), Math.round(y)];
}

export function setPinned(doc, id, on) {
  const p = getPos(doc, id);
  if (p) setPos(doc, id, p[0], p[1], { pin: on });
}

export function unpinAll(doc) {
  let n = 0;
  for (const sec of ['kanji', 'words']) {
    for (const [k, p] of Object.entries(doc.layout[sec])) {
      if (p[2]) {
        doc.layout[sec][k] = [p[0], p[1]];
        n++;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Node sizes (must roughly match css/map.css): kanji are 64px circles; word
// capsules grow with the label (14px bold) or the reading (11px), whichever is wider.
// ---------------------------------------------------------------------------
const KANJI_R = 32;
export function radiusOf(node) {
  if (node.kind === 'kanji') return KANJI_R;
  const label = [...node.label].length * 15 + 40; // dot + padding
  const reading = [...(node.reading || '')].length * 11.5 + 30;
  return Math.max(label, reading) / 2;
}

// ---------------------------------------------------------------------------
// Forces
// ---------------------------------------------------------------------------
const GAP = 34; // breathing room between a kanji and its words

function simulate(simNodes, simLinks, { ticks = 300, alpha = 1, anchors = null, untangle = false } = {}) {
  // Big graphs: fewer collision passes and a coarser Barnes–Hut approximation.
  const big = simNodes.length > 400;
  const sim = forceSimulation(simNodes)
    .stop()
    .alpha(alpha)
    .alphaDecay(1 - Math.pow(0.001, 1 / ticks))
    .velocityDecay(0.35)
    .force(
      'link',
      forceLink(simLinks)
        .id((d) => d.id)
        .distance((l) => l.source.r + l.target.r + (l.lateral ? GAP * 2.2 : GAP))
        .strength((l) => (l.lateral ? 0.12 : 0.7))
    )
    .force('charge', forceManyBody().strength((d) => (d.kind === 'kanji' ? -380 : -170)).distanceMax(520).theta(big ? 1.2 : 0.9))
    .force('collide', forceCollide((d) => d.r + 10).strength(1).iterations(3));
  if (anchors) {
    // Existing neighbours are tethered to where they were: they shift aside, not travel.
    sim.force('ax', forceX((d) => anchors.get(d.id)?.[0] ?? d.x).strength((d) => (anchors.has(d.id) ? 0.25 : 0)));
    sim.force('ay', forceY((d) => anchors.get(d.id)?.[1] ?? d.y).strength((d) => (anchors.has(d.id) ? 0.25 : 0)));
  } else {
    // Gentle pull to the cluster centre keeps it compact.
    sim.force('gx', forceX(0).strength(0.04)).force('gy', forceY(0).strength(0.04));
  }
  if (untangle) {
    // Phase 1: no collisions, so nodes can pass through each other while the springs
    // and repulsion find the overall structure (far fewer crossing lines).
    const collide = sim.force('collide');
    sim.force('collide', null);
    for (let i = 0; i < Math.round(ticks * 0.6); i++) sim.tick();
    // Phase 2: collisions back on to space everything out.
    sim.force('collide', collide).alpha(Math.max(sim.alpha(), 0.35));
    for (let i = 0; i < Math.round(ticks * 0.5); i++) sim.tick();
  } else {
    for (let i = 0; i < ticks; i++) sim.tick();
  }
  if (big) {
    // Huge clusters: a short collisions-only pass removes the overlaps the coarse
    // main pass leaves behind, without disturbing the overall shape.
    sim.force('link', null).force('charge', null).force('gx', null).force('gy', null).force('ax', null).force('ay', null);
    sim.force('collide').iterations(2);
    sim.alpha(0.3).velocityDecay(0.6);
    for (let i = 0; i < 40; i++) sim.tick();
  }
  return simNodes;
}

// Graph pieces as simulation input.
function simGraph(graph, ids) {
  const set = new Set(ids);
  const nodes = ids.map((id) => {
    const n = graph.node(id);
    return { id, kind: n.kind, r: radiusOf(n) };
  });
  const links = [];
  for (const id of ids) {
    if (!id.startsWith('w:')) continue;
    for (const pid of graph.parents.get(id)) if (set.has(pid)) links.push({ source: pid, target: id });
  }
  for (const l of graph.links) if (set.has(l.a) && set.has(l.b)) links.push({ source: l.a, target: l.b, lateral: true });
  return { nodes, links };
}

// Connected groups for layout: kanji–word edges and lateral links both connect.
function components(graph) {
  const adj = new Map();
  const add = (a, b) => {
    adj.get(a).push(b);
    adj.get(b).push(a);
  };
  for (const id of [...graph.kanji.keys(), ...graph.words.keys()]) adj.set(id, []);
  for (const [wid, pids] of graph.parents) for (const pid of pids) add(wid, pid);
  for (const l of graph.links) add(l.a, l.b);
  const seen = new Set();
  const out = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const cur = queue.shift();
      comp.push(cur);
      for (const n of adj.get(cur)) if (!seen.has(n)) (seen.add(n), queue.push(n));
    }
    out.push({ ids: comp, adj });
  }
  return out;
}

// Nearest spot to (x, y) not covered by another node — for "add here".
export function findFreeSpot(doc, x, y, clearance = 90) {
  const pts = [...Object.values(doc.layout.kanji), ...Object.values(doc.layout.words)];
  const clear = (px, py) => pts.every((p) => Math.hypot(p[0] - px, p[1] - py) >= clearance);
  if (clear(x, y)) return { x, y };
  for (let step = 1; step <= 60; step++) {
    const a = step * 0.7;
    const r = 20 + step * 12;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (clear(px, py)) return { x: px, y: py };
  }
  return { x, y };
}

// ---------------------------------------------------------------------------
// Seeding new nodes
// ---------------------------------------------------------------------------
function freeDirection(doc, cx, cy, dist, prefer = null) {
  // Pick the direction (of 24) whose landing spot is farthest from other nodes,
  // nudged toward `prefer` (an outward angle) when it's comparably free.
  const pts = [...Object.values(doc.layout.kanji), ...Object.values(doc.layout.words)];
  let best = null;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const x = cx + Math.cos(a) * dist;
    const y = cy + Math.sin(a) * dist;
    let clear = Infinity;
    for (const p of pts) clear = Math.min(clear, Math.hypot(p[0] - x, p[1] - y));
    const bias = prefer == null ? 0 : Math.cos(a - prefer) * 25;
    const score = Math.min(clear, 400) + bias;
    if (!best || score > best.score) best = { x, y, score };
  }
  return best;
}

function seed(doc, graph, id, center) {
  const node = graph.node(id);
  if (node.kind === 'kanji') {
    // Beside a kanji it shares a word with, else at the centre.
    for (const wid of graph.children.get(id)) {
      for (const pid of graph.parents.get(wid)) {
        const p = pid !== id && getPos(doc, pid);
        if (p) return freeDirection(doc, p[0], p[1], 2 * KANJI_R + 150);
      }
    }
    return freeDirection(doc, center.x, center.y, 0.001);
  }
  const parents = graph.parents.get(id).map((pid) => getPos(doc, pid)).filter(Boolean);
  if (parents.length >= 2) {
    const cx = parents.reduce((a, p) => a + p[0], 0) / parents.length;
    const cy = parents.reduce((a, p) => a + p[1], 0) / parents.length;
    return { x: cx, y: cy };
  }
  if (parents.length === 1) {
    // Outward: away from the centre of the parent's existing words.
    const [px, py] = parents[0];
    const siblings = graph.children
      .get(graph.parents.get(id)[0])
      .filter((w) => w !== id)
      .map((w) => getPos(doc, w))
      .filter(Boolean);
    const prefer = siblings.length
      ? Math.atan2(py - siblings.reduce((a, p) => a + p[1], 0) / siblings.length, px - siblings.reduce((a, p) => a + p[0], 0) / siblings.length)
      : Math.PI / 2;
    return freeDirection(doc, px, py, KANJI_R + radiusOf(node) + GAP, prefer);
  }
  // A word with no registered kanji: near a linked word, else the centre.
  const linked = graph.linksOf.get(id).map((l) => getPos(doc, l.id)).find(Boolean);
  return linked ? freeDirection(doc, linked[0], linked[1], 140) : freeDirection(doc, center.x, center.y, 0.001);
}

// ---------------------------------------------------------------------------
// settle: place `ids` (new or unpinned nodes) and nudge their neighbours.
// Returns a Map id → previous position ([x,y], or the seed for new nodes) so the
// caller can animate the change.
// ---------------------------------------------------------------------------
const MAX_NUDGED = 30; // neighbours allowed to move per settle (closest first)
const WINDOW = 480; // fixed nodes within this distance still push back
const MAX_FIXED = 200; // …but at most this many (the closest)

export function settle(doc, ids, { center = { x: 0, y: 0 }, ticks = 140 } = {}) {
  const graph = buildGraph(doc);
  ids = ids.filter((id) => graph.node(id));
  const from = new Map();

  // 1. Seeds for nodes without a position (kanji first so words can use them).
  const ordered = [...ids].sort((a, b) => (a.startsWith('k:') ? -1 : 1) - (b.startsWith('k:') ? -1 : 1));
  for (const id of ordered) {
    if (getPos(doc, id)) continue;
    const s = seed(doc, graph, id, center);
    setPos(doc, id, s.x, s.y);
    const parent = graph.parents.get(id)?.map((pid) => getPos(doc, pid)).find(Boolean);
    from.set(id, parent ? [parent[0], parent[1]] : [s.x, s.y]); // new words slide out of their kanji
  }

  // 2. Who may move: the given nodes, plus their direct neighbours (the closest
  //    MAX_NUDGED of them, so a busy hub doesn't drag hundreds of words), unless pinned.
  const movable = new Set(ids.filter((id) => !isPinned(doc, id)));
  const seeds = ids.map((id) => getPos(doc, id));
  const distToNew = (id) => Math.min(...seeds.map((s) => Math.hypot(getPos(doc, id)[0] - s[0], getPos(doc, id)[1] - s[1])));
  const neighbours = new Set();
  for (const id of ids) {
    const list = id.startsWith('k:')
      ? graph.children.get(id).flatMap((w) => [w, ...graph.parents.get(w)])
      : [...graph.parents.get(id).flatMap((k) => [k, ...graph.children.get(k)]), ...graph.linksOf.get(id).map((l) => l.id)];
    for (const n of list) if (!movable.has(n) && !isPinned(doc, n) && getPos(doc, n)) neighbours.add(n);
  }
  [...neighbours]
    .sort((a, b) => distToNew(a) - distToNew(b))
    .slice(0, MAX_NUDGED)
    .forEach((n) => movable.add(n));
  if (!movable.size) return from;

  // 3. Simulate a local window; everything in it that may not move is fixed in place.
  const xs = [...movable].map((id) => getPos(doc, id));
  const [minX, maxX] = [Math.min(...xs.map((p) => p[0])) - WINDOW, Math.max(...xs.map((p) => p[0])) + WINDOW];
  const [minY, maxY] = [Math.min(...xs.map((p) => p[1])) - WINDOW, Math.max(...xs.map((p) => p[1])) + WINDOW];
  const cx = xs.reduce((a, p) => a + p[0], 0) / xs.length;
  const cy = xs.reduce((a, p) => a + p[1], 0) / xs.length;
  const fixedNearby = [...graph.kanji.keys(), ...graph.words.keys()]
    .filter((id) => {
      if (movable.has(id)) return false;
      const p = getPos(doc, id);
      return p && p[0] > minX && p[0] < maxX && p[1] > minY && p[1] < maxY;
    })
    .map((id) => [id, Math.hypot(getPos(doc, id)[0] - cx, getPos(doc, id)[1] - cy)])
    .sort((a, b) => a[1] - b[1])
    .slice(0, MAX_FIXED) // dense maps: the closest few hundred are what matters
    .map(([id]) => id);
  const nearby = [...movable, ...fixedNearby];
  const { nodes, links } = simGraph(graph, nearby);
  const fresh = new Set(ids.filter((id) => from.has(id)));
  const anchors = new Map();
  for (const n of nodes) {
    const p = getPos(doc, n.id);
    n.x = p[0];
    n.y = p[1];
    if (!movable.has(n.id)) (n.fx = p[0]), (n.fy = p[1]);
    else if (!fresh.has(n.id)) anchors.set(n.id, [p[0], p[1]]);
  }
  simulate(nodes, links, { ticks, alpha: 0.6, anchors });

  for (const n of nodes) {
    if (!movable.has(n.id)) continue;
    const p = getPos(doc, n.id);
    if (Math.hypot(n.x - p[0], n.y - p[1]) < 2) continue;
    if (!from.has(n.id)) from.set(n.id, [p[0], p[1]]);
    setPos(doc, n.id, n.x, n.y);
  }
  return from;
}

// Positions for nodes that have none (hand-edited data, imports). Returns the count.
export function placeMissing(doc, center = { x: 0, y: 0 }) {
  const graph = buildGraph(doc);
  const missing = [...graph.kanji.keys(), ...graph.words.keys()].filter((id) => !getPos(doc, id));
  if (missing.length) settle(doc, missing, { center });
  return missing.length;
}

// ---------------------------------------------------------------------------
// tidy: organic layout per cluster, clusters packed into rows with even gaps.
// Clusters containing pinned nodes stay where they are; the rest are packed below.
// Returns a Map id → previous position for animation.
// ---------------------------------------------------------------------------
const CLUSTER_GAP = 110;

export function tidy(doc) {
  const graph = buildGraph(doc);
  const from = new Map();
  for (const id of [...graph.kanji.keys(), ...graph.words.keys()]) {
    const p = getPos(doc, id);
    if (p) from.set(id, [p[0], p[1]]);
  }

  const laidOut = []; // { ids, nodes, box, pinned }
  for (const { ids, adj } of components(graph)) {
    const pinned = ids.some((id) => isPinned(doc, id));
    const { nodes, links } = simGraph(graph, ids);
    if (pinned) {
      for (const n of nodes) {
        const p = getPos(doc, n.id) || [0, 0];
        n.x = p[0];
        n.y = p[1];
        if (isPinned(doc, n.id)) (n.fx = p[0]), (n.fy = p[1]);
      }
    } else {
      // Fresh start: breadth-first from the busiest kanji, so d3's spiral seeding
      // puts the hub in the middle with its words around it.
      const hub = ids.reduce((a, b) => (adj.get(b).length > adj.get(a).length || (b.startsWith('k:') && !a.startsWith('k:') && adj.get(b).length === adj.get(a).length) ? b : a));
      const order = [];
      const seen = new Set([hub]);
      const queue = [hub];
      while (queue.length) {
        const cur = queue.shift();
        order.push(cur);
        for (const n of adj.get(cur)) if (!seen.has(n) && ids.includes(n)) (seen.add(n), queue.push(n));
      }
      const rank = new Map(order.map((id, i) => [id, i]));
      nodes.sort((a, b) => rank.get(a.id) - rank.get(b.id));
    }
    const ticks = Math.round((pinned ? 220 : 320) * Math.min(1, Math.sqrt(400 / Math.max(nodes.length, 1))) + 60);
    // Untangling pays off for normal clusters; huge hairballs keep the single pass,
    // which separates nodes more reliably at that size.
    if (nodes.length > 1) simulate(nodes, links, { ticks, alpha: pinned ? 0.7 : 1, untangle: !pinned && nodes.length <= 400 });
    else (nodes[0].x ??= 0), (nodes[0].y ??= 0);
    const box = {
      minX: Math.min(...nodes.map((n) => n.x - n.r)),
      maxX: Math.max(...nodes.map((n) => n.x + n.r)),
      minY: Math.min(...nodes.map((n) => n.y - n.r)),
      maxY: Math.max(...nodes.map((n) => n.y + n.r)),
    };
    laidOut.push({ ids, nodes, box, pinned });
  }

  // Pinned clusters keep their coordinates; packing starts below them.
  const fixed = laidOut.filter((c) => c.pinned);
  const free = laidOut.filter((c) => !c.pinned).sort((a, b) => b.nodes.length - a.nodes.length || b.box.maxX - b.box.minX - (a.box.maxX - a.box.minX));
  const width = (c) => c.box.maxX - c.box.minX;
  const height = (c) => c.box.maxY - c.box.minY;
  const area = free.reduce((a, c) => a + (width(c) + CLUSTER_GAP) * (height(c) + CLUSTER_GAP), 0);
  const rowWidth = Math.max(free.length ? width(free[0]) : 0, Math.sqrt(area) * 1.5);
  let x = 0;
  let y = fixed.length ? Math.max(...fixed.map((c) => c.box.maxY)) + CLUSTER_GAP * 2 : 0;
  const originX = fixed.length ? Math.min(...fixed.map((c) => c.box.minX)) : 0;
  let rowHeight = 0;
  for (const c of free) {
    if (x > 0 && x + width(c) > rowWidth) {
      x = 0;
      y += rowHeight + CLUSTER_GAP;
      rowHeight = 0;
    }
    const dx = originX + x - c.box.minX;
    const dy = y - c.box.minY;
    for (const n of c.nodes) (n.x += dx), (n.y += dy);
    x += width(c) + CLUSTER_GAP;
    rowHeight = Math.max(rowHeight, height(c));
  }

  for (const c of laidOut) for (const n of c.nodes) if (!isPinned(doc, n.id)) setPos(doc, n.id, n.x, n.y);
  return from;
}

// ---------------------------------------------------------------------------
// tidyAsync: same result as tidy(), but big maps run in a Web Worker so the page
// stays responsive. Resolves to the "previous positions" map for animation.
// ---------------------------------------------------------------------------
const WORKER_THRESHOLD = 400; // nodes

export async function tidyAsync(doc) {
  const count = Object.keys(doc.kanji).length + Object.keys(doc.words).length;
  if (count <= WORKER_THRESHOLD || typeof Worker === 'undefined') return tidy(doc);
  const from = new Map();
  for (const sec of ['kanji', 'words']) {
    const prefix = sec === 'kanji' ? 'k:' : 'w:';
    for (const [k, p] of Object.entries(doc.layout[sec])) from.set(prefix + k, [p[0], p[1]]);
  }
  // Versioned like every other asset so a CDN can't serve a stale worker after a deploy.
  const worker = new Worker(new URL(`./layout-worker.js?v=${BUILD}`, import.meta.url), { type: 'module' });
  try {
    const layout = await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data.layout));
      worker.onerror = (e) => reject(new Error(e.message || 'layout worker failed'));
      worker.postMessage({ doc: JSON.parse(JSON.stringify(doc)) });
    });
    doc.layout = layout;
  } finally {
    worker.terminate();
  }
  return from;
}
