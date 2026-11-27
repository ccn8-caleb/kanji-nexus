// Inspector side panel (bottom sheet on mobile) for the selected kanji or word.

import { GRAMMAR_TAGS, LINK_TYPES, PALETTE, DEFAULT_COLORS, dictionaryLinks } from '../../core/constants.js';
import { escapeHtml, extractKanji, fold, joinReadings, splitReadings } from '../../core/util.js';
import { kanjiId, wordId } from '../../core/graph.js';
import { remapSrs } from '../../core/srs.js';
import * as ops from '../../core/ops.js';
import { t, tr } from '../../core/prefs.js';
import { toast, bindImeField, bindSwipe, isCompact, isTouch } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { attachKanaInput } from '../../core/kana.js';
import { settle, getPos } from './layout.js';
import { examplesHtml } from '../../core/examples.js';
import { lookup, pickEntry, meaningText, tagsFor } from '../../core/dict.js';

const elPanel = document.getElementById('inspector-panel');
const elBody = document.getElementById('inspector-body');
const elBadge = document.getElementById('inspector-type-badge');

// Phones: the sheet has a "peek" state (read-first summary) and a "full" state
// (editing). Swipe the header up/down, or use Edit / Done, to switch.
//   view.inspectorMode: 'summary' | 'edit'   (reset to summary on each new selection)
//   view.sheetFull:     boolean
export function initInspectorGestures(ctx) {
  const header = elPanel.querySelector('.inspector-header');
  bindSwipe(header, {
    onUp: () => {
      if (!isCompact()) return;
      ctx.view.sheetFull = true;
      renderInspector(ctx);
    },
    onDown: () => {
      if (!isCompact()) return;
      if (ctx.view.sheetFull || ctx.view.inspectorMode === 'edit') {
        ctx.view.sheetFull = false;
        ctx.view.inspectorMode = 'summary';
        renderInspector(ctx);
      } else ctx.select(null);
    },
  });
}

