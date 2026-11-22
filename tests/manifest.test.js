import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  buildRunManifest,
  writeRunManifest,
  toSqliteTimestamp,
  MANIFEST_SCHEMA,
  MANIFEST_VERSION
} from '../src/cli/manifest.js';
import { validateConfig } from '../src/cli/config.js';

const CLI = path.resolve('src/cli/index.js');
const pkgVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;

describe('run.json manifest builder', () => {
  let store;
  let runDir;
  let baselinesDir;
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const base = () => ({
    runId: 'run_1',
    createdAt: new Date('2026-11-23T10:20:30.456Z'),
    gitInfo: { branch: 'main', commit_hash: 'abc1234', commit_sha: 'abc1234' + '0'.repeat(33) },
    status: 'FAILED',
    threshold: 0.07,
    pixelmatchThreshold: 0.1,
    strict: true,
    mode: 'compare',
    runDir,
    baselinesDir
  });

  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-manifest-unit-'));
    runDir = path.join(store, 'runs', 'run_1');
    baselinesDir = path.join(store, 'baselines');
    write(path.join(runDir, 'index-desktop.png'), 'CURRENT');
    write(path.join(runDir, 'index-desktop-diff.png'), 'DIFF');
    write(path.join(runDir, 'baselines', 'index-desktop.png'), 'BASELINE');
    write(path.join(runDir, 'new-mobile.png'), 'NEW');
  });

  afterEach(() => fs.rmSync(store, { recursive: true, force: true }));

  it('records run details, units and relative forward-slash paths with file hashes', () => {
    const manifest = buildRunManifest({
      ...base(),
      results: [
        {
          route: '/', viewport: 'desktop', width: 1440, height: 900, status: 'DIFF',
          mismatchPercentage: 3.21, mismatchedPixels: 321, totalPixels: 10000,
          currentPath: path.join(runDir, 'index-desktop.png'),
          diffPath: path.join(runDir, 'index-desktop-diff.png'),
          baselineSnapshotPath: path.join(runDir, 'baselines', 'index-desktop.png'),
          baselinePath: path.join(baselinesDir, 'index-desktop.png'),
          baselineSha256: sha('BASELINE')
        },
        {
          route: '/new', viewport: 'mobile', width: 375, height: 812, status: 'MISSING_BASELINE',
          mismatchPercentage: 0, mismatchedPixels: 0, totalPixels: 0,
          currentPath: path.join(runDir, 'new-mobile.png'),
          diffPath: null,
          baselineSnapshotPath: null,
          baselinePath: path.join(baselinesDir, 'new-mobile.png'),
          baselineSha256: 'none'
        }
      ]
    });

    expect(manifest).toMatchObject({
      schema: MANIFEST_SCHEMA,
      version: MANIFEST_VERSION,
      tool: { name: 'visual-ci', version: pkgVersion },
      run: {
        id: 'run_1', commit_hash: 'abc1234', commit_sha: 'abc1234' + '0'.repeat(33), branch: 'main',
        status: 'FAILED', created_at: '2026-11-23T10:20:30.456Z', mode: 'compare', strict: true,
        threshold_percentage: 7, pixelmatch_threshold: 0.1
      }
    });
    expect(manifest.snapshots).toEqual([
      {
        route: '/', viewport: 'desktop', viewport_size: { width: 1440, height: 900 }, status: 'DIFF',
        mismatch_percentage: 3.21, mismatched_pixels: 321, total_pixels: 10000,
        current: 'index-desktop.png', current_sha256: sha('CURRENT'),
        diff: 'index-desktop-diff.png', diff_sha256: sha('DIFF'),
        baseline_snapshot: 'baselines/index-desktop.png', baseline: 'index-desktop.png',
        baseline_sha256: sha('BASELINE')
      },
      {
        route: '/new', viewport: 'mobile', viewport_size: { width: 375, height: 812 }, status: 'MISSING_BASELINE',
        mismatch_percentage: 0, mismatched_pixels: 0, total_pixels: 0,
        current: 'new-mobile.png', current_sha256: sha('NEW'), diff: null, diff_sha256: null,
        baseline_snapshot: null, baseline: 'new-mobile.png', baseline_sha256: 'none'
      }
    ]);
  });

  it('refuses to record a path outside the run folder', () => {
    expect(() => buildRunManifest({
      ...base(),
      results: [{
        route: '/', viewport: 'desktop', status: 'DIFF',
        currentPath: path.join(store, 'elsewhere.png'),
        baselinePath: path.join(baselinesDir, 'index-desktop.png')
      }]
    })).toThrow(/not inside/);
  });

  it('refuses two snapshots that share a file (backstop for colliding names)', () => {
    const shared = {
      viewport: 'desktop', status: 'MATCH',
      currentPath: path.join(runDir, 'index-desktop.png'),
      baselinePath: path.join(baselinesDir, 'index-desktop.png')
    };
    expect(() => buildRunManifest({ ...base(), results: [{ ...shared, route: '/' }, { ...shared, route: '/index' }] }))
      .toThrow(/share the current file "index-desktop.png"/);
  });

  it('uses the same UTC timestamp format as SQLite CURRENT_TIMESTAMP', () => {
    expect(toSqliteTimestamp(new Date('2026-11-23T10:20:30.456Z'))).toBe('2026-11-23 10:20:30');
  });

  it('writes run.json atomically and leaves no temp file behind', () => {
    const file = writeRunManifest({ schema: MANIFEST_SCHEMA, ok: true }, runDir);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ schema: MANIFEST_SCHEMA, ok: true });
    expect(fs.readdirSync(runDir).filter((f) => f.startsWith('run.json'))).toEqual(['run.json']);
  });

  it('removes its temp file if the write fails', () => {
    fs.mkdirSync(path.join(runDir, 'run.json')); // rename onto a directory fails
    expect(() => writeRunManifest({ ok: true }, runDir)).toThrow();
    expect(fs.readdirSync(runDir).some((f) => f.includes('.tmp-'))).toBe(false);
  });
});

