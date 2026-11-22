import express from 'express';
import {
  getAllTestRuns,
  getTestRunById,
  getSnapshotsByRunId,
  approveSnapshot,
  rejectSnapshot
} from '../db.js';

const router = express.Router();

// Runs are recorded by the CLI writing to SQLite directly; there is deliberately
// no endpoint for creating runs, since that would let clients choose file paths.

function errorStatus(err) {
  if (err.message.startsWith('Access denied')) return 403;
  if (err.message.includes('not found')) return 404;
  return 500;
}

/**
 * GET /api/runs
 * Returns list of all test runs with summary counts.
 */
router.get('/runs', (req, res) => {
  try {
    const runs = getAllTestRuns();
    res.json({ success: true, runs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/runs/:id
 * Returns a single run with all its snapshot records.
 */
router.get('/runs/:id', (req, res) => {
  try {
    const run = getTestRunById(req.params.id);
    if (!run) {
      return res.status(404).json({ success: false, error: 'Run not found' });
    }
    const snapshots = getSnapshotsByRunId(req.params.id);
    res.json({ success: true, run, snapshots });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/snapshots/:id/approve
 * Approves a snapshot: copies current screenshot over baseline and updates status.
 */
router.post('/snapshots/:id/approve', (req, res) => {
  try {
    const snapshotId = Number.parseInt(req.params.id, 10);
    if (Number.isNaN(snapshotId)) {
      return res.status(400).json({ success: false, error: 'Invalid snapshot ID' });
    }

    const result = approveSnapshot(snapshotId);
    res.json({
      success: true,
      message: 'Snapshot approved and baseline promoted successfully',
      snapshot: result.snapshot,
      runStatus: result.runStatus
    });
  } catch (err) {
    const statusCode = errorStatus(err);
    res.status(statusCode).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/snapshots/:id/reject
 * Rejects a snapshot: marks snapshot and parent run as REJECTED.
 */
router.post('/snapshots/:id/reject', (req, res) => {
  try {
    const snapshotId = Number.parseInt(req.params.id, 10);
    if (Number.isNaN(snapshotId)) {
      return res.status(400).json({ success: false, error: 'Invalid snapshot ID' });
    }

    const result = rejectSnapshot(snapshotId);
    res.json({
      success: true,
      message: 'Snapshot marked as rejected',
      snapshot: result.snapshot,
      runStatus: result.runStatus
    });
  } catch (err) {
    const statusCode = errorStatus(err);
    res.status(statusCode).json({ success: false, error: err.message });
  }
});

export default router;