// ctx: { store, view, select(id, { center }), canvas, startLink(wordId) }
export function renderInspector(ctx) {
  const { store, view } = ctx;
  const graph = store.graph;
  const node = graph.node(view.selectedId);
  if (!node) {
    view.selectedId = null;
    elPanel.classList.remove('open', 'full');
    return;
  }
  // Touch devices (phones and tablets) open read-first, so a stray tap never brings up
  // the keyboard; mouse users get the edit form straight away.
  const summary = isTouch() && view.inspectorMode !== 'edit';
  elPanel.classList.add('open');
  elPanel.classList.toggle('full', isCompact() && (view.sheetFull || !summary));
  const isKanji = node.kind === 'kanji';
  elBadge.textContent = isKanji ? t('親漢字ノード', 'Primary Kanji') : t('熟語・語彙ノード', 'Compound / Vocab');

  const defaultColor = isKanji ? DEFAULT_COLORS.kanji : DEFAULT_COLORS.word;
  const swatches = PALETTE.map(
    (c) => `<button type="button" class="swatch-btn${node.color === c ? ' active' : ''}" data-set-color="${c}" style="background:${c};"></button>`
  ).join('');
  const dict = dictionaryLinks(node.label, node.kind)
    .map((d) => `<a class="dict-link" href="${d.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.name)}${icon('external')}</a>`)
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
        <button type="button" id="btn-delete-node-init" class="tb-btn danger">${icon('delete')}${isKanji ? t('この漢字を削除', 'Delete Kanji') : t('この熟語を削除', 'Delete Compound')}</button>
        <div id="delete-confirm-group" class="chip-row" hidden>
          <button type="button" id="btn-delete-node-confirm" class="tb-btn danger-solid">${t('確定', 'Delete')}</button>
          <button type="button" id="btn-delete-node-cancel" class="tb-btn">${t('取消', 'Cancel')}</button>
        </div>
      </div>`,
  };

  if (summary) return renderSummary(ctx, node, common);

  if (isKanji) renderKanji(ctx, node, common);
  else renderWord(ctx, node, common);
  if (isTouch()) {
    elBody.insertAdjacentHTML('afterbegin', `<button type="button" class="tb-btn" data-insp="done">${icon('check')}${t('編集を終える', 'Done editing')}</button>`);
    elBody.querySelector('[data-insp="done"]').addEventListener('click', () => {
      view.inspectorMode = 'summary';
      view.sheetFull = false;
      renderInspector(ctx);
    });
  }

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
  elBody.querySelector('#btn-delete-node-confirm').addEventListener('click', () => deleteNode(ctx, node));
}

export function deleteNode(ctx, node) {
  ctx.view.selectedId = null;
  ctx.store.edit((doc) => (node.kind === 'kanji' ? ops.deleteKanji(doc, node.key) : ops.deleteWord(doc, node.key)));
  toast(t(`「${node.label}」を削除しました`, `Deleted "${node.label}"`), {
    action: { label: t('元に戻す', 'Undo'), run: () => ctx.store.undo() },
  });
}

// Read-first view for phones: no inputs, so a stray tap never opens the keyboard.
function renderSummary(ctx, node, common) {
  const { store, view } = ctx;
  const graph = store.graph;
  const isKanji = node.kind === 'kanji';
  const chip = (id, label, extra = '') => `<button type="button" class="kanji-chip" data-jump-node="${escapeHtml(id)}" ${extra}>${escapeHtml(label)}</button>`;
  const section = (title, body) => (body ? `<div class="field-group"><label class="field-label">${title}</label><div class="chip-row">${body}</div></div>` : '');

  let reading;
  let meaning = '';
  let related = '';
  if (isKanji) {
    reading = [joinReadings(node.on), joinReadings(node.kun)].filter(Boolean).join(' ／ ') || t('読み未登録', 'No reading saved');
    const kids = graph.children.get(node.id);
    related = section(t(`関連する熟語 (${kids.length})`, `Compounds (${kids.length})`), kids.map((wid) => chip(wid, graph.words.get(wid).label)).join(''));
  } else {
    reading = node.reading || t('読み未登録', 'No reading saved');
    meaning = node.meaning;
    const tags = node.tags.map((id) => `<span class="tag-toggle active">${tr(GRAMMAR_TAGS.find((g) => g.id === id))}</span>`).join('');
    related =
      section(t('品詞・用法', 'Grammar & usage'), tags) +
      section(t('構成親漢字', 'Kanji'), graph.parents.get(node.id).map((pid) => chip(pid, graph.kanji.get(pid).label)).join('')) +
      section(
        t('関連語', 'Related words'),
        graph.linksOf
          .get(node.id)
          .map(({ id, type }) => chip(id, `${LINK_TYPES[type].short}·${graph.words.get(id).label}`, `style="border-color:${LINK_TYPES[type].color}"`))
          .join('')
      );
  }

  elBody.innerHTML = `
    <div class="summary-hero">
      <span class="summary-label">${escapeHtml(node.label)}</span>
      <span class="summary-reading">${escapeHtml(reading)}</span>
    </div>
    <div class="summary-actions">
      <button type="button" class="tb-btn primary" data-insp="edit">${icon('edit')}${t('編集', 'Edit')}</button>
      ${isKanji ? '' : `<button type="button" class="tb-btn" data-insp="link">${icon('link')}${t('リンク', 'Link')}</button>`}
      <button type="button" class="tb-btn danger icon-only" data-insp="delete" aria-label="${t('削除', 'Delete')}">${icon('delete')}</button>
    </div>
    ${meaning ? `<div class="summary-meaning">${escapeHtml(meaning)}</div>` : ''}
    ${node.notes ? `<div class="summary-notes">${escapeHtml(node.notes)}</div>` : ''}
    ${!isKanji && node.examples.length ? `<div class="field-group"><label class="field-label">${t('例文', 'Examples')}</label>${examplesHtml(node.examples, node.label, { limit: 8 })}</div>` : ''}
    ${related}
    ${common.dict}`;

  elBody.querySelectorAll('[data-jump-node]').forEach((b) => b.addEventListener('click', () => ctx.select(b.dataset.jumpNode, { center: true })));
  elBody.querySelector('[data-insp="edit"]').addEventListener('click', () => {
    view.inspectorMode = 'edit';
    renderInspector(ctx);
  });
  elBody.querySelector('[data-insp="link"]')?.addEventListener('click', () => ctx.startLink(node.id));
  elBody.querySelector('[data-insp="delete"]').addEventListener('click', () => deleteNode(ctx, node));
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
  attachKanaInput(elBody.querySelector('#insp-on'), { script: 'katakana', multi: true });
  attachKanaInput(elBody.querySelector('#insp-kun'), { script: 'hiragana', multi: true, keep: '.-' });
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
          <button type="button" class="icon-btn small" data-unlink-id="${escapeHtml(id)}" aria-label="${t('リンク解除', 'Unlink')}">${icon('close')}</button>
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
        <span>${t('意味', 'Meaning')}</span>
        ${!node.reading || !node.meaning ? `<button type="button" id="btn-fill-dict" class="hint-chip">${icon('dictionary')}${t('辞書で補完', 'Fill from dictionary')}</button>` : ''}
      </label>
      <textarea id="insp-meaning" class="field-textarea short" lang="en">${escapeHtml(node.meaning)}</textarea>
    </div>
    <div class="field-group">
      <label class="field-label">
        <span>${t('構成親漢字', 'Constituent Kanji')}</span>
        ${parentIds.length ? `<button type="button" id="btn-recenter-compound" class="hint-chip">${t('この周辺を整える', 'Tidy around this')}</button>` : ''}
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
      <label class="field-label">
        <span>${t('例文', 'Example sentences')}</span>
        <button type="button" id="btn-add-example" class="hint-chip">＋ ${t('例文を追加', 'Add example')}</button>
      </label>
      <div class="example-edit-list">${(store.doc.words[node.key].examples || [])
        .map(
          (e, i) => `
        <div class="example-edit" data-ex="${i}">
          <textarea class="field-textarea short" data-ex-field="ja" lang="ja" placeholder="${t('例文', 'Sentence')}">${escapeHtml(e.ja)}</textarea>
          <div class="example-edit-row">
            <input type="text" class="field-input" data-ex-field="reading" lang="ja" placeholder="${t('読み（任意）', 'Reading (optional)')}" value="${escapeHtml(e.reading || '')}">
            <button type="button" class="icon-btn small danger" data-ex-del="${i}" aria-label="${t('例文を削除', 'Delete example')}">${icon('delete')}</button>
          </div>
          <input type="text" class="field-input" data-ex-field="en" lang="en" placeholder="${t('訳（任意）', 'Translation (optional)')}" value="${escapeHtml(e.en || '')}">
        </div>`
        )
        .join('')}</div>
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
  attachKanaInput(elBody.querySelector('#insp-reading'), { script: 'hiragana' });
  bindField(ctx, elBody.querySelector('#insp-reading'), (doc, v) => (doc.words[node.key].reading = v.trim()));
  bindField(ctx, elBody.querySelector('#insp-meaning'), (doc, v) => (doc.words[node.key].meaning = v.trim()));
  bindField(ctx, elBody.querySelector('#insp-notes'), (doc, v) => (doc.words[node.key].notes = v));

  // ---- examples ----
  elBody.querySelectorAll('.example-edit').forEach((row) => {
    const i = Number(row.dataset.ex);
    row.querySelectorAll('[data-ex-field]').forEach((el) =>
      bindField(ctx, el, (doc, v) => {
        const ex = doc.words[node.key].examples?.[i];
        if (!ex) return;
        const field = el.dataset.exField;
        if (v.trim() || field === 'ja') ex[field] = v.trim();
        else delete ex[field];
      })
    );
  });
  elBody.querySelectorAll('[data-ex-del]').forEach((b) =>
    b.addEventListener('click', () => store.edit((doc) => doc.words[node.key].examples.splice(Number(b.dataset.exDel), 1)))
  );
  elBody.querySelector('#btn-add-example').addEventListener('click', () => {
    store.edit((doc) => (doc.words[node.key].examples ||= []).push({ ja: '' }));
    const rows = elBody.querySelectorAll('.example-edit [data-ex-field="ja"]');
    rows[rows.length - 1]?.focus();
  });

  // ---- fill empty reading / meaning / tags from the dictionary ----
  elBody.querySelector('#btn-fill-dict')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    const entries = await lookup(node.label).catch(() => null);
    const entry = pickEntry(entries, node.reading);
    if (!entry) {
      toast(entries === null ? t('辞書を利用できません', 'The dictionary is not available') : t(`「${node.label}」は辞書にありません`, `"${node.label}" is not in the dictionary`));
      e.currentTarget.disabled = false;
      return;
    }
    store.edit((doc) => {
      const w = doc.words[node.key];
      if (!w.reading && extractKanji(node.label).length) w.reading = entry.r[0];
      if (!w.meaning) w.meaning = meaningText(entry);
      if (!w.tags.length) w.tags = tagsFor(entry);
    });
  });

  // Re-place this word between its kanji (unpinning it) and let neighbours make room.
  elBody.querySelector('#btn-recenter-compound')?.addEventListener('click', () => {
    const old = getPos(store.doc, node.id);
    let from;
    store.edit((doc) => {
      delete doc.layout.words[node.key];
      from = settle(doc, [node.id]);
      if (old) from.set(node.id, [old[0], old[1]]);
    }, 'layout');
    ctx.canvas.animateFrom(from);
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
