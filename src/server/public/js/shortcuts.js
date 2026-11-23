/**
 * Single-key keyboard shortcuts for the run detail page:
 *
 *   j / k   next / previous snapshot card (the first press goes to the first card still
 *           awaiting review, then every card in page order)
 *   a       approve the current card (same as clicking its Approve button)
 *   r       reject the current card (same as its Reject button, so it still asks to confirm)
 *   1 2 3   side-by-side, slider or diff view of the current card
 *   ?       help dialog (native <dialog>; Esc closes it)
 *
 * Keys are ignored while typing in a field, with Ctrl/Meta/Alt held, on auto-repeat and while
 * a dialog is open. WCAG 2.1.4 (Character Key Shortcuts): the help dialog has a switch that
 * turns them all off, remembered in localStorage; the "Press ? for keyboard shortcuts"
 * button still opens the dialog, so they can be turned back on.
 *
 * Works in the static demo too: approve/reject go through the buttons, which
 * review-actions.js simulates there. Deliberately no shortcut for "Approve all pending".
 *
 * Loaded as a module (deferred), so the DOM is already parsed when this runs.
 */
import { announce } from './common.js';

const STORAGE_KEY = 'vrt:shortcuts-enabled';
const PENDING_STATUSES = ['DIFF', 'MISSING_BASELINE'];
const VIEW_KEYS = { 1: 'side-by-side', 2: 'slider', 3: 'diff' };

const dialog = document.getElementById('shortcuts-dialog');
const toggle = document.getElementById('shortcuts-enabled');
const hintButtons = [...document.querySelectorAll('[data-shortcuts-open]')];

// Storage can be unavailable (private mode, blocked site data): default to on.
function readEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeEnabled(value) {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Not persisted; the setting still applies until the page is reloaded.
  }
}

let enabled = readEnabled();

function renderEnabled() {
  if (toggle) toggle.checked = enabled;
  for (const btn of hintButtons) {
    btn.innerHTML = enabled
      ? 'Press <kbd>?</kbd> for keyboard shortcuts'
      : 'Keyboard shortcuts are off';
  }
}

// ─── Current card ───────────────────────────────────────────────────────────

const cards = () => [...document.querySelectorAll('.snapshot-card')];
const currentCard = () => document.querySelector('.snapshot-card.is-current');
const label = (card) => card.querySelector('h2')?.textContent.trim().replace(/^Snapshot /, '') || 'snapshot';

function setCurrent(card, { focus = true } = {}) {
  for (const c of cards()) {
    const isCurrent = c === card;
    c.classList.toggle('is-current', isCurrent);
    if (isCurrent) c.setAttribute('aria-current', 'true');
    else c.removeAttribute('aria-current');
  }
  if (focus) {
    card.focus({ preventScroll: true });
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
  }
}

function move(step) {
  const all = cards();
  if (all.length === 0) return;
  const current = currentCard();
  let target;
  if (!current) {
    // Start where the review work is: the first (j) or last (k) pending card.
    const pending = all.filter((c) => PENDING_STATUSES.includes(c.dataset.status));
    const pool = pending.length ? pending : all;
    target = step > 0 ? pool[0] : pool[pool.length - 1];
  } else {
    target = all[all.indexOf(current) + step];
    if (!target) {
      announce(step > 0 ? 'Last snapshot.' : 'First snapshot.');
      current.focus({ preventScroll: true });
      return;
    }
  }
  setCurrent(target);
}

function requireCurrent() {
  const card = currentCard();
  if (!card) announce('No snapshot selected. Press j to go to the next snapshot.');
  return card;
}

function clickAction(selector, verb) {
  const card = requireCurrent();
  if (!card) return;
  const btn = card.querySelector(selector);
  if (!btn || btn.disabled) {
    announce(`Nothing to ${verb} for ${label(card)}.`);
    return;
  }
  btn.click();
}

function showView(key) {
  const card = requireCurrent();
  if (!card) return;
  const tab = card.querySelector(`[role="tab"][data-tab="${key}"]`);
  if (!tab) {
    announce(`No ${key} view for ${label(card)}.`);
    return;
  }
  tab.click();
  announce(`${tab.textContent.trim()} view.`);
}

// ─── Help dialog ────────────────────────────────────────────────────────────

let returnFocusTo = null;

function openHelp() {
  if (!dialog || dialog.open) return;
  returnFocusTo = document.activeElement;
  dialog.showModal();
  dialog.querySelector('[data-shortcuts-close]')?.focus();
}

if (dialog) {
  dialog.querySelector('[data-shortcuts-close]')?.addEventListener('click', () => dialog.close());
  // A click on the backdrop lands on the <dialog> element itself (as do clicks on its
  // padding, hence the bounds check).
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close();
  });
  dialog.addEventListener('close', () => {
    const target = returnFocusTo && document.contains(returnFocusTo) ? returnFocusTo : null;
    returnFocusTo = null;
    target?.focus({ preventScroll: true });
  });
}

for (const btn of hintButtons) btn.addEventListener('click', openHelp);

toggle?.addEventListener('change', () => {
  enabled = toggle.checked;
  writeEnabled(enabled);
  renderEnabled();
  announce(enabled ? 'Keyboard shortcuts on.' : 'Keyboard shortcuts off.');
});

// ─── Key handling ───────────────────────────────────────────────────────────

function isTyping(target) {
  if (!(target instanceof Element)) return false;
  return target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
}

document.addEventListener('keydown', (e) => {
  if (!enabled || e.defaultPrevented || e.repeat || e.isComposing) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return; // Esc there is the dialog's own
  if (isTyping(e.target)) return;

  if (e.key === 'j') move(1);
  else if (e.key === 'k') move(-1);
  else if (e.key === 'a') clickAction('.btn-approve', 'approve');
  else if (e.key === 'r') clickAction('.btn-reject', 'reject');
  else if (Object.hasOwn(VIEW_KEYS, e.key)) showView(VIEW_KEYS[e.key]);
  else if (e.key === '?') openHelp();
  else return;
  e.preventDefault();
});

// Clicking or tabbing into a card makes it the current one, so a/r/1-3 act on the card
// the reviewer is looking at. So does arriving from a history link (#snapshot-<id>).
document.addEventListener('focusin', (e) => {
  const card = e.target instanceof Element ? e.target.closest('.snapshot-card') : null;
  if (card && !card.classList.contains('is-current')) setCurrent(card, { focus: false });
});
document.addEventListener('pointerdown', (e) => {
  const card = e.target instanceof Element ? e.target.closest('.snapshot-card') : null;
  if (card && !card.classList.contains('is-current')) setCurrent(card, { focus: false });
});
const fromHash = window.location.hash.startsWith('#snapshot-')
  ? document.getElementById(decodeURIComponent(window.location.hash.slice(1)))
  : null;
if (fromHash?.classList.contains('snapshot-card')) setCurrent(fromHash, { focus: false });

renderEnabled();
