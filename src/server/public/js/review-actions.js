/**
 * Approve / Reject buttons on the run detail page.
 * Loaded as a module (deferred), so the DOM is already parsed when this runs.
 */
import { api, announce } from './common.js';

const APPROVE_LABEL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Approve & Update Baseline</span>';
const REJECT_LABEL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg><span>Reject</span>';

function postAction(snapId, action) {
  return fetch(api(`/snapshots/${encodeURIComponent(snapId)}/${action}`), {
    method: 'POST',
    // Required by the server's CSRF check (see src/server/security.js)
    headers: { 'X-Requested-With': 'visual-ci-dashboard' }
  });
}

function snapshotLabel(card) {
  const route = card?.querySelector('.route-pill')?.textContent.trim();
  const viewport = card?.querySelector('.viewport-badge')?.textContent.trim();
  return [route, viewport].filter(Boolean).join(' ') || 'Snapshot';
}

document.querySelectorAll('.btn-approve').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const snapId = btn.getAttribute('data-id');
    if (!snapId) return;

    btn.disabled = true;
    btn.textContent = 'Approving...';

    try {
      const res = await postAction(snapId, 'approve');
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

        announce(`${snapshotLabel(card)} approved. Baseline updated.`);
      } else {
        alert(`Approval failed: ${data.error}`);
        btn.disabled = false;
        btn.innerHTML = APPROVE_LABEL;
      }
    } catch (err) {
      alert(`Network error: ${err.message}`);
      btn.disabled = false;
      btn.innerHTML = APPROVE_LABEL;
    }
  });
});

document.querySelectorAll('.btn-reject').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const snapId = btn.getAttribute('data-id');
    if (!snapId) return;

    if (!confirm('Are you sure you want to reject this visual diff?')) {
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Rejecting...';

    try {
      const res = await postAction(snapId, 'reject');
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

        announce(`${snapshotLabel(card)} rejected.`);
      } else {
        alert(`Rejection failed: ${data.error}`);
        btn.disabled = false;
        btn.innerHTML = REJECT_LABEL;
      }
    } catch (err) {
      alert(`Network error: ${err.message}`);
      btn.disabled = false;
      btn.innerHTML = REJECT_LABEL;
    }
  });
});
