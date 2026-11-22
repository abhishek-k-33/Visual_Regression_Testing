import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import Database from 'better-sqlite3';

const CLI = path.resolve('src/cli/index.js');

// Runs the real CLI in a throwaway working directory, so its storage/ and
// SQLite database never touch the repository's committed baselines.
function runCli(cwd, args, { ci }) {
  const env = { ...process.env };
  delete env.CI;
  delete env.GITHUB_STEP_SUMMARY;
  if (ci) env.CI = 'true';
  return new Promise((resolve) => {
    execFile('node', [CLI, 'test', ...args], { cwd, env }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: stdout + stderr });
    });
  });
}

describe('CLI strict mode (missing baselines)', () => {
  let server;
  let workDir;
  let baselines;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><body style="background:#fff"><h1>Strict mode</h1></body>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-cli-strict-'));
    baselines = path.join(workDir, 'storage', 'baselines');
    fs.writeFileSync(path.join(workDir, 'visual.config.json'), JSON.stringify({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      routes: ['/'],
      viewports: [{ name: 'desktop', width: 400, height: 300 }],
      threshold: 0.01
    }));
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const baselineFile = () => path.join(baselines, 'index-desktop.png');

  it('CI=true defaults to strict: fails with exit 1 and creates no baseline', async () => {
    const { code, out } = await runCli(workDir, [], { ci: true });
    expect(code).toBe(1);
    expect(out).toContain('Missing baseline: fail (strict)');
    expect(out).toMatch(/\[FAIL\] \/ @ desktop -> no baseline at/);
    expect(fs.existsSync(baselineFile())).toBe(false);
  }, 30000);

  it('--strict also fails outside CI', async () => {
    const { code } = await runCli(workDir, ['--strict'], { ci: false });
    expect(code).toBe(1);
    expect(fs.existsSync(baselineFile())).toBe(false);
  }, 30000);

  it('--no-strict overrides CI=true and creates the baseline', async () => {
    const { code, out } = await runCli(workDir, ['--no-strict'], { ci: true });
    expect(code).toBe(0);
    expect(out).toContain('[NEW BASELINE] / @ desktop');
    expect(fs.existsSync(baselineFile())).toBe(true);
  }, 30000);

  it('--update-baselines records the baseline hash and copy for the run', async () => {
    const { code } = await runCli(workDir, ['--update-baselines', '-r', 'run_update'], { ci: true });
    expect(code).toBe(0);
    const db = new Database(path.join(workDir, 'storage', 'data.sqlite'), { readonly: true });
    const row = db.prepare("SELECT * FROM snapshots WHERE run_id = 'run_update'").get();
    db.close();
    expect(row.status).toBe('NEW_BASELINE');
    expect(row.baseline_snapshot_path).toBe(row.current_path);
    expect(row.baseline_sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30000);

  it('strict passes once the baseline exists', async () => {
    const { code, out } = await runCli(workDir, [], { ci: true });
    expect(code).toBe(0);
    expect(out).toMatch(/\[PASS\] \/ @ desktop/);
  }, 30000);
});
