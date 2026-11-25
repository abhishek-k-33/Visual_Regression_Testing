import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getToolVersion } from './manifest.js';
// TODO(A3): import from src/shared/text.js once sanitizeForDisplay moves there.
import { sanitizeForDisplay } from '../server/importRuns.js';
import { redactUrl, redactUrlsInText, redactLocalPaths, toDisplayPath } from './display.js';

export { CliError } from './errors.js';
export { redactUrl } from './display.js';

/**
 * The machine-readable result of a CLI command (`visual-ci test --json <file>`).
 *
 * Schema "visual-ci-result", version 1. Changes must stay additive: new fields may be
 * added, existing fields keep their name, type and meaning. Paths are relative to the
 * working directory and use "/", so they mean the same thing inside a container whose
 * workspace lives elsewhere (a path outside the working directory, e.g. a
 * VISUAL_STORAGE_DIR elsewhere, is given absolute). Percentages: 1 = 1%.
 *
 * {
 *   schema: 'visual-ci-result', version: 1, tool: { name: 'visual-ci', version },
 *   command: 'test', status: 'passed' | 'failed' | 'error', exit_code: 0 | 1 | 2,
 *   error: null | { code, message },
 *   run: null | { id, mode: 'compare' | 'update-baselines', strict, base_url, branch,
 *                 commit_sha, created_at, duration_ms, threshold_percentage,
 *                 run_dir, manifest, summary },
 *   counts: { total, passed, changed, missing_baseline, new_baseline },
 *   snapshots: [{ route, viewport, status: 'MATCH' | 'DIFF' | 'NEW_BASELINE' |
 *                 'MISSING_BASELINE', mismatch_percentage, current, baseline,
 *                 baseline_snapshot, diff }]
 * }
 *
 * baseline is the shared baseline file (baselines/<name>.png, which later approvals
 * change); baseline_snapshot is the run's own copy of the baseline it was compared
 * against, inside the run folder (so it travels with the CI artifact), or null.
 */

export const RESULT_SCHEMA = 'visual-ci-result';
export const RESULT_VERSION = 1;

/** Process exit codes: 0 all good, 1 visual differences (or missing baselines in strict mode), 2 anything else went wrong. */
export const EXIT = Object.freeze({ PASS: 0, DIFF: 1, ERROR: 2 });

export const ERROR_CODES = Object.freeze([
  'CONFIG_NOT_FOUND',
  'CONFIG_INVALID',
  'NAVIGATION_FAILED',
  'BROWSER_MISSING',
  'INVALID_ARGUMENT',
  'INTERNAL'
]);

/** `--json -` writes the result to stdout. */
export const STDOUT_TARGET = '-';

const MAX_MESSAGE_LENGTH = 2000;

/**
 * Makes an error message safe for a terminal or the JSON: URLs lose credentials and
 * token-like query values (redactUrl), each line goes through sanitizeForDisplay
 * (control, bidi and other invisible characters become visible escapes), line breaks
 * are kept, and very long messages are shortened.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizeMessage(text) {
  const lines = redactUrlsInText(text).split(/\r?\n/).map((line) => sanitizeForDisplay(line).trimEnd());
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const joined = lines.join('\n');
  return joined.length > MAX_MESSAGE_LENGTH ? `${joined.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : joined;
}

/**
 * Something thrown, as an error buildResult can report: Errors (and error-like objects)
 * as they are, anything else (undefined, null, a string...) wrapped in an Error.
 *
 * @param {unknown} err
 * @returns {Error}
 */
export function toError(err) {
  if (err instanceof Error || (err && typeof err === 'object' && 'message' in err)) return err;
  return new Error(String(err));
}

/**
 * Maps an error to one of ERROR_CODES. Errors thrown by this tool carry their code
 * (CliError); a few third-party failures are recognised by their message.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function classifyError(err) {
  if (err && typeof err.code === 'string' && ERROR_CODES.includes(err.code)) return err.code;
  const message = String(err?.message ?? err ?? '');
  // Playwright launch failures that reach here without going through capture's toLaunchError
  if (message.includes("Executable doesn't exist") || message.includes('Host system is missing dependencies')) return 'BROWSER_MISSING';
  return 'INTERNAL';
}

/** A path as the result records it (see toDisplayPath in display.js). */
export const toResultPath = toDisplayPath;

