import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import app from '../src/server/app.js';
import { initDb, closeDb, createTestRun, createSnapshot } from '../src/server/db.js';
import { isAllowedHost } from '../src/server/security.js';

const SAME_ORIGIN_WRITE = { method: 'POST', headers: { 'X-Requested-With': 'test' } };

// Raw request so tests can set Host and other headers fetch() won't let us forge.
function rawRequest(port, { method = 'GET', path: reqPath, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Express Review Dashboard & REST API', () => {
  let server;
  let baseUrl;
  let previousStorageEnv;
  const testTmpDir = path.resolve(process.cwd(), 'tests/.tmp_server');
  const storageRoot = path.join(testTmpDir, 'storage');
  const dbPath = path.join(testTmpDir, 'server_test.sqlite');
  const baselineFile = path.join(storageRoot, 'baselines', 'index-desktop.png');
  const currentFile = path.join(storageRoot, 'runs', 'api-run-1', 'index-desktop.png');
  let snapshotId;

  beforeAll(async () => {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.mkdirSync(path.dirname(currentFile), { recursive: true });

    // Point the server's storage at the temp dir so tests never touch real storage/
    previousStorageEnv = process.env.VISUAL_STORAGE_DIR;
    process.env.VISUAL_STORAGE_DIR = storageRoot;

    const db = initDb(dbPath);

    // Seed data the way the CLI does: direct DB writes
    createTestRun({ id: 'api-run-1', commit_hash: 'c0ffee1', branch: 'feature/nav', status: 'FAILED' }, db);
    snapshotId = createSnapshot({
      run_id: 'api-run-1',
      route: '/',
      viewport: 'desktop',
      baseline_path: baselineFile,
      current_path: currentFile,
      diff_path: path.join(storageRoot, 'runs', 'api-run-1', 'index-desktop-diff.png'),
      mismatch_percentage: 1.5,
      status: 'DIFF'
    }, db).id;

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    closeDb();
    if (previousStorageEnv === undefined) delete process.env.VISUAL_STORAGE_DIR;
    else process.env.VISUAL_STORAGE_DIR = previousStorageEnv;
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  });

  it('GET / returns 200 and renders dashboard HTML', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Visual Regression Test Runs');
    expect(html).toContain('Dashboard');
  });

  it('POST /api/runs no longer exists (clients cannot register file paths)', async () => {
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'test' },
      body: JSON.stringify({ id: 'x', snapshots: [] })
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/runs returns list of runs', async () => {
    const res = await fetch(`${baseUrl}/api/runs`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.runs.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/runs/:id returns run details and snapshots', async () => {
    const res = await fetch(`${baseUrl}/api/runs/api-run-1`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.run.id).toBe('api-run-1');
    expect(data.snapshots).toHaveLength(1);
    expect(data.snapshots[0].route).toBe('/');
  });

  it('GET /runs/:id renders run details HTML view', async () => {
    const res = await fetch(`${baseUrl}/runs/api-run-1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('api-run-1');
    expect(html).toContain('Side-by-Side');
    expect(html).toContain('Approve & Update Baseline');
  });

  describe('cross-site request protection', () => {
    async function expectSnapshotUntouched() {
      expect(fs.readFileSync(baselineFile, 'utf8')).toBe('OLD_IMAGE');
      const data = await (await fetch(`${baseUrl}/api/runs/api-run-1`)).json();
      expect(data.snapshots[0].status).toBe('DIFF');
    }

    beforeAll(() => {
      fs.writeFileSync(baselineFile, 'OLD_IMAGE');
      fs.writeFileSync(currentFile, 'NEW_IMAGE');
    });

    it('blocks a plain cross-site form POST (no custom header)', async () => {
      for (const action of ['approve', 'reject']) {
        const res = await fetch(`${baseUrl}/api/snapshots/${snapshotId}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' },
          body: ''
        });
        expect(res.status, action).toBe(403);
        expect((await res.json()).error).toMatch(/Cross-site request blocked/);
      }
      await expectSnapshotUntouched();
    });

    it('blocks a POST without the custom header even with no Origin', async () => {
      const res = await fetch(`${baseUrl}/api/snapshots/${snapshotId}/approve`, { method: 'POST' });
      expect(res.status).toBe(403);
      await expectSnapshotUntouched();
    });

    it('blocks a POST whose Origin does not match the Host', async () => {
      for (const origin of ['https://evil.example', 'http://localhost:1', 'null']) {
        const res = await fetch(`${baseUrl}/api/snapshots/${snapshotId}/approve`, {
          method: 'POST',
          headers: { 'X-Requested-With': 'x', Origin: origin }
        });
        expect(res.status, origin).toBe(403);
      }
      await expectSnapshotUntouched();
    });

    it('blocks a POST the browser marks as cross-site via Sec-Fetch-Site', async () => {
      for (const site of ['cross-site', 'same-site']) {
        const res = await fetch(`${baseUrl}/api/snapshots/${snapshotId}/approve`, {
          method: 'POST',
          headers: { 'X-Requested-With': 'x', 'Sec-Fetch-Site': site }
        });
        expect(res.status, site).toBe(403);
      }
      await expectSnapshotUntouched();
    });

    it('allows a same-origin browser POST (matching Origin + Sec-Fetch-Site)', async () => {
      const res = await fetch(`${baseUrl}/api/snapshots/999999/reject`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'x', Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' }
      });
      // Gets past the CSRF check to the route itself, which 404s on the unknown ID
      expect(res.status).toBe(404);
    });

    it('rejects DNS-rebinding requests with a foreign Host header, including reads', async () => {
      const { port } = server.address();
      const reads = ['/', '/api/runs', '/storage/runs/api-run-1/index-desktop.png'];
      for (const reqPath of reads) {
        const res = await rawRequest(port, { path: reqPath, headers: { Host: `evil.example:${port}` } });
        expect(res.status, reqPath).toBe(403);
      }
      const write = await rawRequest(port, {
        method: 'POST',
        path: `/api/snapshots/${snapshotId}/approve`,
        headers: { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}`, 'X-Requested-With': 'x' }
      });
      expect(write.status).toBe(403);
      await expectSnapshotUntouched();
    });

    it('accepts localhost, IP-literal hosts and ALLOWED_HOSTS entries', async () => {
      const { port } = server.address();
      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `192.168.1.20:${port}`]) {
        const res = await rawRequest(port, { path: '/api/runs', headers: { Host: host } });
        expect(res.status, host).toBe(200);
      }

      const previous = process.env.ALLOWED_HOSTS;
      process.env.ALLOWED_HOSTS = 'ci-box.internal, Review.Example.com';
      try {
        for (const host of [`ci-box.internal:${port}`, 'review.example.com']) {
          const res = await rawRequest(port, { path: '/api/runs', headers: { Host: host } });
          expect(res.status, host).toBe(200);
        }
      } finally {
        if (previous === undefined) delete process.env.ALLOWED_HOSTS;
        else process.env.ALLOWED_HOSTS = previous;
      }
    });

    it('isAllowedHost handles edge cases', () => {
      expect(isAllowedHost(undefined)).toBe(false);
      expect(isAllowedHost('')).toBe(false);
      expect(isAllowedHost('LOCALHOST:4000')).toBe(true);
      expect(isAllowedHost('localhost.:4000')).toBe(true);
      expect(isAllowedHost('localhost.evil.example')).toBe(false);
      expect(isAllowedHost('127.0.0.1.nip.io')).toBe(false);
      expect(isAllowedHost('not a host')).toBe(false);
    });
  });

  it('POST /api/snapshots/:id/approve promotes baseline and updates status to APPROVED', async () => {
    fs.writeFileSync(baselineFile, 'OLD_IMAGE');
    fs.writeFileSync(currentFile, 'NEW_IMAGE');

    const res = await fetch(`${baseUrl}/api/snapshots/${snapshotId}/approve`, SAME_ORIGIN_WRITE);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.snapshot.status).toBe('APPROVED');
    expect(data.runStatus).toBe('APPROVED');
    expect(fs.readFileSync(baselineFile, 'utf8')).toBe('NEW_IMAGE');
  });

  it('POST /api/snapshots/:id/reject updates status to REJECTED', async () => {
    const res = await fetch(`${baseUrl}/api/snapshots/${snapshotId}/reject`, SAME_ORIGIN_WRITE);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.snapshot.status).toBe('REJECTED');
    expect(data.runStatus).toBe('REJECTED');
  });

  it('serves PNG screenshots from storage/runs and storage/baselines', async () => {
    const res = await fetch(`${baseUrl}/storage/runs/api-run-1/index-desktop.png`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('NEW_IMAGE');
  });

  it('refuses non-PNG and out-of-scope files under /storage', async () => {
    fs.writeFileSync(path.join(storageRoot, 'data.sqlite'), 'DB');
    fs.writeFileSync(path.join(storageRoot, 'runs', 'api-run-1', 'summary.md'), 'MD');
    fs.writeFileSync(path.join(storageRoot, 'stray.png'), 'STRAY');

    for (const p of [
      '/storage/data.sqlite',
      '/storage/data.sqlite-wal',
      '/storage/runs/api-run-1/summary.md',
      '/storage/stray.png'
    ]) {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status, p).toBe(403);
      expect(await res.text(), p).toBe('Access denied');
    }
  });

  it('refuses encoded traversal paths sent raw (bypassing client URL normalization)', async () => {
    fs.writeFileSync(path.join(storageRoot, 'stray.png'), 'STRAY');
    const { port } = server.address();
    for (const rawPath of [
      '/storage/runs/%2e%2e/%2e%2e/stray.png',
      '/storage/runs/..%2f..%2fstray.png',
      '/storage/baselines/..%2fstray.png'
    ]) {
      const status = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
          res.resume();
          resolve(res.statusCode);
        }).on('error', reject);
      });
      expect(status, rawPath).toBe(403);
    }
  });

  it('returns 404 for a missing screenshot', async () => {
    const res = await fetch(`${baseUrl}/storage/runs/api-run-1/missing.png`);
    expect(res.status).toBe(404);
  });

  it('regression: a snapshot pointing at a secrets file cannot be approved or downloaded', async () => {
    // Simulate a malicious row (previously insertable via POST /api/runs)
    const secretFile = path.join(testTmpDir, '.env');
    fs.writeFileSync(secretFile, 'FAKE_SECRET=hunter2');
    const leakTarget = path.join(storageRoot, 'baselines', 'leak.png');

    createTestRun({ id: 'attack-run', status: 'FAILED' });
    const evil = createSnapshot({
      run_id: 'attack-run',
      route: '/',
      viewport: 'desktop',
      baseline_path: leakTarget,
      current_path: secretFile,
      status: 'DIFF'
    });

    const approve = await fetch(`${baseUrl}/api/snapshots/${evil.id}/approve`, SAME_ORIGIN_WRITE);
    expect(approve.status).toBe(403);
    expect(fs.existsSync(leakTarget)).toBe(false);

    const download = await fetch(`${baseUrl}/storage/baselines/leak.png`);
    expect(download.status).toBe(404);
  });
});
