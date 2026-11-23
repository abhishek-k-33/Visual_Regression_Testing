/**
 * Approve / Reject buttons on the run detail page.
 * Loaded as a module (deferred), so the DOM is already parsed when this runs.
 *
 * In the static GitHub Pages build (mode 'static') there is no server: the actions are
 * simulated in the page, with the same UI update as a successful request, and reset
 * on reload.
 */
import { api, announce, mode } from './common.js';

const APPROVE_LABEL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Approve & Update Baseline</span>';
const REJECT_LABEL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg><span>Reject</span>';

function postAction(snapId, action) {
  return fetch(api(`/snapshots/${encodeURIComponent(snapId)}/${action}`), {
    method: 'POST',
    // Required by the server's CSRF check (see src/server/security.js)
    headers: { 'X-Requested-With': 'visual-ci-dashboard' }
  });
}

const DEMO_NOTE = 'Demo: nothing is saved, resets on reload';

// Live: POST to the API and return its JSON. Static demo: a synthetic success result.
async function sendAction(snapId, action) {
  if (mode === 'static') {
    return {
      success: true,
      simulated: true,
      snapshot: { id: Number(snapId), status: action === 'approve' ? 'APPROVED' : 'REJECTED' }
    };
  }
  const res = await postAction(snapId, action);
  return res.json();
}

function showDemoNote(card) {
  const actions = card?.querySelector('.snapshot-actions');
  if (!actions || actions.querySelector('.demo-note')) return;
  const note = document.createElement('span');
  note.className = 'demo-note';
  note.textContent = DEMO_NOTE;
  actions.appendChild(note);
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
      const data = await sendAction(snapId, 'approve');

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

        if (data.simulated) {
          showDemoNote(card);
          announce(`${snapshotLabel(card)} approved (simulated). ${DEMO_NOTE}.`);
        } else {
          announce(`${snapshotLabel(card)} approved. Baseline updated.`);
        }
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
      const data = await sendAction(snapId, 'reject');

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

        if (data.simulated) {
          showDemoNote(card);
          announce(`${snapshotLabel(card)} rejected (simulated). ${DEMO_NOTE}.`);
        } else {
          announce(`${snapshotLabel(card)} rejected.`);
        }
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
