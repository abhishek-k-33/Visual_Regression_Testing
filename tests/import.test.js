import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import Database from 'better-sqlite3';
import { PNG } from 'pngjs';
import app from '../src/server/app.js';
import {
  initDb, closeDb, createTestRun, getTestRunById, getSnapshotsByRunId, approveSnapshot
} from '../src/server/db.js';
import { importRuns, IMPORT_LIMITS } from '../src/server/importRuns.js';
import { runDetailModel } from '../src/server/viewModels.js';
import { toSqliteTimestamp } from '../src/cli/manifest.js';
import { writeZip, folderEntries } from './helpers/zip.js';

// `visual-ci import`: a CI run's folder (or the zipped artifact) recreated in a local
// storage root. The CI run is produced once by the real CLI against a local page.

const CLI = path.resolve('src/cli/index.js');
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ['CI', 'GITHUB_STEP_SUMMARY', 'GITHUB_SHA', 'GITHUB_REF_NAME', 'GITHUB_HEAD_REF']) delete env[key];
  if (!('VISUAL_STORAGE_DIR' in extra)) delete env.VISUAL_STORAGE_DIR;
  return { ...env, ...extra };
}

function runCli(args, { cwd, env = {} }) {
  return new Promise((resolve) => {
    execFile('node', [CLI, ...args], { cwd, env: cleanEnv(env) }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: stdout + stderr });
    });
  });
}

function pngBuffer(width, height, rgb) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** A file listing (relative path -> sha) to prove a folder was not touched. */
function treeHashes(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (abs, rel) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(path.join(abs, d.name), r);
      else out[r] = d.isSymbolicLink() ? `link:${fs.readlinkSync(path.join(abs, d.name))}` : sha(fs.readFileSync(path.join(abs, d.name)));
    }
  };
  walk(dir, '');
  return out;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the import to fail');
}

let site;
let color = 'white';
let ciDir; // cwd of the "CI" runs
let ciRunDir; // its storage/runs/ci_diff
let ciBaselines;
let manifest; // parsed run.json of ci_diff

