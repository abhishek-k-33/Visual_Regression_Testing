/**
 * Approve / Reject buttons on the run detail page, plus "Approve all pending" in the
 * run header. Loaded as a module (deferred), so the DOM is already parsed when this runs.
 *
 * In the static GitHub Pages build (mode 'static') there is no server: the actions are
 * simulated in the page, with the same UI update as a successful request, and reset
 * on reload.
 *
 * Results are announced through the polite live region; errors are shown in the card's (or
 * run header's) role="alert" region, never with a blocking alert().
 */
import { api, announce, mode } from './common.js';

const APPROVE_LABEL = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Approve & Update Baseline</span>';
const REJECT_LABEL = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg><span>Reject</span>';

// Run status pills, matching run-detail.ejs
const RUN_STATUS_PILLS = {
  PASSED: '<span class="status-pill status-pill-passed"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg><span>PASSED</span></span>',
  APPROVED: '<span class="status-pill status-pill-approved"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg><span>APPROVED</span></span>',
  FAILED: '<span class="status-pill status-pill-failed"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg><span>FAILED</span></span>',
  REJECTED: '<span class="status-pill status-pill-rejected"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg><span>REJECTED</span></span>'
};

const PENDING_STATUSES = ['DIFF', 'MISSING_BASELINE'];

// Required by the server's CSRF check (see src/server/security.js)
const WRITE_HEADERS = { 'X-Requested-With': 'visual-ci-dashboard' };

function postAction(snapId, action) {
  return fetch(api(`/snapshots/${encodeURIComponent(snapId)}/${action}`), {
    method: 'POST',
    headers: WRITE_HEADERS
  });
}

// The API answers with JSON, errors included; anything else (e.g. a proxy error page)
// becomes a failure result instead of a JSON parse error.
async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return { success: false, error: `the server responded with HTTP ${res.status}` };
  }
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
  return readJson(res);
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

const snapshotCards = () => [...document.querySelectorAll('.snapshot-card')];

/**
 * Errors go to the role="alert" region (rendered empty in run-detail.ejs) of the card or
 * run header the button belongs to, instead of a blocking alert(). A new paragraph is
 * inserted each time so repeating the same error is announced again.
 *
 * @param {Element} from - The button that was used
 * @param {string|Node[]} content - Text, or nodes (e.g. text plus a button)
 */
function showError(from, content) {
  const region = from.closest('.snapshot-card, .detail-header-card')?.querySelector('[data-action-error]');
  if (!region) return;
  const p = document.createElement('p');
  if (typeof content === 'string') p.textContent = content;
  else p.append(...content);
  region.replaceChildren(p);
}

function clearError(from) {
  from.closest('.snapshot-card, .detail-header-card')?.querySelector('[data-action-error]')?.replaceChildren();
}

/**
 * Keeps keyboard focus on the card when the focused button is disabled or removed by a
 * successful action (focus would otherwise fall back to the top of the page).
 */
function keepFocusInCard(card, hadFocus) {
  if (!card || !hadFocus) return;
  const active = document.activeElement;
  if (!active || active === document.body || !card.contains(active) || active.disabled) card.focus();
}

/** Client-side mirror of recalculateRunStatus() in src/server/db.js (static demo only). */
function runStatusFromCards() {
  const statuses = snapshotCards().map((c) => c.dataset.status);
  if (statuses.includes('REJECTED')) return 'REJECTED';
  if (statuses.some((s) => PENDING_STATUSES.includes(s))) return 'FAILED';
  if (statuses.includes('APPROVED')) return 'APPROVED';
  return 'PASSED';
}

/**
 * Brings the run header in line with the cards: the run status pill, and the
 * "Approve all pending (N)" button (hidden once nothing is pending).
 *
 * @param {string} [runStatus] - From the server; computed from the cards when omitted
 */
function refreshRunHeader(runStatus = runStatusFromCards()) {
  const container = document.querySelector('.run-status-container');
  if (container && RUN_STATUS_PILLS[runStatus] && container.dataset.runStatus !== runStatus) {
    container.dataset.runStatus = runStatus;
    container.innerHTML = RUN_STATUS_PILLS[runStatus];
  }

  const approveAll = document.querySelector('.btn-approve-all');
  if (!approveAll) return;
  const pending = snapshotCards().filter((c) => PENDING_STATUSES.includes(c.dataset.status)).length;
  approveAll.dataset.count = String(pending);
  const label = approveAll.querySelector('.approve-all-label');
  if (label) label.textContent = `Approve all pending (${pending})`;
  approveAll.hidden = pending === 0;
}

