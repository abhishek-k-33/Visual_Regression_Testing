import express from 'express';
import { getAllTestRuns, getTestRunById, getSnapshotsByRunId } from '../db.js';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const router = express.Router();

/**
 * GET /
 * Dashboard homepage: lists all test runs with status cards and summary badges.
 */
router.get('/', (req, res) => {
  try {
    const runs = getAllTestRuns();
    res.render('index', {
      title: 'Visual Regression Test Runs',
      runs
    });
  } catch (err) {
    res.status(500).render('layout', {
      title: 'Error',
      body: `<div class="error-container"><h2>Error Loading Dashboard</h2><p>${escapeHtml(err.message)}</p></div>`
    });
  }
});

/**
 * GET /runs/:id
 * Detail view: inspects individual snapshots of a run with side-by-side, slider, and diff views.
 */
router.get('/runs/:id', (req, res) => {
  try {
    const run = getTestRunById(req.params.id);
    if (!run) {
      return res.status(404).render('index', {
        title: 'Run Not Found',
        runs: getAllTestRuns(),
        error: `Test run "${req.params.id}" not found.`
      });
    }

    const snapshots = getSnapshotsByRunId(req.params.id);

    // Helper to normalize file system paths to web-accessible URLs mounted at /storage
    const toWebUrl = (filePath) => {
      if (!filePath) return null;
      const normalized = filePath.replace(/\\/g, '/');
      const storageIndex = normalized.indexOf('/storage/');
      if (storageIndex !== -1) {
        return normalized.slice(storageIndex);
      }
      if (normalized.startsWith('storage/')) {
        return `/${normalized}`;
      }
      return normalized.startsWith('/') ? normalized : `/${normalized}`;
    };

    // Normalize image paths for web serving (mount storage at /storage)
    const normalizedSnapshots = snapshots.map((s) => ({
      ...s,
      // MISSING_BASELINE records where the baseline *would* go; there is no file to show
      baselineUrl: s.status === 'MISSING_BASELINE' ? null : toWebUrl(s.baseline_path),
      currentUrl: toWebUrl(s.current_path),
      diffUrl: toWebUrl(s.diff_path)
    }));

    res.render('run-detail', {
      title: `Run Details: ${run.id}`,
      run,
      snapshots: normalizedSnapshots
    });
  } catch (err) {
    res.status(500).send(`Server Error: ${err.message}`);
  }
});

export default router;