beforeAll(async () => {
  site = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    // "/" changes colour between runs, "/about" never does, "/new" has no baseline in CI.
    const bg = req.url === '/' ? color : 'white';
    res.end(`<!doctype html><body style="margin:0;background:${bg}"><h1>${req.url}</h1></body>`);
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${site.address().port}`;
  ciDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-import-ci-'));
  const viewports = [{ name: 'desktop', width: 320, height: 240 }];
  fs.writeFileSync(path.join(ciDir, 'base.config.json'), JSON.stringify({ baseUrl, routes: ['/', '/about'], viewports }));
  fs.writeFileSync(path.join(ciDir, 'ci.config.json'), JSON.stringify({ baseUrl, routes: ['/', '/about', '/new'], viewports }));

  const base = await runCli(['test', '-c', 'base.config.json', '--update-baselines', '-r', 'ci_base'], { cwd: ciDir });
  expect(base.code, base.out).toBe(0);
  color = 'red';
  const ci = await runCli(['test', '-c', 'ci.config.json', '--strict', '-r', 'ci_diff'], { cwd: ciDir, env: { CI: 'true' } });
  expect(ci.code, ci.out).toBe(1);

  ciRunDir = path.join(ciDir, 'storage', 'runs', 'ci_diff');
  ciBaselines = path.join(ciDir, 'storage', 'baselines');
  manifest = JSON.parse(fs.readFileSync(path.join(ciRunDir, 'run.json'), 'utf8'));
  expect(manifest.snapshots.map((s) => s.status)).toEqual(['DIFF', 'MATCH', 'MISSING_BASELINE']);
}, 90000);

afterAll(async () => {
  await new Promise((resolve) => site.close(resolve));
  fs.rmSync(ciDir, { recursive: true, force: true });
});

describe('importRuns', () => {
  let work; // scratch for zips and crafted folders
  let storageRoot; // the "local" storage the run is imported into
  let db;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-import-'));
    storageRoot = path.join(work, 'local-storage');
    // The developer's checkout has the same committed baselines CI compared against.
    fs.cpSync(ciBaselines, path.join(storageRoot, 'baselines'), { recursive: true });
    db = initDb(path.join(storageRoot, 'data.sqlite'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(work, { recursive: true, force: true });
  });

  const opts = (extra = {}) => ({ storageRoot, db, ...extra });
  const localRunDir = (id) => path.join(storageRoot, 'runs', id);
  const artifactZip = (name = 'artifact.zip', prefix = 'ci_diff') => writeZip(path.join(work, name), folderEntries(ciRunDir, prefix));
  const leftovers = () => fs.readdirSync(storageRoot).filter((f) => f.startsWith('.import-'));
  const runCount = () => db.prepare('SELECT COUNT(*) AS n FROM test_runs').get().n;

  /** Entries for a copy of the CI run with its manifest edited (hashes can be refreshed). */
  function craftedEntries(edit, { prefix = 'ci_diff', files = {} } = {}) {
    const m = structuredClone(manifest);
    edit?.(m);
    const entries = folderEntries(ciRunDir, prefix)
      .filter((e) => !e.name.endsWith('/run.json'))
      .map((e) => {
        const rel = e.name.slice(prefix.length + 1);
        return rel in files ? { ...e, data: files[rel] } : e;
      });
    for (const [rel, data] of Object.entries(files)) {
      if (!entries.some((e) => e.name === `${prefix}/${rel}`) && data !== undefined) entries.push({ name: `${prefix}/${rel}`, data });
    }
    entries.push({ name: `${prefix}/run.json`, data: JSON.stringify(m) });
    return entries;
  }
  const craftedZip = (edit, options) => writeZip(path.join(work, `crafted-${crypto.randomUUID()}.zip`), craftedEntries(edit, options));

  describe('happy path', () => {
    function expectImported(id = 'ci_diff') {
      const run = getTestRunById(id, db);
      expect(run).toMatchObject({ status: 'FAILED', total_snapshots: 3, diff_count: 2, match_count: 1 });
      expect(run.created_at).toBe(toSqliteTimestamp(new Date(manifest.run.created_at)));
      expect(run.imported_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

      const dir = localRunDir(id);
      const rows = getSnapshotsByRunId(id, db);
      expect(rows.map((r) => [r.route, r.viewport, r.status])).toEqual([
        ['/', 'desktop', 'DIFF'], ['/about', 'desktop', 'MATCH'], ['/new', 'desktop', 'MISSING_BASELINE']
      ]);
      const [diff, match, missing] = rows;
      expect(diff).toMatchObject({
        current_path: path.join(dir, 'index-desktop.png'),
        diff_path: path.join(dir, 'index-desktop-diff.png'),
        baseline_snapshot_path: path.join(dir, 'baselines', 'index-desktop.png'),
        baseline_path: path.join(storageRoot, 'baselines', 'index-desktop.png'),
        baseline_sha256: manifest.snapshots[0].baseline_sha256,
        mismatch_percentage: manifest.snapshots[0].mismatch_percentage
      });
      expect(match.baseline_sha256).toBe(manifest.snapshots[1].baseline_sha256);
      expect(missing).toMatchObject({ baseline_sha256: 'none', baseline_snapshot_path: null, diff_path: null });

      // Exactly the referenced images; no run.json / summary.md; nothing left in staging.
      expect(Object.keys(treeHashes(dir)).sort()).toEqual([
        'about-desktop-diff.png', 'about-desktop.png', 'baselines/about-desktop.png', 'baselines/index-desktop.png',
        'index-desktop-diff.png', 'index-desktop.png', 'new-desktop.png'
      ]);
      expect(sha(fs.readFileSync(path.join(dir, 'index-desktop.png')))).toBe(manifest.snapshots[0].current_sha256);
      expect(leftovers()).toEqual([]);
    }

    it('imports a run folder: rows, absolute local paths, CI hashes kept verbatim', async () => {
      const baselinesBefore = treeHashes(path.join(storageRoot, 'baselines'));
      const result = await importRuns({ kind: 'dir', path: ciRunDir }, opts());
      expect(result).toEqual({ runs: [{ id: 'ci_diff', url: '/runs/ci_diff', status: 'FAILED', snapshots: 3 }] });
      expectImported();
      expect(treeHashes(path.join(storageRoot, 'baselines'))).toEqual(baselinesBefore); // never writes baselines/
    });

    it('imports the artifact zip as upload-artifact lays it out (<runId>/...)', async () => {
      const result = await importRuns({ kind: 'zip', file: artifactZip() }, opts());
      expect(result.runs).toEqual([{ id: 'ci_diff', url: '/runs/ci_diff', status: 'FAILED', snapshots: 3 }]);
      expectImported();
    });

    it.each([
      ['runs/<id>/ (a zipped storage folder)', 'runs/ci_diff'],
      ['a bare run folder at the zip root', '']
    ])('finds run.json under %s', async (_label, prefix) => {
      const result = await importRuns({ kind: 'zip', file: artifactZip('p.zip', prefix) }, opts());
      expect(result.runs.map((r) => r.id)).toEqual(['ci_diff']);
      expectImported();
    });

    it('imports several runs from one artifact and skips folders without run.json', async () => {
      const entries = [
        ...folderEntries(ciRunDir, 'ci_diff'),
        ...folderEntries(path.join(ciDir, 'storage', 'runs', 'ci_base'), 'ci_base'),
        { name: 'partial_run/index-desktop.png', data: pngBuffer(2, 2, [0, 0, 0]) }
      ];
      const result = await importRuns({ kind: 'zip', file: writeZip(path.join(work, 'two.zip'), entries) }, opts());
      expect(result.runs.map((r) => [r.id, r.status])).toEqual([['ci_diff', 'FAILED'], ['ci_base', 'PASSED']]);
      expect(getSnapshotsByRunId('ci_base', db).map((s) => s.status)).toEqual(['NEW_BASELINE', 'NEW_BASELINE']);
      // NEW_BASELINE: the run's own screenshot is the compared baseline, as the CLI records it.
      const [nb] = getSnapshotsByRunId('ci_base', db);
      expect(nb.baseline_snapshot_path).toBe(nb.current_path);
      expect(fs.existsSync(localRunDir('partial_run'))).toBe(false);
    });

    it('serves the imported run in the dashboard with its images and an Imported badge', async () => {
      await importRuns({ kind: 'zip', file: artifactZip() }, opts());
      const previous = process.env.VISUAL_STORAGE_DIR;
      process.env.VISUAL_STORAGE_DIR = storageRoot;
      const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const index = await (await fetch(`${base}/`)).text();
        expect(index).toMatch(/run-id-link">ci_diff<\/a>\s*<span class="imported-badge"[^>]*>Imported<\/span>/);
        const page = await fetch(`${base}/runs/ci_diff`);
        expect(page.status).toBe(200);
        const html = await page.text();
        expect(html).toContain('<span class="imported-badge">Imported</span>');
        expect(html).toContain('Imported on <time');
        for (const img of ['runs/ci_diff/index-desktop.png', 'runs/ci_diff/index-desktop-diff.png', 'runs/ci_diff/baselines/index-desktop.png']) {
          expect(html).toContain(`/storage/${img}`);
          const res = await fetch(`${base}/storage/${img}`);
          expect(res.status, img).toBe(200);
          expect(res.headers.get('content-type')).toBe('image/png');
        }
        // Baselines match CI's: no notice, Approve enabled.
        expect(html).not.toMatch(/id="snapshot-\d+-stale"/);
        expect(html).toContain('id="approve-all-stale-note" data-approve-all-stale hidden>');
        expect(html).not.toMatch(/btn-approve[^"]*" data-id="\d+" disabled/);
      } finally {
        await new Promise((resolve) => server.close(resolve));
        if (previous === undefined) delete process.env.VISUAL_STORAGE_DIR;
        else process.env.VISUAL_STORAGE_DIR = previous;
      }
    });
  });

  describe('run ids', () => {
    it('re-importing the same artifact is a no-op', async () => {
      await importRuns({ kind: 'zip', file: artifactZip() }, opts());
      const before = treeHashes(storageRoot);
      const result = await importRuns({ kind: 'zip', file: artifactZip() }, opts());
      expect(result.runs).toEqual([{ id: 'ci_diff', url: '/runs/ci_diff', status: 'FAILED', snapshots: 3, alreadyImported: true }]);
      expect(runCount()).toBe(1);
      const after = treeHashes(storageRoot);
      for (const file of Object.keys(after).filter((f) => !f.startsWith('data.sqlite'))) expect(after[file], file).toBe(before[file]);
      expect(Object.keys(after).filter((f) => f.startsWith('runs/'))).toEqual(Object.keys(before).filter((f) => f.startsWith('runs/')));
    });

    it('renames a run whose id is taken by a different local run (-imp2), and re-import finds it', async () => {
      createTestRun({ id: 'ci_diff', status: 'PASSED', commit_hash: 'local01' }, db);
      const first = await importRuns({ kind: 'zip', file: artifactZip() }, opts());
      expect(first.runs).toEqual([{ id: 'ci_diff-imp2', url: '/runs/ci_diff-imp2', status: 'FAILED', snapshots: 3, renamedFrom: 'ci_diff' }]);
      expect(getSnapshotsByRunId('ci_diff-imp2', db)[0].current_path).toBe(path.join(localRunDir('ci_diff-imp2'), 'index-desktop.png'));
      expect(getTestRunById('ci_diff', db).status).toBe('PASSED'); // untouched

      const again = await importRuns({ kind: 'zip', file: artifactZip() }, opts());
      expect(again.runs[0]).toMatchObject({ id: 'ci_diff-imp2', alreadyImported: true, renamedFrom: 'ci_diff' });
      expect(runCount()).toBe(2);
    });

    it('also renames when only a leftover runs/<id>/ folder exists', async () => {
      fs.mkdirSync(path.join(localRunDir('ci_diff'), 'x'), { recursive: true });
      fs.mkdirSync(localRunDir('ci_diff-imp2'), { recursive: true });
      const result = await importRuns({ kind: 'dir', path: ciRunDir }, opts());
      expect(result.runs[0]).toMatchObject({ id: 'ci_diff-imp3', renamedFrom: 'ci_diff' });
    });

    it('--run-id picks the local id; it must be valid and free, and is for single runs only', async () => {
      const result = await importRuns({ kind: 'dir', path: ciRunDir }, opts({ runId: 'review-pr-42' }));
      expect(result.runs[0]).toMatchObject({ id: 'review-pr-42', url: '/runs/review-pr-42', renamedFrom: 'ci_diff' });
      expect(fs.existsSync(path.join(localRunDir('review-pr-42'), 'index-desktop.png'))).toBe(true);

      const taken = await rejection(importRuns({ kind: 'dir', path: ciRunDir }, opts({ runId: 'review-pr-42' })));
      expect(taken.status).toBe(409);
      expect(taken.message).toContain('already exists');

      for (const bad of ['../evil', 'a/b', '', 'x'.repeat(129)]) {
        const err = await rejection(importRuns({ kind: 'dir', path: ciRunDir }, opts({ runId: bad })));
        expect(err.status, bad).toBe(400);
      }

      const two = writeZip(path.join(work, 'two.zip'), [
        ...folderEntries(ciRunDir, 'a'),
        ...folderEntries(path.join(ciDir, 'storage', 'runs', 'ci_base'), 'b')
      ]);
      const multi = await rejection(importRuns({ kind: 'zip', file: two }, opts({ runId: 'one' })));
      expect(multi.status).toBe(400);
      expect(runCount()).toBe(1);
    });
  });

  describe('archive safety', () => {
    it.each([
      ['zip-slip', '../evil.png'],
      ['nested zip-slip', 'ci_diff/../../evil.png'],
      ['absolute path', '/tmp/vrt-import-evil.png'],
      ['Windows drive path', 'C:/evil.png'],
      ['backslash traversal', '..\\evil.png'],
      ['empty segment', 'ci_diff//evil.png'],
      ['dot segment', './ci_diff/evil.png']
    ])('rejects a %s entry and writes nothing', async (_label, name) => {
      const zip = writeZip(path.join(work, 'evil.zip'), [{ name, data: pngBuffer(1, 1, [255, 0, 0]) }, ...folderEntries(ciRunDir, 'ci_diff')]);
      const err = await rejection(importRuns({ kind: 'zip', file: zip }, opts()));
      expect(err.status).toBe(400);
      expect(fs.existsSync(path.join(work, 'evil.png'))).toBe(false);
      expect(fs.existsSync('/tmp/vrt-import-evil.png')).toBe(false);
      expect(fs.existsSync(path.join(storageRoot, 'evil.png'))).toBe(false);
      expect(fs.existsSync(path.join(storageRoot, 'runs'))).toBe(true);
      expect(fs.readdirSync(path.join(storageRoot, 'runs'))).toEqual([]);
      expect(runCount()).toBe(0);
      expect(leftovers()).toEqual([]);
    });

    it('skips symlink entries (never creates a link), even one named like a wanted image', async () => {
      const outside = path.join(work, 'outside.png');
      fs.writeFileSync(outside, pngBuffer(1, 1, [1, 2, 3]));
      const entries = [
        ...folderEntries(ciRunDir, 'ci_diff'),
        { name: 'ci_diff/link.png', data: outside, mode: 0o120777, deflate: false },
        { name: 'ci_diff/baselines/link-dir', data: '/etc', mode: 0o120777, deflate: false }
      ];
      const result = await importRuns({ kind: 'zip', file: writeZip(path.join(work, 'links.zip'), entries) }, opts());
      expect(result.runs[0].id).toBe('ci_diff');
      const tree = treeHashes(localRunDir('ci_diff'));
      expect(Object.keys(tree).some((f) => f.includes('link'))).toBe(false);

      // A referenced image that arrives only as a symlink is missing, not followed.
      const swapped = folderEntries(ciRunDir, 'x').map((e) => (e.name === 'x/index-desktop.png'
        ? { name: e.name, data: outside, mode: 0o120777, deflate: false }
        : e));
      const err = await rejection(importRuns({ kind: 'zip', file: writeZip(path.join(work, 'swap.zip'), swapped) }, opts()));
      expect(err.status).toBe(422);
      expect(err.message).toContain('"index-desktop.png" is missing');
    });

    it('never follows symlinks when importing a folder', async () => {
      const copy = path.join(work, 'copy');
      fs.cpSync(ciRunDir, copy, { recursive: true });
      const outside = path.join(work, 'outside');
      fs.mkdirSync(outside);
      fs.renameSync(path.join(copy, 'index-desktop.png'), path.join(outside, 'index-desktop.png'));
      fs.symlinkSync(path.join(outside, 'index-desktop.png'), path.join(copy, 'index-desktop.png'));
      const err = await rejection(importRuns({ kind: 'dir', path: copy }, opts()));
      expect(err.status).toBe(422);
      expect(err.message).toContain('"index-desktop.png" is missing');

      // A symlinked baselines/ folder is not walked either.
      fs.rmSync(path.join(copy, 'index-desktop.png'));
      fs.renameSync(path.join(outside, 'index-desktop.png'), path.join(copy, 'index-desktop.png'));
      fs.renameSync(path.join(copy, 'baselines'), path.join(outside, 'baselines'));
      fs.symlinkSync(path.join(outside, 'baselines'), path.join(copy, 'baselines'));
      const err2 = await rejection(importRuns({ kind: 'dir', path: copy }, opts()));
      expect(err2.status).toBe(422);
      expect(err2.message).toContain('"baselines/index-desktop.png" is missing');
      expect(runCount()).toBe(0);
    });

    it('rejects duplicate entries instead of overwriting', async () => {
      const zip = writeZip(path.join(work, 'dup.zip'), [
        ...folderEntries(ciRunDir, 'ci_diff'),
        { name: 'ci_diff/index-desktop.png', data: pngBuffer(320, 240, [0, 255, 0]) }
      ]);
      const err = await rejection(importRuns({ kind: 'zip', file: zip }, opts()));
      expect(err.status).toBe(400);
      expect(err.message).toContain('more than once');
    });

    it('rejects a file that is not a zip', async () => {
      const file = path.join(work, 'notes.zip');
      fs.writeFileSync(file, 'definitely not a zip archive');
      const err = await rejection(importRuns({ kind: 'zip', file }, opts()));
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/Not a valid zip archive/);
    });

    it('413: an image over the 50 MB limit (counted while streaming)', async () => {
      const big = Buffer.alloc(IMPORT_LIMITS.maxFileBytes + 1);
      const zip = writeZip(path.join(work, 'big.zip'), [...folderEntries(ciRunDir, 'ci_diff'), { name: 'ci_diff/big.png', data: big }]);
      const err = await rejection(importRuns({ kind: 'zip', file: zip }, opts()));
      expect(err.status).toBe(413);
      expect(err.message).toContain('50 MB');
      expect(leftovers()).toEqual([]);
    });

    it('a size header that lies is caught (yauzl size validation stays on)', async () => {
      const zip = writeZip(path.join(work, 'liar.zip'), [
        ...folderEntries(ciRunDir, 'ci_diff'),
        { name: 'ci_diff/liar.png', data: Buffer.alloc(5000), declaredSize: 10 }
      ]);
      const err = await rejection(importRuns({ kind: 'zip', file: zip }, opts()));
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/Invalid zip archive: too many bytes/);
      expect(leftovers()).toEqual([]);
    });

    it('413: sizes are counted while copying, not taken from metadata (folder source)', async () => {
      const copy = path.join(work, 'copy');
      fs.cpSync(ciRunDir, copy, { recursive: true });
      const err = await rejection(importRuns({ kind: 'dir', path: copy }, opts({ limits: { maxFileBytes: 100 } })));
      expect(err.status).toBe(413);
      expect(runCount()).toBe(0);
    });

    it('413: the total uncompressed size limit', async () => {
      const entries = [...folderEntries(ciRunDir, 'ci_diff'), ...[1, 2, 3, 4].map((i) => ({ name: `ci_diff/pad${i}.png`, data: Buffer.alloc(30000) }))];
      const err = await rejection(importRuns({ kind: 'zip', file: writeZip(path.join(work, 't.zip'), entries) }, opts({ limits: { maxTotalBytes: 100000 } })));
      expect(err.status).toBe(413);
      expect(err.message).toContain('import is larger');
    });

    it('413: a run.json over 1 MB', async () => {
      const err = await rejection(importRuns({ kind: 'zip', file: craftedZip((m) => { m.padding = 'x'.repeat(IMPORT_LIMITS.maxManifestBytes); }) }, opts()));
      expect(err.status).toBe(413);
    });

    it('413: too many entries (zip and folder)', async () => {
      const entries = Array.from({ length: IMPORT_LIMITS.maxEntries + 1 }, (_, i) => ({ name: `f${i}.txt`, data: 'x', deflate: false }));
      const err = await rejection(importRuns({ kind: 'zip', file: writeZip(path.join(work, 'many.zip'), entries) }, opts()));
      expect(err.status).toBe(413);

      const dir = path.join(work, 'many');
      fs.mkdirSync(dir);
      for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
      const err2 = await rejection(importRuns({ kind: 'dir', path: dir }, opts({ limits: { maxEntries: 5 } })));
      expect(err2.status).toBe(413);
    });

    it('422: no run.json at all', async () => {
      const zip = writeZip(path.join(work, 'old.zip'), folderEntries(ciRunDir, 'ci_diff').filter((e) => !e.name.endsWith('run.json')));
      const err = await rejection(importRuns({ kind: 'zip', file: zip }, opts()));
      expect(err.status).toBe(422);
      expect(err.message).toContain('No run.json found');
      expect(err.message).toContain('re-run CI');
    });
  });

  describe('manifest validation (422, nothing imported)', () => {
    const fakePng = (width, height) => {
      const buf = Buffer.alloc(33);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
      buf.writeUInt32BE(13, 8);
      buf.write('IHDR', 12, 'latin1');
      buf.writeUInt32BE(width, 16);
      buf.writeUInt32BE(height, 20);
      return buf;
    };

    it.each([
      ['not JSON', null, 'not valid JSON'],
      ['a different schema', (m) => { m.schema = 'something-else'; }, 'not a visual-ci run record'],
      ['a newer version', (m) => { m.version = 2; }, 'unsupported run.json version 2'],
      ['an unsafe run id', (m) => { m.run.id = '../../etc'; }, 'run.id'],
      ['an unknown run status', (m) => { m.run.status = 'APPROVED'; }, 'run.status'],
      ['a bad created_at', (m) => { m.run.created_at = 'yesterday'; }, 'run.created_at'],
      ['a branch with control characters', (m) => { m.run.branch = 'main\u0000'; }, 'run.branch'],
      ['a non-finite threshold', (m) => { m.run.threshold_percentage = 'NaN'; }, 'threshold_percentage'],
      ['no snapshots', (m) => { m.snapshots = []; }, 'non-empty array'],
      ['an unsafe viewport', (m) => { m.snapshots[0].viewport = '../x'; }, 'viewport'],
      ['a route that is too long', (m) => { m.snapshots[0].route = `/${'a'.repeat(2048)}`; }, 'route'],
      ['an unknown snapshot status', (m) => { m.snapshots[0].status = 'APPROVED'; }, 'status'],
      ['a mismatch over 100%', (m) => { m.snapshots[0].mismatch_percentage = 101; }, 'mismatch_percentage'],
      ['a duplicate route/viewport', (m) => { m.snapshots[1] = structuredClone(m.snapshots[0]); }, 'listed twice'],
      ['baseline_sha256 null', (m) => { m.snapshots[0].baseline_sha256 = null; }, 'baseline_sha256 must be a SHA-256'],
      ['baseline_sha256 missing', (m) => { delete m.snapshots[1].baseline_sha256; }, 'baseline_sha256 must be a SHA-256'],
      ['a malformed baseline_sha256', (m) => { m.snapshots[0].baseline_sha256 = 'abc123'; }, 'baseline_sha256 must be a SHA-256'],
      ["'none' for a compared baseline", (m) => { m.snapshots[0].baseline_sha256 = 'none'; }, 'baseline_sha256 must be a SHA-256'],
      ['a hash for a missing baseline', (m) => { m.snapshots[2].baseline_sha256 = 'a'.repeat(64); }, 'must be "none"'],
      ['a current file name that does not match the route', (m) => { m.snapshots[0].current = 'about-desktop.png'; }, 'current must be "index-desktop.png"'],
      ['a diff file name pointing elsewhere', (m) => { m.snapshots[0].diff = '../index-desktop-diff.png'; }, 'diff must be "index-desktop-diff.png"'],
      ['a baseline copy outside baselines/', (m) => { m.snapshots[0].baseline_snapshot = 'index-desktop.png'; }, 'baseline_snapshot must be "baselines/index-desktop.png"'],
      ['a shared baseline path', (m) => { m.snapshots[0].baseline = '../../../.bashrc'; }, 'baseline must be "index-desktop.png"'],
      ['a diff for a missing baseline', (m) => { m.snapshots[2].diff = 'new-desktop-diff.png'; }, 'diff must be null'],
      ['a current hash mismatch', (m) => { m.snapshots[0].current_sha256 = 'f'.repeat(64); }, 'does not match current_sha256'],
      ['a diff hash mismatch', (m) => { m.snapshots[0].diff_sha256 = 'f'.repeat(64); }, 'does not match diff_sha256'],
      ['a baseline hash mismatch', (m) => { m.snapshots[0].baseline_sha256 = 'f'.repeat(64); }, 'does not match baseline_sha256']
    ])('rejects %s', async (_label, edit, message) => {
      const zip = edit === null
        ? writeZip(path.join(work, 'nojson.zip'), [...folderEntries(ciRunDir, 'ci_diff').filter((e) => !e.name.endsWith('run.json')), { name: 'ci_diff/run.json', data: '{ not json' }])
        : craftedZip(edit);
      const err = await rejection(importRuns({ kind: 'zip', file: zip }, opts()));
      expect(err.status).toBe(422);
      expect(err.message).toContain(message);
      expect(err.message).toContain('ci_diff/run.json');
      expect(runCount()).toBe(0);
      expect(fs.readdirSync(path.join(storageRoot, 'runs'))).toEqual([]);
    });

    it('rejects an image that is not a PNG even when its hash matches', async () => {
      const fake = Buffer.from('GIF89a definitely not a png');
      const zip = craftedZip((m) => { m.snapshots[0].current_sha256 = sha(fake); }, { files: { 'index-desktop.png': fake } });
      const err = await rejection(importRuns({ kind: 'zip', file: zip }, opts()));
      expect(err.status).toBe(422);
      expect(err.message).toContain('"index-desktop.png" is not a PNG image');
    });

    it('rejects a PNG whose IHDR declares a huge image', async () => {
      const huge = fakePng(20000, 100);
      const zip = craftedZip((m) => { m.snapshots[0].current_sha256 = sha(huge); }, { files: { 'index-desktop.png': huge } });
      const err = await rejection(importRuns({ kind: 'zip', file: zip }, opts()));
      expect(err.status).toBe(422);
      expect(err.message).toContain('20000x100 pixels');

      const tall = fakePng(100, 70000);
      const zip2 = craftedZip((m) => { m.snapshots[0].diff_sha256 = sha(tall); }, { files: { 'index-desktop-diff.png': tall } });
      const err2 = await rejection(importRuns({ kind: 'zip', file: zip2 }, opts()));
      expect(err2.status).toBe(422);
      expect(err2.message).toContain('100x70000 pixels');
    });

    it('rejects a run whose referenced image is missing', async () => {
      const zip = writeZip(path.join(work, 'missing.zip'), folderEntries(ciRunDir, 'ci_diff').filter((e) => !e.name.endsWith('/baselines/about-desktop.png')));
      const err = await rejection(importRuns({ kind: 'zip', file: zip }, opts()));
      expect(err.status).toBe(422);
      expect(err.message).toContain('"baselines/about-desktop.png" is missing');
    });

    it('is all or nothing: one invalid run means no run is imported', async () => {
      const entries = [
        ...folderEntries(path.join(ciDir, 'storage', 'runs', 'ci_base'), 'ci_base'),
        ...craftedEntries((m) => { m.snapshots[0].baseline_sha256 = null; })
      ];
      const err = await rejection(importRuns({ kind: 'zip', file: writeZip(path.join(work, 'mixed.zip'), entries) }, opts()));
      expect(err.status).toBe(422);
      expect(runCount()).toBe(0);
      expect(fs.readdirSync(path.join(storageRoot, 'runs'))).toEqual([]);
    });

    it('rejects a run nested inside another run folder', async () => {
      const entries = [...folderEntries(ciRunDir, 'ci_diff'), ...folderEntries(path.join(ciDir, 'storage', 'runs', 'ci_base'), 'ci_diff/x')];
      const err = await rejection(importRuns({ kind: 'zip', file: writeZip(path.join(work, 'nested.zip'), entries) }, opts()));
      expect(err.status).toBe(422);
      expect(err.message).toContain('inside the run');
    });
  });

  it('removes the moved run folder when the database insert fails', async () => {
    db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT, 'disk on fire'); END;");
    const err = await rejection(importRuns({ kind: 'zip', file: artifactZip() }, opts()));
    expect(err.message).toContain('disk on fire');
    expect(err.status).toBeUndefined();
    expect(fs.readdirSync(path.join(storageRoot, 'runs'))).toEqual([]);
    expect(runCount()).toBe(0);
    expect(leftovers()).toEqual([]);
  });

  describe('approving an imported run', () => {
    const diffSnapshot = () => getSnapshotsByRunId('ci_diff', db).find((s) => s.status === 'DIFF');

    it('works when the local baseline is the one CI compared against', async () => {
      await importRuns({ kind: 'zip', file: artifactZip() }, opts());
      const model = runDetailModel({ db, runId: 'ci_diff', storageRoot });
      expect(model.stalePendingCount).toBe(0);
      expect(model.snapshots.map((s) => s.baselineStale)).toEqual([false, false, false]);

      const snap = diffSnapshot();
      const result = approveSnapshot(snap.id, db, { storageRoot });
      expect(result.snapshot.status).toBe('APPROVED');
      expect(sha(fs.readFileSync(path.join(storageRoot, 'baselines', 'index-desktop.png')))).toBe(manifest.snapshots[0].current_sha256);
    });

    it('is refused (409) when the local baseline differs, and the page says so up front', async () => {
      await importRuns({ kind: 'zip', file: artifactZip() }, opts());
      const changed = pngBuffer(320, 240, [0, 128, 0]);
      fs.writeFileSync(path.join(storageRoot, 'baselines', 'index-desktop.png'), changed);
      // Someone also created the baseline CI found missing.
      fs.writeFileSync(path.join(storageRoot, 'baselines', 'new-desktop.png'), changed);

      const model = runDetailModel({ db, runId: 'ci_diff', storageRoot });
      expect(model.snapshots.map((s) => [s.status, s.baselineStale])).toEqual([['DIFF', true], ['MATCH', false], ['MISSING_BASELINE', true]]);
      expect(model.stalePendingCount).toBe(2);

      let err;
      try {
        approveSnapshot(diffSnapshot().id, db, { storageRoot });
      } catch (e) {
        err = e;
      }
      expect(err.status).toBe(409);
      expect(sha(fs.readFileSync(path.join(storageRoot, 'baselines', 'index-desktop.png')))).toBe(sha(changed));

      const previous = process.env.VISUAL_STORAGE_DIR;
      process.env.VISUAL_STORAGE_DIR = storageRoot;
      const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const html = await (await fetch(`${base}/runs/ci_diff`)).text();
        const id = diffSnapshot().id;
        expect(html).toContain(`id="snapshot-${id}-stale"`);
        expect(html).toContain('Your local baseline differs from the one CI compared against, so approving would be refused.');
        expect(html).toMatch(new RegExp(`class="btn btn-approve is-blocked" data-id="${id}" disabled aria-describedby="snapshot-${id}-heading snapshot-${id}-stale"`));
        expect(html).toContain(`data-status="DIFF" data-baseline-stale="true"`);
        // Approve all is all or nothing, so it is blocked too, with its own explanation.
        expect(html).toMatch(/class="btn btn-approve-all is-blocked"[^>]*disabled aria-describedby="approve-all-stale-note"/);
        expect(html).toMatch(/id="approve-all-stale-note" data-approve-all-stale>/);
        // Reject still works.
        expect(html).toContain(`class="btn btn-reject" data-id="${id}"`);

        const res = await fetch(`${base}/api/snapshots/${id}/approve`, { method: 'POST', headers: { 'X-Requested-With': 'test' } });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/^Conflict/);
      } finally {
        await new Promise((resolve) => server.close(resolve));
        if (previous === undefined) delete process.env.VISUAL_STORAGE_DIR;
        else process.env.VISUAL_STORAGE_DIR = previous;
      }
    });

    it('local (non-imported) runs never get the notice', async () => {
      await importRuns({ kind: 'zip', file: artifactZip() }, opts());
      db.prepare("UPDATE test_runs SET imported_at = NULL WHERE id = 'ci_diff'").run();
      fs.writeFileSync(path.join(storageRoot, 'baselines', 'index-desktop.png'), pngBuffer(2, 2, [0, 0, 0]));
      expect(runDetailModel({ db, runId: 'ci_diff', storageRoot }).stalePendingCount).toBe(0);
    });
  });
});

describe('initDb migration', () => {
  it('adds imported_at to a database created before imports existed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-import-migrate-'));
    const file = path.join(dir, 'old.sqlite');
    try {
      const old = new Database(file);
      old.exec("CREATE TABLE test_runs (id TEXT PRIMARY KEY, commit_hash TEXT, branch TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL); INSERT INTO test_runs (id, status) VALUES ('old', 'PASSED');");
      old.close();
      const db = initDb(file);
      expect(db.prepare('PRAGMA table_info(test_runs)').all().map((c) => c.name)).toContain('imported_at');
      expect(getTestRunById('old', db).imported_at).toBeNull();
      closeDb();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('visual-ci import (CLI)', () => {
  let cwd;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-import-cli-'));
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it('imports the artifact zip, prints the dashboard URL, and is idempotent', async () => {
    const zip = writeZip(path.join(cwd, 'visual-regression-diffs.zip'), folderEntries(ciRunDir, 'ci_diff'));
    const storage = path.join(cwd, 'store');
    const first = await runCli(['import', 'visual-regression-diffs.zip'], { cwd, env: { VISUAL_STORAGE_DIR: storage } });
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain('Imported 1 run into store');
    expect(first.out).toContain('ci_diff  FAILED, 3 snapshots');
    expect(first.out).toContain('http://localhost:4000/runs/ci_diff');
    expect(fs.existsSync(path.join(storage, 'runs', 'ci_diff', 'index-desktop.png'))).toBe(true);

    const again = await runCli(['import', 'visual-regression-diffs.zip'], { cwd, env: { VISUAL_STORAGE_DIR: storage } });
    expect(again.code).toBe(0);
    expect(again.out).toContain('already imported, nothing changed');

    const renamed = await runCli(['import', 'visual-regression-diffs.zip', '--run-id', 'pr-7'], { cwd, env: { VISUAL_STORAGE_DIR: storage } });
    expect(renamed.code, renamed.out).toBe(0);
    expect(renamed.out).toContain('http://localhost:4000/runs/pr-7');
    expect(renamed.out).toContain('renamed from ci_diff');
  }, 30000);

  it('uses storageDir from a config without baseUrl, and imports a run folder', async () => {
    fs.writeFileSync(path.join(cwd, 'review.config.json'), '{ "storageDir": "review-storage" } // comments are fine');
    const { code, out } = await runCli(['import', ciRunDir, '-c', 'review.config.json'], { cwd });
    expect(code, out).toBe(0);
    expect(out).toContain('Imported 1 run into review-storage');
    const db = new Database(path.join(cwd, 'review-storage', 'data.sqlite'), { readonly: true });
    try {
      expect(db.prepare('SELECT id, imported_at IS NOT NULL AS imported FROM test_runs').all()).toEqual([{ id: 'ci_diff', imported: 1 }]);
    } finally {
      db.close();
    }
  }, 30000);

  it('exits 1 with a clear message on failure', async () => {
    fs.writeFileSync(path.join(cwd, 'bad.zip'), 'nope');
    const notZip = await runCli(['import', 'bad.zip'], { cwd, env: { VISUAL_STORAGE_DIR: path.join(cwd, 's') } });
    expect(notZip.code).toBe(1);
    expect(notZip.out).toContain('[ERROR] Import failed: Not a valid zip archive');

    const missing = await runCli(['import', 'nowhere.zip'], { cwd, env: { VISUAL_STORAGE_DIR: path.join(cwd, 's') } });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('Not found: nowhere.zip');

    const noManifest = writeZip(path.join(cwd, 'old.zip'), folderEntries(ciRunDir, 'ci_diff').filter((e) => !e.name.endsWith('run.json')));
    const old = await runCli(['import', noManifest], { cwd, env: { VISUAL_STORAGE_DIR: path.join(cwd, 's') } });
    expect(old.code).toBe(1);
    expect(old.out).toContain('No run.json found');

    const badConfig = await runCli(['import', ciRunDir, '-c', 'missing.json'], { cwd });
    expect(badConfig.code).toBe(1);
    expect(badConfig.out).toContain('Configuration file not found');
  }, 30000);
});
