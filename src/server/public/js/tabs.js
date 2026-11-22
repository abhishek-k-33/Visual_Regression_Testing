/**
 * Tab switcher for each snapshot card (Side-by-Side, Slider, Diff).
 * Loaded as a module (deferred), so the DOM is already parsed when this runs.
 */

document.querySelectorAll('.snapshot-card').forEach((card) => {
  const tabButtons = card.querySelectorAll('.tab-btn');
  const tabPanels = card.querySelectorAll('.tab-panel');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');

      tabButtons.forEach((b) => b.classList.remove('active'));
      tabPanels.forEach((p) => p.classList.remove('active'));

      btn.classList.add('active');
      const activePanel = card.querySelector(`.tab-panel[data-panel="${targetTab}"]`);
      if (activePanel) {
        activePanel.classList.add('active');
        if (targetTab === 'slider') {
          // The slider panel was hidden, so its images had no width until now.
          window.dispatchEvent(new Event('resize'));
        }
      }
    });
  });
});
