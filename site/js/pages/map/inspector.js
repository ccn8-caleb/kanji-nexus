// Inspector side panel (bottom sheet on mobile) for the selected kanji or word.

import { GRAMMAR_TAGS, LINK_TYPES, PALETTE, DEFAULT_COLORS, dictionaryLinks } from '../../core/constants.js';
import { escapeHtml, extractKanji, fold, joinReadings, splitReadings } from '../../core/util.js';
import { kanjiId, wordId } from '../../core/graph.js';
import { remapSrs } from '../../core/srs.js';
import * as ops from '../../core/ops.js';
import { t, tr } from '../../core/prefs.js';
import { toast, bindImeField } from '../../core/ui.js';
import { findFreePosition, wordAnchor, setPos } from './layout.js';

const elPanel = document.getElementById('inspector-panel');
const elBody = document.getElementById('inspector-body');
const elBadge = document.getElementById('inspector-type-badge');

// ctx: { store, view, select(id, { center }), canvas }
export function renderInspector(ctx) {
  const { store, view } = ctx;
  const graph = store.graph;
  const node = graph.node(view.selectedId);
  if (!node) {
    view.selectedId = null;
    elPanel.classList.remove('open');
    return;
  }
  elPanel.classList.add('open');
  const isKanji = node.kind === 'kanji';
  elBadge.textContent = isKanji ? t('親漢字ノード', 'Primary Kanji') : t('熟語・語彙ノード', 'Compound / Vocab');

  const defaultColor = isKanji ? DEFAULT_COLORS.kanji : DEFAULT_COLORS.word;
  const swatches = PALETTE.map(
    (c) => `<button type="button" class="swatch-btn${node.color === c ? ' active' : ''}" data-set-color="${c}" style="background:${c};"></button>`
  ).join('');
  const dict = dictionaryLinks(node.label, node.kind)
    .map((d) => `<a class="dict-link" href="${d.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.name)} ↗</a>`)
    .join('');

  const common = {
    color: `
      <div class="field-group">
        <label class="field-label">${t('ノード色', 'Accent Color')}</label>
        <div class="color-swatches">${swatches}
          <input type="color" id="insp-color-picker" value="${node.color}" class="color-picker">
          ${node.color !== defaultColor ? `<button type="button" class="hint-chip" data-set-color="">${t('既定に戻す', 'Default')}</button>` : ''}
        </div>
      </div>`,
    dict: `
      <div class="field-group">
        <label class="field-label">${t('辞書で調べる', 'Dictionary Lookup')}</label>
        <div class="dict-links">${dict}</div>
      </div>`,
    danger: `
      <div class="danger-zone">
        <button type="button" id="btn-delete-node-init" class="tb-btn danger">🗑 ${isKanji ? t('この漢字を削除', 'Delete Kanji') : t('この熟語を削除', 'Delete Compound')}</button>
        <div id="delete-confirm-group" class="chip-row" hidden>
          <button type="button" id="btn-delete-node-confirm" class="tb-btn danger-solid">${t('確定', 'Delete')}</button>
          <button type="button" id="btn-delete-node-cancel" class="tb-btn">${t('取消', 'Cancel')}</button>
        </div>
      </div>`,
  };

  if (isKanji) renderKanji(ctx, node, common);
  else renderWord(ctx, node, common);

  // ---- shared bindings ----
  const setColor = (color) =>
    store.edit((doc) => {
      const entry = isKanji ? doc.kanji[node.key] : doc.words[node.key];
      if (color && color !== defaultColor) entry.color = color;
      else delete entry.color;
    });
  elBody.querySelectorAll('[data-set-color]').forEach((b) => b.addEventListener('click', () => setColor(b.dataset.setColor)));
  elBody.querySelector('#insp-color-picker')?.addEventListener('change', (e) => setColor(e.target.value));
  elBody.querySelectorAll('[data-jump-node]').forEach((b) => b.addEventListener('click', () => ctx.select(b.dataset.jumpNode, { center: true })));

  const delInit = elBody.querySelector('#btn-delete-node-init');
  const delGroup = elBody.querySelector('#delete-confirm-group');
  delInit.addEventListener('click', () => {
    delInit.hidden = true;
    delGroup.hidden = false;
  });
  elBody.querySelector('#btn-delete-node-cancel').addEventListener('click', () => {
    delInit.hidden = false;
    delGroup.hidden = true;
  });
  elBody.querySelector('#btn-delete-node-confirm').addEventListener('click', () => {
    view.selectedId = null;
    store.edit((doc) => (isKanji ? ops.deleteKanji(doc, node.key) : ops.deleteWord(doc, node.key)));
    toast(t('ノードを削除しました（Ctrl+Zで元に戻せます）', 'Node deleted (Ctrl+Z to undo)'));
  });
}

