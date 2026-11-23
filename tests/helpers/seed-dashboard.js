/**
 * Seeds a throwaway storage folder with generated PNGs and runs covering every snapshot
 * status, for the browser layout/theme tests (and manual checks). Never touches ./storage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { initDb, createTestRun, createSnapshot } from '../../src/server/db.js';
import { getSnapshotFilename } from '../../src/cli/naming.js';

/** A long run id and branch, so the phone layout has to truncate them. */
export const LONG_RUN_ID = 'run-2026-11-23-feature-checkout-redesign-regression-0001';
export const LONG_BRANCH = 'feature/extremely-long-branch-name-for-checkout-redesign-experiment';

/** Writes a simple striped PNG (optionally with a red "changed" block). */
function writePng(file, { width, height, hue, changed = false, diff = false }) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      let [r, g, b] = diff ? [235, 235, 235] : (Math.floor(y / 40) % 2 ? [240, 244, 250] : [hue, 120, 220]);
      const inBlock = x > width * 0.2 && x < width * 0.6 && y > height * 0.2 && y < height * 0.4;
      if ((changed || diff) && inBlock) [r, g, b] = [255, 0, 0];
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

const SIZES = { desktop: { width: 640, height: 400 }, mobile: { width: 200, height: 420 } };

/**
 * @param {string} storageRoot - Empty temp folder
 * @returns {{ db: import('better-sqlite3').Database, diffRunId: string, historyPath: string }}
 */
export function seedDashboard(storageRoot) {
  const db = initDb(path.join(storageRoot, 'data.sqlite'));
  const baseline = (route, viewport) => path.join(storageRoot, 'baselines', getSnapshotFilename(route, viewport));
  const current = (runId, route, viewport, suffix = '') =>
    path.join(storageRoot, 'runs', runId, getSnapshotFilename(route, viewport).replace(/\.png$/, `${suffix}.png`));

  const routes = [['/', 'desktop'], ['/pricing/enterprise/annual-plans', 'mobile']];
  for (const [route, viewport] of routes) writePng(baseline(route, viewport), { ...SIZES[viewport], hue: 40 });

  const runs = [
    { id: 'run-baseline', status: 'PASSED', created_at: '2026-11-20 09:00:00', branch: 'main', commit_hash: 'aaa1111', snap: 'NEW_BASELINE' },
    { id: 'run-pass', status: 'PASSED', created_at: '2026-11-21 09:00:00', branch: 'main', commit_hash: 'bbb2222', snap: 'MATCH' },
    { id: 'run-approved', status: 'APPROVED', created_at: '2026-11-21 12:00:00', branch: 'main', commit_hash: 'ccc3333', snap: 'APPROVED' },
    { id: 'run-rejected', status: 'REJECTED', created_at: '2026-11-22 09:00:00', commit_hash: 'ddd4444', snap: 'REJECTED' },
    { id: LONG_RUN_ID, status: 'FAILED', created_at: '2026-11-23 10:20:30', branch: LONG_BRANCH, commit_hash: 'eee5555', snap: 'DIFF' }
  ];
  for (const run of runs) {
    createTestRun({ id: run.id, status: run.status, created_at: run.created_at, branch: run.branch, commit_hash: run.commit_hash }, db);
    for (const [route, viewport] of routes) {
      const changed = run.snap === 'DIFF' || run.snap === 'REJECTED';
      const cur = current(run.id, route, viewport);
      writePng(cur, { ...SIZES[viewport], hue: 40, changed });
      let diffPath = null;
      if (changed) {
        diffPath = current(run.id, route, viewport, '-diff');
        writePng(diffPath, { ...SIZES[viewport], hue: 40, diff: true });
      }
      createSnapshot({
        run_id: run.id,
        route,
        viewport,
        status: run.snap,
        baseline_path: baseline(route, viewport),
        baseline_sha256: run.snap === 'NEW_BASELINE' ? 'none' : 'seed-baseline',
        current_path: cur,
        diff_path: diffPath,
        mismatch_percentage: changed ? 6.25 : 0
      }, db);
    }
  }
  return { db, diffRunId: LONG_RUN_ID, historyPath: '/history/index/desktop' };
}
