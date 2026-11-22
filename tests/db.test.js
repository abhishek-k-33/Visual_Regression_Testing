import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  initDb,
  closeDb,
  createTestRun,
  createSnapshot,
  getAllTestRuns,
  getTestRunById,
  getSnapshotsByRunId,
  getSnapshotById,
  recalculateRunStatus,
  approveSnapshot,
  rejectSnapshot
} from '../src/server/db.js';

describe('SQLite Storage Layer (db.js)', () => {
  const testTmpDir = path.resolve(process.cwd(), 'tests/.tmp_db');
  const dbPath = path.join(testTmpDir, 'test.sqlite');
  let db;

  beforeEach(() => {
    fs.mkdirSync(testTmpDir, { recursive: true });
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    db = initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(testTmpDir)) {
      fs.rmSync(testTmpDir, { recursive: true, force: true });
    }
  });

  it('initializes the SQLite tables with correct schema', () => {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name IN ('test_runs', 'snapshots')
    `).all();
    expect(tables).toHaveLength(2);
  });

  it('creates and retrieves a test run record', () => {
    const run = createTestRun({
      id: 'run-101',
      commit_hash: 'a1b2c3d',
      branch: 'main',
      status: 'PASSED'
    }, db);

    expect(run).toBeDefined();
    expect(run.id).toBe('run-101');
    expect(run.commit_hash).toBe('a1b2c3d');
    expect(run.branch).toBe('main');
    expect(run.status).toBe('PASSED');
    expect(run.total_snapshots).toBe(0);
  });

  it('creates and associates snapshots with a run', () => {
    createTestRun({ id: 'run-102', status: 'FAILED' }, db);

    const snap1 = createSnapshot({
      run_id: 'run-102',
      route: '/',
      viewport: 'desktop',
      baseline_path: 'storage/baselines/index-desktop.png',
      current_path: 'storage/runs/run-102/index-desktop.png',
      diff_path: null,
      mismatch_percentage: 0,
      status: 'MATCH'
    }, db);

    const snap2 = createSnapshot({
      run_id: 'run-102',
      route: '/',
      viewport: 'mobile',
      baseline_path: 'storage/baselines/index-mobile.png',
      current_path: 'storage/runs/run-102/index-mobile.png',
      diff_path: 'storage/runs/run-102/index-mobile-diff.png',
      mismatch_percentage: 2.5,
      status: 'DIFF'
    }, db);

    expect(snap1.id).toBe(1);
    expect(snap2.id).toBe(2);

    const snapshots = getSnapshotsByRunId('run-102', db);
    expect(snapshots).toHaveLength(2);

    const run = getTestRunById('run-102', db);
    expect(run.total_snapshots).toBe(2);
    expect(run.diff_count).toBe(1);
    expect(run.match_count).toBe(1);
  });

  it('correctly recalculates run status based on child snapshots', () => {
    createTestRun({ id: 'run-103', status: 'FAILED' }, db);

    createSnapshot({
      run_id: 'run-103',
      route: '/',
      viewport: 'desktop',
      current_path: 'c1.png',
      status: 'DIFF'
    }, db);

    expect(recalculateRunStatus('run-103', db)).toBe('FAILED');

    // Update snapshot to MATCH
    db.prepare("UPDATE snapshots SET status = 'MATCH' WHERE run_id = 'run-103'").run();
    expect(recalculateRunStatus('run-103', db)).toBe('PASSED');

    // A missing baseline (strict mode) fails the run like a diff
    db.prepare("UPDATE snapshots SET status = 'MISSING_BASELINE' WHERE run_id = 'run-103'").run();
    expect(recalculateRunStatus('run-103', db)).toBe('FAILED');
  });

  it('approves a snapshot, copies file over baseline, and recalculates run status', () => {
    createTestRun({ id: 'run-104', status: 'FAILED' }, db);

    const storageRoot = path.join(testTmpDir, 'storage');
    const currentImg = path.join(storageRoot, 'runs', 'run-104', 'about-desktop.png');
    const baselineImg = path.join(storageRoot, 'baselines', 'about-desktop.png');
    fs.mkdirSync(path.dirname(currentImg), { recursive: true });
    fs.mkdirSync(path.dirname(baselineImg), { recursive: true });
    fs.writeFileSync(currentImg, 'NEW_IMAGE_CONTENT');
    fs.writeFileSync(baselineImg, 'OLD_IMAGE_CONTENT');

    const snap = createSnapshot({
      run_id: 'run-104',
      route: '/about',
      viewport: 'desktop',
      baseline_path: baselineImg,
      current_path: currentImg,
      status: 'DIFF'
    }, db);

    const { snapshot: approvedSnap, runStatus } = approveSnapshot(snap.id, db, { storageRoot });

    expect(approvedSnap.status).toBe('APPROVED');
    expect(runStatus).toBe('APPROVED');
    expect(fs.readFileSync(baselineImg, 'utf8')).toBe('NEW_IMAGE_CONTENT');
  });

  it('rejects a snapshot and marks parent run as REJECTED', () => {
    createTestRun({ id: 'run-105', status: 'FAILED' }, db);

    const snap = createSnapshot({
      run_id: 'run-105',
      route: '/contact',
      viewport: 'mobile',
      current_path: 'contact.png',
      status: 'DIFF'
    }, db);

    const { snapshot: rejectedSnap, runStatus } = rejectSnapshot(snap.id, db);

    expect(rejectedSnap.status).toBe('REJECTED');
    expect(runStatus).toBe('REJECTED');

    const run = getTestRunById('run-105', db);
    expect(run.status).toBe('REJECTED');
  });

  describe('approveSnapshot path allowlist', () => {
    let storageRoot;
    let goodCurrent;
    let goodBaseline;
    let n = 0;

    beforeEach(() => {
      storageRoot = path.join(testTmpDir, 'storage');
      goodCurrent = path.join(storageRoot, 'runs', 'run-sec', 'index-desktop.png');
      goodBaseline = path.join(storageRoot, 'baselines', 'index-desktop.png');
      fs.mkdirSync(path.dirname(goodCurrent), { recursive: true });
      fs.mkdirSync(path.dirname(goodBaseline), { recursive: true });
      fs.writeFileSync(goodCurrent, 'NEW');
      fs.writeFileSync(goodBaseline, 'OLD');
      createTestRun({ id: 'run-sec', status: 'FAILED' }, db);
    });

    function approveWith(current_path, baseline_path) {
      const snap = createSnapshot({
        run_id: 'run-sec', route: `/case${n++}`, viewport: 'desktop',
        current_path, baseline_path, status: 'DIFF'
      }, db);
      return () => approveSnapshot(snap.id, db, { storageRoot });
    }

    it('approving a MISSING_BASELINE snapshot creates the baseline', () => {
      const newBaseline = path.join(storageRoot, 'baselines', 'brand-new-desktop.png');
      const snap = createSnapshot({
        run_id: 'run-sec', route: '/brand-new', viewport: 'desktop',
        current_path: goodCurrent, baseline_path: newBaseline, status: 'MISSING_BASELINE'
      }, db);
      const result = approveSnapshot(snap.id, db, { storageRoot });
      expect(fs.readFileSync(newBaseline, 'utf8')).toBe('NEW');
      expect(result.snapshot.status).toBe('APPROVED');
    });

    it('refuses to copy a source outside storage/runs (e.g. a secrets file)', () => {
      const secret = path.join(testTmpDir, '.env');
      fs.writeFileSync(secret, 'FAKE_SECRET=1');
      expect(approveWith(secret, goodBaseline)).toThrow(/Access denied/);
      expect(fs.readFileSync(goodBaseline, 'utf8')).toBe('OLD');
    });

    it('refuses a .png source that lives outside storage/runs', () => {
      const outside = path.join(testTmpDir, 'outside.png');
      fs.writeFileSync(outside, 'X');
      expect(approveWith(outside, goodBaseline)).toThrow(/Access denied/);
    });

    it('refuses a target outside storage/baselines', () => {
      expect(approveWith(goodCurrent, path.join(storageRoot, 'runs', 'evil.png'))).toThrow(/Access denied/);
      expect(approveWith(goodCurrent, '../../../etc/passwd.png')).toThrow(/Access denied/);
      expect(approveWith(goodCurrent, 'src/server/db.png')).toThrow(/Access denied/);
    });

    it('refuses traversal that climbs out of storage/runs', () => {
      const sneaky = path.join(storageRoot, 'runs', '..', '..', 'outside.png');
      fs.writeFileSync(path.join(testTmpDir, 'outside.png'), 'X');
      expect(approveWith(sneaky, goodBaseline)).toThrow(/Access denied/);
    });

    it('refuses non-PNG source and target files', () => {
      const txt = path.join(storageRoot, 'runs', 'run-sec', 'notes.txt');
      fs.writeFileSync(txt, 'X');
      expect(approveWith(txt, goodBaseline)).toThrow(/Access denied/);
      expect(approveWith(goodCurrent, path.join(storageRoot, 'baselines', 'exploit.sh'))).toThrow(/Access denied/);
    });

    it('refuses a symlink in storage/runs that points outside', () => {
      const secret = path.join(testTmpDir, 'secret.png');
      fs.writeFileSync(secret, 'SECRET');
      const link = path.join(storageRoot, 'runs', 'run-sec', 'link.png');
      fs.symlinkSync(secret, link);
      expect(approveWith(link, goodBaseline)).toThrow(/Access denied/);
      expect(fs.readFileSync(goodBaseline, 'utf8')).toBe('OLD');
    });

    it('refuses a baseline symlink that points outside (no write-through)', () => {
      const victim = path.join(testTmpDir, 'victim.png');
      fs.writeFileSync(victim, 'ORIGINAL');
      const link = path.join(storageRoot, 'baselines', 'link.png');
      fs.symlinkSync(victim, link);
      expect(approveWith(goodCurrent, link)).toThrow(/Access denied/);
      expect(fs.readFileSync(victim, 'utf8')).toBe('ORIGINAL');
    });

    it('refuses a sibling directory whose name shares the storage prefix', () => {
      const sibling = path.join(testTmpDir, 'storage-evil', 'runs', 'x.png');
      fs.mkdirSync(path.dirname(sibling), { recursive: true });
      fs.writeFileSync(sibling, 'X');
      expect(approveWith(sibling, goodBaseline)).toThrow(/Access denied/);
    });

    it('creates a new baseline file inside storage/baselines when none exists yet', () => {
      const fresh = path.join(storageRoot, 'baselines', 'fresh-desktop.png');
      approveWith(goodCurrent, fresh)();
      expect(fs.readFileSync(fresh, 'utf8')).toBe('NEW');
    });
  });
});
