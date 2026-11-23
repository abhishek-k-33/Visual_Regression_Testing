import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, createTestRun, createSnapshot } from '../src/server/db.js';
import {
  indexModel,
  runDetailModel,
  snapshotViewModel,
  toWebUrl,
  knownStorageTail,
  historyModel,
  historyPath,
  baselineChange,
  buildSparkline,
  snapshotCounts,
  sqliteUtcToIso,
  HISTORY_LIMIT
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

    it('gives each run its non-zero snapshot counts and an ISO time', () => {
      createTestRun({ id: 'base', status: 'PASSED', created_at: '2026-11-20 09:00:00' }, db);
      createTestRun({ id: 'mixed', status: 'FAILED', created_at: '2026-11-21 09:00:00' }, db);
      createTestRun({ id: 'empty', status: 'PASSED', created_at: '2026-11-22 09:00:00' }, db);
      const snap = (run_id, route, status) => createSnapshot({ run_id, route, viewport: 'desktop', status, current_path: path.join(storageRoot, 'runs', run_id, 'a.png') }, db);
      snap('base', '/a', 'NEW_BASELINE');
      snap('base', '/b', 'NEW_BASELINE');
      for (const [route, status] of [['/a', 'DIFF'], ['/b', 'MISSING_BASELINE'], ['/c', 'MATCH'], ['/d', 'APPROVED'], ['/e', 'REJECTED']]) snap('mixed', route, status);

      const runs = Object.fromEntries(indexModel({ db }).runs.map((r) => [r.id, r]));
      expect(runs.base.snapshotCounts).toEqual([{ count: 2, label: 'new baseline', cls: 'new-count' }]);
      expect(runs.mixed.snapshotCounts.map((p) => `${p.count} ${p.label}`)).toEqual(['2 diff', '1 rejected', '1 approved', '1 match']);
      expect(runs.empty.snapshotCounts).toEqual([]);
      expect(runs.base.createdAtIso).toBe('2026-11-20T09:00:00Z');
      expect(runDetailModel({ db, runId: 'base', storageRoot }).run.createdAtIso).toBe('2026-11-20T09:00:00Z');
    });
  });

  describe('snapshotCounts / sqliteUtcToIso', () => {
    it('lists approved runs as approved, not "0 match"', () => {
      expect(snapshotCounts({ total_snapshots: 3, approved_count: 2, match_count: 1, diff_count: 0 }))
        .toEqual([{ count: 2, label: 'approved', cls: 'approved-count' }, { count: 1, label: 'match', cls: 'match-count' }]);
      expect(snapshotCounts({ total_snapshots: 0, match_count: null })).toEqual([]);
    });

    it('converts only the SQLite UTC format', () => {
      expect(sqliteUtcToIso('2026-11-23 10:20:30')).toBe('2026-11-23T10:20:30Z');
      expect(sqliteUtcToIso('yesterday')).toBeNull();
      expect(sqliteUtcToIso(null)).toBeNull();
    });
  });

  describe('runDetailModel history links', () => {
    it('adds a history URL per snapshot, keyed by route slug and viewport', () => {
      createTestRun({ id: 'r1', status: 'PASSED' }, db);
      for (const [route, viewport] of [['/', 'desktop'], ['/blog/post 1', 'mobile'], ['/x', 'bad.name']]) {
        createSnapshot({ run_id: 'r1', route, viewport, status: 'MATCH', current_path: path.join(storageRoot, 'runs', 'r1', 'a.png') }, db);
      }
      expect(runDetailModel({ db, runId: 'r1', storageRoot }).snapshots.map((s) => s.historyUrl))
        .toEqual(['/history/index/desktop', '/history/blog_post_1/mobile', null]);
    });
  });

  describe('history', () => {
    const png = (run, name = 'index-desktop.png') => path.join(storageRoot, 'runs', run, name);
    function seed(id, createdAt, snapshots) {
      createTestRun({ id, status: 'PASSED', created_at: createdAt, branch: 'main', commit_hash: 'abc1234' }, db);
      return snapshots.map((snap) => createSnapshot({
        run_id: id,
        route: '/',
        viewport: 'desktop',
        status: 'MATCH',
        current_path: png(id),
        ...snap
      }, db));
    }

    describe('historyPath', () => {
      it('uses the route slug (same identity as the baseline file) and the viewport', () => {
        expect(historyPath('/', 'desktop')).toBe('/history/index/desktop');
        expect(historyPath('', 'mobile')).toBe('/history/index/mobile');
        expect(historyPath('/a/b/', 'm_1-x')).toBe('/history/a_b/m_1-x');
      });

      it('returns null for viewports that are not URL/file safe', () => {
        for (const vp of ['', 'a.b', 'a b', '../x', 'x'.repeat(65), 'ü']) expect(historyPath('/', vp), vp).toBeNull();
        expect(historyPath('/', 'x'.repeat(64))).not.toBeNull();
      });
    });

    it('returns null for unknown or invalid slugs and viewports', () => {
      seed('r1', '2026-01-01 00:00:00', [{}]);
      expect(historyModel({ db, slug: 'index', viewport: 'desktop', storageRoot })).not.toBeNull();
      for (const [slug, viewport] of [
        ['nope', 'desktop'],
        ['index', 'mobile'],
        ['index', 'desk.top'],
        ['index', '../desktop'],
        ['index', ''],
        ['../index', 'desktop'],
        ['', 'desktop'],
        [undefined, 'desktop']
      ]) {
        expect(historyModel({ db, slug, viewport, storageRoot }), `${slug} @ ${viewport}`).toBeNull();
      }
    });

    it('lists runs newest first, breaking same-second ties by insertion order', () => {
      seed('b-later', '2026-01-02 00:00:00', [{}]);
      seed('a-earlier', '2026-01-01 00:00:00', [{}]);
      seed('c-same-1', '2026-01-03 00:00:00', [{}]);
      seed('c-same-2', '2026-01-03 00:00:00', [{}]);
      const model = historyModel({ db, slug: 'index', viewport: 'desktop', storageRoot });
      expect(model.entries.map((e) => e.run_id)).toEqual(['c-same-2', 'c-same-1', 'b-later', 'a-earlier']);
      expect(model.title).toBe('History: / @ desktop');
      expect(model.truncated).toBe(false);
    });

    it('merges slug-equivalent routes and ignores other routes and viewports', () => {
      seed('r1', '2026-01-01 00:00:00', [{ route: '/a/b' }, { route: '/a-b' }, { route: '/a/b', viewport: 'mobile' }]);
      seed('r2', '2026-01-02 00:00:00', [{ route: '/a_b' }]);
      const model = historyModel({ db, slug: 'a_b', viewport: 'desktop', storageRoot });
      expect(model.entries.map((e) => [e.run_id, e.route, e.viewport])).toEqual([['r2', '/a_b', 'desktop'], ['r1', '/a/b', 'desktop']]);
      expect(model.routes.sort()).toEqual(['/a/b', '/a_b']);
      expect(model.route).toBe('/a_b'); // newest spelling
      expect(historyModel({ db, slug: 'a-b', viewport: 'desktop', storageRoot }).entries).toHaveLength(1);
    });

    it('shapes each row: run link to the snapshot anchor, UTC ISO time, status pill, thumbnail URL', () => {
      const [snap] = seed('feat/x #1', '2026-03-04 05:06:07', [{ status: 'DIFF', mismatch_percentage: 2.5, current_path: png('feat-x', 'index-desktop.png') }]);
      const [entry] = historyModel({ db, slug: 'index', viewport: 'desktop', storageRoot }).entries;
      expect(entry).toMatchObject({
        runUrl: `/runs/feat%2Fx%20%231#snapshot-${snap.id}`,
        created_at: '2026-03-04 05:06:07',
        createdAtIso: '2026-03-04T05:06:07Z',
        branch: 'main',
        commit_hash: 'abc1234',
        run_status: 'PASSED',
        mismatch: 2.5,
        statusPill: { cls: 'status-pill-failed', label: 'DIFF' },
        currentUrl: '/storage/runs/feat-x/index-desktop.png',
        baselineChanged: false
      });
    });

    it('marks rows compared against a different baseline than the next older row', () => {
      // oldest -> newest
      seed('r1', '2026-01-01 00:00:00', [{ status: 'MISSING_BASELINE', baseline_sha256: 'none' }]);
      seed('r2', '2026-01-02 00:00:00', [{ status: 'NEW_BASELINE', baseline_sha256: 'A' }]);
      seed('r3', '2026-01-03 00:00:00', [{ status: 'MATCH', baseline_sha256: 'A' }]);
      seed('r4', '2026-01-04 00:00:00', [{ status: 'DIFF', baseline_sha256: 'B' }]);
      seed('r5', '2026-01-05 00:00:00', [{ status: 'DIFF', baseline_sha256: null }]); // legacy: unknown
      seed('r6', '2026-01-06 00:00:00', [{ status: 'MATCH', baseline_sha256: 'B' }]);
      seed('r7', '2026-01-07 00:00:00', [{ status: 'MISSING_BASELINE', baseline_sha256: null }]); // legacy: none
      const model = historyModel({ db, slug: 'index', viewport: 'desktop', storageRoot });
      expect(model.entries.map((e) => [e.run_id, e.baselineChange])).toEqual([
        ['r7', 'removed'],
        ['r6', null],
        ['r5', null],
        ['r4', 'changed'],
        ['r3', null],
        ['r2', 'created'],
        ['r1', null]
      ]);
      expect(model.entries.filter((e) => e.baselineChanged).map((e) => e.baselineChangeLabel))
        .toEqual(['Baseline removed', 'Baseline changed', 'Baseline created']);
      // Chart markers line up with the changed runs (oldest first)
      expect(model.sparkline.changes.map((c) => c.runId)).toEqual(['r2', 'r4', 'r7']);
      expect(model.sparkline.changes[0].x).toBe(model.sparkline.points[1].x);
    });

    it('baselineChange handles none/NULL and a missing older row', () => {
      expect(baselineChange({ baseline_sha256: 'A' }, undefined)).toBeNull();
      expect(baselineChange({ baseline_sha256: 'A' }, { baseline_sha256: 'A' })).toBeNull();
      expect(baselineChange({ baseline_sha256: 'B' }, { baseline_sha256: 'A' })).toBe('changed');
      expect(baselineChange({ baseline_sha256: 'A' }, { baseline_sha256: 'none' })).toBe('created');
      expect(baselineChange({ baseline_sha256: 'none' }, { baseline_sha256: 'A' })).toBe('removed');
      expect(baselineChange({ baseline_sha256: 'none' }, { baseline_sha256: null, status: 'MISSING_BASELINE' })).toBeNull();
      expect(baselineChange({ baseline_sha256: 'A' }, { baseline_sha256: null, status: 'DIFF' })).toBeNull();
      expect(baselineChange({ baseline_sha256: null, status: 'APPROVED' }, { baseline_sha256: 'A' })).toBeNull();
    });

    it('links the current shared baseline only when the file exists', () => {
      seed('r1', '2026-01-01 00:00:00', [{}]);
      expect(historyModel({ db, slug: 'index', viewport: 'desktop', storageRoot }).baselineUrl).toBeNull();
      fs.mkdirSync(path.join(storageRoot, 'baselines'), { recursive: true });
      fs.writeFileSync(path.join(storageRoot, 'baselines', 'index-desktop.png'), 'PNG');
      expect(historyModel({ db, slug: 'index', viewport: 'desktop', storageRoot }).baselineUrl).toBe('/storage/baselines/index-desktop.png');
    });

    const seedMany = (n, hashOf = () => 'A') => db.transaction(() => {
      for (let i = 0; i < n; i++) {
        const at = `2026-01-01 ${String(Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;
        seed(`r${String(i).padStart(3, '0')}`, at, [{ baseline_sha256: hashOf(i) }]);
      }
    })();

    it(`exactly ${HISTORY_LIMIT} runs are all shown and not reported as truncated`, () => {
      seedMany(HISTORY_LIMIT);
      const model = historyModel({ db, slug: 'index', viewport: 'desktop', storageRoot });
      expect(model.entries).toHaveLength(HISTORY_LIMIT);
      expect(model.truncated).toBe(false);
    });

    it('keeps the baseline-changed marker on the oldest row shown when older runs exist', () => {
      // Runs r000..r100 (101 runs): the baseline changed at r001, which is the oldest shown
      seedMany(HISTORY_LIMIT + 1, (i) => (i === 0 ? 'A' : 'B'));
      const model = historyModel({ db, slug: 'index', viewport: 'desktop', storageRoot });
      expect(model.truncated).toBe(true);
      const oldest = model.entries[model.entries.length - 1];
      expect(oldest.run_id).toBe('r001');
      expect(oldest.baselineChange).toBe('changed');
    });

    it(`keeps only the latest ${HISTORY_LIMIT} runs`, () => {
      db.transaction(() => {
        for (let i = 0; i < HISTORY_LIMIT + 5; i++) seed(`r${String(i).padStart(3, '0')}`, `2026-01-01 00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`, [{}]);
      })();
      const model = historyModel({ db, slug: 'index', viewport: 'desktop', storageRoot });
      expect(model.entries).toHaveLength(HISTORY_LIMIT);
      expect(model.entries[0].run_id).toBe('r104');
      expect(model.truncated).toBe(true);
    });

    describe('buildSparkline', () => {
      it('handles no points', () => {
        expect(buildSparkline([])).toMatchObject({ points: [], path: '', label: 'Mismatch: no runs recorded' });
      });

      it('centres a single point', () => {
        const s = buildSparkline([3], { width: 100, height: 40, pad: 5 });
        expect(s.points).toEqual([{ value: 3, x: 50, y: 5 }]);
        expect(s.path).toBe('M50 5');
        expect(s.label).toBe('Mismatch for 1 run: 3.00%');
      });

      it('scales from 0% at the bottom to the max at the top, oldest on the left', () => {
        const s = buildSparkline([0, 5, 10], { width: 100, height: 40, pad: 5 });
        expect(s.points.map((p) => [p.x, p.y])).toEqual([[5, 35], [50, 20], [95, 5]]);
        expect(s.path).toBe('M5 35 L50 20 L95 5');
        expect(s).toMatchObject({ min: 0, max: 10, latest: 10 });
        expect(s.label).toBe('Mismatch over 3 runs, oldest to newest: min 0.00%, max 10.00%, latest 10.00%');
      });

      it('draws an all-zero history as a flat line along the bottom', () => {
        const s = buildSparkline([0, 0], { width: 100, height: 40, pad: 5 });
        expect(s.points.map((p) => p.y)).toEqual([35, 35]);
      });
    });
  });
});
