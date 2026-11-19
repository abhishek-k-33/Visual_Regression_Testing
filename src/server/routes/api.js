import express from 'express';
import {
  createTestRun,
  createSnapshot,
  getAllTestRuns,
  getTestRunById,
  getSnapshotsByRunId,
  getSnapshotById,
  approveSnapshot,
  rejectSnapshot
} from '../db.js';

const router = express.Router();

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
 * POST /api/runs
 * Receives test run results from the CLI and records them in SQLite.
 * Body: { id, commit_hash, branch, status, snapshots: [...] }
 */
router.post('/runs', (req, res) => {
  try {
    const { id, commit_hash, branch, status, snapshots } = req.body;

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ success: false, error: 'Run "id" is required.' });
    }

    // Check if run already exists
    const existing = getTestRunById(id);
    if (existing) {
      return res.status(409).json({ success: false, error: `Run with id "${id}" already exists.` });
    }

    createTestRun({
      id,
      commit_hash: commit_hash || null,
      branch: branch || null,
      status: status || 'PASSED'
    });

    const createdSnapshots = [];
    if (Array.isArray(snapshots)) {
      for (const snap of snapshots) {
        const created = createSnapshot({
          run_id: id,
          route: snap.route,
          viewport: snap.viewport,
          baseline_path: snap.baseline_path || snap.baselinePath || null,
          current_path: snap.current_path || snap.currentPath || snap.filepath,
          diff_path: snap.diff_path || snap.diffPath || null,
          mismatch_percentage: snap.mismatch_percentage !== undefined ? snap.mismatch_percentage : snap.mismatchPercentage,
          status: snap.status || 'MATCH'
        });
        createdSnapshots.push(created);
      }
    }

    res.status(201).json({
      success: true,
      runId: id,
      snapshotsCount: createdSnapshots.length
    });
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
    const statusCode = err.message.includes('not found') ? 404 : 500;
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
    const statusCode = err.message.includes('not found') ? 404 : 500;
    res.status(statusCode).json({ success: false, error: err.message });
  }
});

export default router;
