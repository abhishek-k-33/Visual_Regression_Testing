import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Default database path within storage directory.
 */
export const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'storage/data.sqlite');

let dbInstance = null;

/**
 * Initializes and returns the SQLite database instance.
 * Sets WAL mode for high concurrency and executes schema creation.
 *
 * @param {string} [customDbPath] - Optional custom path for the SQLite file
 * @returns {Database.Database} SQLite database connection
 */
export function initDb(customDbPath) {
  const dbPath = customDbPath || DEFAULT_DB_PATH;

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
      baseline_path TEXT,
      current_path TEXT NOT NULL,
      diff_path TEXT,
      mismatch_percentage REAL DEFAULT 0,
      status TEXT NOT NULL, -- 'MATCH', 'DIFF', 'NEW_BASELINE', 'APPROVED', 'REJECTED'
      FOREIGN KEY (run_id) REFERENCES test_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_run_id ON snapshots(run_id);
  `);

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
      run_id, route, viewport, baseline_path, current_path, diff_path, mismatch_percentage, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    snap.run_id,
    snap.route,
    snap.viewport,
    snap.baseline_path || null,
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
      SUM(CASE WHEN s.status = 'DIFF' THEN 1 ELSE 0 END) as diff_count,
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
      SUM(CASE WHEN s.status = 'DIFF' THEN 1 ELSE 0 END) as diff_count,
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
 * - If any snapshot is 'DIFF', run is 'FAILED'
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
    if (s.status === 'DIFF') hasDiff = true;
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
 * @returns {object} Updated snapshot and new parent run status
 */
export function approveSnapshot(snapshotId, db = getDb()) {
  const snapshot = getSnapshotById(snapshotId, db);
  if (!snapshot) {
    throw new Error(`Snapshot with id ${snapshotId} not found.`);
  }

  // Promote current image to baseline on disk
  if (snapshot.baseline_path && snapshot.current_path) {
    const projectRoot = path.resolve(process.cwd());
    const resolvedBaseline = path.resolve(projectRoot, snapshot.baseline_path);
    const resolvedCurrent = path.resolve(projectRoot, snapshot.current_path);

    const relBaseline = path.relative(projectRoot, resolvedBaseline);
    const relCurrent = path.relative(projectRoot, resolvedCurrent);

    // Defense-in-depth: ensure paths strictly reside within workspace without escaping
    if (
      relBaseline.startsWith('..') ||
      path.isAbsolute(relBaseline) ||
      relCurrent.startsWith('..') ||
      path.isAbsolute(relCurrent)
    ) {
      throw new Error('Access denied: Snapshot filepaths must reside within workspace.');
    }

    // Protect critical project files and directories from accidental overwrite
    const protectedRoots = ['.git', 'node_modules', 'src', '.antigravity'];
    const firstSegment = relBaseline.split(path.sep)[0];
    if (protectedRoots.includes(firstSegment) || relBaseline === 'package.json' || relBaseline === 'package-lock.json') {
      throw new Error('Access denied: Baseline path cannot target protected source or configuration files.');
    }

    // Ensure baseline target is an image file
    const ext = path.extname(resolvedBaseline).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      throw new Error('Access denied: Baseline target must be a valid image file (.png, .jpg, .jpeg, .webp).');
    }

    fs.mkdirSync(path.dirname(resolvedBaseline), { recursive: true });
    if (fs.existsSync(resolvedCurrent)) {
      fs.copyFileSync(resolvedCurrent, resolvedBaseline);
    }
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
