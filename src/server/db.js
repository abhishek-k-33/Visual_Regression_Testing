import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getStorageRoot, resolvePngInside } from './paths.js';

/**
 * Default database path: data.sqlite inside the storage root (see getStorageRoot).
 *
 * @returns {string}
 */
export function getDefaultDbPath() {
  return path.join(getStorageRoot(), 'data.sqlite');
}

let dbInstance = null;

/**
 * Initializes and returns the SQLite database instance.
 * Sets WAL mode for high concurrency and executes schema creation.
 *
 * @param {string} [customDbPath] - Optional custom path for the SQLite file
 * @returns {Database.Database} SQLite database connection
 */
export function initDb(customDbPath) {
  const dbPath = customDbPath || getDefaultDbPath();

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (_) {}
    dbInstance = null;
  }

  const db = new Database(dbPath);

  // Enable WAL mode for optimal concurrent performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Schema creation
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_runs (
      id TEXT PRIMARY KEY,
      commit_hash TEXT,
      branch TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL -- 'PASSED', 'FAILED', 'APPROVED', 'REJECTED'
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      route TEXT NOT NULL,
      viewport TEXT NOT NULL,
      baseline_path TEXT,             -- shared baseline that approval promotes into
      baseline_snapshot_path TEXT,    -- per-run copy of the baseline actually compared
      baseline_sha256 TEXT,           -- hash of that baseline ('none' if there was none), to refuse stale approvals
      current_path TEXT NOT NULL,
      diff_path TEXT,
      mismatch_percentage REAL DEFAULT 0,
      status TEXT NOT NULL, -- 'MATCH', 'DIFF', 'NEW_BASELINE', 'MISSING_BASELINE', 'APPROVED', 'REJECTED'
      FOREIGN KEY (run_id) REFERENCES test_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_run_id ON snapshots(run_id);
  `);

  // Migrate databases created before per-run baselines existed. IMMEDIATE locking so a
  // dashboard and CLI opening the same old database at once don't both add the columns.
  db.transaction(() => {
    const columns = new Set(db.prepare('PRAGMA table_info(snapshots)').all().map((c) => c.name));
    for (const column of ['baseline_snapshot_path', 'baseline_sha256']) {
      if (!columns.has(column)) db.exec(`ALTER TABLE snapshots ADD COLUMN ${column} TEXT`);
    }
  }).immediate();

  dbInstance = db;
  return db;
}

/**
 * Returns the singleton or active database instance.
 *
 * @param {string} [dbPath] - Optional path
 * @returns {Database.Database}
 */
export function getDb(dbPath) {
  if (!dbInstance || (dbPath && dbInstance.name !== dbPath)) {
    dbInstance = initDb(dbPath);
  }
  return dbInstance;
}

/**
 * Closes the active database connection (useful for testing and graceful shutdowns).
 */
export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Inserts a new test run record.
 *
 * @param {object} run - Test run metadata
 * @param {string} run.id - Unique run ID
 * @param {string} [run.commit_hash] - Git commit hash
 * @param {string} [run.branch] - Git branch
 * @param {string} run.status - 'PASSED', 'FAILED', 'APPROVED', 'REJECTED'
 * @param {Database.Database} [db] - Optional DB instance
 * @returns {object} The created run
 */
export function createTestRun(run, db = getDb()) {
  const stmt = db.prepare(`
    INSERT INTO test_runs (id, commit_hash, branch, status)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(
    run.id,
    run.commit_hash || null,
    run.branch || null,
    run.status || 'PASSED'
  );

  return getTestRunById(run.id, db);
}

/**
 * Inserts a snapshot record associated with a test run.
 *
 * @param {object} snap - Snapshot metadata
 * @param {Database.Database} [db] - Optional DB instance
 * @returns {object} The created snapshot with its ID
 */