/**
 * Shows a snapshot card as approved: badge, "Baseline Promoted" in place of the
 * Approve button, Reject removed. Used by single approve and approve-all alike.
 *
 * @returns {HTMLElement|null} The card, if it is on the page
 */
function markApproved(snapId, { simulated = false } = {}) {
  const card = document.getElementById(`snapshot-${snapId}`);
  if (!card) return null;
  card.dataset.status = 'APPROVED';

  const badge = card.querySelector('.status-badge-container');
  if (badge) {
    badge.innerHTML = '<span class="status-pill status-pill-approved"><svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg><span>APPROVED</span></span>';
  }

  const btn = card.querySelector('.btn-approve');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>✓ Baseline Promoted</span>';
    btn.style.backgroundColor = 'transparent';
    btn.style.borderColor = 'transparent';
    btn.style.color = 'var(--success-green)';
    btn.style.cursor = 'default';
  }

  // Disable corresponding reject button
  const rejectBtn = card.querySelector('.btn-reject');
  if (rejectBtn) rejectBtn.remove();

  if (simulated) showDemoNote(card);
  return card;
}

/** Shows a snapshot card as rejected (counterpart of markApproved). */
function markRejected(snapId, { simulated = false } = {}) {
  const card = document.getElementById(`snapshot-${snapId}`);
  if (!card) return null;
  card.dataset.status = 'REJECTED';

  const badge = card.querySelector('.status-badge-container');
  if (badge) {
    badge.innerHTML = '<span class="status-pill status-pill-rejected"><span>REJECTED</span></span>';
  }

  const btn = card.querySelector('.btn-reject');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>✗ Rejected</span>';
    btn.style.backgroundColor = 'transparent';
    btn.style.borderColor = 'transparent';
    btn.style.color = 'var(--error-red)';
    btn.style.cursor = 'default';
  }

  // Disable corresponding approve button
  const approveBtn = card.querySelector('.btn-approve');
  if (approveBtn) approveBtn.remove();

  if (simulated) showDemoNote(card);
  return card;
}

/**
 * Wires one Approve or Reject button. Success updates the card and is announced through
 * the polite live region; failure goes to the card's role="alert" region and restores the
 * button. Reject asks for confirmation first (also when triggered by the "r" shortcut).
 */
function wireSnapshotAction(btn, { action, busyLabel, idleLabel, confirmMessage, mark, done, failed }) {
  btn.addEventListener('click', async () => {
    const snapId = btn.getAttribute('data-id');
    if (!snapId) return;
    if (confirmMessage && !confirm(confirmMessage)) return;

    const card = btn.closest('.snapshot-card');
    const btnHadFocus = document.activeElement === btn;
    const hadFocus = btnHadFocus || Boolean(card?.contains(document.activeElement));
    clearError(btn);
    btn.disabled = true;
    btn.textContent = busyLabel;

    const restore = () => {
      btn.disabled = false;
      btn.innerHTML = idleLabel;
      if (btnHadFocus) btn.focus();
    };

    try {
      const data = await sendAction(snapId, action);

      if (data.success) {
        mark(snapId, { simulated: data.simulated });
        refreshRunHeader(data.runStatus);
        keepFocusInCard(card, hadFocus);
        const label = snapshotLabel(card);
        announce(data.simulated ? `${label} ${done} (simulated). ${DEMO_NOTE}.` : `${label} ${done}${action === 'approve' ? '. Baseline updated.' : '.'}`);
      } else {
        restore();
        showError(btn, `${failed}: ${data.error || 'unknown error'}`);
      }
    } catch (err) {
      restore();
      showError(btn, `Network error: ${err.message}`);
    }
  });
}

document.querySelectorAll('.btn-approve').forEach((btn) => wireSnapshotAction(btn, {
  action: 'approve',
  busyLabel: 'Approving...',
  idleLabel: APPROVE_LABEL,
  mark: markApproved,
  done: 'approved',
  failed: 'Approval failed'
}));

