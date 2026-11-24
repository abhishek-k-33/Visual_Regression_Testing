import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { resolveStorageRoot } from '../src/server/paths.js';

const CLI = path.resolve('src/cli/index.js');
const APP = path.resolve('src/server/app.js');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ['CI', 'GITHUB_STEP_SUMMARY', 'VISUAL_STORAGE_DIR']) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

describe('resolveStorageRoot precedence', () => {
  it('VISUAL_STORAGE_DIR > config storageDir > ./storage', () => {
    const previous = process.env.VISUAL_STORAGE_DIR;
    try {
      delete process.env.VISUAL_STORAGE_DIR;
      expect(resolveStorageRoot()).toBe(path.resolve('storage'));
      expect(resolveStorageRoot('data/vrt')).toBe(path.resolve('data/vrt'));
      process.env.VISUAL_STORAGE_DIR = '/tmp/elsewhere';
      expect(resolveStorageRoot('data/vrt')).toBe('/tmp/elsewhere');
    } finally {
      if (previous === undefined) delete process.env.VISUAL_STORAGE_DIR;
      else process.env.VISUAL_STORAGE_DIR = previous;
    }
  });
});

// The CLI and the dashboard must agree on one storage folder: previously the CLI put
// screenshots in storageDir but the database in ./storage, and the dashboard only
// looked in ./storage, so a custom storageDir broke review and approval.
describe('custom storageDir is honoured by the CLI and the dashboard', () => {
  let site;
  let workDir;
  let dashboard;

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><body style="background:#fff"><h1>storageDir</h1></body>');
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-storage-dir-'));
    // No baseUrl: the CLI gets it from --base-url. The dashboard only needs storageDir
    // and must not fall back to ./storage just because the rest isn't complete.
    fs.writeFileSync(path.join(workDir, 'visual.config.json'), JSON.stringify({
      routes: ['/'],
      viewports: [{ name: 'desktop', width: 400, height: 300 }],
      threshold: 0.01,
      storageDir: 'vrt-data'
    }));
  });

  afterAll(async () => {
    if (dashboard) dashboard.kill();
    await new Promise((resolve) => site.close(resolve));
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('CLI writes baselines, screenshots and the database under storageDir only', async () => {
    const code = await new Promise((resolve) => {
      const baseUrl = `http://127.0.0.1:${site.address().port}`;
      execFile('node', [CLI, 'test', '--no-strict', '-r', 'run_custom', '-u', baseUrl], { cwd: workDir, env: cleanEnv() },
        (err) => resolve(err ? err.code : 0));
    });
    expect(code).toBe(0);

    const data = path.join(workDir, 'vrt-data');
    expect(fs.existsSync(path.join(data, 'baselines', 'index-desktop.png'))).toBe(true);
    expect(fs.existsSync(path.join(data, 'runs', 'run_custom', 'index-desktop.png'))).toBe(true);
    expect(fs.existsSync(path.join(data, 'data.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'storage'))).toBe(false);
  }, 30000);

  it('dashboard reads storageDir from visual.config.json and serves its screenshots', async () => {
    // A port the OS says is free (a random one could already be taken), and a generous
    // start-up wait: under a full parallel test run the server can take several seconds.
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address();
        probe.close(() => resolve(free));
      });
    });
    dashboard = spawn('node', [APP], { cwd: workDir, env: cleanEnv({ PORT: String(port) }), stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;

    let html;
    const deadline = Date.now() + 25000; // under the 30 s test timeout
    while (!html && Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/runs/run_custom`);
        if (res.ok) html = await res.text();
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    expect(html).toContain('run_custom');

    const url = '/storage/runs/run_custom/index-desktop.png';
    expect(html).toContain(url);
    const img = await fetch(`${base}${url}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toContain('image/png');
  }, 30000);
});