export function createSnapshot(snap, db = getDb()) {
  const stmt = db.prepare(`
    INSERT INTO snapshots (
      run_id, route, viewport, baseline_path, baseline_snapshot_path, baseline_sha256,
      current_path, diff_path, mismatch_percentage, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    snap.run_id,
    snap.route,
    snap.viewport,
    snap.baseline_path || null,
    snap.baseline_snapshot_path || null,
    snap.baseline_sha256 || null,
    snap.current_path,
    snap.diff_path || null,
    snap.mismatch_percentage !== undefined ? snap.mismatch_percentage : 0,
    snap.status || 'MATCH'
  );

  return getSnapshotById(info.lastInsertRowid, db);
}

/**
 * Fetches all test runs ordered by creation date descending,
 * augmented with snapshot counts (total, diffs, matches).
 *
 * @param {Database.Database} [db] - Optional DB instance
 * @returns {Array<object>}
 */
export function getAllTestRuns(db = getDb()) {
  const stmt = db.prepare(`
    SELECT 
      r.*,
      COUNT(s.id) as total_snapshots,
      SUM(CASE WHEN s.status IN ('DIFF', 'MISSING_BASELINE') THEN 1 ELSE 0 END) as diff_count,
      SUM(CASE WHEN s.status = 'MATCH' THEN 1 ELSE 0 END) as match_count,
      SUM(CASE WHEN s.status = 'NEW_BASELINE' THEN 1 ELSE 0 END) as new_baseline_count,
      SUM(CASE WHEN s.status = 'APPROVED' THEN 1 ELSE 0 END) as approved_count
    FROM test_runs r
    LEFT JOIN snapshots s ON s.run_id = r.id
    GROUP BY r.id
    ORDER BY r.created_at DESC
  `);
  return stmt.all();
}

/**
 * Fetches a single test run by its ID.
 *
 * @param {string} id - Run ID
 * @param {Database.Database} [db] - Optional DB instance
 * @returns {object|null}
 */
export function getTestRunById(id, db = getDb()) {
  const stmt = db.prepare(`
    SELECT 
      r.*,
      COUNT(s.id) as total_snapshots,
      SUM(CASE WHEN s.status IN ('DIFF', 'MISSING_BASELINE') THEN 1 ELSE 0 END) as diff_count,
      SUM(CASE WHEN s.status = 'MATCH' THEN 1 ELSE 0 END) as match_count,
      SUM(CASE WHEN s.status = 'NEW_BASELINE' THEN 1 ELSE 0 END) as new_baseline_count,
      SUM(CASE WHEN s.status = 'APPROVED' THEN 1 ELSE 0 END) as approved_count
    FROM test_runs r
    LEFT JOIN snapshots s ON s.run_id = r.id
    WHERE r.id = ?
    GROUP BY r.id
  `);
  return stmt.get(id) || null;
}

/**
 * Fetches all snapshots belonging to a given run ID.
 *
 * @param {string} runId - Run ID
 * @param {Database.Database} [db] - Optional DB instance
 * @returns {Array<object>}
 */
export function getSnapshotsByRunId(runId, db = getDb()) {
  const stmt = db.prepare(`
    SELECT * FROM snapshots
    WHERE run_id = ?
    ORDER BY id ASC
  `);
  return stmt.all(runId);
}

/**
 * Fetches a single snapshot by its primary key ID.
 *
 * @param {number|string} id - Snapshot ID
 * @param {Database.Database} [db] - Optional DB instance
 * @returns {object|null}
 */
export function getSnapshotById(id, db = getDb()) {
  const stmt = db.prepare('SELECT * FROM snapshots WHERE id = ?');
  return stmt.get(id) || null;
}

/**
 * Recalculates and updates the parent test_run status based on all its child snapshots:
 * - If any snapshot is 'DIFF' or 'MISSING_BASELINE', run is 'FAILED'
 * - If any snapshot is 'REJECTED', run is 'REJECTED'
 * - If all snapshots are 'APPROVED', 'MATCH', or 'NEW_BASELINE':
 *     - If at least one was 'APPROVED', run is 'APPROVED'
 *     - Else, run is 'PASSED'
 *
 * @param {string} runId - Parent run ID
 * @param {Database.Database} [db] - Optional DB instance
 * @returns {string} New run status
 */
export function recalculateRunStatus(runId, db = getDb()) {
  const snapshots = getSnapshotsByRunId(runId, db);
  if (!snapshots || snapshots.length === 0) {
    return 'PASSED';
  }

  let hasDiff = false;
  let hasRejected = false;
  let hasApproved = false;

  for (const s of snapshots) {
    if (s.status === 'DIFF' || s.status === 'MISSING_BASELINE') hasDiff = true;
    if (s.status === 'REJECTED') hasRejected = true;
    if (s.status === 'APPROVED') hasApproved = true;
  }

  let newStatus = 'PASSED';
  if (hasRejected) {
    newStatus = 'REJECTED';
  } else if (hasDiff) {
    newStatus = 'FAILED';
  } else if (hasApproved) {
    newStatus = 'APPROVED';
  }

  db.prepare('UPDATE test_runs SET status = ? WHERE id = ?').run(newStatus, runId);
  return newStatus;
}

/**
 * Approves a snapshot:
 * 1. Copies current_path screenshot over baseline_path on disk
 * 2. Updates snapshot status in SQLite to 'APPROVED'
 * 3. Recalculates parent test_run status
 *
 * @param {number|string} snapshotId - Snapshot ID
 * @param {Database.Database} [db] - Optional DB instance
 * @param {object} [options]
 * @param {string} [options.storageRoot] - Storage root (defaults to getStorageRoot())
 * @returns {object} Updated snapshot and new parent run status
 */
const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Refuses to approve a run whose baseline has since been replaced (e.g. a newer run was
 * approved), which would otherwise silently revert the newer baseline.
 * - baseline_sha256 'none': the run found no baseline, so there must still be none.
 * - any other hash: the baseline must still have that hash.
 * - NULL (rows recorded before hashes existed): unchecked, except legacy
 *   MISSING_BASELINE rows, which must still have no baseline.
 * Approving is always allowed when the baseline already equals this run's screenshot,
 * since the copy then changes nothing.
 */
function assertBaselineUnchanged(snapshot, source, target) {
  const exists = fs.existsSync(target);
  const recorded = snapshot.baseline_sha256 ||
    (snapshot.status === 'MISSING_BASELINE' ? 'none' : null);
  if (!recorded) return;

  const actual = exists ? hashFile(target) : 'none';
  if (actual === recorded) return;
  if (exists && actual === hashFile(source)) return; // already this screenshot: no-op

  throw new Error(
    'Conflict: the baseline has changed since this run (a newer run was probably approved). ' +
    'Re-run the visual tests and review the new result instead.'
  );
}

export function approveSnapshot(snapshotId, db = getDb(), options = {}) {
  const snapshot = getSnapshotById(snapshotId, db);
  if (!snapshot) {
    throw new Error(`Snapshot with id ${snapshotId} not found.`);
  }

  // Promote current image to baseline on disk.
  // Allowlist: copy only a .png from <storage>/runs/ to a .png in <storage>/baselines/.
  if (snapshot.baseline_path && snapshot.current_path) {
    const storageRoot = options.storageRoot || getStorageRoot();
    const source = resolvePngInside(snapshot.current_path, path.join(storageRoot, 'runs'));
    const target = resolvePngInside(snapshot.baseline_path, path.join(storageRoot, 'baselines'), { mustExist: false });
    assertBaselineUnchanged(snapshot, source, target);
    fs.copyFileSync(source, target);
  }

  // Update snapshot status in database
  db.prepare('UPDATE snapshots SET status = ? WHERE id = ?').run('APPROVED', snapshotId);

  // Recalculate parent run status
  const runStatus = recalculateRunStatus(snapshot.run_id, db);

  return {
    snapshot: getSnapshotById(snapshotId, db),
    runStatus
  };
}

/**
 * Rejects a snapshot:
 * 1. Updates snapshot status in SQLite to 'REJECTED'
 * 2. Updates parent run status to 'REJECTED'
 *
 * @param {number|string} snapshotId - Snapshot ID
 * @param {Database.Database} [db] - Optional DB instance
 * @returns {object} Updated snapshot and new parent run status
 */
export function rejectSnapshot(snapshotId, db = getDb()) {
  const snapshot = getSnapshotById(snapshotId, db);
  if (!snapshot) {
    throw new Error(`Snapshot with id ${snapshotId} not found.`);
  }

  db.prepare('UPDATE snapshots SET status = ? WHERE id = ?').run('REJECTED', snapshotId);
  const runStatus = recalculateRunStatus(snapshot.run_id, db);

  return {
    snapshot: getSnapshotById(snapshotId, db),
    runStatus
  };
}
