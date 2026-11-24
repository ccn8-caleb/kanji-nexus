// "Add kanji" form, built for back-to-back entry: Enter saves and clears the form
// for the next kanji; Done / Esc closes it and shows the last one added.
// On'yomi formats to katakana, kun'yomi to hiragana (romaji works too), and a
// double space inserts "・" between readings.

import { escapeHtml, splitReadings } from '../../core/util.js';
import { kanjiId } from '../../core/graph.js';
import * as ops from '../../core/ops.js';
import { t } from '../../core/prefs.js';
import { openModal, onModalClose } from '../../core/ui.js';
import { attachKanaInput } from '../../core/kana.js';
import { settle, findFreeSpot, setPos } from './layout.js';

const $ = (id) => document.getElementById(id);

// ctx: { store, canvas, select }. Returns { open(atWorldPoint?) }.
export function initAddKanji({ store, canvas, select }) {
  const els = {
    label: $('new-primary-label'),
    on: $('new-primary-onyomi'),
    kun: $('new-primary-kunyomi'),
    notes: $('new-primary-notes'),
    list: $('kanji-added-list'),
    status: $('kanji-form-status'),
  };
  let added = [];
  let at = null;

  attachKanaInput(els.on, { script: 'katakana', multi: true });
  attachKanaInput(els.kun, { script: 'hiragana', multi: true, keep: '.-' });

  const clearFields = () => [els.label, els.on, els.kun, els.notes].forEach((el) => (el.value = ''));
  const setStatus = (text, kind = 'ok') => {
    els.status.textContent = text;
    els.status.dataset.kind = kind;
  };
  function renderAdded() {
    els.list.hidden = !added.length;
    els.list.innerHTML = `<span class="added-label">${t('追加済み', 'Added')}</span>${added.map((ch) => `<span class="added-chip">${escapeHtml(ch)}</span>`).join('')}`;
  }

  function save() {
    const ch = els.label.value.trim();
    if (!ch) return els.label.focus();
    if (store.doc.kanji[ch]) {
      setStatus(t(`「${ch}」は既に登録されています`, `"${ch}" already exists`), 'error');
      els.label.select();
      return;
    }
    // Words already containing this kanji attach to it automatically; settle places the
    // kanji next to them (or at the viewport centre) and makes room. "Add here" pins it.
    let from;
    store.edit((doc) => {
      ops.addKanji(doc, ch, { on: splitReadings(els.on.value), kun: splitReadings(els.kun.value), notes: els.notes.value.trim() });
      if (at) {
        const spot = findFreeSpot(doc, at.x, at.y);
        setPos(doc, kanjiId(ch), spot.x, spot.y, { pin: true });
      }
      from = settle(doc, [kanjiId(ch)], { center: canvas.viewportCenter() });
    });
    canvas.animateFrom(from);
    added.push(ch);
    renderAdded();
    setStatus(t(`✓「${ch}」を追加しました`, `✓ Added "${ch}"`));
    clearFields();
    els.label.focus();
  }

  for (const el of [els.label, els.on, els.kun, els.notes]) {
    el.setAttribute('enterkeyhint', 'done');
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      save();
    });
  }
  $('btn-confirm-add-primary').addEventListener('click', save);

  // Closing shows the last kanji added.
  onModalClose('modal-add-primary', () => {
    const last = added.at(-1);
    if (last && store.doc.kanji[last]) select(kanjiId(last), { center: true });
  });

  return {
    open(point = null) {
      at = point;
      added = [];
      clearFields();
      renderAdded();
      setStatus('');
      openModal('modal-add-primary');
      els.label.focus(); // synchronous: iOS only opens the keyboard during the tap
    },
  };
}
