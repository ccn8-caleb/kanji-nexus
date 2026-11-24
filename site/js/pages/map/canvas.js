// Map canvas: camera, progressive-disclosure visibility, edge/node rendering,
// and pointer interaction (pan, pinch zoom, wheel zoom, node drag, tap).

import { LINK_TYPES } from '../../core/constants.js';
import { escapeHtml, fold, joinReadings } from '../../core/util.js';
import { getPos, setPos } from './layout.js';
import { icon } from '../../core/icons.js';
import { isCompact } from '../../core/ui.js';

const MIN_SCALE = 0.2;
const MAX_SCALE = 2.8;

export function createCanvas({ store, view, onTap, onBackgroundTap, onCameraChange, onContextMenu }) {
  const elContainer = document.getElementById('canvas-container');
  const elWorld = document.getElementById('world');
  const elEdgesParent = document.getElementById('edges-primary-layer');
  const elEdgesLateral = document.getElementById('edges-lateral-layer');
  const elNodes = document.getElementById('nodes-layer');
  const elZoom = document.getElementById('zoom-level-text');
  const elInspector = document.getElementById('inspector-panel');
  const camera = { x: 0, y: 0, scale: 1 };

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------
  let crispTimer = null;
  function apply(animate = false) {
    elWorld.style.transition = animate ? 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
    elWorld.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
    elZoom.textContent = `${Math.round(camera.scale * 100)}%`;
    onCameraChange?.(getView());
    // Nudge the browser to re-rasterise text crisply once zooming settles.
    clearTimeout(crispTimer);
    crispTimer = setTimeout(() => {
      elNodes.style.opacity = '0.999';
      requestAnimationFrame(() => (elNodes.style.opacity = ''));
    }, 100);
  }

  function zoomAt(cx, cy, newScale, animate = false) {
    newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
    const ratio = newScale / camera.scale;
    camera.x = cx - (cx - camera.x) * ratio;
    camera.y = cy - (cy - camera.y) * ratio;
    camera.scale = newScale;
    apply(animate);
  }

  function zoomBy(factor) {
    const r = elContainer.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, camera.scale * factor, true);
  }

  function resetZoom() {
    const r = elContainer.getBoundingClientRect();
    Object.assign(camera, { x: r.width / 2, y: r.height / 2, scale: 1 });
    apply(true);
  }

  // Area of the canvas not covered by the inspector (side panel on desktop,
  // bottom sheet on phones), so focused nodes land where they can be seen.
  function visibleArea() {
    const r = elContainer.getBoundingClientRect();
    if (!elInspector.classList.contains('open')) return { width: r.width, height: r.height };
    if (!isCompact()) return { width: r.width - 320, height: r.height };
    const sheetVisible = window.innerHeight * (elInspector.classList.contains('full') ? 0.88 : 0.44);
    const covered = Math.max(0, r.bottom - (window.innerHeight - sheetVisible));
    return { width: r.width, height: Math.max(80, r.height - covered) };
  }

  function centerOn(wx, wy, scale = camera.scale, animate = true) {
    const { width, height } = visibleArea();
    camera.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    camera.x = width / 2 - wx * camera.scale;
    camera.y = height / 2 - wy * camera.scale;
    apply(animate);
  }

  const focusOn = (wx, wy, minScale = 0.95) => centerOn(wx, wy, Math.max(camera.scale, minScale));

  // Camera as "world point at the viewport centre + scale" survives screen-size changes.
  function getView() {
    const r = elContainer.getBoundingClientRect();
    return { cx: Math.round((r.width / 2 - camera.x) / camera.scale), cy: Math.round((r.height / 2 - camera.y) / camera.scale), scale: Number(camera.scale.toFixed(3)) };
  }
  function restoreView({ cx, cy, scale }) {
    const r = elContainer.getBoundingClientRect();
    camera.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    camera.x = r.width / 2 - cx * camera.scale;
    camera.y = r.height / 2 - cy * camera.scale;
    apply(false);
  }

  function fit({ animate = true } = {}) {
    const r = elContainer.getBoundingClientRect();
    const pts = [...Object.values(store.doc.layout.kanji), ...Object.values(store.doc.layout.words)];
    if (!pts.length) return resetZoom();
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = 110;
    const w = Math.max(240, maxX - minX + pad * 2);
    const h = Math.max(240, maxY - minY + pad * 2);
    camera.scale = Math.min(1.25, Math.max(0.25, Math.min(r.width / w, r.height / h)));
    camera.x = r.width / 2 - ((minX + maxX) / 2) * camera.scale;
    camera.y = r.height / 2 - ((minY + maxY) / 2) * camera.scale;
    apply(animate);
  }

  function clientToWorld(x, y) {
    const r = elContainer.getBoundingClientRect();
    return { x: Math.round((x - r.left - camera.x) / camera.scale), y: Math.round((y - r.top - camera.y) / camera.scale) };
  }

  function viewportCenter() {
    const r = elContainer.getBoundingClientRect();
    return { x: (r.width / 2 - camera.x) / camera.scale, y: (r.height / 2 - camera.y) / camera.scale };
  }

  // -------------------------------------------------------------------------
  // Visibility (progressive disclosure)
  // -------------------------------------------------------------------------
  function computeVisibility(graph) {
    const visibleWords = new Set();
    const hiKanji = new Set();
    const hiWords = new Set();
    const q = fold(view.search.trim());
    const tag = view.tagFilter;

    // Words with no registered kanji have nothing to reveal them, so always show them.
    for (const [wid, pids] of graph.parents) if (!pids.length) visibleWords.add(wid);

    if (q || tag !== 'all') {
      for (const w of graph.words.values()) {
        const tagOk = tag === 'all' || w.tags.includes(tag);
        const qOk = !q || fold(w.label).includes(q) || fold(w.reading).includes(q) || fold(w.meaning).includes(q);
        if (tagOk && qOk) {
          visibleWords.add(w.id);
          hiWords.add(w.id);
          graph.parents.get(w.id).forEach((pid) => hiKanji.add(pid));
        }
      }
      if (q && tag === 'all') {
        for (const k of graph.kanji.values()) {
          if (fold(k.label).includes(q) || fold(joinReadings(k.on)).includes(q) || fold(joinReadings(k.kun)).includes(q)) {
            hiKanji.add(k.id);
            graph.children.get(k.id).forEach((wid) => visibleWords.add(wid));
          }
        }
      }
      return { visibleWords, hiKanji, hiWords, hasFocus: true };
    }

    if (view.revealAll) graph.words.forEach((_, wid) => visibleWords.add(wid));

    const sel = view.selectedId;
    if (graph.kanji.has(sel)) {
      hiKanji.add(sel);
      for (const wid of graph.children.get(sel)) {
        visibleWords.add(wid);
        hiWords.add(wid);
        graph.linksOf.get(wid).forEach((l) => visibleWords.add(l.id));
      }
    } else if (graph.words.has(sel)) {
      visibleWords.add(sel);
      hiWords.add(sel);
      graph.parents.get(sel).forEach((pid) => hiKanji.add(pid));
      for (const l of graph.linksOf.get(sel)) {
        visibleWords.add(l.id);
        hiWords.add(l.id);
        graph.parents.get(l.id).forEach((pid) => hiKanji.add(pid));
      }
    }
    return { visibleWords, hiKanji, hiWords, hasFocus: Boolean(sel) };
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  function curve(a, b, bend) {
    const [x1, y1] = a;
    const [x2, y2] = b;
    const cx = (x1 + x2) / 2 - (y2 - y1) * bend;
    const cy = (y1 + y2) / 2 + (x2 - x1) * bend;
    return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
  }

  // -------------------------------------------------------------------------
  // Layout animation: nodes glide from their previous positions after settle/tidy.
  // -------------------------------------------------------------------------
  let anim = null; // { from: Map(id → [x,y]), start, t }
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function animateFrom(from, duration = 420) {
    if (!from?.size || matchMedia('(prefers-reduced-motion: reduce)').matches) return render();
    anim = { from, start: performance.now(), t: 0, duration };
    const step = (now) => {
      if (!anim) return;
      anim.t = ease(Math.min(1, (now - anim.start) / anim.duration));
      render();
      if (anim.t < 1) requestAnimationFrame(step);
      else {
        anim = null;
        render();
      }
    };
    requestAnimationFrame(step);
  }
  // Rendering position: the stored one, or partway along its animation.
  function posOf(doc, id) {
    const p = getPos(doc, id);
    const f = anim?.from.get(id);
    if (!p || !f) return p;
    return [f[0] + (p[0] - f[0]) * anim.t, f[1] + (p[1] - f[1]) * anim.t, p[2]];
  }

  function render() {
    const doc = store.doc;
    const graph = store.graph;
    const vis = computeVisibility(graph);
    const sel = view.selectedId;

    let parentPaths = '';
    for (const [wid, pids] of graph.parents) {
      if (!vis.visibleWords.has(wid)) continue;
      const wp = posOf(doc, wid);
      if (!wp) continue;
      for (const pid of pids) {
        const kp = posOf(doc, pid);
        if (!kp) continue;
        const hi = sel === pid || sel === wid || (vis.hiKanji.has(pid) && vis.hiWords.has(wid));
        parentPaths += `<path class="edge-primary${hi ? ' highlighted' : ''}" d="${curve(kp, wp, 0.08)}" />`;
      }
    }
    elEdgesParent.innerHTML = parentPaths;

    let lateralPaths = '';
    for (const { a, b, type } of graph.links) {
      if (!vis.visibleWords.has(a) || !vis.visibleWords.has(b)) continue;
      const pa = posOf(doc, a);
      const pb = posOf(doc, b);
      if (pa && pb) lateralPaths += `<path class="edge-lateral" stroke="${LINK_TYPES[type].color}" d="${curve(pa, pb, 0.18)}" />`;
    }
    elEdgesLateral.innerHTML = lateralPaths;

    let html = '';
    for (const k of graph.kanji.values()) {
      const pos = posOf(doc, k.id);
      if (!pos) continue;
      const selected = sel === k.id;
      const dimmed = vis.hasFocus && !selected && !vis.hiKanji.has(k.id);
      const reading = view.showReadings ? k.on[0] || k.kun[0] || '' : '';
      const glow = selected ? `box-shadow: 0 0 0 5px ${k.color}33, 0 8px 20px rgba(15, 23, 42, 0.18);` : '';
      const pin = pos[2] ? `<span class="pin-badge" title="pinned">${icon('pin')}</span>` : '';
      html += `<div class="node-primary${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}${pos[2] ? ' pinned' : ''}" data-node-id="${escapeHtml(k.id)}"
        style="left:${pos[0]}px; top:${pos[1]}px; border-color:${k.color}; ${glow}">
        <span class="node-primary-char">${escapeHtml(k.label)}</span>
        ${reading ? `<span class="node-primary-reading">${escapeHtml(reading)}</span>` : ''}${pin}
      </div>`;
    }
    for (const w of graph.words.values()) {
      const pos = posOf(doc, w.id);
      if (!pos || !vis.visibleWords.has(w.id)) continue;
      const selected = sel === w.id;
      const dimmed = vis.hasFocus && !selected && !vis.hiWords.has(w.id);
      const glow = selected ? `box-shadow: 0 0 0 4px ${w.color}33, 0 6px 16px rgba(15, 23, 42, 0.16);` : '';
      const wpin = pos[2] ? `<span class="pin-badge" title="pinned">${icon('pin')}</span>` : '';
      html += `<div class="node-secondary${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}${pos[2] ? ' pinned' : ''}" data-node-id="${escapeHtml(w.id)}"
        style="left:${pos[0]}px; top:${pos[1]}px; border-color:${w.color}; ${glow}">
        <div class="node-secondary-row">
          <span class="node-secondary-dot" style="background:${w.color};"></span>
          <span class="node-secondary-label">${escapeHtml(w.label)}</span>
        </div>
        ${view.showReadings && w.reading ? `<div class="node-secondary-reading">${escapeHtml(w.reading)}</div>` : ''}${wpin}
      </div>`;
    }
    elNodes.innerHTML = html;
  }

  // -------------------------------------------------------------------------
  // Pointer interaction
  // -------------------------------------------------------------------------
  const pointers = new Map();
  let mode = null; // 'pan' | 'drag' | 'pinch'
  let dragId = null;
  let dragOffset = { x: 0, y: 0 };
  let moved = false;
  let panStart = { x: 0, y: 0 };
  let pinchStart = { dist: 0, scale: 1 };

  // Context menu: right-click with a mouse, long-press (≈0.5 s, no movement) on touch.
  let longPress = null; // { timer, x, y }
  let longPressFired = false;
  let lastPointerType = 'mouse';
  const cancelLongPress = () => {
    if (longPress) clearTimeout(longPress.timer);
    longPress = null;
  };
  function fireContextMenu(target, x, y) {
    const nodeId = target?.closest?.('[data-node-id]')?.dataset.nodeId || null;
    onContextMenu?.(nodeId, x, y, clientToWorld(x, y));
  }
  elContainer.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (lastPointerType !== 'mouse') return; // touch uses our own long-press timer
    fireContextMenu(e.target, e.clientX, e.clientY);
  });

  elContainer.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    longPressFired = false;
    cancelLongPress();
    if (e.pointerType !== 'mouse' && pointers.size === 1) {
      const target = e.target;
      longPress = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          longPress = null;
          longPressFired = true;
          mode = null; // the gesture becomes a menu, not a drag/pan/tap
          elContainer.classList.remove('grabbing');
          navigator.vibrate?.(12);
          fireContextMenu(target, e.clientX, e.clientY);
        }, 520),
      };
    } else cancelLongPress();

    if (pointers.size === 2) {
      mode = 'pinch';
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(b.x - a.x, b.y - a.y), scale: camera.scale };
      return;
    }

    moved = false;
    const nodeEl = e.target.closest('[data-node-id]');
    const pos = nodeEl && getPos(store.doc, nodeEl.dataset.nodeId);
    if (pos) {
      mode = 'drag';
      dragId = nodeEl.dataset.nodeId;
      dragOffset = { x: e.clientX / camera.scale - pos[0], y: e.clientY / camera.scale - pos[1] };
    } else {
      mode = 'pan';
      panStart = { x: e.clientX - camera.x, y: e.clientY - camera.y };
      elContainer.classList.add('grabbing');
    }
    elContainer.setPointerCapture(e.pointerId);
  });

  elContainer.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (longPress && Math.hypot(e.clientX - longPress.x, e.clientY - longPress.y) > 8) cancelLongPress();

    if (mode === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (pinchStart.dist > 10) {
        const r = elContainer.getBoundingClientRect();
        zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, pinchStart.scale * (dist / pinchStart.dist));
      }
    } else if (mode === 'drag' && dragId) {
      const x = e.clientX / camera.scale - dragOffset.x;
      const y = e.clientY / camera.scale - dragOffset.y;
      const pos = getPos(store.doc, dragId);
      if (!moved && Math.hypot(pos[0] - x, pos[1] - y) < 3) return;
      if (!moved) {
        store.checkpoint();
        moved = true;
      }
      setPos(store.doc, dragId, x, y);
      render();
    } else if (mode === 'pan') {
      const nx = e.clientX - panStart.x;
      const ny = e.clientY - panStart.y;
      if (Math.hypot(nx - camera.x, ny - camera.y) > 4) moved = true;
      camera.x = nx;
      camera.y = ny;
      apply(false);
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    elContainer.classList.remove('grabbing');
    cancelLongPress();
    if (longPressFired) {
      if (pointers.size === 0) {
        mode = null;
        dragId = null;
      }
      return;
    }
    if (mode === 'drag' && dragId) {
      if (moved) {
        // A node you place by hand stays there: automatic layout won't move it.
        const p = getPos(store.doc, dragId);
        setPos(store.doc, dragId, p[0], p[1], { pin: true });
        store.commit('layout');
      }
      else onTap(dragId);
    } else if (mode === 'pan' && !moved) {
      onBackgroundTap();
    }
    if (pointers.size === 0) {
      mode = null;
      dragId = null;
    }
  }
  elContainer.addEventListener('pointerup', endPointer);
  elContainer.addEventListener('pointercancel', endPointer);

  elContainer.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = elContainer.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, camera.scale * (e.deltaY < 0 ? 1.12 : 0.89));
    },
    { passive: false }
  );

  return { render, fit, focusOn, centerOn, zoomBy, resetZoom, viewportCenter, clientToWorld, getView, restoreView, animateFrom };
}
