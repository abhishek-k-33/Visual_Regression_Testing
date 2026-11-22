/**
 * Draggable Before/After split slider (baseline under, current screenshot over).
 * Loaded as a module (deferred), so the DOM is already parsed when this runs.
 */

document.querySelectorAll('.slider-view-container').forEach((container) => {
  const overWrapper = container.querySelector('.slider-img-over-wrapper');
  const overImg = container.querySelector('.slider-img-over');
  const underImg = container.querySelector('.slider-img-under');
  const divider = container.querySelector('.slider-divider');

  if (!overWrapper || !divider || !underImg) return;

  let isDragging = false;

  // Ensure overlay image has the exact same width as the under image
  function syncWidth() {
    if (overImg && underImg && underImg.clientWidth > 0) {
      overImg.style.width = `${underImg.clientWidth}px`;
    }
  }

  if (underImg.complete) {
    syncWidth();
  } else {
    underImg.addEventListener('load', syncWidth);
  }
  window.addEventListener('resize', syncWidth);

  function updateSlider(clientX) {
    const rect = container.getBoundingClientRect();
    let offsetX = clientX - rect.left;

    if (offsetX < 0) offsetX = 0;
    if (offsetX > rect.width) offsetX = rect.width;

    const percentage = (offsetX / rect.width) * 100;

    overWrapper.style.width = `${percentage}%`;
    divider.style.left = `${percentage}%`;
  }

  // Mouse Dragging Events
  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    e.preventDefault();
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    updateSlider(e.clientX);
  });

  // Touch Dragging Events (Mobile & Touchscreens)
  divider.addEventListener('touchstart', () => {
    isDragging = true;
  }, { passive: true });

  window.addEventListener('touchend', () => {
    isDragging = false;
  });

  window.addEventListener('touchmove', (e) => {
    if (!isDragging || !e.touches[0]) return;
    updateSlider(e.touches[0].clientX);
  });

  // Click anywhere on container to move slider
  container.addEventListener('click', (e) => {
    if (e.target.closest('.slider-divider')) return;
    updateSlider(e.clientX);
  });
});
