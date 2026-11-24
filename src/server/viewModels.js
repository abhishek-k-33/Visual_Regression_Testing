import fs from 'node:fs';
import path from 'node:path';
import {
  getAllTestRuns,
  getTestRunById,
  getSnapshotsByRunId,
  getRoutesForViewport,
  getSnapshotHistory,
  PENDING_STATUSES
} from './db.js';
import { getStorageRoot } from './paths.js';
import { getRouteSlug, getSnapshotFilename } from '../cli/naming.js';

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

// Snapshot status counts shown in the dashboard's Snapshots column, in display order.
const SNAPSHOT_COUNT_PARTS = [
  { key: 'diff_count', label: 'diff', cls: 'diff-count' }, // DIFF + MISSING_BASELINE (pending review)
  { key: 'rejected_count', label: 'rejected', cls: 'rejected-count' },
  { key: 'new_baseline_count', label: 'new baseline', cls: 'new-count' },
  { key: 'approved_count', label: 'approved', cls: 'approved-count' },
  { key: 'match_count', label: 'match', cls: 'match-count' }
];

/**
 * Non-zero snapshot counts of a run row from getAllTestRuns(), e.g.
 * [{ count: 2, label: 'new baseline', cls: 'new-count' }]. A baseline-only run reads
 * "2 new baseline" rather than "0 match"; an approved run "2 approved".
 *
 * @param {object} run
 * @returns {{ count: number, label: string, cls: string }[]}
 */
export function snapshotCounts(run) {
  return SNAPSHOT_COUNT_PARTS
    .map(({ key, label, cls }) => ({ count: Number(run[key]) || 0, label, cls }))
    .filter((part) => part.count > 0);
}

/** 'YYYY-MM-DD HH:MM:SS' (SQLite UTC) -> ISO 8601 with Z, or null for anything else. */
export function sqliteUtcToIso(value) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(String(value ?? ''));
  return m ? `${m[1]}T${m[2]}Z` : null;
}

/**
 * Dashboard homepage model: all runs (newest first) plus the KPI / filter-tab counts.
 * Each run also gets `snapshotCounts` and `createdAtIso` (for <time datetime>).
 *
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db] - Defaults to the shared DB
 */
export function indexModel({ db } = {}) {
  const runs = getAllTestRuns(db).map((run) => ({
    ...run,
    snapshotCounts: snapshotCounts(run),
    createdAtIso: sqliteUtcToIso(run.created_at)
  }));
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
  const snapshots = getSnapshotsByRunId(runId, db).map((s) => ({
    ...snapshotViewModel(s, storageRoot),
    historyUrl: historyPath(s.route, s.viewport)
  }));
  return {
    title: `Run Details: ${run.id}`,
    run: { ...run, createdAtIso: sqliteUtcToIso(run.created_at) },
    snapshots,
    // Snapshots still awaiting review: the "Approve all pending (N)" button
    pendingCount: snapshots.filter((s) => PENDING_STATUSES.includes(s.status)).length
  };
}

// ─── History page (one route + viewport across runs) ────────────────────────

/** Viewport names the history page accepts (also keeps "/history/<slug>/<viewport>" file-safe). */
export const VIEWPORT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// getRouteSlug() only ever produces these characters; the length cap matches file names.
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
export const HISTORY_LIMIT = 100;

/**
 * App-relative URL of a route's history page at one viewport, or null when the pair
 * can't have one (e.g. a viewport name outside VIEWPORT_PATTERN). Routes are identified
 * by getRouteSlug(), the same identity as their shared baseline file, so "/a/b" and
 * "/a_b" share one history.
 *
 * @param {string} route
 * @param {string} viewport
 * @returns {string|null}
 */
export function historyPath(route, viewport) {
  const slug = getRouteSlug(route);
  if (!SLUG_PATTERN.test(slug) || !VIEWPORT_PATTERN.test(String(viewport))) return null;
  return `/history/${slug}/${viewport}`;
}

const STATUS_PILLS = {
  MATCH: { cls: 'status-pill-passed', label: 'MATCH' },
  DIFF: { cls: 'status-pill-failed', label: 'DIFF' },
  MISSING_BASELINE: { cls: 'status-pill-failed', label: 'MISSING BASELINE' },
  NEW_BASELINE: { cls: 'status-pill-new', label: 'NEW BASELINE' },
  APPROVED: { cls: 'status-pill-approved', label: 'APPROVED' },
  REJECTED: { cls: 'status-pill-rejected', label: 'REJECTED' }
};

/**
 * The baseline a row was compared against: its hash, 'none' when there was no baseline,
 * or null when unknown (rows recorded before hashes existed, except MISSING_BASELINE).
 */
function comparedBaseline(row) {
  if (row.baseline_sha256) return row.baseline_sha256;
  return row.status === 'MISSING_BASELINE' ? 'none' : null;
}

