import path from 'node:path';
import { getAllTestRuns, getTestRunById, getSnapshotsByRunId, PENDING_STATUSES } from './db.js';
import { getStorageRoot } from './paths.js';

// Data shaping for the server-rendered views, kept out of the routes so the same
// models can feed other renderers (e.g. a static build). Image URLs are app-relative
// ("/storage/..."); templates prefix them with url() for the configured base path.

// runs/<id>/<file>, runs/<id>/baselines/<file> or baselines/<file>, taken from the end
export function knownStorageTail(parts) {
  const n = parts.length;
  if (n >= 4 && parts[n - 4] === 'runs' && parts[n - 2] === 'baselines') return parts.slice(n - 4);
  if (n >= 3 && parts[n - 3] === 'runs') return parts.slice(n - 3);
  if (n >= 2 && parts[n - 2] === 'baselines') return parts.slice(n - 2);
  return null;
}

/**
 * Maps a stored file path to its "/storage/..." URL, relative to the storage root.
 * (Searching the path for "/storage/" broke with a custom storageDir, or when the
 * project itself lives under a folder named "storage".)
 *
 * @param {string|null} filePath - Path recorded in the database
 * @param {string} [storageRoot] - Absolute storage root (defaults to getStorageRoot())
 * @returns {string|null} "/storage/<encoded segments>", or null when it can't be served
 */
export function toWebUrl(filePath, storageRoot = getStorageRoot()) {
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
}

/**
 * Adds baselineUrl / currentUrl / diffUrl to a snapshot row.
 */
export function snapshotViewModel(s, storageRoot = getStorageRoot()) {
  return {
    ...s,
    // Show the baseline this run was compared against (its own copy), not today's
    // shared file. Older rows have no copy and fall back to the shared baseline.
    // Runs that found no baseline ('none', or legacy MISSING_BASELINE rows) have none to show,
    // even after being approved or rejected.
    baselineUrl: s.baseline_sha256 === 'none' || s.status === 'MISSING_BASELINE'
      ? null
      : toWebUrl(s.baseline_snapshot_path || s.baseline_path, storageRoot),
    currentUrl: toWebUrl(s.current_path, storageRoot),
    diffUrl: toWebUrl(s.diff_path, storageRoot)
  };
}

/**
 * Dashboard homepage model: all runs (newest first) plus the KPI / filter-tab counts.
 *
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db] - Defaults to the shared DB
 */
export function indexModel({ db } = {}) {
  const runs = getAllTestRuns(db);
  const count = (...statuses) => runs.filter((r) => statuses.includes(r.status)).length;
  return {
    title: 'Visual Regression Test Runs',
    runs,
    stats: {
      total: runs.length,
      passed: count('PASSED'),
      approved: count('APPROVED'),
      passedOrApproved: count('PASSED', 'APPROVED'),
      failed: count('FAILED', 'REJECTED')
    }
  };
}

/**
 * Run detail model, or null when the run doesn't exist.
 *
 * @param {object} options
 * @param {import('better-sqlite3').Database} [options.db] - Defaults to the shared DB
 * @param {string} options.runId
 * @param {string} [options.storageRoot] - Defaults to getStorageRoot()
 */
export function runDetailModel({ db, runId, storageRoot = getStorageRoot() }) {
  const run = getTestRunById(runId, db);
  if (!run) return null;
  const snapshots = getSnapshotsByRunId(runId, db).map((s) => snapshotViewModel(s, storageRoot));
  return {
    title: `Run Details: ${run.id}`,
    run,
    snapshots,
    // Snapshots still awaiting review: the "Approve all pending (N)" button
    pendingCount: snapshots.filter((s) => PENDING_STATUSES.includes(s.status)).length
  };
}
