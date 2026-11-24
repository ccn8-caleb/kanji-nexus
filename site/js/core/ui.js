// Small shared UI primitives: toast, modals, bilingual tooltips, IME-safe inputs.

import { getLang } from './prefs.js';

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastEl = null;
let toastTimer = null;
export function toast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast-banner';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 2400);
}

// ---------------------------------------------------------------------------
// Modals: <div class="modal-backdrop" id="…"><div class="modal-card">…</div></div>
// Any [data-close-modal="id"] button closes its modal; Escape closes the top one.
// ---------------------------------------------------------------------------
export const openModal = (id) => document.getElementById(id)?.classList.add('open');
export const closeModal = (id) => document.getElementById(id)?.classList.remove('open');
export const anyModalOpen = () => Boolean(document.querySelector('.modal-backdrop.open'));

document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close-modal]');
  if (closer) closeModal(closer.dataset.closeModal);
  else if (e.target.classList?.contains('modal-backdrop')) e.target.classList.remove('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.modal-backdrop.open')].pop();
  if (open) {
    open.classList.remove('open');
    e.stopImmediatePropagation();
  }
});

// ---------------------------------------------------------------------------
// choose(): modal with several buttons; resolves to the chosen option's id,
// or null if dismissed (✕, backdrop, Escape).
//   await choose({ title, message, options: [{ id, label, tone?: 'primary'|'danger' }] })
// ---------------------------------------------------------------------------
export function choose({ title, message, options }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'modal-backdrop open choose-dialog';
    el.innerHTML = `
      <div class="modal-card">
        <div class="modal-title"><span></span><button type="button" class="tb-btn" data-choice="">✕</button></div>
        <p class="panel-note choose-message"></p>
        <div class="modal-actions">${options
          .map((o) => `<button type="button" class="tb-btn ${o.tone === 'danger' ? 'danger' : o.tone === 'primary' ? 'primary' : ''}" data-choice="${o.id}"></button>`)
          .join('')}</div>
      </div>`;
    el.querySelector('.modal-title span').textContent = title;
    el.querySelector('.choose-message').textContent = message;
    options.forEach((o, i) => (el.querySelectorAll('.modal-actions [data-choice]')[i].textContent = o.label));
    document.body.appendChild(el);

    const finish = (value) => {
      observer.disconnect();
      el.remove();
      resolve(value || null);
    };
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-choice]');
      if (btn) finish(btn.dataset.choice);
    });
    // Backdrop click / Escape remove the "open" class (handlers above): treat as dismiss.
    const observer = new MutationObserver(() => !el.classList.contains('open') && finish(null));
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  });
}

// ---------------------------------------------------------------------------
// IME-safe input binding: fires onChange(value, committed) only outside composition.
// onStart fires once per focus session before the first change (use for undo checkpoints).
// ---------------------------------------------------------------------------
export function bindImeField(el, onChange, { onStart } = {}) {
  if (!el) return;
  let composing = false;
  let started = false;
  const fire = (committed) => {
    if (!started) {
      started = true;
      onStart?.();
    }
    onChange(el.value, committed);
  };
  el.addEventListener('focus', () => (started = false));
  el.addEventListener('compositionstart', () => (composing = true));
  el.addEventListener('compositionend', () => {
    composing = false;
    fire(true);
  });
  el.addEventListener('input', (e) => {
    if (composing || e.isComposing) return;
    fire(false);
  });
}

export const isTyping = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

// ---------------------------------------------------------------------------
// Bilingual tooltips: [data-tip-ja] / [data-tip-en] show the *other* language,
// so hovering a Japanese label reveals its English gloss and vice versa.
// ---------------------------------------------------------------------------
export function initTooltips() {
  const tip = document.createElement('div');
  tip.className = 'bilingual-tooltip';
  document.body.appendChild(tip);
  let longPress = null;

  const show = (target, x, y) => {
    const el = target?.closest?.('[data-tip-ja], [data-tip-en]');
    if (!el) return;
    const text = getLang() === 'en' ? el.dataset.tipJa : el.dataset.tipEn;
    if (!text) return;
    tip.textContent = text;
    tip.classList.add('visible');
    tip.style.left = `${Math.min(window.innerWidth - 270, Math.max(8, x + 10))}px`;
    tip.style.top = `${Math.min(window.innerHeight - 36, Math.max(8, y + 14))}px`;
  };

  document.addEventListener('mouseover', (e) => show(e.target, e.clientX, e.clientY));
  document.addEventListener('mouseout', (e) => {
    if (e.target?.closest?.('[data-tip-ja], [data-tip-en]')) tip.classList.remove('visible');
  });
  document.addEventListener(
    'touchstart',
    (e) => {
      const touch = e.touches[0];
      if (touch) longPress = setTimeout(() => show(e.target, touch.clientX, touch.clientY), 420);
    },
    { passive: true }
  );
  document.addEventListener('touchend', () => {
    clearTimeout(longPress);
    setTimeout(() => tip.classList.remove('visible'), 900);
  });
}
