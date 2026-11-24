// Stats & Index page: KPIs, top kanji hubs, tag/link breakdowns, and a searchable
// gojūon / cluster index. Read-only view over the shared graph.

import { icon } from '../core/icons.js';
import { GRAMMAR_TAGS, LINK_TYPES, KANA_ROWS } from '../core/constants.js';
import { escapeHtml, toHiragana, fold, joinReadings } from '../core/util.js';
import { t, tr, onPrefsChange } from '../core/prefs.js';
import { bindImeField } from '../core/ui.js';
import { initPage, openInMap } from '../core/hub.js';

const $ = (id) => document.getElementById(id);
const { store } = await initPage('stats');

const state = { viewMode: 'all', kanaRow: 'all', tagFilter: 'all', search: '' };

function kanaRowOf(reading) {
  const first = toHiragana(String(reading || '').trim())[0];
  if (!first) return 'other';
  return KANA_ROWS.find((r) => r.id !== 'all' && r.chars.includes(first))?.id || 'other';
}

const kanjiReading = (k) => joinReadings(k.on) || joinReadings(k.kun);
const kanjiReadingFull = (k) => [joinReadings(k.on), joinReadings(k.kun)].filter(Boolean).join(' / ');

// ---------------------------------------------------------------------------
// KPIs & analytics
// ---------------------------------------------------------------------------
function renderKpis(graph) {
  const kTotal = graph.kanji.size;
  const kWithReading = [...graph.kanji.values()].filter((k) => k.on.length || k.kun.length).length;
  const wTotal = graph.words.size;
  const avg = kTotal ? (wTotal / kTotal).toFixed(1) : '0.0';
  const clusters = graph.clusters();
  const multi = clusters.filter((c) => c.kanji.length >= 2).length;

  const card = (label, value, color, sub) => `
    <div class="kpi-card">
      <span class="kpi-label">${label}</span>
      <span class="kpi-value" style="color: var(${color});">${value}</span>
      <span class="kpi-sub">${sub}</span>
    </div>`;
  $('kpi-grid').innerHTML =
    card(t('親漢字数', 'Primary Kanji'), kTotal, '--accent-primary', t(`読み登録済: ${kWithReading} 字`, `${kWithReading} with readings saved`)) +
    card(t('熟語・語彙数', 'Compounds & Vocab'), wTotal, '--accent-secondary', t(`平均 ${avg} 語 / 漢字`, `${avg} compounds / kanji`)) +
    card(t('クラスター数', 'Connected Clusters'), clusters.length, '--accent-purple', t(`多漢字ネットワーク: ${multi} 群`, `${multi} multi-kanji networks`)) +
    card(t('熟語間リンク数', 'Lateral Word Links'), graph.links.length, '--accent-amber', t('対義語・類義語・派生語', 'Antonyms, synonyms & derivatives'));
}

