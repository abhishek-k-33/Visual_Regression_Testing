import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  EXIT, ERROR_CODES, RESULT_SCHEMA, RESULT_VERSION, CliError,
  buildResult, writeResult, classifyError, sanitizeMessage, toResultPath
} from '../src/cli/result.js';
import { loadConfig } from '../src/cli/config.js';
import { assertValidRunId } from '../src/cli/capture.js';
import { getToolVersion } from '../src/cli/manifest.js';

describe('EXIT', () => {
  it('is 0 pass, 1 visual differences, 2 errors', () => {
    expect(EXIT).toEqual({ PASS: 0, DIFF: 1, ERROR: 2 });
    expect(Object.isFrozen(EXIT)).toBe(true);
  });
});

describe('classifyError', () => {
  it('keeps the code a CliError carries', () => {
    for (const code of ERROR_CODES) expect(classifyError(new CliError(code, 'x'))).toBe(code);
  });

  it('recognises a missing Playwright browser', () => {
    const err = new Error("browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1/chrome\n╔══╗\n║ Looks like Playwright was just installed ║");
    expect(classifyError(err)).toBe('BROWSER_MISSING');
  });

  it('recognises Playwright missing system libraries', () => {
    expect(classifyError(new Error('browserType.launch: \n╔═╗\n║ Host system is missing dependencies to run browsers. ║'))).toBe('BROWSER_MISSING');
  });

  it('does not guess NAVIGATION_FAILED from a raw page.goto message (capture tags real ones)', () => {
    expect(classifyError(new Error('page.goto: Target page, context or browser has been closed'))).toBe('INTERNAL');
  });

  it('falls back to INTERNAL, also for Node error codes and non-errors', () => {
    expect(classifyError(new Error('boom'))).toBe('INTERNAL');
    expect(classifyError(Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBe('INTERNAL');
    expect(classifyError('a string')).toBe('INTERNAL');
    expect(classifyError(undefined)).toBe('INTERNAL');
  });

  it('config loading errors carry CONFIG_NOT_FOUND / CONFIG_INVALID', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-result-config-'));
    try {
      const missing = (() => { try { loadConfig(path.join(dir, 'none.json')); } catch (e) { return e; } })();
      expect(classifyError(missing)).toBe('CONFIG_NOT_FOUND');
      expect(missing.message).toContain('Configuration file not found at:');

      fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
      expect(classifyError((() => { try { loadConfig(path.join(dir, 'broken.json')); } catch (e) { return e; } })())).toBe('CONFIG_INVALID');

      fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ baseUrl: 'http://x.test', routes: [], viewports: [] }));
      const bad = (() => { try { loadConfig(path.join(dir, 'bad.json')); } catch (e) { return e; } })();
      expect(classifyError(bad)).toBe('CONFIG_INVALID');
      expect(bad.message).toContain('"routes" must be a non-empty array');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unsafe run id is INVALID_ARGUMENT', () => {
    expect(() => assertValidRunId('../escape')).toThrow(/Invalid runId/);
    expect(classifyError((() => { try { assertValidRunId('a/b'); } catch (e) { return e; } })())).toBe('INVALID_ARGUMENT');
    expect(() => assertValidRunId('run_ok-1')).not.toThrow();
  });
});

describe('sanitizeMessage', () => {
  it('escapes terminal control characters but keeps line breaks', () => {
    expect(sanitizeMessage('a\u001b[2Jb\nc‮d\n\n')).toBe('a\\u{1B}[2Jb\nc\\u{202E}d');
  });

  it('shortens very long messages', () => {
    const text = sanitizeMessage('x'.repeat(5000));
    expect(text.length).toBe(2000);
    expect(text.endsWith('...')).toBe(true);
  });
});

describe('toResultPath', () => {
  const cwd = path.resolve('/work/project');
  it('is relative to cwd with "/" separators', () => {
    expect(toResultPath(path.join(cwd, 'storage', 'runs', 'r1', 'a.png'), cwd)).toBe('storage/runs/r1/a.png');
    expect(toResultPath(cwd, cwd)).toBe('.');
    expect(toResultPath(null, cwd)).toBe(null);
  });

  it('is absolute for a path outside cwd (a relative ../ path would not survive a container)', () => {
    expect(toResultPath(path.resolve('/elsewhere/runs/x.png'), cwd)).toBe(path.resolve('/elsewhere/runs/x.png').split(path.sep).join('/'));
  });
});

