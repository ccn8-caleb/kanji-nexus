// SRS Drill page: SM-2 flashcards over every kanji and word in the shared graph.
// Progress lives in its own storage key (core/srs.js); vocabulary is never modified here.

import { icon } from '../core/icons.js';
import { GRAMMAR_TAGS, LINK_TYPES, dictionaryLinks } from '../core/constants.js';
import { escapeHtml, isKanji, joinReadings } from '../core/util.js';
import { loadSrs, saveSrs, freshRecord, nextSm2 } from '../core/srs.js';
import { t, tr, onPrefsChange, applyStaticText } from '../core/prefs.js';
import { isTyping, isCompact, onCompactChange } from '../core/ui.js';
import { initPage, navigate, openInMap } from '../core/hub.js';
import { buildGraph } from '../core/graph.js';

const $ = (id) => document.getElementById(id);
const { store } = await initPage('drill');

const SCOPE_KEY = 'kanji_nexus_drill_scope';
const state = {
  srs: loadSrs(),
  scope: localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'map', // this map | all maps
  graphs: null, // [graph] for the current scope, current map first
  deckType: 'all', // 'all' | 'word' | 'kanji'
  direction: 'kanji-to-reading', // | 'reading-to-kanji'
  tagFilter: 'all',
  practiceAll: false,
  queue: [],
  done: 0,
  flipped: false,
};

const record = (id) => state.srs[id] || freshRecord();

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------
// Graphs in scope: the current map, or every map (current first so its context wins).
// Progress is keyed by node id ("w:構造"), so a word in several maps is one card.
async function loadGraphs() {
  if (state.scope === 'map') return [store.graph];
  const graphs = [store.graph];
  for (const m of store.maps) {
    if (m.id === store.currentMap?.id) continue;
    const d = await store.getMapDoc(m.id);
    if (d) graphs.push(buildGraph(d));
  }
  return graphs;
}

function allCards() {
  const seen = new Set();
  const cards = [];
  for (const g of state.graphs || [store.graph]) {
    for (const k of g.kanji.values()) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      cards.push({ ...k, graph: g, reading: [joinReadings(k.on), joinReadings(k.kun)].filter(Boolean).join(' / '), tags: [] });
    }
    for (const w of g.words.values()) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      cards.push({ ...w, graph: g });
    }
  }
  return cards;
}

