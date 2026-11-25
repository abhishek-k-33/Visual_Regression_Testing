import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { monitorEventLoopDelay } from 'node:perf_hooks';
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
  delete process.env.VISUAL_IMPORT_IDLE_TIMEOUT_MS;
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
  delete process.env.VISUAL_IMPORT_IDLE_TIMEOUT_MS;
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
 * response (even if the server stops reading the body early); rejects if no response
 * arrives within `timeout`, so a server that never answers fails the test instead of
 * hanging it.
 */
// holdAfterBytes: once more than this many bytes are sent, wait for the response (or the
// timeout) before sending the rest, so "answered before the body was complete" doesn't
// depend on how fast a loaded machine runs.
function post({ body, headers = {}, chunks = null, chunkDelay = 0, holdAfterBytes, onRequest, timeout = 10000 } = {}) {
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
    req.setTimeout(timeout, () => req.destroy(new Error(`no response within ${timeout} ms`)));
    onRequest?.(req);
    if (chunks) {
      (async () => {
        let sent = 0;
        for (const chunk of chunks) {
          if (settled || req.destroyed) return;
          req.write(chunk);
          sent += chunk.length;
          if (holdAfterBytes !== undefined && sent > holdAfterBytes) {
            while (!settled && !req.destroyed) await sleep(10);
          }
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
      // The client holds the rest of the body once it has sent twice the cap: the server
      // must answer from the first ~40 KB (a server that waited for the whole body would
      // never answer, and the request would time out).
      const res = await post({
        chunks, chunkDelay: 5, holdAfterBytes: 40000, onRequest: (req) => { req.on('finish', () => { finished = true; }); }
      });
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

  describe('server-side failures', () => {
    const serverPathsIn = (text) => [storageRoot, root, os.tmpdir()].filter((p) => text.includes(p));

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      '500 (not a hang) when the temp file cannot be created; nothing left, lock released', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        fs.chmodSync(storageRoot, 0o555);
        let res;
        try {
          res = await post({ body: artifact({ runId: 'ci_eacces' }).body, timeout: 5000 });
        } finally {
          fs.chmodSync(storageRoot, 0o755);
        }
        expect(res.status).toBe(500);
        expect(res.json.error).toBe('Import failed because of a server error (EACCES).');
        expect(serverPathsIn(res.text)).toEqual([]); // no absolute paths leak to the client
        // The details are in the server log, as a readable multi-line stack.
        const log = logged.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(log).toContain('EACCES');
        expect(log.split('\n').length).toBeGreaterThan(2);
        expect(log).not.toContain('\\u{A}');

        await waitFor(() => !isImportBusy());
        expect((await post({ body: artifact({ runId: 'ci_after_eacces' }).body })).status).toBe(201);
      });

    it('500 when writing the upload fails part-way (disk full); nothing left, lock released', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const realCreate = fs.createWriteStream;
      vi.spyOn(fs, 'createWriteStream').mockImplementationOnce((file, ...rest) => {
        const real = realCreate(file, ...rest); // creates the temp file, like a real partial write
        let chunks = 0;
        return new Writable({
          write(chunk, _enc, cb) {
            chunks += 1;
            if (chunks === 1) return real.write(chunk, cb);
            return cb(Object.assign(new Error(`ENOSPC: no space left on device, write '${file}'`), { code: 'ENOSPC' }));
          },
          destroy(err, cb) { real.destroy(); cb(err); }
        });
      });
      const { body } = artifact({ runId: 'ci_enospc' });
      const res = await post({ chunks: [body.subarray(0, 100), body.subarray(100)], chunkDelay: 20, timeout: 5000 });
      expect(res.status).toBe(500);
      expect(res.json.error).toBe('Import failed because of a server error (ENOSPC).');
      expect(serverPathsIn(res.text)).toEqual([]);
      await waitFor(() => !isImportBusy() && uploads().length === 0);
      expect((await post({ body })).status).toBe(201);
    });

    it('507 when only the filesystem of runs/ (where the archive is unpacked) is low', async () => {
      const runsDir = path.join(storageRoot, 'runs');
      vi.spyOn(fs.promises, 'statfs').mockImplementation(async (dir) => (
        path.resolve(dir) === runsDir ? { bsize: 4096, bavail: 10 } : { bsize: 4096, bavail: 1e9 }));
      const res = await post({ body: artifact().body });
      expect(res.status).toBe(507);
      expect(res.json.error).toContain('40 KB free');
    });

    it('unpacks inside runs/ when runs/ is on another filesystem, and imports fine', async () => {
      const runsDir = path.join(storageRoot, 'runs');
      fs.mkdirSync(runsDir, { recursive: true });
      const realStat = fs.promises.stat.bind(fs.promises);
      vi.spyOn(fs.promises, 'stat').mockImplementation(async (p, ...rest) => {
        const st = await realStat(p, ...rest);
        return path.resolve(String(p)) === runsDir ? { ...st, dev: st.dev + 1, isDirectory: () => true } : st;
      });
      const mkdtemp = vi.spyOn(fs.promises, 'mkdtemp');
      const res = await post({ body: artifact({ runId: 'ci_xdev' }).body });
      expect(res.status).toBe(201);
      expect(mkdtemp.mock.calls.map(([prefix]) => prefix)).toEqual([path.join(runsDir, '.import-')]);
      expect(fs.readdirSync(runsDir)).toEqual(['ci_xdev']); // staging removed again
    });

    it('a stalled upload is dropped after the idle timeout: lock released, temp file removed', async () => {
      process.env.VISUAL_IMPORT_IDLE_TIMEOUT_MS = '200';
      const { body } = artifact({ runId: 'ci_stalled' });
      const stalled = post({
        headers: { 'Content-Length': String(body.length) },
        onRequest: (req) => req.write(body.subarray(0, 100)), // then nothing more
        timeout: 5000
      }).then(() => 'answered', (err) => `dropped: ${err.message}`);
      await waitFor(() => uploads().length === 1);
      const started = Date.now();
      await waitFor(() => !isImportBusy() && uploads().length === 0, { timeout: 3000 });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await stalled).toMatch(/^dropped/);
      expect((await post({ body })).status).toBe(201);
    });
  });

  it('stays responsive: requests are served while a large import runs, without blocking reads', async () => {
    // ~40 MB per image (3 images): unpacking, hashing and writing take a while, but are
    // all streamed, so the event loop keeps serving requests.
    const { body } = artifact({ runId: 'ci_big', padBytes: 40 * 1024 * 1024 });
    // The real guard: no imported file is ever read synchronously (whole or in part).
    const readFileSync = vi.spyOn(fs, 'readFileSync');
    const openSync = vi.spyOn(fs, 'openSync');
    const readSync = vi.spyOn(fs, 'readSync');
    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();

    let done = false;
    const upload = post({ body, timeout: 60000 }).finally(() => { done = true; });
    let served = 0;
    while (!done) {
      const res = await fetch(`http://127.0.0.1:${port}/api/runs`);
      await res.json();
      if (!done) served += 1;
      await sleep(20);
    }
    loopDelay.disable();
    const res = await upload;
    expect(res.status).toBe(201);
    expect(getSnapshotsByRunId('ci_big', db)).toHaveLength(1);

    const underStorage = (p) => typeof p === 'string' && p.startsWith(storageRoot);
    expect(readFileSync.mock.calls.map(([p]) => p).filter(underStorage)).toEqual([]);
    const storageFds = new Set(openSync.mock.calls
      .map(([p], i) => (underStorage(String(p)) ? openSync.mock.results[i].value : null))
      .filter((fd) => fd !== null));
    expect(storageFds.size).toBe(0);
    expect(readSync.mock.calls.filter(([fd]) => storageFds.has(fd))).toEqual([]);

    // Requests really were served during the import, and the loop never stalled for
    // long (generous bound: client and server share this process, and CI is noisy).
    expect(served).toBeGreaterThanOrEqual(3);
    expect(loopDelay.percentile(99) / 1e6).toBeLessThan(1000);
  }, 60000);
});
