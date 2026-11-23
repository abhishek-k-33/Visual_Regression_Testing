/**
 * Browser-test fixture: the real dashboard app on an ephemeral port, against a temp storage
 * folder with a seeded SQLite DB and small generated PNGs (never the repo's storage/).
 *
 *   const ui = await startUiServer();
 *   ui.baseUrl, ui.createReviewRun('my-run') -> { cards: [...] }, ui.renderStatic(view, model)
 *   await ui.close();
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import app from '../../src/server/app.js';
import { initDb, closeDb, createTestRun, createSnapshot } from '../../src/server/db.js';
import { pageLocals } from '../../src/server/urls.js';
import { getSnapshotFilename } from '../../src/cli/naming.js';

/** Writes a solid-colour PNG with a darker band, so baseline/current/diff look different. */
export function writePng(file, { width, height, color, band }) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      const c = band && y >= band.from && y < band.to ? band.color : color;
      png.data[i] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = 255;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

const SIZES = { desktop: { width: 480, height: 320 }, mobile: { width: 160, height: 360 } };

export async function startUiServer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-ui-'));
  const storageRoot = path.join(root, 'storage');
  const previousStorageEnv = process.env.VISUAL_STORAGE_DIR;
  process.env.VISUAL_STORAGE_DIR = storageRoot;
  const db = initDb(path.join(root, 'ui.sqlite'));

  function snapshotFiles(runId, route, viewport, status) {
    const name = getSnapshotFilename(route, viewport);
    const size = SIZES[viewport];
    const baseline = path.join(storageRoot, 'baselines', name);
    const current = path.join(storageRoot, 'runs', runId, name);
    const diff = path.join(storageRoot, 'runs', runId, name.replace(/\.png$/, '-diff.png'));
    if (status !== 'MISSING_BASELINE') writePng(baseline, { ...size, color: [230, 236, 245] });
    writePng(current, { ...size, color: [230, 236, 245], band: status === 'DIFF' ? { from: 40, to: 90, color: [40, 90, 200] } : null });
    if (status === 'DIFF') writePng(diff, { ...size, color: [250, 250, 250], band: { from: 40, to: 90, color: [255, 0, 60] } });
    return {
      baseline_path: status === 'MISSING_BASELINE' ? null : baseline,
      current_path: current,
      diff_path: status === 'DIFF' ? diff : null
    };
  }

  /**
   * A FAILED run to review, cards in this order:
   *   0 "/" mobile MATCH, 1 "/" desktop DIFF, 2 "/about" desktop DIFF, 3 "/new" desktop MISSING_BASELINE
   * so the first pending card is not the first card.
   */
  function createReviewRun(runId, { createdAt } = {}) {
    createTestRun({ id: runId, status: 'FAILED', branch: 'feature/a11y', commit_hash: 'abc1234', created_at: createdAt }, db);
    const specs = [
      ['/', 'mobile', 'MATCH', 0],
      ['/', 'desktop', 'DIFF', 3.12],
      ['/about', 'desktop', 'DIFF', 7.5],
      ['/new', 'desktop', 'MISSING_BASELINE', 0]
    ];
    const cards = specs.map(([route, viewport, status, mismatch]) => createSnapshot({
      run_id: runId, route, viewport, status, mismatch_percentage: mismatch,
      ...snapshotFiles(runId, route, viewport, status)
    }, db));
    return { runId, cards };
  }

  createReviewRun('ui-review', { createdAt: '2026-11-20 10:00:00' });
  createTestRun({ id: 'ui-pass', status: 'PASSED', branch: 'main', created_at: '2026-11-19 10:00:00' }, db);
  createSnapshot({ run_id: 'ui-pass', route: '/', viewport: 'desktop', status: 'MATCH', ...snapshotFiles('ui-pass', '/', 'desktop', 'MATCH') }, db);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  /** Renders a view in static (GitHub Pages) mode at the site root, as the static build does. */
  function renderStatic(view, model) {
    return new Promise((resolve, reject) => {
      app.render(view, { ...model, ...pageLocals({ base: '', mode: 'static' }) }, (err, html) => (err ? reject(err) : resolve(html)));
    });
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    if (previousStorageEnv === undefined) delete process.env.VISUAL_STORAGE_DIR;
    else process.env.VISUAL_STORAGE_DIR = previousStorageEnv;
    fs.rmSync(root, { recursive: true, force: true });
  }

  return { baseUrl, db, storageRoot, createReviewRun, renderStatic, close };
}
