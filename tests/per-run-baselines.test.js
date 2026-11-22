import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PNG } from 'pngjs';
import { compareSnapshot, sha256, NO_BASELINE } from '../src/cli/compare.js';
import {
  initDb,
  closeDb,
  createTestRun,
  createSnapshot,
  getSnapshotById,
  approveSnapshot,
  rejectSnapshot
} from '../src/server/db.js';

// Every run shares one baseline file per route/viewport. These tests cover the
// two ways that went wrong: old runs displaying today's baseline, and approving
// an old run silently reverting a newer approved baseline.

function solidPng(r, g, b, size = 10) {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

const RED = solidPng(255, 0, 0);
const GREEN = solidPng(0, 255, 0);
const BLUE = solidPng(0, 0, 255);

describe('Per-run baselines and stale approvals', () => {
  const tmp = path.resolve(process.cwd(), 'tests/.tmp_per_run');
  const storageRoot = path.join(tmp, 'storage');
  const baselinesDir = path.join(storageRoot, 'baselines');
  const baselineFile = path.join(baselinesDir, 'index-desktop.png');
  let db;

  beforeEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(baselinesDir, { recursive: true });
    db = initDb(path.join(tmp, 'test.sqlite'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Capture `png` as run `runId`, compare it the way the CLI does, and record it.
  function recordRun(runId, png, { strict = false } = {}) {
    const runDir = path.join(storageRoot, 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    const current = path.join(runDir, 'index-desktop.png');
    fs.writeFileSync(current, png);

    const r = compareSnapshot(
      { route: '/', viewport: 'desktop', filepath: current },
      { baselinesDir, diffDir: runDir, createMissingBaselines: !strict }
    );
    createTestRun({ id: runId, status: ['DIFF', 'MISSING_BASELINE'].includes(r.status) ? 'FAILED' : 'PASSED' }, db);
    return createSnapshot({
      run_id: runId,
      route: '/',
      viewport: 'desktop',
      baseline_path: r.baselinePath,
      baseline_snapshot_path: r.baselineSnapshotPath,
      baseline_sha256: r.baselineSha256,
      current_path: r.currentPath,
      diff_path: r.diffPath,
      mismatch_percentage: r.mismatchPercentage,
      status: r.status
    }, db);
  }

  it('records a per-run copy and hash of the baseline that was compared', () => {
    fs.writeFileSync(baselineFile, RED);
    const snap = recordRun('run-a', GREEN);

    expect(snap.status).toBe('DIFF');
    expect(snap.baseline_snapshot_path).toBe(path.join(storageRoot, 'runs', 'run-a', 'baselines', 'index-desktop.png'));
    expect(fs.readFileSync(snap.baseline_snapshot_path).equals(RED)).toBe(true);
    expect(snap.baseline_sha256).toBe(sha256(RED));
  });

  it('regression: approving an older run cannot overwrite a newer approved baseline', () => {
    fs.writeFileSync(baselineFile, RED);
    const older = recordRun('run-older', GREEN); // compared against RED
    const newer = recordRun('run-newer', BLUE); // also compared against RED

    // Approve the newer run first: baseline becomes BLUE
    approveSnapshot(newer.id, db, { storageRoot });
    expect(fs.readFileSync(baselineFile).equals(BLUE)).toBe(true);

    // The older run still shows what it was actually compared against
    expect(fs.readFileSync(getSnapshotById(older.id, db).baseline_snapshot_path).equals(RED)).toBe(true);

    // Approving it now would revert BLUE -> GREEN; refuse instead
    expect(() => approveSnapshot(older.id, db, { storageRoot })).toThrow(/^Conflict: the baseline has changed/);
    expect(fs.readFileSync(baselineFile).equals(BLUE)).toBe(true);
    expect(getSnapshotById(older.id, db).status).toBe('DIFF');
  });

  it('refuses to approve if the baseline was deleted after the run', () => {
    fs.writeFileSync(baselineFile, RED);
    const snap = recordRun('run-a', GREEN);
    fs.unlinkSync(baselineFile);
    expect(() => approveSnapshot(snap.id, db, { storageRoot })).toThrow(/^Conflict/);
    expect(fs.existsSync(baselineFile)).toBe(false);
  });

  it('refuses a MISSING_BASELINE approval once a baseline has appeared', () => {
    const runDir = path.join(storageRoot, 'runs', 'run-missing');
    fs.mkdirSync(runDir, { recursive: true });
    const current = path.join(runDir, 'index-desktop.png');
    fs.writeFileSync(current, GREEN);
    createTestRun({ id: 'run-missing', status: 'FAILED' }, db);
    const snap = createSnapshot({
      run_id: 'run-missing', route: '/', viewport: 'desktop',
      baseline_path: baselineFile, current_path: current, status: 'MISSING_BASELINE'
    }, db);

    fs.writeFileSync(baselineFile, BLUE); // someone else created it meanwhile
    expect(() => approveSnapshot(snap.id, db, { storageRoot })).toThrow(/^Conflict/);
    expect(fs.readFileSync(baselineFile).equals(BLUE)).toBe(true);
  });

  it('still approves rows recorded before hashes existed (legacy behaviour)', () => {
    fs.writeFileSync(baselineFile, RED);
    const runDir = path.join(storageRoot, 'runs', 'run-legacy');
    fs.mkdirSync(runDir, { recursive: true });
    const current = path.join(runDir, 'index-desktop.png');
    fs.writeFileSync(current, GREEN);
    createTestRun({ id: 'run-legacy', status: 'FAILED' }, db);
    const snap = createSnapshot({
      run_id: 'run-legacy', route: '/', viewport: 'desktop',
      baseline_path: baselineFile, current_path: current, status: 'DIFF'
    }, db);

    approveSnapshot(snap.id, db, { storageRoot });
    expect(fs.readFileSync(baselineFile).equals(GREEN)).toBe(true);
  });

  it('compareSnapshot records NEW_BASELINE and MISSING_BASELINE baselines correctly', () => {
    const created = recordRun('run-first', GREEN);
    expect(created.status).toBe('NEW_BASELINE');
    expect(created.baseline_snapshot_path).toBe(created.current_path);
    expect(created.baseline_sha256).toBe(sha256(GREEN));

    fs.unlinkSync(baselineFile);
    const missing = recordRun('run-strict', GREEN, { strict: true });
    expect(missing.status).toBe('MISSING_BASELINE');
    expect(missing.baseline_snapshot_path).toBeNull();
    expect(missing.baseline_sha256).toBe(NO_BASELINE);
  });

  it('regression: an approved MISSING_BASELINE run cannot later revert a newer baseline', () => {
    const missing = recordRun('run-m', RED, { strict: true });
    approveSnapshot(missing.id, db, { storageRoot }); // baseline: RED
    const newer = recordRun('run-n', GREEN);
    approveSnapshot(newer.id, db, { storageRoot }); // baseline: GREEN

    // Status is now APPROVED, but the run still records that it saw no baseline
    expect(() => approveSnapshot(missing.id, db, { storageRoot })).toThrow(/^Conflict/);
    expect(fs.readFileSync(baselineFile).equals(GREEN)).toBe(true);
  });

  it('regression: a rejected MISSING_BASELINE run cannot overwrite a baseline created later', () => {
    const missing = recordRun('run-m2', RED, { strict: true });
    rejectSnapshot(missing.id, db);
    fs.writeFileSync(baselineFile, GREEN);

    expect(() => approveSnapshot(missing.id, db, { storageRoot })).toThrow(/^Conflict/);
    expect(fs.readFileSync(baselineFile).equals(GREEN)).toBe(true);
  });

  it('allows an approval that would not change the baseline (same screenshot already approved)', () => {
    fs.writeFileSync(baselineFile, RED);
    const a = recordRun('run-a', BLUE);
    const b = recordRun('run-b', BLUE);
    approveSnapshot(a.id, db, { storageRoot });

    const result = approveSnapshot(b.id, db, { storageRoot });
    expect(result.snapshot.status).toBe('APPROVED');
    expect(fs.readFileSync(baselineFile).equals(BLUE)).toBe(true);
  });

  it('keeps baseline copies apart from screenshots of viewports named "*-baseline"', () => {
    fs.writeFileSync(baselineFile, RED);
    const runDir = path.join(storageRoot, 'runs', 'run-vp');
    fs.mkdirSync(runDir, { recursive: true });
    // Screenshot of a viewport literally named "desktop-baseline"
    const otherViewportShot = path.join(runDir, 'index-desktop-baseline.png');
    fs.writeFileSync(otherViewportShot, BLUE);
    const current = path.join(runDir, 'index-desktop.png');
    fs.writeFileSync(current, GREEN);

    compareSnapshot({ route: '/', viewport: 'desktop', filepath: current }, { baselinesDir, diffDir: runDir });
    expect(fs.readFileSync(otherViewportShot).equals(BLUE)).toBe(true);
  });

  it('migrates a database created before per-run baselines', () => {
    closeDb();
    const legacyPath = path.join(tmp, 'legacy.sqlite');
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE test_runs (id TEXT PRIMARY KEY, commit_hash TEXT, branch TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL);
      CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
        route TEXT NOT NULL, viewport TEXT NOT NULL, baseline_path TEXT, current_path TEXT NOT NULL,
        diff_path TEXT, mismatch_percentage REAL DEFAULT 0, status TEXT NOT NULL);
      INSERT INTO test_runs (id, status) VALUES ('old-run', 'FAILED');
      INSERT INTO snapshots (run_id, route, viewport, current_path, status)
        VALUES ('old-run', '/', 'desktop', 'c.png', 'DIFF');
    `);
    legacy.close();

    db = initDb(legacyPath);
    const columns = db.prepare('PRAGMA table_info(snapshots)').all().map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['baseline_snapshot_path', 'baseline_sha256']));
    const old = db.prepare("SELECT * FROM snapshots WHERE run_id = 'old-run'").get();
    expect(old.status).toBe('DIFF');
    expect(old.baseline_sha256).toBeNull();

    // Re-opening an already migrated database is a no-op
    closeDb();
    expect(() => { db = initDb(legacyPath); }).not.toThrow();
  });
});
