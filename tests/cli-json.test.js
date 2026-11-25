import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CLI = path.resolve('src/cli/index.js');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ['CI', 'GITHUB_STEP_SUMMARY', 'VISUAL_STORAGE_DIR']) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

// Runs the real CLI in a throwaway working directory (never the repository's storage/).
function runCli(cwd, args, { env = {}, nodeArgs = [] } = {}) {
  return new Promise((resolve) => {
    execFile('node', [...nodeArgs, CLI, ...args], { cwd, env: cleanEnv(env) }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr, out: stdout + stderr });
    });
  });
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('visual-ci test --json and exit codes', () => {
  let site;
  let baseUrl;
  let deadUrl;
  let workDir;
  let color = 'white';

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      if (req.url.startsWith('/hang')) return; // never answers
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><body style="margin:0;background:${color}"><h1>JSON result</h1></body>`);
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${site.address().port}`;

    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    deadUrl = `http://127.0.0.1:${closed.address().port}`;
    await new Promise((resolve) => closed.close(resolve));

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-cli-json-'));
    fs.writeFileSync(path.join(workDir, 'visual.config.json'), JSON.stringify({
      baseUrl,
      routes: ['/'],
      viewports: [{ name: 'desktop', width: 400, height: 300 }],
      threshold: 0.01
    }));
  });

  afterAll(async () => {
    site.closeAllConnections();
    await new Promise((resolve) => site.close(resolve));
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  describe('errors exit 2 and still write the JSON', () => {
    it('missing config: CONFIG_NOT_FOUND', async () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-cli-json-empty-'));
      try {
        const { code, stderr } = await runCli(empty, ['test', '--json', 'out/result.json']);
        expect(code).toBe(2);
        expect(stderr).toContain('[ERROR] Test run failed: Configuration file not found');
        const result = readJson(path.join(empty, 'out', 'result.json'));
        expect(result).toMatchObject({
          schema: 'visual-ci-result', version: 1, command: 'test', status: 'error', exit_code: 2,
          error: { code: 'CONFIG_NOT_FOUND' }, run: null,
          counts: { total: 0, passed: 0, changed: 0, missing_baseline: 0, new_baseline: 0 }, snapshots: []
        });
        expect(result.error.message).toContain('Configuration file not found');
        expect(fs.readdirSync(path.join(empty, 'out'))).toEqual(['result.json']); // no temp file left
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    }, 30000);

    it('invalid config (bad JSON or bad values): CONFIG_INVALID', async () => {
      fs.writeFileSync(path.join(workDir, 'broken.json'), '{ "baseUrl": ');
      const broken = await runCli(workDir, ['test', '-c', 'broken.json', '--json', 'broken-result.json']);
      expect(broken.code).toBe(2);
      expect(readJson(path.join(workDir, 'broken-result.json')).error.code).toBe('CONFIG_INVALID');

      fs.writeFileSync(path.join(workDir, 'invalid.json'), JSON.stringify({ baseUrl, routes: [], viewports: [] }));
      const invalid = await runCli(workDir, ['test', '-c', 'invalid.json', '--json', 'invalid-result.json']);
      expect(invalid.code).toBe(2);
      const result = readJson(path.join(workDir, 'invalid-result.json'));
      expect(result.error).toEqual({ code: 'CONFIG_INVALID', message: 'Invalid configuration: "routes" must be a non-empty array of URL paths.' });
    }, 30000);

    it('unreachable base URL: NAVIGATION_FAILED, with what is known about the run', async () => {
      const { code, stderr } = await runCli(workDir, ['test', '-u', deadUrl, '-r', 'run_dead', '--json', 'dead.json']);
      expect(code).toBe(2);
      expect(stderr).toContain(`Could not load ${deadUrl}/`);
      const result = readJson(path.join(workDir, 'dead.json'));
      expect(result).toMatchObject({ status: 'error', exit_code: 2, error: { code: 'NAVIGATION_FAILED' } });
      expect(result.error.message).toMatch(/ERR_CONNECTION_REFUSED/);
      expect(result.run).toMatchObject({ id: 'run_dead', mode: 'compare', base_url: deadUrl, run_dir: 'storage/runs/run_dead', manifest: null, summary: null });
    }, 30000);

    it('a missing browser: BROWSER_MISSING', async () => {
      const noBrowsers = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-cli-json-nobrowser-'));
      try {
        const { code } = await runCli(workDir, ['test', '-r', 'run_nobrowser', '--json', 'nobrowser.json'], {
          env: { PLAYWRIGHT_BROWSERS_PATH: noBrowsers }
        });
        expect(code).toBe(2);
        expect(readJson(path.join(workDir, 'nobrowser.json')).error.code).toBe('BROWSER_MISSING');
      } finally {
        fs.rmSync(noBrowsers, { recursive: true, force: true });
      }
    }, 30000);

    it('an unsafe run id: INVALID_ARGUMENT, before anything is written', async () => {
      const { code } = await runCli(workDir, ['test', '-r', '../escape', '--json', 'badid.json']);
      expect(code).toBe(2);
      expect(readJson(path.join(workDir, 'badid.json'))).toMatchObject({ error: { code: 'INVALID_ARGUMENT' }, run: null });
      expect(fs.existsSync(path.join(workDir, 'storage', 'escape'))).toBe(false);
    }, 30000);
  });

  describe('the --json target', () => {
    it("refuses the run's run.json and summary, and writes neither", async () => {
      for (const [args, label] of [
        [['-r', 'run_guard', '--json', 'storage/runs/run_guard/run.json'], 'run.json'],
        [['-r', 'run_guard', '--json', 'storage/runs/run_guard/summary.md'], 'markdown summary'],
        [['-r', 'run_guard', '-s', 'report.md', '--json', path.join(workDir, 'storage/runs/run_guard/report.md')], 'markdown summary']
      ]) {
        const { code, stderr } = await runCli(workDir, ['test', ...args]);
        expect(code, stderr).toBe(2);
        expect(stderr).toContain('--json cannot be');
        expect(stderr).toContain(label);
      }
      expect(fs.existsSync(path.join(workDir, 'storage', 'runs', 'run_guard'))).toBe(false);
    }, 30000);

    it('refuses run.json even when the config failed to load (nothing is written there)', async () => {
      const runDir = path.join(workDir, 'storage', 'runs', 'run_kept');
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'run.json'), '{"keep":true}');
      const { code } = await runCli(workDir, ['test', '-c', 'nowhere.json', '-r', 'run_kept', '--json', 'storage/runs/run_kept/run.json']);
      expect(code).toBe(2);
      expect(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')).toBe('{"keep":true}');
    }, 30000);

    it('refuses an absolute --summary-file "/run.json" (it is written inside the run folder)', async () => {
      const { code, stderr } = await runCli(workDir, ['test', '-r', 'run_abs', '-s', '/run.json']);
      expect(code).toBe(2);
      expect(stderr).toContain('--summary-file cannot be "/run.json"');
    }, 30000);
  });

  describe('outcomes', () => {
    it('pass: exit 0, status passed, paths relative to the working directory', async () => {
      color = 'white';
      const update = await runCli(workDir, ['test', '--update-baselines', '-r', 'run_base', '--json', 'base.json']);
      expect(update.code, update.out).toBe(0);
      expect(readJson(path.join(workDir, 'base.json'))).toMatchObject({
        status: 'passed', exit_code: 0, run: { mode: 'update-baselines' }, counts: { total: 1, new_baseline: 1 }
      });

      const { code, stdout } = await runCli(workDir, ['test', '-r', 'run_pass', '--json', 'reports/pass.json']);
      expect(code).toBe(0);
      expect(stdout).toContain('JSON Result      : reports/pass.json');
      const result = readJson(path.join(workDir, 'reports', 'pass.json'));
      expect(result).toMatchObject({
        status: 'passed', exit_code: 0, error: null,
        run: {
          id: 'run_pass', mode: 'compare', strict: false, base_url: baseUrl, threshold_percentage: 1,
          run_dir: 'storage/runs/run_pass', manifest: 'storage/runs/run_pass/run.json', summary: 'storage/runs/run_pass/summary.md'
        },
        counts: { total: 1, passed: 1, changed: 0, missing_baseline: 0, new_baseline: 0 },
        snapshots: [{
          route: '/', viewport: 'desktop', status: 'MATCH', mismatch_percentage: 0,
          current: 'storage/runs/run_pass/index-desktop.png', baseline: 'storage/baselines/index-desktop.png',
          diff: 'storage/runs/run_pass/index-desktop-diff.png' // compare writes a diff image for a MATCH too
        }]
      });
      expect(result.run.duration_ms).toBeGreaterThan(0);
      for (const rel of [result.run.manifest, result.run.summary, result.snapshots[0].current, result.snapshots[0].baseline]) {
        expect(fs.existsSync(path.join(workDir, rel)), rel).toBe(true);
      }
      // Same created_at as the run.json written next to the screenshots
      expect(result.run.created_at).toBe(readJson(path.join(workDir, result.run.manifest)).run.created_at);
    }, 60000);

    it('visual diff: exit 1, status failed, counts.changed >= 1', async () => {
      color = 'red';
      const { code } = await runCli(workDir, ['test', '-r', 'run_diff', '--json', 'diff.json']);
      color = 'white';
      expect(code).toBe(1);
      const result = readJson(path.join(workDir, 'diff.json'));
      expect(result).toMatchObject({ status: 'failed', exit_code: 1, error: null });
      expect(result.counts.changed).toBeGreaterThanOrEqual(1);
      expect(result.snapshots[0]).toMatchObject({ status: 'DIFF', diff: 'storage/runs/run_diff/index-desktop-diff.png' });
      expect(result.snapshots[0].mismatch_percentage).toBeGreaterThan(1);
      expect(fs.existsSync(path.join(workDir, result.snapshots[0].diff))).toBe(true);
    }, 30000);

    it('missing baseline in strict mode: exit 1, status failed, counts.missing_baseline', async () => {
      const { code } = await runCli(workDir, ['test', '--strict', '-r', 'run_strict', '--json', 'strict.json'], {
        env: { VISUAL_STORAGE_DIR: path.join(workDir, 'empty-storage') }
      });
      expect(code).toBe(1);
      expect(readJson(path.join(workDir, 'strict.json'))).toMatchObject({
        status: 'failed', exit_code: 1, run: { strict: true, run_dir: 'empty-storage/runs/run_strict' },
        counts: { missing_baseline: 1 }, snapshots: [{ status: 'MISSING_BASELINE', baseline: 'empty-storage/baselines/index-desktop.png' }]
      });
    }, 30000);
  });

  describe('--json - (stdout)', () => {
    it('stdout is only the JSON; the human output, warnings included, goes to stderr', async () => {
      // A directory where the database should be: the CLI warns and carries on.
      const storage = path.join(workDir, 'warn-storage');
      fs.mkdirSync(path.join(storage, 'data.sqlite'), { recursive: true });
      const { code, stdout, stderr } = await runCli(workDir, ['test', '--no-strict', '-r', 'run_stdout', '--json', '-'], {
        env: { VISUAL_STORAGE_DIR: storage }
      });
      expect(code, stderr).toBe(0);
      const result = JSON.parse(stdout);
      expect(result).toMatchObject({ schema: 'visual-ci-result', status: 'passed', run: { id: 'run_stdout' } });
      expect(stdout.trim().startsWith('{')).toBe(true);
      expect(stderr).toContain('Visual Regression Testing Tool: Compare & Test');
      expect(stderr).toContain('[NEW BASELINE] / @ desktop');
      expect(stderr).toContain('[WARN] Failed to record run in database');
      expect(stderr).toContain('[SUCCESS]');
      expect(fs.existsSync(path.join(workDir, '-'))).toBe(false);
    }, 30000);

    it('also on error', async () => {
      const { code, stdout, stderr } = await runCli(workDir, ['test', '-c', 'nowhere.json', '--json', '-']);
      expect(code).toBe(2);
      expect(JSON.parse(stdout).error.code).toBe('CONFIG_NOT_FOUND');
      expect(stderr).toContain('[ERROR] Test run failed');
    }, 30000);
  });

  describe('usage errors and crashes', () => {
    it('an unknown flag, a missing option value or a missing argument exits 2', async () => {
      expect((await runCli(workDir, ['test', '--bogus'])).code).toBe(2);
      expect((await runCli(workDir, ['test', '--json'])).code).toBe(2);
      expect((await runCli(workDir, ['import'])).code).toBe(2);
      expect((await runCli(workDir, ['no-such-command'])).code).toBe(2);
    }, 30000);

    it('--help and --version exit 0', async () => {
      const help = await runCli(workDir, ['test', '--help']);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('--json <file>');
      expect((await runCli(workDir, ['--help'])).code).toBe(0);
      expect((await runCli(workDir, ['--version'])).code).toBe(0);
    }, 30000);

    // A preload that crashes the process once the CLI has registered its handlers
    // (or after 3 s, so the test fails fast without them), while the CLI waits on a
    // page that never answers.
    const crashPreload = () => {
      const file = path.join(workDir, 'crash-preload.mjs');
      fs.writeFileSync(file, `
        const started = Date.now();
        const timer = setInterval(() => {
          if (process.listenerCount('uncaughtException') === 0 && Date.now() - started < 3000) return;
          clearInterval(timer);
          if (process.env.VRT_CRASH === 'rejection') Promise.reject(new Error('boom from preload'));
          else setTimeout(() => { throw new Error('boom from preload'); });
        }, 10);
      `);
      return ['--import', pathToFileURL(file).href];
    };

    for (const kind of ['rejection', 'exception']) {
      it(`an unhandled ${kind} exits 2`, async () => {
        const { code, stderr } = await runCli(workDir, ['test', '-u', `${baseUrl}/hang`, '-r', `run_crash_${kind}`], {
          env: { VRT_CRASH: kind },
          nodeArgs: crashPreload()
        });
        expect(code, stderr).toBe(2);
        expect(stderr).toContain('boom from preload');
      }, 30000);
    }
  });
});