const round6 = (value) => Math.round(value * 1e6) / 1e6; // no float noise like 3.4200000000000004
const percentage = (ratio) => round6(ratio * 100); // 0.07 * 100 is 7.000000000000001

/**
 * Builds the visual-ci-result object.
 *
 * @param {object} options
 * @param {string} [options.command='test']
 * @param {unknown} [options.error] - Set when the command failed with an error (status 'error', exit 2)
 * @param {object|null} [options.run] - What is known about the run (null if it never started):
 *   { id, mode, strict, baseUrl, gitInfo: { branch, commit_sha }, createdAt: Date,
 *     durationMs, threshold (ratio, 0.01 = 1%), runDir, manifestPath, summaryPath }
 * @param {object[]} [options.results] - Comparison results as produced by the CLI
 * @param {string} [options.cwd=process.cwd()] - Paths are recorded relative to this
 * @returns {object}
 */
export function buildResult({ command = 'test', error = null, run = null, results = [], cwd = process.cwd() } = {}) {
  const snapshots = results.map((r) => ({
    route: r.route,
    viewport: r.viewport,
    status: r.status,
    mismatch_percentage: round6(r.mismatchPercentage || 0),
    current: toResultPath(r.currentPath || r.filepath, cwd),
    baseline: toResultPath(r.baselinePath, cwd),
    baseline_snapshot: toResultPath(r.baselineSnapshotPath, cwd),
    diff: toResultPath(r.diffPath, cwd)
  }));

  const countOf = (status) => snapshots.filter((s) => s.status === status).length;
  const counts = {
    total: snapshots.length,
    passed: countOf('MATCH'),
    changed: countOf('DIFF'),
    missing_baseline: countOf('MISSING_BASELINE'),
    new_baseline: countOf('NEW_BASELINE')
  };

  let status;
  let exitCode;
  if (error) {
    status = 'error';
    exitCode = EXIT.ERROR;
  } else if (counts.changed + counts.missing_baseline > 0) {
    status = 'failed';
    exitCode = EXIT.DIFF;
  } else {
    status = 'passed';
    exitCode = EXIT.PASS;
  }

  return {
    schema: RESULT_SCHEMA,
    version: RESULT_VERSION,
    tool: { name: 'visual-ci', version: getToolVersion() },
    command,
    status,
    exit_code: exitCode,
    // No host paths in the published message: cwd becomes ".", the home directory "~".
    error: error ? { code: classifyError(error), message: redactLocalPaths(sanitizeMessage(error.message ?? error), { cwd }) } : null,
    run: run ? {
      id: run.id,
      mode: run.mode,
      strict: run.strict,
      base_url: run.baseUrl ? redactUrl(run.baseUrl) : null, // credentials and tokens never go in the JSON
      branch: run.gitInfo?.branch || null,
      commit_sha: run.gitInfo?.commit_sha || null,
      created_at: run.createdAt ? run.createdAt.toISOString() : null,
      duration_ms: run.durationMs ?? null,
      threshold_percentage: typeof run.threshold === 'number' ? percentage(run.threshold) : null,
      run_dir: toResultPath(run.runDir, cwd),
      manifest: toResultPath(run.manifestPath, cwd),
      summary: toResultPath(run.summaryPath, cwd)
    } : null,
    counts,
    snapshots
  };
}

/** Writes all of `data` to a file descriptor, waiting out EAGAIN on a non-blocking pipe. */
function writeAllSync(fd, data) {
  const buffer = Buffer.from(data, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (err) {
      if (err.code !== 'EAGAIN') throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // brief pause, then retry
    }
  }
}

/**
 * Writes the result as JSON, synchronously (so it also works right before
 * process.exit, e.g. on a crash). A file is written via a temp file + rename (like
 * run.json), so a reader never sees a half-written result; "-" writes to stdout.
 *
 * @param {object} result
 * @param {string} target - File path (relative to cwd) or "-"
 * @param {{ fd?: number, cwd?: string }} [options] - fd: where "-" writes (default 1, stdout)
 * @returns {string} The absolute path written, or "-"
 */
export function writeResult(result, target, { fd = 1, cwd = process.cwd() } = {}) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (target === STDOUT_TARGET) {
    writeAllSync(fd, json);
    return STDOUT_TARGET;
  }

  const file = path.resolve(cwd, target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Random suffix: in a container the pid is often 1 for every run.
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temp, json, 'utf8');
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  return file;
}
