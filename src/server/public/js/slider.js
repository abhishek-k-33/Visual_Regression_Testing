/**
 * Before/After split slider: baseline underneath, current screenshot on top, clipped to
 * the left `pct`% of the width. The divider is an ARIA slider (role=slider, rendered by
 * run-detail.ejs) whose value is that percentage:
 *   - keyboard: ArrowLeft/ArrowRight (and Down/Up) ±5, PageDown/PageUp ±20, Home 0, End 100
 *   - pointer: drag the divider (Pointer Events + pointer capture, so mouse, pen and touch
 *     share one code path), or click anywhere in the image to jump there. The container has
 *     `touch-action: pan-y`, so vertical swipes still scroll the page on touch screens.
 *
 * Loaded as a module (deferred), so the DOM is already parsed when this runs.
 */

const STEP = 5;
const PAGE_STEP = 20;

const clamp = (n) => Math.min(100, Math.max(0, n));

function initSlider(container) {
  const overWrapper = container.querySelector('.slider-img-over-wrapper');
  const overImg = container.querySelector('.slider-img-over');
  const underImg = container.querySelector('.slider-img-under');
  const divider = container.querySelector('.slider-divider');

  if (!overWrapper || !divider || !underImg) return;

  // Ensure overlay image has the exact same width as the under image
  function syncWidth() {
    if (overImg && underImg.clientWidth > 0) {
      overImg.style.width = `${underImg.clientWidth}px`;
    }
  }

  if (underImg.complete) {
    syncWidth();
  } else {
    underImg.addEventListener('load', syncWidth);
  }
  window.addEventListener('resize', syncWidth);

  let position = 50;

  /** Moves the divider to `pct` (0-100, rounded) and keeps the ARIA value in sync. */
  function setPosition(pct) {
    position = Math.round(clamp(Number(pct) || 0));
    overWrapper.style.width = `${position}%`;
    divider.style.left = `${position}%`;
    divider.setAttribute('aria-valuenow', String(position));
    divider.setAttribute('aria-valuetext', `${position}% current, ${100 - position}% baseline`);
  }

  function positionAt(clientX) {
    const rect = container.getBoundingClientRect();
    return rect.width > 0 ? ((clientX - rect.left) / rect.width) * 100 : position;
  }

  setPosition(Number(divider.getAttribute('aria-valuenow')) || 50);

  // Keyboard
  const KEY_DELTAS = {
    ArrowLeft: -STEP,
    ArrowDown: -STEP,
    ArrowRight: STEP,
    ArrowUp: STEP,
    PageDown: -PAGE_STEP,
    PageUp: PAGE_STEP
  };
  divider.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key in KEY_DELTAS) setPosition(position + KEY_DELTAS[e.key]);
    else if (e.key === 'Home') setPosition(0);
    else if (e.key === 'End') setPosition(100);
    else return;
    e.preventDefault();
  });

  // Dragging the divider
  let dragPointer = null;
  divider.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragPointer = e.pointerId;
    divider.setPointerCapture(e.pointerId);
    divider.focus({ preventScroll: true });
    e.preventDefault(); // no text selection or image drag while dragging
  });
  divider.addEventListener('pointermove', (e) => {
    if (e.pointerId === dragPointer) setPosition(positionAt(e.clientX));
  });
  const endDrag = (e) => {
    if (e.pointerId !== dragPointer) return;
    dragPointer = null;
    if (divider.hasPointerCapture(e.pointerId)) divider.releasePointerCapture(e.pointerId);
  };
  divider.addEventListener('pointerup', endDrag);
  divider.addEventListener('pointercancel', endDrag); // e.g. the browser took over to scroll

  // Click anywhere on the image to move the divider there (then the arrow keys carry on)
  container.addEventListener('click', (e) => {
    if (e.target.closest('.slider-divider')) return;
    setPosition(positionAt(e.clientX));
    divider.focus({ preventScroll: true });
  });
}

document.querySelectorAll('.slider-view-container').forEach(initSlider);
