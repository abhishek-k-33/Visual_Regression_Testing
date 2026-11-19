/**
 * Frontend logic for Visual Regression Review Dashboard:
 * 1. Interactive draggable Before/After overlay image slider
 * 2. Tab switcher (Side-by-Side, Slider, Diff)
 * 3. Asynchronous AJAX Approve and Reject baseline promotions
 */

document.addEventListener('DOMContentLoaded', () => {
  // ─────────────────────────────────────────────────────────────
  // 1. Tab Switching Logic
  // ─────────────────────────────────────────────────────────────
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
            window.dispatchEvent(new Event('resize'));
          }
        }
      });
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Draggable Split Overlay Slider Logic
  // ─────────────────────────────────────────────────────────────
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
    divider.addEventListener('touchstart', (e) => {
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

  // ─────────────────────────────────────────────────────────────
  // 3. AJAX Baseline Approval & Rejection Handlers
  // ─────────────────────────────────────────────────────────────
  document.querySelectorAll('.btn-approve').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const snapId = btn.getAttribute('data-id');
      if (!snapId) return;

      btn.disabled = true;
      btn.textContent = 'Approving...';

      try {
        const res = await fetch(`/api/snapshots/${snapId}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();

        if (data.success) {
          const card = document.getElementById(`snapshot-${snapId}`);
          if (card) {
            const badge = card.querySelector('.status-badge-container');
            if (badge) {
              badge.innerHTML = '<span class="status-pill status-pill-approved"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg><span>APPROVED</span></span>';
            }
          }
          btn.innerHTML = '<span>✓ Baseline Promoted</span>';
          btn.style.backgroundColor = 'transparent';
          btn.style.borderColor = 'transparent';
          btn.style.color = 'var(--success-green)';
          btn.style.cursor = 'default';

          // Disable corresponding reject button
          const rejectBtn = card?.querySelector('.btn-reject');
          if (rejectBtn) rejectBtn.remove();
        } else {
          alert(`Approval failed: ${data.error}`);
          btn.disabled = false;
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Approve & Update Baseline</span>';
        }
      } catch (err) {
        alert(`Network error: ${err.message}`);
        btn.disabled = false;
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Approve & Update Baseline</span>';
      }
    });
  });

  document.querySelectorAll('.btn-reject').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const snapId = btn.getAttribute('data-id');
      if (!snapId) return;

      if (!confirm('Are you sure you want to reject this visual diff?')) {
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Rejecting...';

      try {
        const res = await fetch(`/api/snapshots/${snapId}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();

        if (data.success) {
          const card = document.getElementById(`snapshot-${snapId}`);
          if (card) {
            const badge = card.querySelector('.status-badge-container');
            if (badge) {
              badge.innerHTML = '<span class="status-pill status-pill-rejected"><span>REJECTED</span></span>';
            }
          }
          btn.innerHTML = '<span>✗ Rejected</span>';
          btn.style.backgroundColor = 'transparent';
          btn.style.borderColor = 'transparent';
          btn.style.color = 'var(--error-red)';
          btn.style.cursor = 'default';

          // Disable corresponding approve button
          const approveBtn = card?.querySelector('.btn-approve');
          if (approveBtn) approveBtn.remove();
        } else {
          alert(`Rejection failed: ${data.error}`);
          btn.disabled = false;
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg><span>Reject</span>';
        }
      } catch (err) {
        alert(`Network error: ${err.message}`);
        btn.disabled = false;
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg><span>Reject</span>';
      }
    });
  });
});