function rebuildQueue() {
  const now = Date.now();
  const due = [];
  const fresh = [];
  for (const card of allCards()) {
    if (state.deckType !== 'all' && card.kind !== state.deckType) continue;
    if (state.tagFilter !== 'all' && !card.tags.includes(state.tagFilter)) continue;
    if (state.direction === 'reading-to-kanji' && !card.reading) continue;
    const rec = record(card.id);
    if (!state.practiceAll && rec.reps > 0 && rec.due > now) continue;
    (rec.reps > 0 ? due : fresh).push(card);
  }
  due.sort((a, b) => record(a.id).due - record(b.id).due);
  for (let i = fresh.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
  }
  state.queue = [...due, ...fresh];
  state.done = 0;
  state.flipped = false;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderStatus() {
  const now = Date.now();
  let due = 0;
  let fresh = 0;
  let learning = 0;
  let mastered = 0;
  for (const c of allCards()) {
    const rec = record(c.id);
    if (rec.reps === 0) {
      fresh++;
      due++;
    } else {
      if (rec.due <= now) due++;
      rec.interval >= 7 ? mastered++ : learning++;
    }
  }
  const box = (label, n, color) => `<div class="stat-box"><span class="stat-label">${label}</span><span class="stat-num" style="color: var(${color});">${n}</span></div>`;
  $('srs-status-grid').innerHTML =
    box(t('本日の復習予定', 'Due Today'), due, '--accent-primary') +
    box(t('未学習カード', 'New Cards'), fresh, '--accent-purple') +
    box(t('学習中', 'Learning'), learning, '--accent-amber') +
    box(t('定着済 (7日以上)', 'Mastered (7d+)'), mastered, '--accent-secondary');
}

function renderControls() {
  document.querySelectorAll('[data-deck-type]').forEach((b) => b.classList.toggle('active', b.dataset.deckType === state.deckType));
  document.querySelectorAll('[data-dir]').forEach((b) => b.classList.toggle('active', b.dataset.dir === state.direction));
  document.querySelectorAll('[data-scope]').forEach((b) => b.classList.toggle('active', b.dataset.scope === state.scope));
  const cram = $('btn-toggle-cram');
  cram.classList.toggle('active', state.practiceAll);
  cram.textContent = state.practiceAll ? t('全カード練習中', 'Practice All: ON') : t('全カード練習', 'Practice All');

  const pills = [{ id: 'all', ja: '全品詞', en: 'All Tags' }, ...GRAMMAR_TAGS];
  $('drill-tag-pills').innerHTML = pills
    .map((p) => `<button type="button" class="tag-pill${state.tagFilter === p.id ? ' active' : ''}" data-dtag="${p.id}">${tr(p)}</button>`)
    .join('');

  // One-line summary shown on phones while the filters are folded away.
  const deck = { all: t('すべて', 'All'), word: t('熟語', 'Words'), kanji: t('漢字', 'Kanji') }[state.deckType];
  const dir = state.direction === 'kanji-to-reading' ? t('漢字→読み', 'Kanji→Reading') : t('読み→漢字', 'Reading→Kanji');
  const tag = state.tagFilter === 'all' ? '' : ` · ${tr(GRAMMAR_TAGS.find((g) => g.id === state.tagFilter))}`;
  const scopeLabel = state.scope === 'all' ? t('全マップ', 'All maps') : store.currentMap?.name || '';
  $('controls-summary-text').textContent = `${scopeLabel} · ${deck} · ${dir}${tag}${state.practiceAll ? ` · ${t('全カード', 'All cards')}` : ''}`;

  const total = state.done + state.queue.length;
  $('session-progress-fill').style.width = `${total ? Math.round((state.done / total) * 100) : 100}%`;
  $('session-progress-text').textContent = t(`${state.done} / ${total} 完了`, `${state.done} / ${total} done`);
}

const intervalLabel = (days) => (days <= 0 ? t('すぐ再出題', '< 1 min') : days === 1 ? t('1日後', '1 day') : t(`${days}日後`, `${days} days`));

function renderEmpty(stage) {
  const empty = allCards().length === 0;
  stage.innerHTML = `
    <div class="flashcard">
      <div class="done-state">
        <div class="done-icon">${icon('check')}</div>
        <div class="done-title">${empty ? t('カードデータがありません', 'No Kanji or Vocabulary Found') : t('本日の復習が完了しました！', 'Session Complete!')}</div>
        <div class="done-sub">${
          empty
            ? t('先に「マップ」で漢字や熟語を追加すると、自動的にここに表示されます。', 'Add kanji or compounds in the Map view first, and they will appear here automatically.')
            : t('この条件の復習予定カードはすべて完了しました。全カード練習モードで追加練習するか、マップでネットワークを確認できます。', 'All scheduled cards in this filter are up to date. You can review all cards ahead of schedule or inspect your network in the Map.')
        }</div>
        <div class="done-actions">
          ${!empty && !state.practiceAll ? `<button type="button" data-action="cram-now" class="primary-pill-btn">${t('全カード練習を始める', 'Practice All Cards Anyway')}</button>` : ''}
          <button type="button" data-action="open-map" class="tb-btn">${icon('map')}${t('マップを開く', 'Open Map')}</button>
        </div>
      </div>
    </div>`;
}

function contextChip(node, sub, color) {
  return `<button type="button" class="ctx-chip" data-jump-id="${escapeHtml(node.id)}" ${color ? `style="border-color:${color};"` : ''}>${escapeHtml(node.label)}${
    sub ? ` <span class="ctx-sub">${escapeHtml(sub)}</span>` : ''
  }</button>`;
}

function renderBack(card) {
  const g = card.graph || store.graph; // context from the map the card came from
  const boxes = [];
  const box = (title, chips) => `<div class="context-box"><div class="context-title">${title}</div><div class="chip-list">${chips}</div></div>`;

  if (card.kind === 'word') {
    const parents = g.parents.get(card.id).map((pid) => g.kanji.get(pid));
    if (parents.length) {
      boxes.push(box(t('構成親漢字 (クリックでマップ)', 'Constituent Kanji (Click for Map)'), parents.map((k) => contextChip(k, k.on[0] || k.kun[0])).join('')));
    }
    const links = g.linksOf.get(card.id);
    if (links.length) {
      boxes.push(
        box(
          t('関連語リンク', 'Related Compounds'),
          links.map(({ id, type }) => {
            const m = LINK_TYPES[type];
            return contextChip({ id, label: `${m.short}·${g.words.get(id).label}` }, '', m.color);
          }).join('')
        )
      );
    }
  } else {
    const kids = g.children.get(card.id).map((wid) => g.words.get(wid));
    if (kids.length) {
      boxes.push(box(t(`関連する熟語 (${kids.length})`, `Connected Compounds (${kids.length})`), kids.slice(0, 8).map((w) => contextChip(w, w.reading)).join('')));
    }
  }
  boxes.push(
    box(
      t('外部辞書', 'Dictionary Lookup'),
      dictionaryLinks(card.label, card.kind)
        .map((d) => `<a class="ctx-chip" href="${d.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.name)}${icon('external')}</a>`)
        .join('')
    )
  );

  const reveal =
    state.direction === 'kanji-to-reading'
      ? `<div class="answer-reading">${escapeHtml(card.reading || t('読み未登録', 'No reading saved'))}</div>`
      : `<div class="answer-kanji-reveal">${escapeHtml(card.label)}</div>`;
  return `
    <div class="answer-divider"></div>
    <div class="answer-panel">
      <div class="answer-main-row">
        ${reveal}
        ${card.meaning && state.direction === 'kanji-to-reading' ? `<div class="answer-meaning">${escapeHtml(card.meaning)}</div>` : ''}
        ${card.notes && state.direction === 'kanji-to-reading' ? `<div class="answer-note">${escapeHtml(card.notes)}</div>` : ''}
      </div>
      <div class="context-grid">${boxes.join('')}</div>
    </div>`;
}

function renderCard() {
  const stage = $('card-stage');
  if (!state.queue.length) return renderEmpty(stage);

  const card = state.queue[0];
  const rec = record(card.id);
  const status =
    rec.reps === 0 ? t('未学習', 'New') : rec.interval >= 7 ? t(`定着 (${rec.interval}日)`, `Mastered (${rec.interval}d)`) : t(`学習中 (${rec.interval}日)`, `Learning (${rec.interval}d)`);
  const tagChips = card.tags
    .map((id) => `<span class="srs-state-badge tag">${tr(GRAMMAR_TAGS.find((tg) => tg.id === id))}</span>`)
    .join('');
  const tags = tagChips ? `<div class="chip-list centered">${tagChips}</div>` : '';
  const hint = state.flipped
    ? ''
    : `<div class="flip-hint">${
        state.direction === 'kanji-to-reading'
          ? t('カードをタップ または Spaceキーで答えを表示', 'Tap card or press Space to reveal answer')
          : t('カードをタップ または Spaceキーで漢字を表示', 'Tap card or press Space to reveal kanji')
      }</div>`;

  const front =
    state.direction === 'kanji-to-reading'
      ? `<div class="prompt-hero">${escapeHtml(card.label)}</div>${tags}${hint}`
      : `<div class="prompt-reading-hero">${escapeHtml(card.reading || '—')}</div>
         <div class="prompt-mask">${escapeHtml([...card.label].map((ch) => (isKanji(ch) ? '〇' : ch)).join(''))}</div>
         ${tags}
         ${card.meaning ? `<div class="prompt-sub">${escapeHtml(card.meaning)}</div>` : ''}
         ${card.notes ? `<div class="prompt-sub">${escapeHtml(card.notes)}</div>` : ''}
         ${hint}`;

  const ratings = [
    [1, t('もう一度', 'Again'), 'rate-again'],
    [2, t('難しい', 'Hard'), 'rate-hard'],
    [3, t('正解', 'Good'), 'rate-good'],
    [4, t('簡単', 'Easy'), 'rate-easy'],
  ];
  const footer = state.flipped
    ? `<div class="rating-grid">${ratings
        .map(([q, label, cls]) => `<button type="button" class="rate-btn ${cls}" data-rate="${q}"><span class="rate-title"><span class="rate-key">${q} · </span>${label}</span><span class="rate-int">${intervalLabel(nextSm2(rec, q).interval)}</span></button>`)
        .join('')}</div>`
    : `<button type="button" data-action="flip" class="reveal-btn-full">${t('答えを表示する (Space)', 'Show Answer (Space)')}</button>`;

  stage.innerHTML = `
    <div class="flashcard">
      <div class="card-top-meta">
        <div class="card-badges">
          <span class="type-badge ${card.kind === 'kanji' ? 'primary' : 'secondary'}">${card.kind === 'kanji' ? t('親漢字', 'Primary Kanji') : t('熟語・語彙', 'Compound / Vocab')}</span>
          <span class="srs-state-badge">${status}</span>
        </div>
        <button type="button" class="jump-map-btn" data-jump-id="${escapeHtml(card.id)}">${icon('map')}${t('マップで確認', 'View in Map')}</button>
      </div>
      <div class="card-center" data-action="flip">${front}</div>
      ${state.flipped ? renderBack(card) : ''}
      ${footer}
    </div>`;
}

function renderAll() {
  renderStatus();
  renderControls();
  renderCard();
  applyStaticText(document.querySelector('main'));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function flip() {
  if (state.flipped || !state.queue.length) return;
  state.flipped = true;
  renderCard();
}

function rate(quality) {
  const card = state.queue.shift();
  if (!card) return;
  state.srs[card.id] = nextSm2(record(card.id), quality);
  saveSrs(state.srs);
  // "Again" comes back two cards later in this session.
  if (quality === 1) state.queue.splice(Math.min(2, state.queue.length), 0, card);
  else state.done++;
  state.flipped = false;
  renderAll();
}

async function refilter(patch) {
  Object.assign(state, patch);
  state.graphs = await loadGraphs();
  rebuildQueue();
  renderAll();
}

document.querySelector('main').addEventListener('click', (e) => {
  const jump = e.target.closest('[data-jump-id]');
  if (jump) return openInMap(jump.dataset.jumpId);
  const r = e.target.closest('[data-rate]');
  if (r) return rate(Number(r.dataset.rate));

  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'flip') return flip();
  if (action === 'cram-now') return refilter({ practiceAll: true });
  if (action === 'open-map') return navigate('map');

  const deck = e.target.closest('[data-deck-type]')?.dataset.deckType;
  if (deck) return refilter({ deckType: deck });
  const dir = e.target.closest('[data-dir]')?.dataset.dir;
  if (dir) return refilter({ direction: dir });
  const tag = e.target.closest('[data-dtag]')?.dataset.dtag;
  if (tag) return refilter({ tagFilter: tag, deckType: tag !== 'all' && state.deckType === 'kanji' ? 'word' : state.deckType });
  const scope = e.target.closest('[data-scope]')?.dataset.scope;
  if (scope) {
    localStorage.setItem(SCOPE_KEY, scope);
    return refilter({ scope });
  }
  if (e.target.closest('#btn-toggle-cram')) return refilter({ practiceAll: !state.practiceAll });
});

$('btn-reset-srs').addEventListener('click', () => {
  if (!confirm(t('復習ドリルの学習履歴をすべてリセットしますか？', 'Reset all spaced-repetition review progress?'))) return;
  state.srs = {};
  saveSrs(state.srs);
  refilter({});
});

document.addEventListener('keydown', (e) => {
  if (isTyping() || !state.queue.length) return;
  if (e.code === 'Space' || e.key === 'Enter') {
    if (!state.flipped) {
      e.preventDefault();
      flip();
    }
  } else if (state.flipped && ['1', '2', '3', '4'].includes(e.key)) {
    e.preventDefault();
    rate(Number(e.key));
  }
});

// New or edited vocabulary (this tab via import, or another tab) re-syncs the deck.
// Filters are always open on desktop and folded behind the summary on phones.
const controls = $('drill-controls');
const syncControls = () => (controls.open = !isCompact());
onCompactChange(syncControls);
syncControls();
// Picking a filter on a phone folds the panel again so the card is back in view.
controls.addEventListener('click', (e) => {
  if (isCompact() && e.target.closest('[data-deck-type], [data-dir]')) controls.open = false;
});

store.subscribe(() => refilter({}));
onPrefsChange(renderAll);
refilter({});
