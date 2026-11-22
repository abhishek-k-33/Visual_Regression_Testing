import express from 'express';
import { getAllTestRuns, getTestRunById, getSnapshotsByRunId } from '../db.js';
import path from 'node:path';
import { getStorageRoot } from '../paths.js';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const router = express.Router();

// runs/<id>/<file>, runs/<id>/baselines/<file> or baselines/<file>, taken from the end
function knownStorageTail(parts) {
  const n = parts.length;
  if (n >= 4 && parts[n - 4] === 'runs' && parts[n - 2] === 'baselines') return parts.slice(n - 4);
  if (n >= 3 && parts[n - 3] === 'runs') return parts.slice(n - 3);
  if (n >= 2 && parts[n - 2] === 'baselines') return parts.slice(n - 2);
  return null;
}

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

    // Map a stored file path to its /storage URL, relative to the storage root.
    // (Searching the path for "/storage/" broke with a custom storageDir, or when the
    // project itself lives under a folder named "storage".)
    const storageRoot = getStorageRoot();
    const toWebUrl = (filePath) => {
      if (!filePath) return null;
      let segments;
      const rel = path.relative(storageRoot, path.resolve(filePath));
      if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
        segments = rel.split(path.sep);
      } else {
        // Recorded under another root (e.g. /app/storage inside Docker, viewed on the
        // host): keep the trailing runs/... or baselines/... part. The /storage
        // middleware still allowlists whatever this produces.
        segments = knownStorageTail(filePath.split(/[\\/]/));
      }
      return segments ? `/storage/${segments.map(encodeURIComponent).join('/')}` : null;
    };

    // Normalize image paths for web serving (mount storage at /storage)
    const normalizedSnapshots = snapshots.map((s) => ({
      ...s,
      // Show the baseline this run was compared against (its own copy), not today's
      // shared file. Older rows have no copy and fall back to the shared baseline.
      // Runs that found no baseline ('none', or legacy MISSING_BASELINE rows) have none to show,
      // even after being approved or rejected.
      baselineUrl: s.baseline_sha256 === 'none' || s.status === 'MISSING_BASELINE'
        ? null
        : toWebUrl(s.baseline_snapshot_path || s.baseline_path),
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