// Text fields edit in place without re-rendering the panel (reason 'field'), with one
// undo checkpoint per focus session.
function bindField(ctx, el, apply) {
  bindImeField(el, (value) => {
    apply(ctx.store.doc, value);
    ctx.store.commit('field');
  }, { onStart: () => ctx.store.checkpoint() });
}

function renderKanji(ctx, node, common) {
  const { store } = ctx;
  const graph = store.graph;
  const hints = ops.suggestReadings(graph, node.id);
  const childIds = graph.children.get(node.id);
  const hintChips = (list, attr) =>
    list.length ? `<div class="chip-row">${list.map((h) => `<button type="button" class="hint-chip" ${attr}="${escapeHtml(h)}">＋ ${escapeHtml(h)}</button>`).join('')}</div>` : '';

  elBody.innerHTML = `
    <div class="field-group">
      <label class="field-label">${t('漢字', 'Kanji Character')}</label>
      <input type="text" id="insp-label" class="field-input label-input" value="${escapeHtml(node.label)}">
    </div>
    <div class="field-grid-2">
      <div class="field-group">
        <label class="field-label">${t('音読み', 'Onyomi')}</label>
        <input type="text" id="insp-on" class="field-input" value="${escapeHtml(joinReadings(node.on))}">
        ${hintChips(hints.on, 'data-add-on')}
      </div>
      <div class="field-group">
        <label class="field-label">${t('訓読み', 'Kunyomi')}</label>
        <input type="text" id="insp-kun" class="field-input" value="${escapeHtml(joinReadings(node.kun))}">
        ${hintChips(hints.kun, 'data-add-kun')}
      </div>
    </div>
    ${common.color}
    <div class="field-group">
      <label class="field-label">${t('学習メモ', 'Study Notes')}</label>
      <textarea id="insp-notes" class="field-textarea">${escapeHtml(node.notes)}</textarea>
    </div>
    <div class="field-group">
      <label class="field-label">${t(`関連する熟語 (${childIds.length})`, `Connected Compounds (${childIds.length})`)}</label>
      <div class="chip-row">${
        childIds.length
          ? childIds.map((wid) => `<button type="button" class="kanji-chip" data-jump-node="${escapeHtml(wid)}">${escapeHtml(graph.words.get(wid).label)}</button>`).join('')
          : `<span class="muted">${t('なし', 'None')}</span>`
      }</div>
    </div>
    ${common.dict}
    ${common.danger}`;

  elBody.querySelector('#insp-label').addEventListener('change', (e) => {
    const next = e.target.value.trim();
    if (!next || next === node.key) return;
    if (store.doc.kanji[next]) {
      toast(t(`「${next}」は既に登録されています`, `"${next}" already exists`));
      e.target.value = node.key;
      return;
    }
    remapSrs({ [node.id]: kanjiId(next) });
    ctx.view.selectedId = kanjiId(next);
    store.edit((doc) => ops.renameKanji(doc, node.key, next));
  });
  bindField(ctx, elBody.querySelector('#insp-on'), (doc, v) => (doc.kanji[node.key].on = splitReadings(v)));
  bindField(ctx, elBody.querySelector('#insp-kun'), (doc, v) => (doc.kanji[node.key].kun = splitReadings(v)));
  bindField(ctx, elBody.querySelector('#insp-notes'), (doc, v) => (doc.kanji[node.key].notes = v));

  const addHint = (field, value) => store.edit((doc) => doc.kanji[node.key][field].push(value));
  elBody.querySelectorAll('[data-add-on]').forEach((b) => b.addEventListener('click', () => addHint('on', b.dataset.addOn)));
  elBody.querySelectorAll('[data-add-kun]').forEach((b) => b.addEventListener('click', () => addHint('kun', b.dataset.addKun)));
}

