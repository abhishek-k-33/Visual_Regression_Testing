import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  initDb,
  closeDb,
  createTestRun,
  createSnapshot,
  getSnapshotById,
  getTestRunById,
  planApproval,
  approveSnapshot,
  approveSnapshots,
  approveAllPending
} from '../src/server/db.js';

// Batch approval ("Approve all pending") is all or nothing: every snapshot is planned
// and checked before any file is written, and a failure part-way through restores
// every baseline it already replaced.

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

function thrown(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}

describe('Approve all pending (approveSnapshots / approveAllPending)', () => {
  const tmp = path.resolve(process.cwd(), 'tests/.tmp_approve_all');
  const storageRoot = path.join(tmp, 'storage');
  const baselinesDir = path.join(storageRoot, 'baselines');
  const opts = { storageRoot };
  let db;

  beforeEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(baselinesDir, { recursive: true });
    db = initDb(path.join(tmp, 'test.sqlite'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Records a snapshot the way the CLI does: current screenshot in runs/<run>/, the
   * shared baseline in baselines/ and the hash of the baseline that was compared.
   * baseline: string contents, or null for MISSING_BASELINE.
   */
  function seed(runId, name, { baseline, current, status, hash } = {}) {
    if (!getTestRunById(runId, db)) createTestRun({ id: runId, status: 'FAILED' }, db);
    const runDir = path.join(storageRoot, 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    const currentPath = path.join(runDir, `${name}.png`);
    const baselinePath = path.join(baselinesDir, `${name}.png`);
    fs.writeFileSync(currentPath, current ?? `${runId}:${name}:NEW`);
    if (baseline != null) fs.writeFileSync(baselinePath, baseline);
    return createSnapshot({
      run_id: runId,
      route: `/${name}`,
      viewport: 'desktop',
      baseline_path: baselinePath,
      current_path: currentPath,
      baseline_sha256: hash ?? (baseline == null ? 'none' : sha(baseline)),
      status: status ?? (baseline == null ? 'MISSING_BASELINE' : 'DIFF'),
      mismatch_percentage: baseline == null ? 0 : 3.2
    }, db);
  }

  const read = (name) => fs.readFileSync(path.join(baselinesDir, `${name}.png`), 'utf8');
  const exists = (name) => fs.existsSync(path.join(baselinesDir, `${name}.png`));
  // Anything besides the baselines themselves: hidden temp copies or backups
  const leftovers = () => fs.readdirSync(baselinesDir).filter((f) => f.startsWith('.') || /\.(tmp|bak)$|\.tmp-/.test(f));

  it('approves every pending snapshot: files, statuses and run status', () => {
    const a = seed('run-1', 'home', { baseline: 'OLD_HOME' });
    const b = seed('run-1', 'about', { baseline: 'OLD_ABOUT' });
    const match = seed('run-1', 'contact', { baseline: 'SAME', current: 'SAME', status: 'MATCH' });

    const result = approveAllPending('run-1', db, opts);

    expect(result.approved).toEqual([a.id, b.id]);
    expect(result.runStatus).toBe('APPROVED');
    expect(result.snapshots.map((s) => s.status)).toEqual(['APPROVED', 'APPROVED']);
    expect(read('home')).toBe('run-1:home:NEW');
    expect(read('about')).toBe('run-1:about:NEW');
    expect(getSnapshotById(match.id, db).status).toBe('MATCH');
    expect(getTestRunById('run-1', db).status).toBe('APPROVED');
    expect(leftovers()).toEqual([]);
  });

  it('a MISSING_BASELINE snapshot in the batch creates its baseline', () => {
    seed('run-1', 'home', { baseline: 'OLD_HOME' });
    const missing = seed('run-1', 'brand-new', { baseline: null });
    expect(exists('brand-new')).toBe(false);

    const result = approveAllPending('run-1', db, opts);

    expect(result.approved).toContain(missing.id);
    expect(read('brand-new')).toBe('run-1:brand-new:NEW');
    expect(getSnapshotById(missing.id, db).status).toBe('APPROVED');
  });

  it('keeps a REJECTED snapshot rejected, so the run stays REJECTED', () => {
    seed('run-1', 'home', { baseline: 'OLD_HOME' });
    seed('run-1', 'about', { baseline: 'OLD_ABOUT', status: 'REJECTED' });

    const result = approveAllPending('run-1', db, opts);
    expect(result.approved).toHaveLength(1);
    expect(result.runStatus).toBe('REJECTED');
    expect(read('about')).toBe('OLD_ABOUT');
  });

  it('a conflict on one snapshot changes nothing and lists every conflict', () => {
    const ok = seed('run-1', 'home', { baseline: 'OLD_HOME' });
    const stale = seed('run-1', 'about', { baseline: 'NEWER_APPROVED', hash: sha('BASELINE_AT_RUN_TIME') });
    const staleMissing = seed('run-1', 'fresh', { baseline: null });
    fs.writeFileSync(path.join(baselinesDir, 'fresh.png'), 'APPEARED_LATER');

    const error = thrown(() => approveAllPending('run-1', db, opts));

    expect(error.message).toMatch(/^Conflict: the baseline has changed since this run for 2 of 3 snapshot\(s\)/);
    expect(error.status).toBe(409);
    expect(error.conflicts).toEqual([
      { id: stale.id, route: '/about', viewport: 'desktop' },
      { id: staleMissing.id, route: '/fresh', viewport: 'desktop' }
    ]);
    // Zero files or rows changed
    expect(read('home')).toBe('OLD_HOME');
    expect(read('about')).toBe('NEWER_APPROVED');
    expect(read('fresh')).toBe('APPEARED_LATER');
    for (const s of [ok, stale, staleMissing]) expect(getSnapshotById(s.id, db).status, s.route).not.toBe('APPROVED');
    expect(getTestRunById('run-1', db).status).toBe('FAILED');
  });

  it('a single stale approval keeps its original message, now with conflicts attached', () => {
    const stale = seed('run-1', 'about', { baseline: 'NEWER', hash: sha('OLDER') });
    const error = thrown(() => approveSnapshot(stale.id, db, opts));
    expect(error.message).toBe(
      'Conflict: the baseline has changed since this run (a newer run was probably approved). ' +
      'Re-run the visual tests and review the new result instead.'
    );
    expect(error.conflicts).toEqual([{ id: stale.id, route: '/about', viewport: 'desktop' }]);
  });

  it('refuses two snapshots that would write the same baseline file', () => {
    const a = seed('run-1', 'home', { baseline: 'OLD_HOME' });
    const b = createSnapshot({
      run_id: 'run-1', route: '/home-again', viewport: 'desktop',
      baseline_path: a.baseline_path,
      current_path: path.join(storageRoot, 'runs', 'run-1', 'home.png'),
      baseline_sha256: sha('OLD_HOME'),
      status: 'DIFF'
    }, db);

    expect(() => approveSnapshots([a.id, b.id], db, opts)).toThrow(/^Conflict: .* would both write the baseline home\.png/);
    const err = thrown(() => approveAllPending('run-1', db, opts));
    expect(err.status).toBe(409);
    expect(err.conflicts.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(read('home')).toBe('OLD_HOME');
    expect(getSnapshotById(a.id, db).status).toBe('DIFF');
  });

  it('also refuses a duplicate target reached through a symlink inside baselines/', () => {
    const a = seed('run-1', 'home', { baseline: 'OLD_HOME' });
    const link = path.join(baselinesDir, 'alias.png');
    fs.symlinkSync(path.join(baselinesDir, 'home.png'), link);
    const b = seed('run-1', 'other', { baseline: 'X' });
    db.prepare('UPDATE snapshots SET baseline_path = ?, baseline_sha256 = ? WHERE id = ?').run(link, sha('OLD_HOME'), b.id);

    expect(() => approveAllPending('run-1', db, opts)).toThrow(/would both write the baseline home\.png/);
    expect(read('home')).toBe('OLD_HOME');
  });

  it('approving the same id twice in one call approves it once', () => {
    const a = seed('run-1', 'home', { baseline: 'OLD_HOME' });
    const result = approveSnapshots([a.id, String(a.id)], db, opts);
    expect(result.approved).toEqual([a.id]);
    expect(read('home')).toBe('run-1:home:NEW');
  });

  it('a failure mid-copy restores every baseline and leaves no temp files', () => {
    const a = seed('run-1', 'home', { baseline: 'OLD_HOME' });
    const b = seed('run-1', 'about', { baseline: 'OLD_ABOUT' });
    const c = seed('run-1', 'brand-new', { baseline: null });

    const realRename = fs.renameSync;
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      calls++;
      if (calls === 2) throw new Error('EIO: simulated disk failure');
      return realRename(from, to);
    });

    expect(() => approveAllPending('run-1', db, opts)).toThrow('EIO: simulated disk failure');

    expect(read('home')).toBe('OLD_HOME'); // replaced by the 1st rename, then restored
    expect(read('about')).toBe('OLD_ABOUT');
    expect(exists('brand-new')).toBe(false);
    expect(leftovers()).toEqual([]);
    for (const s of [a, b, c]) expect(getSnapshotById(s.id, db).status).not.toBe('APPROVED');
    expect(getTestRunById('run-1', db).status).toBe('FAILED');
  });

  it('a successful batch leaves no temp or backup files behind', () => {
    seed('run-1', 'home', { baseline: 'OLD_HOME' });
    seed('run-1', 'brand-new', { baseline: null });
    approveAllPending('run-1', db, opts);
    expect(read('home')).toBe('run-1:home:NEW');
    expect(read('brand-new')).toBe('run-1:brand-new:NEW');
    expect(leftovers()).toEqual([]);
  });

  it('a failing copy of the 2nd screenshot restores the 1st baseline', () => {
    seed('run-1', 'a-first', { baseline: 'OLD_A' });
    seed('run-1', 'b-second', { baseline: 'OLD_B' });
    const realCopy = fs.copyFileSync;
    vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      if (String(from).endsWith('b-second.png') && String(to).endsWith('.tmp')) throw new Error('ENOSPC: simulated');
      return realCopy(from, to, mode);
    });
    expect(() => approveAllPending('run-1', db, opts)).toThrow('ENOSPC: simulated');
    expect(read('a-first')).toBe('OLD_A');
    expect(read('b-second')).toBe('OLD_B');
    expect(leftovers()).toEqual([]);
  });

  it('still restores the baselines when removing the temp file also fails', () => {
    seed('run-1', 'a-first', { baseline: 'OLD_A' });
    seed('run-1', 'b-second', { baseline: 'OLD_B' });
    const realRename = fs.renameSync;
    const realRm = fs.rmSync;
    let renames = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (++renames === 2) throw new Error('EIO: simulated');
      return realRename(from, to);
    });
    vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => {
      if (String(p).endsWith('.tmp')) throw new Error('EBUSY: simulated');
      return realRm(p, o);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => approveAllPending('run-1', db, opts)).toThrow('EIO: simulated');
    expect(read('a-first')).toBe('OLD_A');
    expect(read('b-second')).toBe('OLD_B');
  });

  it('reports a baseline it could not restore and keeps its backup', () => {
    seed('run-1', 'a-first', { baseline: 'OLD_A' });
    seed('run-1', 'b-second', { baseline: 'OLD_B' });
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith('.tmp') && String(to).endsWith('b-second.png')) throw new Error('EIO: simulated');
      if (String(from).endsWith('.bak')) throw new Error('EIO: restore failed too');
      return realRename(from, to);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = thrown(() => approveAllPending('run-1', db, opts));
    expect(err.message).toMatch(/EIO: simulated.*could not be restored: .*a-first\.png \(backup kept at .*\.bak\)/);
    const backups = fs.readdirSync(baselinesDir).filter((f) => f.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(baselinesDir, backups[0]), 'utf8')).toBe('OLD_A');
  });

  it('refuses (409) when a baseline changes between planning and writing, changing nothing', () => {
    const a = seed('run-1', 'a-first', { baseline: 'OLD_A' });
    const b = seed('run-1', 'b-second', { baseline: 'OLD_B' });
    // Another process (e.g. the CLI with --update-baselines) rewrites b's baseline just
    // after it was planned, before the batch reaches it.
    const realCopy = fs.copyFileSync;
    let swapped = false;
    vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      const out = realCopy(from, to, mode);
      if (!swapped && String(to).endsWith('.tmp')) {
        swapped = true;
        fs.writeFileSync(path.join(baselinesDir, 'b-second.png'), 'NEWER_FROM_ELSEWHERE');
      }
      return out;
    });
    const err = thrown(() => approveAllPending('run-1', db, opts));
    expect(err.status).toBe(409);
    expect(err.conflicts).toEqual([{ id: b.id, route: '/b-second', viewport: 'desktop' }]);
    expect(read('a-first')).toBe('OLD_A'); // first file was rolled back
    expect(read('b-second')).toBe('NEWER_FROM_ELSEWHERE'); // the newer baseline survives
    expect(leftovers()).toEqual([]);
    for (const s of [a, b]) expect(getSnapshotById(s.id, db).status).toBe('DIFF');
  });

  it('a failure after a new baseline was created removes it again', () => {
    seed('run-1', 'brand-new', { baseline: null });
    seed('run-1', 'zz-last', { baseline: 'OLD_LAST' });

    const realRename = fs.renameSync;
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (++calls === 2) throw new Error('EACCES: simulated');
      return realRename(from, to);
    });

    expect(() => approveAllPending('run-1', db, opts)).toThrow('EACCES: simulated');
    expect(exists('brand-new')).toBe(false);
    expect(read('zz-last')).toBe('OLD_LAST');
    expect(leftovers()).toEqual([]);
  });

  it('a database failure after the copies restores the baselines and rolls back every row', () => {
    const a = seed('run-1', 'home', { baseline: 'OLD_HOME' });
    const b = seed('run-1', 'brand-new', { baseline: null });
    db.exec(`
      CREATE TRIGGER fail_second_approval BEFORE UPDATE OF status ON snapshots
      WHEN NEW.id = ${b.id} BEGIN SELECT RAISE(ABORT, 'simulated database failure'); END;
    `);

    expect(() => approveAllPending('run-1', db, opts)).toThrow('simulated database failure');

    expect(read('home')).toBe('OLD_HOME');
    expect(exists('brand-new')).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(getSnapshotById(a.id, db).status).toBe('DIFF'); // first UPDATE rolled back too
    expect(getTestRunById('run-1', db).status).toBe('FAILED');
  });

  it('an access-denied snapshot stops the batch before anything is written', () => {
    const a = seed('run-1', 'home', { baseline: 'OLD_HOME' });
    const secret = path.join(tmp, 'secret.png');
    fs.writeFileSync(secret, 'SECRET');
    createSnapshot({
      run_id: 'run-1', route: '/evil', viewport: 'desktop',
      baseline_path: path.join(baselinesDir, 'evil.png'), current_path: secret, status: 'DIFF'
    }, db);

    expect(() => approveAllPending('run-1', db, opts)).toThrow(/^Access denied/);
    expect(read('home')).toBe('OLD_HOME');
    expect(exists('evil')).toBe(false);
    expect(getSnapshotById(a.id, db).status).toBe('DIFF');
  });

  it('with nothing pending returns approved: [] without touching files or the run', () => {
    seed('run-1', 'home', { baseline: 'SAME', current: 'SAME', status: 'MATCH' });
    db.prepare("UPDATE test_runs SET status = 'PASSED' WHERE id = 'run-1'").run();
    const before = fs.statSync(path.join(baselinesDir, 'home.png')).mtimeMs;

    const result = approveAllPending('run-1', db, opts);

    expect(result).toEqual({ approved: [], runStatus: 'PASSED', snapshots: [] });
    expect(fs.statSync(path.join(baselinesDir, 'home.png')).mtimeMs).toBe(before);
  });

  it('throws "not found" for an unknown run or snapshot', () => {
    expect(() => approveAllPending('no-such-run', db, opts)).toThrow(/not found/);
    expect(() => approveSnapshots([424242], db, opts)).toThrow('Snapshot with id 424242 not found.');
  });

  it('only touches the requested run', () => {
    seed('run-1', 'home', { baseline: 'OLD_HOME' });
    const other = seed('run-2', 'about', { baseline: 'OLD_ABOUT' });
    approveAllPending('run-1', db, opts);
    expect(read('about')).toBe('OLD_ABOUT');
    expect(getSnapshotById(other.id, db).status).toBe('DIFF');
    expect(getTestRunById('run-2', db).status).toBe('FAILED');
  });

  it('planApproval resolves source and target without changing anything', () => {
    const a = seed('run-1', 'home', { baseline: 'OLD_HOME' });
    const plan = planApproval(a, storageRoot);
    expect(plan.source).toBe(fs.realpathSync(a.current_path));
    expect(plan.target).toBe(fs.realpathSync(a.baseline_path));
    expect(read('home')).toBe('OLD_HOME');

    // No files recorded: status-only approval
    expect(planApproval({ ...a, baseline_path: null }, storageRoot)).toMatchObject({ source: null, target: null });
  });
});