/**
 * How the baseline changed between an older row and the next newer one:
 * 'created' (none -> baseline), 'removed' (baseline -> none), 'changed' (different
 * hash), or null (same, or unknown for either row).
 */
export function baselineChange(newer, older) {
  const before = older ? comparedBaseline(older) : null;
  const after = comparedBaseline(newer);
  if (!before || !after || before === after) return null;
  if (before === 'none') return 'created';
  if (after === 'none') return 'removed';
  return 'changed';
}

const BASELINE_CHANGE_LABELS = {
  created: 'Baseline created',
  removed: 'Baseline removed',
  changed: 'Baseline changed'
};

const pct = (n) => `${n.toFixed(2)}%`;

/**
 * Geometry for a server-rendered SVG sparkline of mismatch percentages (oldest first).
 * The y axis starts at 0%, so an all-zero history is a flat line along the bottom.
 *
 * @param {number[]} values
 * @param {{ width?: number, height?: number, pad?: number }} [size]
 */
export function buildSparkline(values, { width = 600, height = 72, pad = 8 } = {}) {
  const n = values.length;
  if (n === 0) {
    return { width, height, points: [], path: '', label: 'Mismatch: no runs recorded' };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const latest = values[n - 1];
  const top = max > 0 ? max : 1;
  const round = (v) => Math.round(v * 10) / 10;
  const points = values.map((value, i) => ({
    value,
    x: round(n === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (n - 1)),
    y: round(height - pad - (value / top) * (height - 2 * pad))
  }));
  const label = n === 1
    ? `Mismatch for 1 run: ${pct(latest)}`
    : `Mismatch over ${n} runs, oldest to newest: min ${pct(min)}, max ${pct(max)}, latest ${pct(latest)}`;
  return {
    width,
    height,
    points,
    path: points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' '),
    min,
    max,
    latest,
    label
  };
}

/**
 * History page model: every recorded snapshot of one route (by slug) at one viewport,
 * newest run first, or null when the slug/viewport is invalid or has no snapshots.
 *
 * @param {object} options
 * @param {import('better-sqlite3').Database} [options.db] - Defaults to the shared DB
 * @param {string} options.slug - getRouteSlug(route)
 * @param {string} options.viewport
 * @param {string} [options.storageRoot] - Defaults to getStorageRoot()
 */
export function historyModel({ db, slug, viewport, storageRoot = getStorageRoot() }) {
  if (typeof slug !== 'string' || typeof viewport !== 'string') return null;
  if (!SLUG_PATTERN.test(slug) || !VIEWPORT_PATTERN.test(viewport)) return null;

  const routes = getRoutesForViewport(viewport, db).filter((r) => getRouteSlug(r) === slug);
  if (routes.length === 0) return null;
  // One extra row so the oldest row shown can still be compared with the run before it,
  // and so "truncated" is only claimed when there really are more runs.
  const fetched = getSnapshotHistory({ routes, viewport, limit: HISTORY_LIMIT + 1 }, db);
  if (fetched.length === 0) return null;
  const truncated = fetched.length > HISTORY_LIMIT;
  const rows = fetched.slice(0, HISTORY_LIMIT);

  const entries = rows.map((row, i) => {
    const change = baselineChange(row, fetched[i + 1]);
    return {
      ...snapshotViewModel(row, storageRoot),
      mismatch: Number(row.mismatch_percentage) || 0,
      runUrl: `/runs/${encodeURIComponent(row.run_id)}#snapshot-${row.id}`,
      createdAtIso: sqliteUtcToIso(row.created_at),
      statusPill: STATUS_PILLS[row.status] || { cls: 'status-pill-new', label: String(row.status) },
      baselineChange: change,
      baselineChanged: change !== null,
      baselineChangeLabel: change ? BASELINE_CHANGE_LABELS[change] : null
    };
  });

  // Oldest -> newest for the chart; baseline changes become vertical markers.
  const chronological = [...entries].reverse();
  const sparkline = buildSparkline(chronological.map((e) => e.mismatch));
  sparkline.changes = chronological
    .map((e, i) => (e.baselineChanged ? { x: sparkline.points[i].x, label: e.baselineChangeLabel, runId: e.run_id } : null))
    .filter(Boolean);

  const route = rows[0].route;
  // Today's shared baseline (what the next run compares against), if there is one.
  const sharedBaseline = path.join(storageRoot, 'baselines', getSnapshotFilename(route, viewport));

  return {
    title: `History: ${route} @ ${viewport}`,
    slug,
    viewport,
    route,
    routes,
    entries,
    sparkline,
    baselineUrl: fs.existsSync(sharedBaseline) ? toWebUrl(sharedBaseline, storageRoot) : null,
    limit: HISTORY_LIMIT,
    truncated
  };
}