document.querySelectorAll('.btn-reject').forEach((btn) => wireSnapshotAction(btn, {
  action: 'reject',
  busyLabel: 'Rejecting...',
  idleLabel: REJECT_LABEL,
  confirmMessage: 'Are you sure you want to reject this visual diff?',
  mark: markRejected,
  done: 'rejected',
  failed: 'Rejection failed'
}));

// ─── Approve all pending ─────────────────────────────────────────────────────

// Live: POST /api/runs/:id/approve-all and return its JSON. Static demo: approve every
// pending card in the page.
async function sendApproveAll(runId) {
  if (mode === 'static') {
    const approved = snapshotCards()
      .filter((c) => PENDING_STATUSES.includes(c.dataset.status))
      .map((c) => Number(c.id.replace(/^snapshot-/, '')));
    return { success: true, simulated: true, approved };
  }
  const res = await fetch(api(`/runs/${encodeURIComponent(runId)}/approve-all`), {
    method: 'POST',
    headers: WRITE_HEADERS
  });
  return readJson(res);
}

function conflictList(conflicts) {
  return conflicts.map((c) => `${c.route} @ ${c.viewport}`);
}

const approveAllBtn = document.querySelector('.btn-approve-all');
if (approveAllBtn) {
  approveAllBtn.addEventListener('click', async () => {
    const runId = approveAllBtn.getAttribute('data-run-id');
    const count = Number(approveAllBtn.dataset.count) || 0;
    if (!runId || count === 0) return;

    const noun = count === 1 ? 'snapshot' : 'snapshots';
    if (!confirm(`Approve all ${count} pending ${noun} in this run? Their baselines will be replaced with this run's screenshots.`)) {
      return;
    }

    const label = approveAllBtn.querySelector('.approve-all-label');
    const hadFocus = document.activeElement === approveAllBtn;
    const restoreLabel = () => {
      approveAllBtn.disabled = false;
      if (label) label.textContent = `Approve all pending (${approveAllBtn.dataset.count})`;
      if (hadFocus) approveAllBtn.focus();
    };
    clearError(approveAllBtn);
    approveAllBtn.disabled = true;
    if (label) label.textContent = 'Approving...';

    try {
      const data = await sendApproveAll(runId);

      if (data.success && !data.simulated && data.approved.length !== count) {
        // The page was out of date (e.g. approved or rejected in another tab). The snapshots
        // that WERE approved must still show it, so their Approve/Reject buttons can't act on
        // a baseline that was just promoted; then offer a reload for the rest.
        for (const id of data.approved) markApproved(id, { simulated: false });
        refreshRunHeader(data.runStatus);
        const reload = document.createElement('button');
        reload.type = 'button';
        reload.className = 'action-error-button';
        reload.textContent = 'Reload page';
        reload.addEventListener('click', () => window.location.reload());
        showError(approveAllBtn, [
          `This run changed since the page was loaded: ${data.approved.length} of ${count} snapshots were still pending and have been approved. Reload to see its current state. `,
          reload
        ]);
        if (label) label.textContent = 'Out of date';
        if (hadFocus) reload.focus();
        return;
      }

      if (data.success) {
        for (const id of data.approved) markApproved(id, { simulated: data.simulated });
        refreshRunHeader(data.runStatus);
        approveAllBtn.disabled = false;
        // The button is hidden once nothing is pending: keep focus at the top of the content.
        if (hadFocus) (approveAllBtn.hidden ? document.getElementById('main') : approveAllBtn)?.focus();

        const n = data.approved.length;
        const summary = `Approved ${n} ${n === 1 ? 'snapshot' : 'snapshots'}`;
        if (data.simulated) {
          announce(`${summary} (simulated). ${DEMO_NOTE}.`);
        } else {
          announce(`${summary}. Baselines updated; run is now ${data.runStatus}.`);
        }
      } else if (Array.isArray(data.conflicts) && data.conflicts.length) {
        const pairs = conflictList(data.conflicts);
        restoreLabel();
        showError(approveAllBtn, `Nothing was approved. The baseline has changed since this run for ${pairs.join(', ')}. ` +
          'Re-run the visual tests and review the new result, or approve the other snapshots one at a time.');
      } else {
        restoreLabel();
        showError(approveAllBtn, `Approve all failed: ${data.error || 'unknown error'}`);
      }
    } catch (err) {
      restoreLabel();
      showError(approveAllBtn, `Network error: ${err.message}`);
    }
  });
}