function renderWord(ctx, node, common) {
  const { store, view } = ctx;
  const graph = store.graph;
  const parentIds = graph.parents.get(node.id);
  const missing = ops.missingKanji(store.doc, node.key);
  const typeOptions = (selected) =>
    Object.entries(LINK_TYPES)
      .map(([k, m]) => `<option value="${k}"${selected === k ? ' selected' : ''}>${m.short}·${tr(m)}</option>`)
      .join('');

  const linkRows = graph.linksOf
    .get(node.id)
    .map(({ id, type }) => `
      <div class="checklist-item">
        <span class="link-target" data-jump-node="${escapeHtml(id)}">${escapeHtml(graph.words.get(id).label)}</span>
        <div class="chip-row">
          <select class="field-select compact" data-change-link-type="${escapeHtml(id)}">${typeOptions(type)}</select>
          <button type="button" class="tb-btn small" data-unlink-id="${escapeHtml(id)}">✕</button>
        </div>
      </div>`)
    .join('');

  elBody.innerHTML = `
    <div class="field-group">
      <label class="field-label">${t('熟語・単語', 'Compound / Word')}</label>
      <input type="text" id="insp-label" class="field-input label-input" value="${escapeHtml(node.key)}">
    </div>
    <div class="field-group">
      <label class="field-label">${t('読み (ひらがな)', 'Reading')}</label>
      <input type="text" id="insp-reading" class="field-input" value="${escapeHtml(node.reading)}">
    </div>
    <div class="field-group">
      <label class="field-label">
        <span>${t('構成親漢字', 'Constituent Kanji')}</span>
        ${parentIds.length ? `<button type="button" id="btn-recenter-compound" class="hint-chip">${t('親漢字の中心へ再配置', 'Center between parents')}</button>` : ''}
      </label>
      <div class="chip-row">
        ${parentIds.map((pid) => `<button type="button" class="kanji-chip" data-jump-node="${escapeHtml(pid)}">${escapeHtml(graph.kanji.get(pid).label)}</button>`).join('')}
        ${missing.map((ch) => `<button type="button" class="hint-chip" data-create-kanji="${escapeHtml(ch)}" data-tip-ja="親漢字として登録" data-tip-en="Register as primary kanji">＋ ${escapeHtml(ch)}</button>`).join('')}
        ${!parentIds.length && !missing.length ? `<span class="muted">${t('未接続', 'None')}</span>` : ''}
      </div>
    </div>
    <div class="field-group">
      <label class="field-label">${t('品詞・用法タグ', 'Grammar & Usage Tags')}</label>
      <div class="chip-row">${GRAMMAR_TAGS.map((tg) => `<button type="button" class="tag-toggle${node.tags.includes(tg.id) ? ' active' : ''}" data-toggle-tag="${tg.id}">${tr(tg)}</button>`).join('')}</div>
    </div>
    ${common.color}
    <div class="field-group">
      <label class="field-label">${t('メモ', 'Notes')}</label>
      <textarea id="insp-notes" class="field-textarea">${escapeHtml(node.notes)}</textarea>
    </div>
    <div class="field-group">
      <label class="field-label">${t('関連語リンク (対義語・類義語・派生語)', 'Related Word Links')}</label>
      ${linkRows ? `<div class="checklist-box">${linkRows}</div>` : ''}
      <div class="link-search-row">
        <input type="text" id="inspector-link-search" class="field-input" placeholder="${t('リンク先を検索...', 'Filter words to link...')}">
        <select id="inspector-new-link-type" class="field-select compact">${typeOptions(view.activeLinkType)}</select>
      </div>
      <div id="inspector-link-results" class="checklist-box"></div>
    </div>
    ${common.dict}
    ${common.danger}`;

  elBody.querySelector('#insp-label').addEventListener('change', (e) => {
    const next = e.target.value.trim();
    if (!next || next === node.key) return;
    if (store.doc.words[next]) {
      toast(t(`「${next}」は既に登録されています`, `"${next}" already exists`));
      e.target.value = node.key;
      return;
    }
    remapSrs({ [node.id]: wordId(next) });
    view.selectedId = wordId(next);
    store.edit((doc) => {
      ops.renameWord(doc, node.key, next);
      if (view.autoCreateKanji) ops.missingKanji(doc, next).forEach((ch) => ops.addKanji(doc, ch));
    });
  });
  bindField(ctx, elBody.querySelector('#insp-reading'), (doc, v) => (doc.words[node.key].reading = v.trim()));
  bindField(ctx, elBody.querySelector('#insp-notes'), (doc, v) => (doc.words[node.key].notes = v));

  elBody.querySelector('#btn-recenter-compound')?.addEventListener('click', () => {
    store.edit((doc) => {
      const base = wordAnchor(doc, graph, node.id, { x: node.x, y: node.y });
      const pos = findFreePosition(doc, base.x, base.y, { excludeId: node.id, clearance: 95 });
      setPos(doc, node.id, pos.x, pos.y);
    }, 'layout');
    ctx.select(node.id, { center: true });
  });

  elBody.querySelectorAll('[data-create-kanji]').forEach((b) =>
    b.addEventListener('click', () => store.edit((doc) => ops.addKanji(doc, b.dataset.createKanji)))
  );
  elBody.querySelectorAll('[data-toggle-tag]').forEach((b) =>
    b.addEventListener('click', () => store.edit((doc) => ops.toggleTag(doc, node.key, b.dataset.toggleTag)))
  );
  elBody.querySelectorAll('[data-change-link-type]').forEach((sel) =>
    sel.addEventListener('change', () => {
      const other = graph.words.get(sel.dataset.changeLinkType).key;
      store.edit((doc) => ops.setLink(doc, node.key, other, sel.value));
    })
  );
  elBody.querySelectorAll('[data-unlink-id]').forEach((b) =>
    b.addEventListener('click', () => {
      const other = graph.words.get(b.dataset.unlinkId).key;
      store.edit((doc) => ops.removeLink(doc, node.key, other));
    })
  );

  // Link search: words sharing a kanji with this one are listed first.
  const search = elBody.querySelector('#inspector-link-search');
  const results = elBody.querySelector('#inspector-link-results');
  const typeSelect = elBody.querySelector('#inspector-new-link-type');
  typeSelect.addEventListener('change', () => (view.activeLinkType = typeSelect.value));
  const linked = new Set(graph.linksOf.get(node.id).map((l) => l.id));
  const mine = new Set(extractKanji(node.label));
  const shares = (w) => extractKanji(w.label).some((k) => mine.has(k));

  function updateResults() {
    const q = fold(search.value.trim());
    const candidates = [...graph.words.values()]
      .filter((w) => w.id !== node.id && !linked.has(w.id))
      .filter((w) => !q || fold(w.label).includes(q) || fold(w.reading).includes(q))
      .sort((a, b) => Number(shares(b)) - Number(shares(a)))
      .slice(0, 25);
    results.innerHTML = candidates.length
      ? candidates
          .map((w) => `
            <div class="checklist-item" data-add-link-target="${escapeHtml(w.key)}">
              <span><strong>${escapeHtml(w.label)}</strong> <span class="muted">${escapeHtml(w.reading)}</span></span>
              <span class="add-hint">${shares(w) ? t('同漢字 · ＋', 'shared kanji · ＋') : '＋'}</span>
            </div>`)
          .join('')
      : `<div class="muted pad">${t('候補なし', 'No candidates')}</div>`;
    results.querySelectorAll('[data-add-link-target]').forEach((row) =>
      row.addEventListener('click', () => store.edit((doc) => ops.setLink(doc, node.key, row.dataset.addLinkTarget, typeSelect.value)))
    );
  }
  bindImeField(search, updateResults);
  updateResults();
}
