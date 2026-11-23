import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import app from '../src/server/app.js';
import { initDb, closeDb, createTestRun, createSnapshot, getSnapshotById, getTestRunById } from '../src/server/db.js';
import { runDetailModel } from '../src/server/viewModels.js';
import { pageLocals } from '../src/server/urls.js';

// POST /api/runs/:id/approve-all and the "Approve all pending (N)" button.

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const WRITE = { method: 'POST', headers: { 'X-Requested-With': 'test' } };

describe('Approve all pending: API and run page', () => {
  const tmp = path.resolve(process.cwd(), 'tests/.tmp_approve_all_api');
  const storageRoot = path.join(tmp, 'storage');
  const baselinesDir = path.join(storageRoot, 'baselines');
  let db;
  let server;
  let baseUrl;
  let previousStorageEnv;
  let runCounter = 0;

  beforeAll(async () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(baselinesDir, { recursive: true });
    previousStorageEnv = process.env.VISUAL_STORAGE_DIR;
    process.env.VISUAL_STORAGE_DIR = storageRoot;
    db = initDb(path.join(tmp, 'api.sqlite'));
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDb();
    if (previousStorageEnv === undefined) delete process.env.VISUAL_STORAGE_DIR;
    else process.env.VISUAL_STORAGE_DIR = previousStorageEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  let runId;
  beforeEach(() => {
    runId = `api-run-${++runCounter}`;
  });

  // One snapshot per name in a fresh run. specs: { name: 'DIFF' | 'MISSING_BASELINE' | 'MATCH' | 'STALE' }
  function seedRun(specs, id = runId) {
    createTestRun({ id, status: Object.values(specs).some((s) => s !== 'MATCH') ? 'FAILED' : 'PASSED' }, db);
    const slug = id.replace(/[^\w-]/g, '_'); // files stay flat even for ids like "feat/x"
    const runDir = path.join(storageRoot, 'runs', slug);
    fs.mkdirSync(runDir, { recursive: true });
    const snaps = {};
    for (const [name, kind] of Object.entries(specs)) {
      const file = `${slug}-${name}.png`;
      const currentPath = path.join(runDir, file);
      const baselinePath = path.join(baselinesDir, file);
      fs.writeFileSync(currentPath, `NEW:${name}`);
      let hash = 'none';
      if (kind !== 'MISSING_BASELINE') {
        const baseline = kind === 'MATCH' ? `NEW:${name}` : `OLD:${name}`;
        fs.writeFileSync(baselinePath, baseline);
        hash = kind === 'STALE' ? sha('SOMETHING_ELSE') : sha(baseline);
      }
      snaps[name] = createSnapshot({
        run_id: id,
        route: `/${name}`,
        viewport: 'desktop',
        baseline_path: baselinePath,
        current_path: currentPath,
        baseline_sha256: hash,
        mismatch_percentage: kind === 'DIFF' || kind === 'STALE' ? 2.5 : 0,
        status: kind === 'STALE' ? 'DIFF' : kind
      }, db);
    }
    return snaps;
  }

  const baseline = (snap) => (fs.existsSync(snap.baseline_path) ? fs.readFileSync(snap.baseline_path, 'utf8') : null);
  const approveAll = (id, init = WRITE) => fetch(`${baseUrl}/api/runs/${encodeURIComponent(id)}/approve-all`, init);

  describe('POST /api/runs/:id/approve-all', () => {
    it('approves every pending snapshot and returns the updated rows', async () => {
      const s = seedRun({ home: 'DIFF', about: 'DIFF', fresh: 'MISSING_BASELINE', same: 'MATCH' });

      const res = await approveAll(runId);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.approved).toEqual([s.home.id, s.about.id, s.fresh.id]);
      expect(data.runStatus).toBe('APPROVED');
      expect(data.snapshots.map((r) => [r.id, r.status])).toEqual([
        [s.home.id, 'APPROVED'], [s.about.id, 'APPROVED'], [s.fresh.id, 'APPROVED']
      ]);
      expect(baseline(s.home)).toBe('NEW:home');
      expect(baseline(s.about)).toBe('NEW:about');
      expect(baseline(s.fresh)).toBe('NEW:fresh');
      expect(getSnapshotById(s.same.id, db).status).toBe('MATCH');
      expect(getTestRunById(runId, db).status).toBe('APPROVED');
    });

    it('409 with the conflicting route/viewport pairs, and nothing changed', async () => {
      const s = seedRun({ home: 'DIFF', stale: 'STALE' });

      const res = await approveAll(runId);
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toMatch(/^Conflict: /);
      expect(data.conflicts).toEqual([{ id: s.stale.id, route: '/stale', viewport: 'desktop' }]);

      expect(baseline(s.home)).toBe('OLD:home');
      expect(baseline(s.stale)).toBe('OLD:stale');
      expect(getSnapshotById(s.home.id, db).status).toBe('DIFF');
      expect(getTestRunById(runId, db).status).toBe('FAILED');
    });

    it('200 with approved: [] when nothing is pending', async () => {
      const s = seedRun({ same: 'MATCH' });
      const res = await approveAll(runId);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, approved: [], runStatus: 'PASSED', snapshots: [] });
      expect(baseline(s.same)).toBe('NEW:same');
    });

    it('404 for an unknown run', async () => {
      const res = await approveAll('no-such-run');
      expect(res.status).toBe(404);
      expect((await res.json()).success).toBe(false);
    });

    it('works for run ids with slashes and other URL-special characters', async () => {
      const odd = `feat/x#${runCounter} a`;
      const s = seedRun({ home: 'DIFF' }, odd);
      const res = await approveAll(odd);
      expect(res.status).toBe(200);
      expect((await res.json()).approved).toEqual([s.home.id]);
    });

    it('403 when a snapshot points outside storage (access denied)', async () => {
      const s = seedRun({ home: 'DIFF' });
      const secret = path.join(tmp, 'secret.png');
      fs.writeFileSync(secret, 'SECRET');
      createSnapshot({
        run_id: runId, route: '/evil', viewport: 'desktop',
        baseline_path: path.join(baselinesDir, 'evil.png'), current_path: secret, status: 'DIFF'
      }, db);

      const res = await approveAll(runId);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/^Access denied/);
      expect(baseline(s.home)).toBe('OLD:home');
      expect(fs.existsSync(path.join(baselinesDir, 'evil.png'))).toBe(false);
    });

    describe('CSRF protection', () => {
      async function expectUntouched(s) {
        expect(baseline(s.home)).toBe('OLD:home');
        expect(getSnapshotById(s.home.id, db).status).toBe('DIFF');
      }

      it('403 without the X-Requested-With header', async () => {
        const s = seedRun({ home: 'DIFF' });
        const res = await approveAll(runId, { method: 'POST' });
        expect(res.status).toBe(403);
        expect((await res.json()).error).toMatch(/Cross-site request blocked/);
        await expectUntouched(s);
      });

      it('403 for a cross-origin request, even with the header', async () => {
        const s = seedRun({ home: 'DIFF' });
        for (const headers of [
          { 'X-Requested-With': 'x', Origin: 'https://evil.example' },
          { 'X-Requested-With': 'x', 'Sec-Fetch-Site': 'cross-site' }
        ]) {
          const res = await approveAll(runId, { method: 'POST', headers });
          expect(res.status, JSON.stringify(headers)).toBe(403);
        }
        await expectUntouched(s);
      });

      it('GET is not an approval', async () => {
        const s = seedRun({ home: 'DIFF' });
        const res = await fetch(`${baseUrl}/api/runs/${runId}/approve-all`);
        expect(res.status).toBe(404);
        await expectUntouched(s);
      });
    });
  });

  describe('run page button', () => {
    const BUTTON = 'class="btn btn-approve-all"';

    it('shows "Approve all pending (N)" counting DIFF and MISSING_BASELINE snapshots', async () => {
      seedRun({ a: 'DIFF', b: 'MISSING_BASELINE', c: 'MATCH', d: 'DIFF' });
      const html = await (await fetch(`${baseUrl}/runs/${runId}`)).text();
      expect(html.match(new RegExp(BUTTON, 'g'))).toHaveLength(1);
      expect(html).toContain('Approve all pending (3)');
      expect(html).toContain(`data-run-id="${runId}" data-count="3"`);
      expect(html).toContain('<span class="run-status-container" data-run-status="FAILED">');
      expect(html).toContain('data-status="MISSING_BASELINE"');
      // Separate from the per-snapshot buttons, which review-actions.js binds by class
      expect(html.match(/class="btn btn-approve"/g)).toHaveLength(3);
      expect(runDetailModel({ db, runId, storageRoot }).pendingCount).toBe(3);
    });

    it('is absent when nothing is pending, and after approving all', async () => {
      seedRun({ a: 'MATCH' });
      let html = await (await fetch(`${baseUrl}/runs/${runId}`)).text();
      expect(html).not.toContain(BUTTON);
      expect(html).not.toContain('Approve all pending');

      const pendingRun = `${runId}-b`;
      seedRun({ a: 'DIFF' }, pendingRun);
      expect(await (await fetch(`${baseUrl}/runs/${pendingRun}`)).text()).toContain(BUTTON);
      expect((await approveAll(pendingRun)).status).toBe(200);
      html = await (await fetch(`${baseUrl}/runs/${pendingRun}`)).text();
      expect(html).not.toContain(BUTTON);
      expect(html).toContain('data-run-status="APPROVED"');
    });

    it('renders in static mode (GitHub Pages demo) under a sub-path', async () => {
      seedRun({ a: 'DIFF', b: 'DIFF' });
      const html = await new Promise((resolve, reject) => {
        app.render('run-detail', { ...runDetailModel({ db, runId, storageRoot }), ...pageLocals({ base: '/demo', mode: 'static' }) },
          (err, out) => (err ? reject(err) : resolve(out)));
      });
      expect(html).toContain('data-mode="static"');
      expect(html).toContain('Approve all pending (2)');
      expect(html).toContain('<script type="module" src="/demo/js/review-actions.js"></script>');
    });
  });
});
