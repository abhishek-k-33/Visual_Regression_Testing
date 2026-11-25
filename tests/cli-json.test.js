import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
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
  let dead;
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

    // Accepts and immediately drops every connection: a page that can never load. (A
    // closed ephemeral port could be taken by another test worker in the meantime.)
    dead = net.createServer((socket) => socket.destroy());
    await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
    deadUrl = `http://127.0.0.1:${dead.address().port}`;

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
    await new Promise((resolve) => dead.close(resolve));
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
        expect(result.error.message).toBe('Configuration file not found at: visual.config.json');
        expect(result.error.message).not.toContain(empty);
        expect(result.error.message).not.toContain(os.tmpdir());
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
      expect(result.error.message).toMatch(/net::ERR_/);
      expect(result.run).toMatchObject({ id: 'run_dead', mode: 'compare', base_url: deadUrl, run_dir: 'storage/runs/run_dead', manifest: null, summary: null });
    }, 30000);

    it('credentials and tokens in the base URL never reach the JSON or the terminal', async () => {
      const secretDead = deadUrl.replace('http://', 'http://user:s3cret@') + '/?token=abc&page=2';
      const failed = await runCli(workDir, ['test', '-u', secretDead, '-r', 'run_secret_dead', '--json', 'secret-dead.json']);
      expect(failed.code).toBe(2);
      const failedJson = fs.readFileSync(path.join(workDir, 'secret-dead.json'), 'utf8');
      expect(JSON.parse(failedJson).error.code).toBe('NAVIGATION_FAILED');
      expect(JSON.parse(failedJson).run.base_url).toBe(`${deadUrl}/?token=***&page=2`);

      const secretSite = baseUrl.replace('http://', 'http://user:s3cret@');
      const passed = await runCli(workDir, ['test', '--no-strict', '-u', secretSite, '-r', 'run_secret_ok', '--json', '-'], {
        env: { VISUAL_STORAGE_DIR: path.join(workDir, 'secret-storage') }
      });
      expect(passed.code, passed.stderr).toBe(0);
      expect(JSON.parse(passed.stdout).run.base_url).toBe(baseUrl);

      for (const text of [failedJson, failed.out, passed.out]) {
        expect(text).not.toContain('s3cret');
        expect(text).not.toContain('user:');
        expect(text).not.toContain('token=abc');
      }
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

    it('refuses run.json through a symlinked folder, also when the link only resolves once the run started', async () => {
      // store -> realstore, which does not exist yet: only the check right before
      // writing can see through the link. The run must stay importable.
      const base = fs.mkdtempSync(path.join(workDir, 'link-'));
      fs.symlinkSync(path.join(base, 'realstore'), path.join(base, 'store'));
      const config = path.join(workDir, 'visual.config.json');
      const env = { VISUAL_STORAGE_DIR: path.join(base, 'realstore') };
      const { code, stderr } = await runCli(base, ['test', '-c', config, '--no-strict', '-r', 'r1', '--json', 'store/runs/r1/run.json'], { env });
      expect(code, stderr).toBe(2);
      expect(stderr).toContain("--json cannot be \"store/runs/r1/run.json\": that is the run's run.json");
      expect(readJson(path.join(base, 'realstore', 'runs', 'r1', 'run.json')).schema).toBe('visual-ci-run');
      const imported = await runCli(base, ['import', 'realstore/runs/r1'], { env: { VISUAL_STORAGE_DIR: path.join(base, 'review') } });
      expect(imported.code, imported.out).toBe(0);

      // Same through the summary, and with an existing link up front
      const summary = await runCli(base, ['test', '-c', config, '--no-strict', '-r', 'r2', '--json', 'store/runs/r2/summary.md'], { env });
      expect(summary.code).toBe(2);
      expect(summary.stderr).toContain('markdown summary');
    }, 60000);

    it('refuses run.json when VISUAL_STORAGE_DIR itself is a symlink, and leaves an existing one alone', async () => {
      const base = fs.mkdtempSync(path.join(workDir, 'envlink-'));
      const runDir = path.join(base, 'realstore', 'runs', 'r3');
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'run.json'), '{"keep":true}');
      fs.symlinkSync(path.join(base, 'realstore'), path.join(base, 'store'));
      const { code, stderr } = await runCli(base, ['test', '-c', path.join(workDir, 'visual.config.json'), '-r', 'r3', '--json', 'realstore/runs/r3/run.json'], {
        env: { VISUAL_STORAGE_DIR: path.join(base, 'store') }
      });
      expect(code).toBe(2);
      expect(stderr).toContain("that is the run's run.json");
      expect(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')).toBe('{"keep":true}');
    }, 30000);

    it('refuses a directory as the target, and creates nothing', async () => {
      fs.mkdirSync(path.join(workDir, 'outdir'), { recursive: true });
      fs.writeFileSync(path.join(workDir, 'outdir', 'keep.txt'), 'keep');
      for (const target of ['.', 'outdir', 'newdir/']) {
        const { code, stderr } = await runCli(workDir, ['test', '-r', 'run_dir_target', '--json', target]);
        expect(code, target).toBe(2);
        expect(stderr).toContain('that is a directory');
      }
      expect(fs.readdirSync(path.join(workDir, 'outdir'))).toEqual(['keep.txt']);
      expect(fs.existsSync(path.join(workDir, 'newdir'))).toBe(false);
      expect(fs.existsSync(path.join(workDir, 'storage', 'runs', 'run_dir_target'))).toBe(false);
    }, 30000);

    it('a stale result at an accepted target never survives; a refused or unparsed one is untouched', async () => {
      const stale = path.join(workDir, 'stale.json');
      const old = '{"status":"passed","exit_code":0}';
      fs.writeFileSync(stale, old);
      // An argument error found after the target was accepted: replaced by this run's error
      const late = await runCli(workDir, ['test', '-r', 'run_stale', '-s', '/run.json', '--json', 'stale.json']);
      expect(late.code).toBe(2);
      expect(readJson(stale)).toMatchObject({ status: 'error', exit_code: 2, error: { code: 'INVALID_ARGUMENT' } });

      // This run cannot write its JSON at all (simulated I/O error): the old result must
      // be gone rather than left to be mistaken for this run's
      fs.writeFileSync(stale, old);
      const preload = path.join(workDir, 'fail-json-write.mjs');
      fs.writeFileSync(preload, `
        import fs from 'node:fs';
        const real = fs.writeFileSync;
        fs.writeFileSync = function (file, ...rest) {
          if (typeof file === 'string' && file.includes('stale.json.tmp-')) throw new Error('EIO: simulated write failure');
          return real.call(this, file, ...rest);
        };
      `);
      const failed = await runCli(workDir, ['test', '--no-strict', '-r', 'run_stale_eio', '--json', 'stale.json'], {
        env: { VISUAL_STORAGE_DIR: path.join(workDir, 'eio-storage') },
        nodeArgs: ['--import', pathToFileURL(preload).href]
      });
      expect(failed.code, failed.stderr).toBe(2);
      expect(failed.stderr).toContain('Could not write the JSON result to stale.json: EIO: simulated write failure');
      expect(fs.existsSync(stale)).toBe(false);

      // A usage error is rejected before the command runs: nothing is touched
      fs.writeFileSync(stale, old);
      expect((await runCli(workDir, ['test', '--bogus', '--json', 'stale.json'])).code).toBe(2);
      expect(fs.readFileSync(stale, 'utf8')).toBe(old);

      // A refused target (the run's run.json) is never deleted
      const runDir = path.join(workDir, 'storage', 'runs', 'run_stale_kept');
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'run.json'), old);
      expect((await runCli(workDir, ['test', '-r', 'run_stale_kept', '--json', 'storage/runs/run_stale_kept/run.json'])).code).toBe(2);
      expect(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')).toBe(old);
    }, 30000);

    it.skipIf(process.getuid?.() === 0)('a JSON write failure after a good run is an error (INTERNAL, exit 2)', async () => {
      const ro = path.join(workDir, 'readonly');
      fs.mkdirSync(ro);
      fs.chmodSync(ro, 0o555);
      try {
        const { code, stderr } = await runCli(workDir, ['test', '--no-strict', '-r', 'run_ro', '--json', 'readonly/result.json'], {
          env: { VISUAL_STORAGE_DIR: path.join(workDir, 'ro-storage') }
        });
        expect(code, stderr).toBe(2);
        expect(stderr).toContain('Could not write the JSON result to readonly/result.json');
        expect(fs.readdirSync(ro)).toEqual([]);
      } finally {
        fs.chmodSync(ro, 0o755);
      }
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
          baseline_snapshot: 'storage/runs/run_pass/baselines/index-desktop.png',
          diff: 'storage/runs/run_pass/index-desktop-diff.png' // compare writes a diff image for a MATCH too
        }]
      });
      expect(result.run.duration_ms).toBeGreaterThan(0);
      for (const rel of [result.run.manifest, result.run.summary, result.snapshots[0].current, result.snapshots[0].baseline, result.snapshots[0].baseline_snapshot]) {
        expect(fs.existsSync(path.join(workDir, rel)), rel).toBe(true);
      }
      // Same created_at as the run.json written next to the screenshots
      expect(result.run.created_at).toBe(readJson(path.join(workDir, result.run.manifest)).run.created_at);
    }, 60000);

    it('a JSON target outside the working directory is shown by its absolute path, not as ../../..', async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-cli-json-outside-'));
      try {
        const target = path.join(outside, 'result.json');
        const { code, stdout } = await runCli(workDir, ['test', '--no-strict', '-r', 'run_outside', '--json', target]);
        expect(code, stdout).toBe(0);
        expect(stdout).toContain(`JSON Result      : ${target}`);
        expect(stdout).not.toMatch(/JSON Result {6}: \.\./);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    }, 60000);

    it('visual diff: exit 1, status failed, counts.changed >= 1', async () => {
      color = 'red';
      const { code } = await runCli(workDir, ['test', '-r', 'run_diff', '--json', 'diff.json']);
      color = 'white';
      expect(code).toBe(1);
      const result = readJson(path.join(workDir, 'diff.json'));
      expect(result).toMatchObject({ status: 'failed', exit_code: 1, error: null });
      expect(result.counts.changed).toBeGreaterThanOrEqual(1);
      expect(result.snapshots[0]).toMatchObject({
        status: 'DIFF', diff: 'storage/runs/run_diff/index-desktop-diff.png',
        baseline: 'storage/baselines/index-desktop.png', baseline_snapshot: 'storage/runs/run_diff/baselines/index-desktop.png'
      });
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
        counts: { missing_baseline: 1 },
        snapshots: [{ status: 'MISSING_BASELINE', baseline: 'empty-storage/baselines/index-desktop.png', baseline_snapshot: null }]
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
      it(`an unhandled ${kind} exits 2 and still writes the JSON (INTERNAL)`, async () => {
        const target = `crash-${kind}.json`;
        const { code, stderr } = await runCli(workDir, ['test', '-u', `${baseUrl}/hang`, '-r', `run_crash_${kind}`, '--json', target], {
          env: { VRT_CRASH: kind },
          nodeArgs: crashPreload()
        });
        expect(code, stderr).toBe(2);
        expect(stderr).toContain('boom from preload');
        const result = readJson(path.join(workDir, target));
        expect(result).toMatchObject({ status: 'error', exit_code: 2, error: { code: 'INTERNAL', message: 'boom from preload' } });
        expect(result.run).toMatchObject({ id: `run_crash_${kind}` });
      }, 30000);
    }

    it('a crash with --json - writes the JSON to stdout', async () => {
      const { code, stdout, stderr } = await runCli(workDir, ['test', '-u', `${baseUrl}/hang`, '-r', 'run_crash_stdout', '--json', '-'], {
        env: { VRT_CRASH: 'rejection' },
        nodeArgs: crashPreload()
      });
      expect(code, stderr).toBe(2);
      expect(JSON.parse(stdout)).toMatchObject({ status: 'error', exit_code: 2, error: { code: 'INTERNAL' } });
      expect(stderr).toContain('boom from preload');
    }, 30000);

    it('capture exits 2 on a config error', async () => {
      const { code, stderr } = await runCli(workDir, ['capture', '-c', 'nowhere.json']);
      expect(code).toBe(2);
      expect(stderr).toContain('[ERROR] Capture failed: Configuration file not found at: nowhere.json');
    }, 30000);
  });
});
