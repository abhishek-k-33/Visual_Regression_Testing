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
  });

  it('approves a snapshot, copies file over baseline, and recalculates run status', () => {
    createTestRun({ id: 'run-104', status: 'FAILED' }, db);

    const currentImg = path.join(testTmpDir, 'current.png');
    const baselineImg = path.join(testTmpDir, 'baseline.png');
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

    const { snapshot: approvedSnap, runStatus } = approveSnapshot(snap.id, db);

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

  it('prevents path traversal or overwriting protected files during approveSnapshot', () => {
    createTestRun({ id: 'run-sec', status: 'FAILED' }, db);

    // Test 1: path escaping outside workspace
    const snapOutside = createSnapshot({
      run_id: 'run-sec',
      route: '/exploit1',
      viewport: 'desktop',
      baseline_path: '../../../etc/passwd.png',
      current_path: path.join(testTmpDir, 'foo.png'),
      status: 'DIFF'
    }, db);
    expect(() => approveSnapshot(snapOutside.id, db)).toThrow(/Access denied/);

    // Test 2: targeting protected source directory (e.g. src/index.js)
    const snapProtected = createSnapshot({
      run_id: 'run-sec',
      route: '/exploit2',
      viewport: 'desktop',
      baseline_path: 'src/server/db.png',
      current_path: path.join(testTmpDir, 'foo.png'),
      status: 'DIFF'
    }, db);
    expect(() => approveSnapshot(snapProtected.id, db)).toThrow(/protected source or configuration files/);

    // Test 3: targeting non-image file
    const snapNonImage = createSnapshot({
      run_id: 'run-sec',
      route: '/exploit3',
      viewport: 'desktop',
      baseline_path: 'tests/.tmp_db/exploit.sh',
      current_path: path.join(testTmpDir, 'foo.png'),
      status: 'DIFF'
    }, db);
    expect(() => approveSnapshot(snapNonImage.id, db)).toThrow(/valid image file/);
  });
});
