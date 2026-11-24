import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import app from '../src/server/app.js';
import { initDb, closeDb, getTestRunById, getSnapshotsByRunId } from '../src/server/db.js';
import { isImportBusy, RETRY_AFTER_SECONDS, DEFAULT_MAX_UPLOAD_BYTES } from '../src/server/uploadImport.js';
import { writeZip, folderEntries } from './helpers/zip.js';
import { writeFakeRun } from './helpers/fake-run.js';

// POST /api/imports: the dashboard's upload of a CI artifact zip.

const RAW_CONTROL = /[\p{Cc}\p{Cf}]/u;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitFor(check, { timeout = 5000, interval = 10 } = {}) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error('timed out waiting for a condition');
    await sleep(interval);
  }
}

let server;
let port;
let root;
let storageRoot;
let db;
let previousEnv;

beforeAll(async () => {
  previousEnv = { storage: process.env.VISUAL_STORAGE_DIR, cap: process.env.VISUAL_IMPORT_MAX_UPLOAD_BYTES };
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const [key, value] of [['VISUAL_STORAGE_DIR', previousEnv.storage], ['VISUAL_IMPORT_MAX_UPLOAD_BYTES', previousEnv.cap]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-upload-'));
  storageRoot = path.join(root, 'storage');
  fs.mkdirSync(path.join(storageRoot, 'baselines'), { recursive: true });
  process.env.VISUAL_STORAGE_DIR = storageRoot;
  delete process.env.VISUAL_IMPORT_MAX_UPLOAD_BYTES;
  db = initDb(path.join(storageRoot, 'data.sqlite'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Whatever the test did, no upload temp file may be left behind, and the lock is free.
  await waitFor(() => !isImportBusy());
  expect(uploads()).toEqual([]);
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

const uploads = () => fs.readdirSync(storageRoot).filter((f) => f.startsWith('.upload-'));

/** An artifact zip laid out like actions/upload-artifact's (<runId>/...). */
function artifact(options = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'ci-'));
  const { runDir, manifest } = writeFakeRun(dir, options);
  const zip = writeZip(path.join(root, `${manifest.run.id}-${Date.now()}.zip`), folderEntries(runDir, manifest.run.id));
  return { zip, body: fs.readFileSync(zip), manifest };
}

/**
 * Raw POST, so tests control Content-Length, chunking and aborts. Resolves with the
 * response (even if the server stops reading the body early).
 */
function post({ body, headers = {}, chunks = null, chunkDelay = 0, onRequest } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/imports',
      headers: { 'X-Requested-With': 'test', 'Content-Type': 'application/zip', ...headers }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        settled = true;
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', (err) => { if (!settled) setTimeout(() => { if (!settled) reject(err); }, 200); });
    onRequest?.(req);
    if (chunks) {
      (async () => {
        for (const chunk of chunks) {
          if (settled || req.destroyed) return;
          req.write(chunk);
          if (chunkDelay) await sleep(chunkDelay);
        }
        if (!req.destroyed) req.end();
      })();
    } else if (body !== undefined) {
      req.end(body);
    }
  });
}

describe('POST /api/imports', () => {
  it('201: imports an artifact; the run is in the DB and the dashboard; re-upload is 200', async () => {
    const { body, manifest } = artifact({ runId: 'ci_upload_1' });
    const res = await post({ body });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({
      success: true,
      runs: [{ id: 'ci_upload_1', url: '/runs/ci_upload_1', status: 'FAILED', snapshots: 1 }]
    });
    const run = getTestRunById('ci_upload_1', db);
    expect(run.imported_at).toBeTruthy();
    expect(getSnapshotsByRunId('ci_upload_1', db)[0].baseline_sha256).toBe(manifest.snapshots[0].baseline_sha256);

    const page = await (await fetch(`http://127.0.0.1:${port}/runs/ci_upload_1`)).text();
    expect(page).toContain('<span class="imported-badge">Imported</span>');
    const img = await fetch(`http://127.0.0.1:${port}/storage/runs/ci_upload_1/index-desktop.png`);
    expect(img.status).toBe(200);

    const again = await post({ body, headers: { 'Content-Type': 'application/x-zip-compressed' } });
    expect(again.status).toBe(200);
    expect(again.json.runs[0]).toMatchObject({ id: 'ci_upload_1', alreadyImported: true });
  });

  it('accepts application/octet-stream (with parameters) too', async () => {
    const { body } = artifact({ runId: 'ci_octet' });
    const res = await post({ body, headers: { 'Content-Type': 'application/octet-stream; charset=binary' } });
    expect(res.status).toBe(201);
  });

  describe('CSRF (same checks as every write)', () => {
    it('403 without the X-Requested-With header', async () => {
      const { body } = artifact();
      const res = await post({ body, headers: { 'X-Requested-With': '' } });
      expect(res.status).toBe(403);
      expect(res.json.error).toContain('missing X-Requested-With');
      expect(getTestRunById('ci_fake', db)).toBeNull();
    });

    it('403 from another origin', async () => {
      const { body } = artifact();
      for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        const res = await post({ body, headers });
        expect(res.status).toBe(403);
      }
      expect(getTestRunById('ci_fake', db)).toBeNull();
    });
  });

  it('415 for any other Content-Type (or none)', async () => {
    const { body } = artifact();
    for (const type of ['text/plain', 'multipart/form-data; boundary=x', 'application/json', '']) {
      const res = await post({ body, headers: { 'Content-Type': type } });
      expect(res.status, type).toBe(415);
      expect(res.json.success).toBe(false);
    }
  });

  describe('413 upload cap', () => {
    it('defaults to 200 MB', () => {
      expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(200 * 1024 * 1024);
    });

    it('refuses early on Content-Length over the cap', async () => {
      process.env.VISUAL_IMPORT_MAX_UPLOAD_BYTES = '1000';
      const res = await post({ body: Buffer.alloc(5000) });
      expect(res.status).toBe(413);
      expect(res.json.error).toContain('1000 bytes limit');
    });

    it('stops a chunked body (no Content-Length) once it passes the cap', async () => {
      process.env.VISUAL_IMPORT_MAX_UPLOAD_BYTES = '20000';
      const chunks = Array.from({ length: 50 }, () => Buffer.alloc(4096, 7)); // 200 KB in total, 5 ms apart
      let finished = false;
      const res = await post({ chunks, chunkDelay: 5, onRequest: (req) => { req.on('finish', () => { finished = true; }); } });
      const finishedAtResponse = finished;
      expect(res.status).toBe(413);
      expect(res.json.error).toContain('20 KB limit');
      expect(finishedAtResponse).toBe(false); // answered before the client finished sending
    });
  });

  it('a client that aborts mid-upload leaves no temp file', async () => {
    const { body } = artifact();
    let request;
    const pending = post({
      headers: { 'Content-Length': String(body.length) },
      onRequest: (req) => { request = req; req.write(body.subarray(0, 100)); }
    }).catch(() => null);
    await waitFor(() => uploads().length === 1);
    request.destroy();
    await pending;
    await waitFor(() => !isImportBusy() && uploads().length === 0);
    expect(getTestRunById('ci_fake', db)).toBeNull();
  });

  it('503 with Retry-After while another import runs (no queue), then the first completes', async () => {
    const first = artifact({ runId: 'ci_first' });
    const second = artifact({ runId: 'ci_second' });
    let request;
    const firstDone = post({
      headers: { 'Content-Length': String(first.body.length) },
      onRequest: (req) => { request = req; req.write(first.body.subarray(0, 50)); }
    });
    await waitFor(() => uploads().length === 1); // the first upload is being received

    const busy = await post({ body: second.body });
    expect(busy.status).toBe(503);
    expect(busy.headers['retry-after']).toBe(String(RETRY_AFTER_SECONDS));
    expect(busy.json.error).toContain('Another import is in progress');

    request.end(first.body.subarray(50));
    expect((await firstDone).status).toBe(201);
    expect(getTestRunById('ci_second', db)).toBeNull();
    expect((await post({ body: second.body })).status).toBe(201);
  });

  describe('507 disk guard', () => {
    it('refuses when the disk has less than max(2 x cap, 1 GB) free', async () => {
      vi.spyOn(fs.promises, 'statfs').mockResolvedValue({ bsize: 4096, bavail: 1000, blocks: 1e6, bfree: 1000 });
      const { body } = artifact();
      const res = await post({ body });
      expect(res.status).toBe(507);
      expect(res.json.error).toMatch(/Not enough free disk space to import: 4 MB free, at least 1024 MB needed/);
      expect(getTestRunById('ci_fake', db)).toBeNull();
    });

    it('a larger cap raises the bar', async () => {
      process.env.VISUAL_IMPORT_MAX_UPLOAD_BYTES = String(1024 * 1024 * 1024); // 1 GB -> 2 GB needed
      vi.spyOn(fs.promises, 'statfs').mockResolvedValue({ bsize: 1024 * 1024, bavail: 1500 });
      const res = await post({ body: artifact().body });
      expect(res.status).toBe(507);
      expect(res.json.error).toContain('at least 2048 MB needed');
    });

    it('carries on where statfs is unavailable', async () => {
      vi.spyOn(fs.promises, 'statfs').mockRejectedValue(Object.assign(new Error('ENOSYS'), { code: 'ENOSYS' }));
      expect((await post({ body: artifact().body })).status).toBe(201);
    });
  });

  describe('import errors propagate, sanitised', () => {
    it('400: not a zip', async () => {
      const res = await post({ body: Buffer.from('this is not a zip archive') });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/^Not a valid zip archive/);
    });

    it('400: an empty body', async () => {
      const res = await post({ body: Buffer.alloc(0) });
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('empty');
    });

    it('400: a terminal-escape entry name comes back escaped', async () => {
      const dir = fs.mkdtempSync(path.join(root, 'ci-'));
      const { runDir } = writeFakeRun(dir);
      const zip = writeZip(path.join(root, 'evil.zip'), [
        ...folderEntries(runDir, 'ci_fake'),
        { name: 'x\\\u001b]0;PWNED\u0007\u001b[2J\u009b2J\u202e', data: 'x' }
      ]);
      const res = await post({ body: fs.readFileSync(zip) });
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('Unsafe file name');
      expect(res.text).not.toMatch(/[\u001b\u0007\u009b\u202e]/); // no raw characters in the response body
      expect(res.json.error).not.toMatch(RAW_CONTROL);
    });

    it('422: an invalid manifest, with control characters escaped in the message', async () => {
      const dir = fs.mkdtempSync(path.join(root, 'ci-'));
      const { runDir } = writeFakeRun(dir, { branch: 'main' });
      const manifestPath = path.join(runDir, 'run.json');
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      m.run.branch = 'main\u009b2J\u202e';
      fs.writeFileSync(manifestPath, JSON.stringify(m));
      const zip = writeZip(path.join(root, 'bad.zip'), folderEntries(runDir, 'ci_fake'));
      const res = await post({ body: fs.readFileSync(zip) });
      expect(res.status).toBe(422);
      expect(res.json.error).toContain('run.branch');
      expect(res.json.error).not.toMatch(RAW_CONTROL);
      expect(res.json.error).toContain('\\u{9B}');
    });

    it('409 is not reachable without a run id, but id collisions are renamed', async () => {
      const { body } = artifact({ runId: 'ci_twice', createdAt: new Date('2026-11-24T08:00:00Z') });
      expect((await post({ body })).status).toBe(201);
      const other = artifact({ runId: 'ci_twice', createdAt: new Date('2026-11-24T09:00:00Z') });
      const res = await post({ body: other.body });
      expect(res.status).toBe(201);
      expect(res.json.runs[0]).toMatchObject({ id: 'ci_twice-imp2', renamedFrom: 'ci_twice' });
    });
  });

  it('stays responsive: GET /api/runs answers promptly while a large import runs', async () => {
    // ~40 MB per image (3 images): unpacking, hashing and writing take a while, but are
    // all streamed, so the event loop keeps serving requests.
    const { body } = artifact({ runId: 'ci_big', padBytes: 40 * 1024 * 1024 });
    const readFileSync = vi.spyOn(fs, 'readFileSync');

    let done = false;
    const upload = post({ body }).finally(() => { done = true; });
    const latencies = [];
    while (!done) {
      const started = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/api/runs`);
      await res.json();
      if (!done) latencies.push(Date.now() - started);
      await sleep(20);
    }
    const res = await upload;
    expect(res.status).toBe(201);
    expect(getSnapshotsByRunId('ci_big', db)).toHaveLength(1);

    // Requests were really served during the import, each one promptly.
    expect(latencies.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...latencies)).toBeLessThan(500);
    // And by construction: no imported file was ever read whole and synchronously.
    const syncReads = readFileSync.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith(storageRoot));
    expect(syncReads).toEqual([]);
  }, 60000);
});