describe('buildResult', () => {
  const cwd = path.resolve('/work/project');
  const runDir = path.join(cwd, 'storage', 'runs', 'r1');
  const baselines = path.join(cwd, 'storage', 'baselines');
  const snap = (status, extra = {}) => ({
    route: '/', viewport: `v-${status}`, status, mismatchPercentage: 0,
    currentPath: path.join(runDir, `index-v-${status}.png`),
    baselinePath: path.join(baselines, `index-v-${status}.png`),
    ...extra
  });
  const run = {
    id: 'r1', mode: 'compare', strict: true, baseUrl: 'http://127.0.0.1:4567',
    gitInfo: { branch: 'main', commit_sha: 'a'.repeat(40), commit_hash: 'aaaaaaa' },
    createdAt: new Date('2026-11-25T10:00:00.000Z'), durationMs: 1234, threshold: 0.07,
    runDir, manifestPath: path.join(runDir, 'run.json'), summaryPath: path.join(runDir, 'summary.md')
  };

  it('passes when every snapshot matches or got a new baseline', () => {
    const r = buildResult({ run, results: [snap('MATCH'), snap('NEW_BASELINE')], cwd });
    expect(r).toMatchObject({
      schema: RESULT_SCHEMA, version: RESULT_VERSION, tool: { name: 'visual-ci', version: getToolVersion() },
      command: 'test', status: 'passed', exit_code: 0, error: null,
      counts: { total: 2, passed: 1, changed: 0, missing_baseline: 0, new_baseline: 1 }
    });
    expect(RESULT_SCHEMA).toBe('visual-ci-result');
    expect(RESULT_VERSION).toBe(1);
  });

  it('fails (exit 1) on a DIFF or a MISSING_BASELINE', () => {
    const diff = buildResult({ run, results: [snap('MATCH'), snap('DIFF', { mismatchPercentage: 3.5, diffPath: path.join(runDir, 'index-v-DIFF-diff.png') })], cwd });
    expect(diff).toMatchObject({ status: 'failed', exit_code: 1, counts: { changed: 1, passed: 1 } });
    const missing = buildResult({ run, results: [snap('MISSING_BASELINE')], cwd });
    expect(missing).toMatchObject({ status: 'failed', exit_code: 1, counts: { missing_baseline: 1 } });
  });

  it('records the run and snapshots with cwd-relative POSIX paths', () => {
    const r = buildResult({ run, results: [snap('DIFF', { mismatchPercentage: 3.5, diffPath: path.join(runDir, 'index-v-DIFF-diff.png') })], cwd });
    expect(r.run).toEqual({
      id: 'r1', mode: 'compare', strict: true, base_url: 'http://127.0.0.1:4567', branch: 'main',
      commit_sha: 'a'.repeat(40), created_at: '2026-11-25T10:00:00.000Z', duration_ms: 1234,
      threshold_percentage: 7, run_dir: 'storage/runs/r1', manifest: 'storage/runs/r1/run.json',
      summary: 'storage/runs/r1/summary.md'
    });
    expect(r.snapshots).toEqual([{
      route: '/', viewport: 'v-DIFF', status: 'DIFF', mismatch_percentage: 3.5,
      current: 'storage/runs/r1/index-v-DIFF.png', baseline: 'storage/baselines/index-v-DIFF.png',
      diff: 'storage/runs/r1/index-v-DIFF-diff.png'
    }]);
  });

  it('uses filepath when a result has no currentPath (update-baselines results)', () => {
    const r = buildResult({ results: [{ route: '/', viewport: 'd', status: 'NEW_BASELINE', filepath: path.join(runDir, 'index-d.png') }], cwd });
    expect(r.snapshots[0]).toMatchObject({ current: 'storage/runs/r1/index-d.png', baseline: null, diff: null, mismatch_percentage: 0 });
  });

  it('the error message names no host paths: cwd is ".", home is "~"', () => {
    const err = Object.assign(new Error(`ENOENT: no such file or directory, open '${path.join(cwd, 'a.json')}' (see ${path.join(os.homedir(), '.cache', 'x')})`), {});
    const r = buildResult({ error: err, cwd });
    expect(r.error.message).toBe(`ENOENT: no such file or directory, open '.${path.sep}a.json' (see ~${path.sep}.cache${path.sep}x)`);
  });

  it('an error wins: status error, exit 2, a code and a sanitised message', () => {
    const r = buildResult({ error: new CliError('NAVIGATION_FAILED', 'Could not load \u001b]0;x\u0007'), results: [snap('MATCH')], cwd });
    expect(r).toMatchObject({ status: 'error', exit_code: 2, run: null });
    expect(r.error).toEqual({ code: 'NAVIGATION_FAILED', message: 'Could not load \\u{1B}]0;x\\u{7}' });
  });
});

describe('writeResult', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-result-write-')); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const result = buildResult({ results: [] });

  it('writes via a temp file and a rename, creating parent folders', async () => {
    const target = path.join(dir, 'nested', 'result.json');
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, 'old');
    const realRename = fs.renameSync;
    const seen = [];
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      // At rename time the target is untouched and the temp file next to it is complete.
      seen.push({ from, to, targetBefore: fs.readFileSync(to, 'utf8'), temp: JSON.parse(fs.readFileSync(from, 'utf8')) });
      return realRename(from, to);
    });

    expect(await writeResult(result, target)).toBe(target);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ to: target, targetBefore: 'old', temp: result });
    expect(path.dirname(seen[0].from)).toBe(path.dirname(target));
    expect(seen[0].from).not.toBe(target);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(result);
    expect(fs.readdirSync(path.dirname(target))).toEqual(['result.json']);

    vi.restoreAllMocks();
    const relative = path.relative(process.cwd(), path.join(dir, 'a', 'b', 'r.json'));
    const fresh = await writeResult(result, relative);
    expect(fresh).toBe(path.join(dir, 'a', 'b', 'r.json'));
    expect(JSON.parse(fs.readFileSync(fresh, 'utf8'))).toEqual(result);
  });

  it('leaves the previous file intact and no temp file behind when the rename fails', async () => {
    const target = path.join(dir, 'result.json');
    fs.writeFileSync(target, 'previous');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk on fire'); });
    await expect(writeResult(result, target)).rejects.toThrow('disk on fire');
    expect(fs.readFileSync(target, 'utf8')).toBe('previous');
    expect(fs.readdirSync(dir)).toEqual(['result.json']);
  });

  it('"-" writes the JSON to stdout (the given stream)', async () => {
    let out = '';
    const stream = new Writable({ write(chunk, _enc, cb) { out += chunk; cb(); } });
    expect(await writeResult(result, '-', { stdout: stream })).toBe('-');
    expect(JSON.parse(out)).toEqual(result);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