describe('config rejects routes/viewports whose files would collide', () => {
  const vp = (name) => ({ name, width: 100, height: 100 });
  const config = (routes, viewports) => ({ baseUrl: 'http://127.0.0.1:1', routes, viewports });

  it.each([
    ['dashes across route and viewport', ['/a-b', '/a'], [vp('c'), vp('b-c')], 'a-b-c.png'],
    ['slug-equivalent routes', ['/a/b', '/a_b'], [vp('m')], 'a_b-m.png'],
    ['"/" and "/index"', ['/', '/index'], [vp('m')], 'index-m.png'],
    ['a viewport named like a diff image', ['/'], [vp('m'), vp('m-diff')], 'index-m-diff.png'],
    ['a route listed twice', ['/x', '/x'], [vp('m')], 'x-m.png']
  ])('%s', (_label, routes, viewports, file) => {
    expect(() => validateConfig(config(routes, viewports))).toThrow(`would both write "${file}"`);
  });

  it('accepts distinct names, including viewports with dashes', () => {
    expect(() => validateConfig(config(['/', '/about'], [vp('desktop'), vp('mobile-landscape')]))).not.toThrow();
  });
});

describe('CLI writes run.json for every test run', () => {
  let site;
  let color = 'white';
  let workDir;
  const runDir = (id) => path.join(workDir, 'storage', 'runs', id);
  const manifestOf = (id) => JSON.parse(fs.readFileSync(path.join(runDir(id), 'run.json'), 'utf8'));

  function runCli(args, { ci = false } = {}) {
    const env = { ...process.env };
    for (const key of ['CI', 'GITHUB_STEP_SUMMARY', 'VISUAL_STORAGE_DIR']) delete env[key];
    if (ci) env.CI = 'true';
    return new Promise((resolve) => {
      execFile('node', [CLI, 'test', ...args], { cwd: workDir, env }, (err, stdout, stderr) => {
        resolve({ code: err ? err.code : 0, out: stdout + stderr });
      });
    });
  }

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><body style="margin:0;background:${color}"><h1>Manifest</h1></body>`);
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-cli-manifest-'));
    fs.writeFileSync(path.join(workDir, 'visual.config.json'), JSON.stringify({
      baseUrl: `http://127.0.0.1:${site.address().port}`,
      routes: ['/'],
      viewports: [{ name: 'desk-top', width: 400, height: 300 }],
      threshold: 0.01
    }));
  });

  afterAll(async () => {
    await new Promise((resolve) => site.close(resolve));
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('strict run with no baseline: MISSING_BASELINE entry with no baseline copy', async () => {
    const { code } = await runCli(['-r', 'run_missing'], { ci: true });
    expect(code).toBe(1);
    const m = manifestOf('run_missing');
    expect(m.run.status).toBe('FAILED');
    expect(m.snapshots).toEqual([expect.objectContaining({
      status: 'MISSING_BASELINE', current: 'index-desk-top.png', diff: null,
      baseline_snapshot: null, baseline: 'index-desk-top.png', baseline_sha256: 'none'
    })]);
  }, 30000);

  it('first run creates the baseline: NEW_BASELINE points at its own screenshot', async () => {
    const { code } = await runCli(['--no-strict', '-r', 'run_new']);
    expect(code).toBe(0);
    const m = manifestOf('run_new');
    expect(m.run.status).toBe('PASSED');
    expect(m.snapshots[0]).toMatchObject({
      status: 'NEW_BASELINE', current: 'index-desk-top.png', baseline_snapshot: 'index-desk-top.png'
    });
    expect(m.snapshots[0].baseline_sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30000);

  it('a regression records the diff and the compared baseline copy; the DB row shares created_at', async () => {
    color = 'red';
    const { code } = await runCli(['-r', 'run_diff']);
    expect(code).toBe(1);
    const m = manifestOf('run_diff');
    expect(m.run.status).toBe('FAILED');
    expect(m.snapshots[0]).toMatchObject({
      status: 'DIFF', current: 'index-desk-top.png', diff: 'index-desk-top-diff.png',
      baseline_snapshot: 'baselines/index-desk-top.png', baseline: 'index-desk-top.png'
    });
    expect(m.snapshots[0].mismatch_percentage).toBeGreaterThan(1);
    for (const rel of [m.snapshots[0].current, m.snapshots[0].diff, m.snapshots[0].baseline_snapshot]) {
      expect(fs.existsSync(path.join(runDir('run_diff'), rel)), rel).toBe(true);
    }

    const db = new Database(path.join(workDir, 'storage', 'data.sqlite'), { readonly: true });
    const row = db.prepare("SELECT created_at FROM test_runs WHERE id = 'run_diff'").get();
    db.close();
    expect(row.created_at).toBe(toSqliteTimestamp(new Date(m.run.created_at)));
  }, 30000);

  it('an unchanged page records MATCH with sizes, units and the full commit sha', async () => {
    color = 'white';
    await runCli(['--update-baselines', '-r', 'run_reset']);
    const { code } = await runCli(['-r', 'run_match']);
    expect(code).toBe(0);
    const m = manifestOf('run_match');
    expect(m.run).toMatchObject({ mode: 'compare', strict: false, threshold_percentage: 1, pixelmatch_threshold: 0.1 });
    expect(m.snapshots[0]).toMatchObject({
      route: '/', viewport: 'desk-top', viewport_size: { width: 400, height: 300 }, status: 'MATCH',
      mismatch_percentage: 0, mismatched_pixels: 0, total_pixels: 400 * 300
    });
    expect(m.snapshots[0].current_sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30000);

  it('--update-baselines is recorded as its own mode', async () => {
    const { code } = await runCli(['--update-baselines', '-r', 'run_update']);
    expect(code).toBe(0);
    const m = manifestOf('run_update');
    expect(m.run.mode).toBe('update-baselines');
    expect(m.snapshots[0]).toMatchObject({ status: 'NEW_BASELINE', baseline_snapshot: 'index-desk-top.png' });
    expect(m.snapshots[0].baseline_sha256).toBe(m.snapshots[0].current_sha256);
  }, 30000);

  it('refuses a --summary-file that would overwrite run.json', async () => {
    const { code, out } = await runCli(['-r', 'run_clash', '-s', 'run.json']);
    expect(code).toBe(1);
    expect(out).toContain('--summary-file cannot be "run.json"');
  }, 30000);

  it('still writes run.json when the database cannot be opened', async () => {
    const dbPath = path.join(workDir, 'storage', 'data.sqlite');
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    fs.mkdirSync(dbPath); // a directory where the database file should be
    try {
      const { out } = await runCli(['-r', 'run_nodb']);
      expect(out).toContain('Failed to record run in database');
      expect(manifestOf('run_nodb').run.id).toBe('run_nodb');
    } finally {
      fs.rmSync(dbPath, { recursive: true, force: true });
    }
  }, 30000);
});
