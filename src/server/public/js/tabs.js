/**
 * Comparison view tabs on each snapshot card (Side-by-Side, Slider, Diff), following the
 * WAI-ARIA tabs pattern: role=tablist/tab/tabpanel rendered by run-detail.ejs, a roving
 * tabindex (only the selected tab is in the Tab order), inactive panels `hidden`, and
 * ArrowLeft/ArrowRight (wrapping), Home and End to move between tabs. Moving selects
 * the tab straight away (automatic activation): the panels are already in the page.
 *
 * Loaded as a module (deferred), so the DOM is already parsed when this runs.
 */

/**
 * Screenshot frames scroll when an image is taller than the frame (tall mobile pages). A
 * scrollable region with nothing focusable inside can't be scrolled from the keyboard, so
 * frames that overflow join the Tab order as a labelled group (and leave it when they don't).
 */
function updateScrollableFrames(root = document) {
  for (const frame of root.querySelectorAll('.image-frame')) {
    const scrollable = frame.scrollHeight > frame.clientHeight + 1;
    if (scrollable && !frame.hasAttribute('tabindex')) {
      const alt = frame.querySelector('img')?.alt || 'Screenshot';
      frame.tabIndex = 0;
      frame.setAttribute('role', 'group');
      frame.setAttribute('aria-label', `${alt} (scrollable)`);
    } else if (!scrollable && frame.hasAttribute('tabindex')) {
      frame.removeAttribute('tabindex');
      frame.removeAttribute('role');
      frame.removeAttribute('aria-label');
    }
  }
}

function initTabs(card) {
  const tabs = [...card.querySelectorAll('[role="tab"]')];
  if (tabs.length === 0) return;

  function select(tab, { focus = false } = {}) {
    for (const t of tabs) {
      const selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      t.classList.toggle('active', selected);
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) {
        panel.hidden = !selected;
        panel.classList.toggle('active', selected);
      }
    }
    if (focus) tab.focus();
    updateScrollableFrames(card);
    if (tab.dataset.tab === 'slider') {
      // The slider panel was hidden, so its images had no width until now.
      window.dispatchEvent(new Event('resize'));
    }
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab));
  }

  card.querySelector('[role="tablist"]')?.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const current = tabs.indexOf(document.activeElement);
    if (current === -1) return;
    let next;
    if (e.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    select(tabs[next], { focus: true });
  });
}

document.querySelectorAll('.snapshot-card').forEach(initTabs);

updateScrollableFrames();
document.querySelectorAll('.image-frame img').forEach((img) => {
  if (!img.complete) img.addEventListener('load', () => updateScrollableFrames(img.closest('.snapshot-card') || document));
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => updateScrollableFrames(), 150);
});