function renderAnalytics(graph) {
  const ranked = [...graph.kanji.values()]
    .map((k) => ({ k, count: graph.children.get(k.id).length }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 7);
  const max = ranked[0]?.count || 1;
  $('top-hubs-list').innerHTML = ranked.length
    ? ranked
        .map(({ k, count }) => `
          <div class="hub-bar-row" data-jump-id="${escapeHtml(k.id)}">
            <div class="hub-kanji-badge" style="border-color: ${k.color};">${escapeHtml(k.label)}</div>
            <div class="hub-track"><div class="hub-fill" style="width: ${Math.max(8, Math.round((count / max) * 100))}%; background: ${k.color};"></div></div>
            <div class="hub-count">${count}${t('語', '')}</div>
          </div>`)
        .join('')
    : `<div class="panel-hint">${t('データがありません', 'No data yet.')}</div>`;

  const tagCounts = Object.fromEntries(GRAMMAR_TAGS.map((tg) => [tg.id, 0]));
  for (const w of graph.words.values()) for (const tag of w.tags) tagCounts[tag]++;
  $('grammar-dist-chips').innerHTML = GRAMMAR_TAGS.map(
    (tg) => `<button type="button" class="dist-chip${state.tagFilter === tg.id ? ' active' : ''}" data-filter-tag="${tg.id}">${tr(tg)} <strong>${tagCounts[tg.id]}</strong></button>`
  ).join('');

  const linkCounts = Object.fromEntries(Object.keys(LINK_TYPES).map((k) => [k, 0]));
  for (const l of graph.links) linkCounts[l.type]++;
  $('linktype-dist-chips').innerHTML = Object.entries(LINK_TYPES)
    .map(([k, m]) => `<span class="dist-chip static"><span class="dot" style="background: ${m.color};"></span>${tr(m)} <strong>${linkCounts[k]}</strong></span>`)
    .join('');
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------
function renderKanaBar() {
  $('kana-row-bar').innerHTML = KANA_ROWS.map(
    (r) => `<button type="button" class="kana-btn${state.kanaRow === r.id ? ' active' : ''}" data-kana-row="${r.id}">${r.label}</button>`
  ).join('');
}

function matchesKanji(k, q) {
  return !q || fold(`${k.label} ${joinReadings(k.on)} ${joinReadings(k.kun)} ${k.notes}`).includes(q);
}
function matchesWord(w, q) {
  const tagOk = state.tagFilter === 'all' || w.tags.includes(state.tagFilter);
  return tagOk && (!q || fold(`${w.label} ${w.reading} ${w.meaning} ${w.notes}`).includes(q));
}

function renderClusters(graph, q) {
  const groups = [
    [t('多漢字ネットワーク (3字以上)', 'Multi-Kanji Networks (3+ Kanji)'), (c) => c.kanji.length >= 3],
    [t('2漢字ペア', '2-Kanji Pairs'), (c) => c.kanji.length === 2],
    [t('単漢字アイランド', 'Single-Kanji Islands'), (c) => c.kanji.length <= 1],
  ];
  const filter = (c) =>
    (!q && state.tagFilter === 'all') ||
    (state.tagFilter === 'all' && c.kanji.some((k) => matchesKanji(k, q))) ||
    c.words.some((w) => matchesWord(w, q));

  let total = 0;
  const html = groups
    .map(([title, pick]) => {
      const list = graph.clusters().filter(pick).filter(filter);
      total += list.length;
      if (!list.length) return '';
      return `
        <div>
          <div class="cluster-group-title">${title} (${list.length})</div>
          <div class="index-grid">${list
            .map((c) => `
              <div class="cluster-card">
                <div class="cluster-row">${c.kanji.map((k) => `<button type="button" class="cluster-node-btn primary" style="border-color: ${k.color};" data-jump-id="${escapeHtml(k.id)}">${escapeHtml(k.label)}</button>`).join('')}</div>
                <div class="cluster-row">${c.words.map((w) => `<button type="button" class="cluster-node-btn" data-jump-id="${escapeHtml(w.id)}">${escapeHtml(w.label)} <span class="reading">${escapeHtml(w.reading)}</span></button>`).join('')}</div>
              </div>`)
            .join('')}</div>
        </div>`;
    })
    .join('');
  $('index-count-label').textContent = t(`${total} クラスター`, `${total} clusters`);
  return `<div class="cluster-section">${html}</div>`;
}

function kanjiCard(graph, k) {
  const kids = graph.children.get(k.id).map((wid) => graph.words.get(wid));
  return `
    <article class="entry-card" data-jump-id="${escapeHtml(k.id)}">
      <div class="entry-top">
        <div class="entry-main">
          <div class="kanji-avatar" style="border-color: ${k.color};">${escapeHtml(k.label)}</div>
          <div>
            <div class="entry-title">${escapeHtml(k.label)} <span class="entry-count">(${kids.length})</span></div>
            <div class="entry-reading">${escapeHtml(kanjiReadingFull(k) || t('読み未登録', 'No reading saved'))}</div>
          </div>
        </div>
        <span class="jump-pill">${t('マップ', 'Map')}${icon('external')}</span>
      </div>
      ${kids.length ? `<div class="mini-chips">${kids.slice(0, 8).map((w) => `<span class="mini-chip" data-jump-id="${escapeHtml(w.id)}">${escapeHtml(w.label)}</span>`).join('')}</div>` : ''}
      ${k.notes ? `<div class="entry-note">${escapeHtml(k.notes)}</div>` : ''}
    </article>`;
}

function wordCard(graph, w) {
  const parents = graph.parents.get(w.id).map((pid) => graph.kanji.get(pid));
  const tagMeta = (id) => GRAMMAR_TAGS.find((tg) => tg.id === id);
  return `
    <article class="entry-card" data-jump-id="${escapeHtml(w.id)}">
      <div class="entry-top">
        <div class="entry-main">
          <span class="compound-dot" style="background: ${w.color};"></span>
          <div>
            <div class="entry-title">${escapeHtml(w.label)}</div>
            <div class="entry-reading">${escapeHtml(w.reading || '—')}</div>
          </div>
        </div>
        <span class="jump-pill">${t('マップ', 'Map')}${icon('external')}</span>
      </div>
      ${w.meaning ? `<div class="entry-meaning">${escapeHtml(w.meaning)}</div>` : ''}
      <div class="mini-chips">
        ${parents.map((k) => `<span class="mini-chip kanji-ref" data-jump-id="${escapeHtml(k.id)}">${escapeHtml(k.label)}</span>`).join('')}
        ${w.tags.map((id) => `<span class="mini-chip tag-badge">${tr(tagMeta(id))}</span>`).join('')}
        ${graph.linksOf
          .get(w.id)
          .map(({ id, type }) => `<span class="mini-chip" data-jump-id="${escapeHtml(id)}" style="border-color: ${LINK_TYPES[type].color};">${LINK_TYPES[type].short}·${escapeHtml(graph.words.get(id).label)}</span>`)
          .join('')}
      </div>
      ${w.notes ? `<div class="entry-note">${escapeHtml(w.notes)}</div>` : ''}
    </article>`;
}

function renderIndex() {
  const graph = store.graph;
  const q = fold(state.search.trim());
  $('btn-clear-filters').hidden = !(q || state.kanaRow !== 'all' || state.tagFilter !== 'all');
  document.querySelectorAll('[data-view-mode]').forEach((tab) => tab.classList.toggle('active', tab.dataset.viewMode === state.viewMode));

  const area = $('index-content-area');
  if (state.viewMode === 'clusters') {
    area.innerHTML = renderClusters(graph, q);
    return;
  }

  const cards = [];
  if ((state.viewMode === 'all' || state.viewMode === 'kanji') && state.tagFilter === 'all') {
    const sorted = [...graph.kanji.values()].sort((a, b) => toHiragana(kanjiReading(a) || a.label).localeCompare(toHiragana(kanjiReading(b) || b.label), 'ja'));
    for (const k of sorted) {
      if (state.kanaRow !== 'all' && kanaRowOf(kanjiReading(k)) !== state.kanaRow) continue;
      if (matchesKanji(k, q)) cards.push(kanjiCard(graph, k));
    }
  }
  if (state.viewMode === 'all' || state.viewMode === 'words') {
    const sorted = [...graph.words.values()].sort((a, b) => toHiragana(a.reading || a.label).localeCompare(toHiragana(b.reading || b.label), 'ja'));
    for (const w of sorted) {
      if (state.kanaRow !== 'all' && kanaRowOf(w.reading) !== state.kanaRow) continue;
      if (matchesWord(w, q)) cards.push(wordCard(graph, w));
    }
  }
  $('index-count-label').textContent = t(`${cards.length} 件`, `${cards.length} entries`);
  area.innerHTML = cards.length
    ? `<div class="index-grid">${cards.join('')}</div>`
    : `<div class="panel-hint empty">${t('一致する項目がありません。', 'No matching entries found.')}</div>`;
}

function renderAll() {
  const graph = store.graph;
  renderKpis(graph);
  renderAnalytics(graph);
  renderKanaBar();
  renderIndex();
}

// ---------------------------------------------------------------------------
// Events (delegated, so re-rendering never needs to re-bind)
// ---------------------------------------------------------------------------
document.querySelector('main').addEventListener('click', (e) => {
  const jump = e.target.closest('[data-jump-id]');
  if (jump) return openInMap(jump.dataset.jumpId);

  const tag = e.target.closest('[data-filter-tag]')?.dataset.filterTag;
  if (tag) {
    state.tagFilter = state.tagFilter === tag ? 'all' : tag;
    if (state.tagFilter !== 'all' && state.viewMode === 'kanji') state.viewMode = 'words';
    return renderAll();
  }
  const row = e.target.closest('[data-kana-row]')?.dataset.kanaRow;
  if (row) {
    state.kanaRow = row;
    renderKanaBar();
    return renderIndex();
  }
  const mode = e.target.closest('[data-view-mode]')?.dataset.viewMode;
  if (mode) {
    state.viewMode = mode;
    return renderIndex();
  }
  if (e.target.closest('#btn-clear-filters')) {
    Object.assign(state, { search: '', kanaRow: 'all', tagFilter: 'all' });
    $('index-search-input').value = '';
    renderAll();
  }
});

bindImeField($('index-search-input'), (value) => {
  state.search = value;
  renderIndex();
});

store.subscribe(renderAll);
onPrefsChange(renderAll);
renderAll();
