import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import app from '../src/server/app.js';
import { initDb, closeDb } from '../src/server/db.js';

describe('Express Review Dashboard & REST API', () => {
  let server;
  let baseUrl;
  const testTmpDir = path.resolve(process.cwd(), 'tests/.tmp_server');
  const dbPath = path.join(testTmpDir, 'server_test.sqlite');

  beforeAll(async () => {
    fs.mkdirSync(testTmpDir, { recursive: true });
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    // Initialize test database
    initDb(dbPath);

    // Bind Express server to ephemeral port
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    closeDb();
    if (fs.existsSync(testTmpDir)) {
      fs.rmSync(testTmpDir, { recursive: true, force: true });
    }
  });

  it('GET / returns 200 and renders dashboard HTML', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Visual Regression Test Runs');
    expect(html).toContain('Dashboard');
  });

  it('POST /api/runs registers a test run and its snapshots', async () => {
    const payload = {
      id: 'api-run-1',
      commit_hash: 'c0ffee1',
      branch: 'feature/nav',
      status: 'FAILED',
      snapshots: [
        {
          route: '/',
          viewport: 'desktop',
          baseline_path: path.join(testTmpDir, 'baseline.png'),
          current_path: path.join(testTmpDir, 'current.png'),
          diff_path: path.join(testTmpDir, 'diff.png'),
          mismatch_percentage: 1.5,
          status: 'DIFF'
        }
      ]
    };

    const res = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.runId).toBe('api-run-1');
    expect(data.snapshotsCount).toBe(1);
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

  it('POST /api/snapshots/:id/approve promotes baseline and updates status to APPROVED', async () => {
    // Setup dummy files for baseline promotion
    const baselineFile = path.join(testTmpDir, 'baseline.png');
    const currentFile = path.join(testTmpDir, 'current.png');
    fs.writeFileSync(baselineFile, 'OLD_IMAGE');
    fs.writeFileSync(currentFile, 'NEW_IMAGE');

    const res = await fetch(`${baseUrl}/api/snapshots/1/approve`, {
      method: 'POST'
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.snapshot.status).toBe('APPROVED');
    expect(data.runStatus).toBe('APPROVED');

    // Verify baseline file was overwritten on disk
    expect(fs.readFileSync(baselineFile, 'utf8')).toBe('NEW_IMAGE');
  });

  it('POST /api/snapshots/:id/reject updates status to REJECTED', async () => {
    const res = await fetch(`${baseUrl}/api/snapshots/1/reject`, {
      method: 'POST'
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.snapshot.status).toBe('REJECTED');
    expect(data.runStatus).toBe('REJECTED');
  });

  it('blocks direct access to SQLite database files under /storage', async () => {
    const res = await fetch(`${baseUrl}/storage/data.sqlite`);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toBe('Access denied');
  });
});
