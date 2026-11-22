import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, createTestRun, createSnapshot } from '../src/server/db.js';
import {
  indexModel,
  runDetailModel,
  snapshotViewModel,
  toWebUrl,
  knownStorageTail
} from '../src/server/viewModels.js';

describe('view models (src/server/viewModels.js)', () => {
  const testTmpDir = path.resolve(process.cwd(), 'tests/.tmp_viewmodels');
  const storageRoot = path.join(testTmpDir, 'storage');
  let db;

  beforeEach(() => {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
    fs.mkdirSync(storageRoot, { recursive: true });
    db = initDb(path.join(testTmpDir, 'vm.sqlite'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  });

  describe('toWebUrl', () => {
    it('maps paths under the storage root to /storage URLs', () => {
      expect(toWebUrl(path.join(storageRoot, 'runs', 'r1', 'a.png'), storageRoot)).toBe('/storage/runs/r1/a.png');
      expect(toWebUrl(path.join(storageRoot, 'baselines', 'a.png'), storageRoot)).toBe('/storage/baselines/a.png');
    });

    it('encodes each path segment', () => {
      expect(toWebUrl(path.join(storageRoot, 'runs', 'r 1', 'a#b?.png'), storageRoot))
        .toBe('/storage/runs/r%201/a%23b%3F.png');
    });

    it('keeps the runs/ or baselines/ tail of paths recorded under another root', () => {
      expect(toWebUrl('/app/storage/runs/docker-run/index-desktop.png', storageRoot))
        .toBe('/storage/runs/docker-run/index-desktop.png');
      expect(toWebUrl('/app/storage/runs/docker-run/baselines/index-desktop.png', storageRoot))
        .toBe('/storage/runs/docker-run/baselines/index-desktop.png');
      expect(toWebUrl('/app/storage/baselines/index-desktop.png', storageRoot))
        .toBe('/storage/baselines/index-desktop.png');
      expect(toWebUrl('C:\\ci\\storage\\runs\\win-run\\a.png', storageRoot))
        .toBe('/storage/runs/win-run/a.png');
    });

    it('returns null for empty or unrecognisable paths', () => {
      expect(toWebUrl(null, storageRoot)).toBeNull();
      expect(toWebUrl('', storageRoot)).toBeNull();
      expect(toWebUrl('/somewhere/else/entirely.png', storageRoot)).toBeNull();
    });

    it('knownStorageTail only accepts the known layouts', () => {
      expect(knownStorageTail(['x', 'runs', 'r', 'a.png'])).toEqual(['runs', 'r', 'a.png']);
      expect(knownStorageTail(['runs', 'r', 'baselines', 'a.png'])).toEqual(['runs', 'r', 'baselines', 'a.png']);
      expect(knownStorageTail(['baselines', 'a.png'])).toEqual(['baselines', 'a.png']);
      expect(knownStorageTail(['other', 'a.png'])).toBeNull();
    });
  });

  describe('snapshotViewModel', () => {
    const at = (...p) => path.join(storageRoot, ...p);

    it('prefers the per-run baseline copy over the shared baseline', () => {
      const vm = snapshotViewModel({
        status: 'DIFF',
        baseline_path: at('baselines', 'a.png'),
        baseline_snapshot_path: at('runs', 'r1', 'baselines', 'a.png'),
        current_path: at('runs', 'r1', 'a.png'),
        diff_path: at('runs', 'r1', 'a-diff.png')
      }, storageRoot);
      expect(vm.baselineUrl).toBe('/storage/runs/r1/baselines/a.png');
      expect(vm.currentUrl).toBe('/storage/runs/r1/a.png');
      expect(vm.diffUrl).toBe('/storage/runs/r1/a-diff.png');
    });

    it('falls back to the shared baseline for rows without a copy', () => {
      const vm = snapshotViewModel({ status: 'MATCH', baseline_path: at('baselines', 'a.png'), current_path: at('runs', 'r1', 'a.png') }, storageRoot);
      expect(vm.baselineUrl).toBe('/storage/baselines/a.png');
      expect(vm.diffUrl).toBeNull();
    });

    it('shows no baseline when the run found none', () => {
      const shared = at('baselines', 'a.png');
      for (const row of [
        { status: 'MISSING_BASELINE', baseline_path: shared },
        { status: 'APPROVED', baseline_path: shared, baseline_sha256: 'none' },
        { status: 'NEW_BASELINE', baseline_path: shared, baseline_sha256: 'none' }
      ]) {
        expect(snapshotViewModel({ ...row, current_path: at('runs', 'r1', 'a.png') }, storageRoot).baselineUrl, row.status).toBeNull();
      }
    });
  });

  describe('runDetailModel', () => {
    it('returns null for an unknown run', () => {
      expect(runDetailModel({ db, runId: 'nope', storageRoot })).toBeNull();
    });

    it('returns the run and its snapshots with web URLs, including foreign-root paths', () => {
      createTestRun({ id: 'r1', status: 'FAILED' }, db);
      createSnapshot({
        run_id: 'r1', route: '/', viewport: 'desktop', status: 'DIFF',
        baseline_path: path.join(storageRoot, 'baselines', 'a.png'),
        current_path: path.join(storageRoot, 'runs', 'r1', 'a.png')
      }, db);
      createSnapshot({
        run_id: 'r1', route: '/docker', viewport: 'mobile', status: 'DIFF',
        baseline_path: '/app/storage/baselines/b.png',
        current_path: '/app/storage/runs/r1/b.png',
        diff_path: '/elsewhere/b-diff.png'
      }, db);

      const model = runDetailModel({ db, runId: 'r1', storageRoot });
      expect(model.title).toBe('Run Details: r1');
      expect(model.run.id).toBe('r1');
      expect(model.snapshots.map((s) => [s.route, s.baselineUrl, s.currentUrl, s.diffUrl])).toEqual([
        ['/', '/storage/baselines/a.png', '/storage/runs/r1/a.png', null],
        ['/docker', '/storage/baselines/b.png', '/storage/runs/r1/b.png', null]
      ]);
    });
  });

  describe('indexModel', () => {
    it('returns runs and the KPI / filter counts', () => {
      for (const [id, status] of [['a', 'PASSED'], ['b', 'APPROVED'], ['c', 'FAILED'], ['d', 'REJECTED'], ['e', 'PASSED']]) {
        createTestRun({ id, status }, db);
      }
      const model = indexModel({ db });
      expect(model.title).toBe('Visual Regression Test Runs');
      expect(model.runs).toHaveLength(5);
      expect(model.stats).toEqual({ total: 5, passed: 2, approved: 1, passedOrApproved: 3, failed: 2 });
    });

    it('handles an empty database', () => {
      expect(indexModel({ db })).toMatchObject({ runs: [], stats: { total: 0, failed: 0 } });
    });
  });
});
