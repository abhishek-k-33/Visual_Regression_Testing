import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { getSnapshotFilename } from '../cli/naming.js';
import { MANIFEST_FILENAME, MANIFEST_SCHEMA, MANIFEST_VERSION, toSqliteTimestamp } from '../cli/manifest.js';
import { createSnapshot, createTestRun, getTestRunById, recalculateRunStatus } from './db.js';
import { isInside } from './paths.js';

/**
 * Imports test runs recorded elsewhere (typically the `visual-regression-diffs` artifact
 * a failed CI job uploads: a zip of storage/runs/) into a local storage root, so they
 * show up in the dashboard and can be reviewed there.
 *
 * Used by `visual-ci import` and meant to back a dashboard upload as well, so it takes
 * everything it needs as arguments and reports failures as ImportError with an HTTP-ish
 * `status`:
 *   400 unreadable or unsafe input (not a zip, path traversal, duplicate entries, bad option)
 *   409 the requested run id is taken
 *   413 an input limit was exceeded (see IMPORT_LIMITS)
 *   422 the input is readable but holds no valid run (no run.json, invalid manifest,
 *       missing/forged images, hashes that don't match)
 * Anything else (disk full, database error) is rethrown unchanged.
 *
 * Trust model: the archive is untrusted. Only run.json and *.png files are extracted,
 * into a private staging folder, never following symlinks; sizes are counted while
 * streaming, not taken from headers. File names are re-derived from each snapshot's
 * route and viewport (never taken from the manifest), every referenced image must be a
 * PNG of bounded size whose SHA-256 matches the manifest, and nothing is ever written
 * to baselines/. The CI-recorded baseline hash is kept verbatim, so approving an
 * imported snapshot only works while the local baseline is exactly the one CI compared
 * against (see approveSnapshots in db.js).
 *
 * All or nothing per call: if any run in the input is invalid, nothing is imported.
 */

export const IMPORT_LIMITS = Object.freeze({
  maxEntries: 2000, // archive entries / directory entries visited
  maxFileBytes: 50 * 1024 * 1024, // per extracted image
  maxTotalBytes: 500 * 1024 * 1024, // all extracted files together
  maxManifestBytes: 1024 * 1024, // per run.json
  maxSnapshots: 1000, // per run
  maxImageWidth: 16384,
  maxImageHeight: 65536
});

/** Same rule as capture.js plus a length cap (it becomes a folder name and a URL). */
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const VIEWPORT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9A-Fa-f]{1,64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_MANIFEST_DEPTH = 3; // run.json, <id>/run.json, runs/<id>/run.json
const MAX_FILE_DEPTH = MAX_MANIFEST_DEPTH + 1; // + baselines/<file>.png
const MAX_ENTRY_NAME = 1024;
const MAX_ID_SUFFIX = 1000;
const RUN_STATUSES = ['PASSED', 'FAILED'];
const SNAPSHOT_STATUSES = ['MATCH', 'DIFF', 'NEW_BASELINE', 'MISSING_BASELINE'];
const MODES = ['compare', 'update-baselines'];

export class ImportError extends Error {
  /**
   * @param {number} status - 400, 409, 413 or 422 (see the module comment)
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = 'ImportError';
    this.status = status;
  }
}

const badInput = (message) => new ImportError(400, message);
const tooLarge = (message) => new ImportError(413, message);
const invalid = (message) => new ImportError(422, message);

/** Untrusted value for an error message: quoted, escaped and shortened. */
function show(value) {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

const mb = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function pathExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// ─── Staging: extract / copy only what an import can use ─────────────────────

/** 'manifest' for run.json, 'png' for images, null for anything the import ignores. */
function classify(parts) {
  const name = parts[parts.length - 1];
  if (name === MANIFEST_FILENAME && parts.length <= MAX_MANIFEST_DEPTH) return 'manifest';
  if (name.endsWith('.png') && parts.length <= MAX_FILE_DEPTH) return 'png';
  return null;
}

/**
 * Splits an archive entry name into path segments, refusing anything that could escape
 * or confuse the staging folder (yauzl already rejects absolute paths, ".." and
 * backslashes; this adds empty and "." segments and control characters).
 */
function entrySegments(name) {
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  const parts = trimmed.split('/');
  if (
    trimmed.length === 0 || trimmed.length > MAX_ENTRY_NAME || CONTROL_CHARS.test(trimmed) ||
    parts.some((p) => p === '' || p === '.' || p === '..' || p.length > 255)
  ) {
    throw badInput(`Unsafe file name in the archive: ${show(name)}. Nothing was imported.`);
  }
  return parts;
}

/**
 * Streams `source` into a new file at staging/<parts>, counting the bytes that actually
 * arrive (the per-file and the overall limit), and records it in `state`.
 */
async function stageFile(source, parts, kind, state) {
  const dest = path.join(state.filesDir, ...parts);
  if (!isInside(dest, state.filesDir)) throw badInput(`Unsafe file name: ${show(parts.join('/'))}.`);
  const maxBytes = kind === 'manifest' ? state.limits.maxManifestBytes : state.limits.maxFileBytes;
  const label = parts.join('/');
  let written = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length;
      state.totalBytes += chunk.length;
      if (written > maxBytes) {
        return callback(tooLarge(`${show(label)} is larger than the ${mb(maxBytes)} limit for ${kind === 'manifest' ? 'run.json' : 'an image'}.`));
      }
      if (state.totalBytes > state.limits.maxTotalBytes) {
        return callback(tooLarge(`The import is larger than the ${mb(state.limits.maxTotalBytes)} limit.`));
      }
      return callback(null, chunk);
    }
  });

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // 'wx': a second entry with the same name must not silently replace the first.
    await pipeline(source, counter, fs.createWriteStream(dest, { flags: 'wx' }));
  } catch (err) {
    if (['EEXIST', 'ENOTDIR', 'EISDIR'].includes(err.code)) {
      throw badInput(`The input contains ${show(label)} more than once (or as both a file and a folder). Nothing was imported.`);
    }
    throw err;
  }
  if (kind === 'manifest') state.manifests.push(parts);
}

function countEntry(state) {
  state.entries += 1;
  if (state.entries > state.limits.maxEntries) {
    throw tooLarge(`The input has more than ${state.limits.maxEntries} files and folders.`);
  }
}

/** ENOSPC, EACCES, ... (not yauzl's format errors, not Node's ERR_* stream errors). */
const isSystemError = (err) => typeof err.code === 'string' && /^E[A-Z]+$/.test(err.code);

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

async function stageZip(file, state) {
  let zip;
  try {
    // strictFileNames: a backslash is an error instead of being turned into "/".
    zip = await yauzl.openPromise(file, { strictFileNames: true, validateEntrySizes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EISDIR') {
      throw badInput(`Cannot read ${show(file)}: ${err.code}.`);
    }
    throw badInput(`Not a valid zip archive: ${err.message}`);
  }

  try {
    if (zip.entryCount > state.limits.maxEntries) {
      throw tooLarge(`The archive has ${zip.entryCount} entries; the limit is ${state.limits.maxEntries}.`);
    }
    for await (const entry of zip.eachEntry()) {
      countEntry(state);
      const parts = entrySegments(entry.fileName);
      if (entry.fileName.endsWith('/')) continue; // folders are created as needed

      // Unix file type in the high 16 bits: skip symlinks, devices etc. (0 = not recorded).
      const type = (entry.externalFileAttributes >>> 16) & S_IFMT;
      if (type !== 0 && type !== S_IFREG) continue;

      const kind = classify(parts);
      if (!kind) continue;
      if (entry.isEncrypted()) throw badInput(`${show(entry.fileName)} is encrypted; encrypted archives are not supported.`);

      // Quick refusal from the header; the real limit is enforced while streaming.
      const max = kind === 'manifest' ? state.limits.maxManifestBytes : state.limits.maxFileBytes;
      if (entry.uncompressedSize > max) {
        throw tooLarge(`${show(entry.fileName)} is larger than the ${mb(max)} limit.`);
      }
      const stream = await zip.openReadStreamPromise(entry);
      try {
        await stageFile(stream, parts, kind, state);
      } finally {
        stream.destroy();
      }
    }
  } catch (err) {
    if (err instanceof ImportError || isSystemError(err)) throw err; // ours, or e.g. a full disk
    throw badInput(`Invalid zip archive: ${err.message}`);
  } finally {
    zip.close();
  }
}

/** Copies a folder's run.json / *.png files, never following symlinks. */
async function stageDir(dir, state) {
  let root;
  try {
    root = fs.realpathSync(dir);
    if (!fs.statSync(root).isDirectory()) throw badInput(`${show(dir)} is not a folder.`);
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw badInput(`Cannot read the folder ${show(dir)}: ${err.code || err.message}.`);
  }
  const staging = fs.statSync(state.stagingDir);

  async function walk(abs, relParts) {
    const st = fs.lstatSync(abs);
    // Importing the storage folder itself must not walk into this import's staging copy.
    if (st.ino === staging.ino && st.dev === staging.dev) return;
    for (const dirent of fs.readdirSync(abs, { withFileTypes: true })) {
      countEntry(state);
      if (dirent.isSymbolicLink()) continue;
      const parts = [...relParts, dirent.name];
      const child = path.join(abs, dirent.name);
      if (dirent.isDirectory()) {
        if (parts.length < MAX_FILE_DEPTH) await walk(child, parts);
        continue;
      }
      if (!dirent.isFile()) continue;
      const kind = classify(parts);
      if (!kind) continue;
      // O_NOFOLLOW + fstat: the file can't be swapped for a symlink after readdir.
      let fd;
      try {
        fd = fs.openSync(child, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      } catch (err) {
        if (err.code === 'ELOOP') continue;
        throw err;
      }
      if (!fs.fstatSync(fd).isFile()) {
        fs.closeSync(fd);
        continue;
      }
      const stream = fs.createReadStream(null, { fd }); // closes fd when destroyed
      try {
        await stageFile(stream, parts, kind, state);
      } finally {
        stream.destroy();
      }
    }
  }

  await walk(root, []);
}

// ─── Manifest validation ─────────────────────────────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkString(v, where, { max, nullable = false, pattern, allowEmpty = false } = {}) {
  if (v === null || v === undefined) {
    if (nullable) return null;
    throw invalid(`${where} is required.`);
  }
  if (typeof v !== 'string') throw invalid(`${where} must be a string, got ${show(v)}.`);
  if ((!allowEmpty && v.length === 0) || (max && v.length > max) || CONTROL_CHARS.test(v)) {
    throw invalid(`${where} is not a valid value: ${show(v)}.`);
  }
  if (pattern && !pattern.test(v)) throw invalid(`${where} is not valid: ${show(v)}.`);
  return v;
}

function checkEnum(v, allowed, where) {
  if (!allowed.includes(v)) throw invalid(`${where} must be one of ${allowed.join(', ')}, got ${show(v)}.`);
  return v;
}

function checkNumber(v, where, { min, max, integer = false, nullable = false }) {
  if (v === null && nullable) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isSafeInteger(v))) {
    throw invalid(`${where} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}, got ${show(v)}.`);
  }
  return v;
}

function checkBoolean(v, where) {
  if (typeof v !== 'boolean') throw invalid(`${where} must be true or false, got ${show(v)}.`);
  return v;
}

function checkPng(file, rel, where, limits) {
  const fd = fs.openSync(file, 'r');
  const header = Buffer.alloc(24);
  let read;
  try {
    read = fs.readSync(fd, header, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (read < 24 || !header.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw invalid(`${where}: ${show(rel)} is not a PNG image.`);
  }
  if (header.readUInt32BE(8) !== 13 || header.toString('latin1', 12, 16) !== 'IHDR') {
    throw invalid(`${where}: ${show(rel)} is not a valid PNG image (no IHDR header).`);
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (width < 1 || height < 1 || width > limits.maxImageWidth || height > limits.maxImageHeight) {
    throw invalid(`${where}: ${show(rel)} is ${width}x${height} pixels; images may be at most ` +
      `${limits.maxImageWidth}x${limits.maxImageHeight}.`);
  }
}

/**
 * Validates one parsed run.json against the files staged next to it.
 *
 * @param {unknown} manifest - Parsed JSON
 * @param {string} runDir - Absolute staged folder that held the run.json
 * @param {string} label - Where the manifest came from, for messages
 * @param {object} limits
 * @returns {{ run: object, createdAtSql: string, snapshots: object[] }}
 */
export function validateManifest(manifest, runDir, label, limits = IMPORT_LIMITS) {
  const fail = (message) => invalid(`${label}: ${message}`);
  if (!isPlainObject(manifest)) throw fail('run.json must be a JSON object.');
  if (manifest.schema !== MANIFEST_SCHEMA) throw fail(`not a visual-ci run record (schema ${show(manifest.schema)}).`);
  if (manifest.version !== MANIFEST_VERSION) {
    throw fail(`unsupported run.json version ${show(manifest.version)}; this visual-ci understands version ${MANIFEST_VERSION}.`);
  }

  const wrap = (fn) => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ImportError) throw fail(err.message);
      throw err;
    }
  };

  const r = manifest.run;
  if (!isPlainObject(r)) throw fail('"run" must be an object.');
  const run = wrap(() => ({
    id: checkString(r.id, 'run.id', { pattern: RUN_ID_PATTERN }),
    commit_hash: checkString(r.commit_hash, 'run.commit_hash', { nullable: true, pattern: COMMIT_PATTERN }),
    commit_sha: checkString(r.commit_sha, 'run.commit_sha', { nullable: true, pattern: COMMIT_PATTERN }),
    branch: checkString(r.branch, 'run.branch', { nullable: true, max: 255 }),
    status: checkEnum(r.status, RUN_STATUSES, 'run.status'),
    created_at: checkString(r.created_at, 'run.created_at', { pattern: ISO_TIMESTAMP }),
    mode: checkEnum(r.mode, MODES, 'run.mode'),
    strict: checkBoolean(r.strict, 'run.strict'),
    threshold_percentage: checkNumber(r.threshold_percentage, 'run.threshold_percentage', { min: 0, max: 100 }),
    pixelmatch_threshold: checkNumber(r.pixelmatch_threshold, 'run.pixelmatch_threshold', { min: 0, max: 1 })
  }));
  const createdAt = new Date(run.created_at);
  if (Number.isNaN(createdAt.getTime())) throw fail(`run.created_at is not a valid date: ${show(run.created_at)}.`);

  if (!Array.isArray(manifest.snapshots) || manifest.snapshots.length === 0) {
    throw fail('"snapshots" must be a non-empty array.');
  }
  if (manifest.snapshots.length > limits.maxSnapshots) {
    throw fail(`too many snapshots (${manifest.snapshots.length}; the limit is ${limits.maxSnapshots}).`);
  }

  const pairs = new Set();
  const fileOwners = new Map();
  const snapshots = manifest.snapshots.map((s, i) => wrap(() => {
    const at = `snapshots[${i}]`;
    if (!isPlainObject(s)) throw invalid(`${at} must be an object.`);
    const route = checkString(s.route, `${at}.route`, { max: 2048 });
    const viewport = checkString(s.viewport, `${at}.viewport`, { pattern: VIEWPORT_PATTERN });
    const status = checkEnum(s.status, SNAPSHOT_STATUSES, `${at}.status`);
    if (s.viewport_size !== null && s.viewport_size !== undefined) {
      if (!isPlainObject(s.viewport_size)) throw invalid(`${at}.viewport_size must be an object or null.`);
      checkNumber(s.viewport_size.width, `${at}.viewport_size.width`, { min: 1, max: 100000, integer: true });
      checkNumber(s.viewport_size.height, `${at}.viewport_size.height`, { min: 1, max: 100000, integer: true });
    }
    const mismatch = checkNumber(s.mismatch_percentage, `${at}.mismatch_percentage`, { min: 0, max: 100 });
    const mismatched = checkNumber(s.mismatched_pixels ?? null, `${at}.mismatched_pixels`, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true, nullable: true });
    const total = checkNumber(s.total_pixels ?? null, `${at}.total_pixels`, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true, nullable: true });
    if (mismatched !== null && total !== null && mismatched > total) {
      throw invalid(`${at}.mismatched_pixels is larger than total_pixels.`);
    }

    const pair = `${route}\u0000${viewport}`;
    if (pairs.has(pair)) throw invalid(`${at}: route ${show(route)} at viewport ${show(viewport)} is listed twice.`);
    pairs.add(pair);

    // File names are derived, never trusted: the manifest must agree with them.
    const file = getSnapshotFilename(route, viewport);
    const diffFile = `${file.slice(0, -'.png'.length)}-diff.png`;
    if (diffFile.length > 255) throw invalid(`${at}: the route is too long to make a file name.`);
    for (const name of [file, diffFile]) {
      const owner = fileOwners.get(name);
      if (owner !== undefined) throw invalid(`${at} and snapshots[${owner}] would both use the file ${show(name)}.`);
      fileOwners.set(name, i);
    }

    const expect = (key, expected) => {
      if (s[key] !== expected) {
        throw invalid(`${at}.${key} must be ${show(expected)} (derived from its route, viewport and status), got ${show(s[key])}.`);
      }
    };
    const compared = status === 'MATCH' || status === 'DIFF';
    expect('current', file);
    expect('baseline', file);
    expect('baseline_snapshot', compared ? `baselines/${file}` : status === 'NEW_BASELINE' ? file : null);
    if (compared) {
      if (s.diff !== null) expect('diff', diffFile);
    } else {
      expect('diff', null);
    }

    checkString(s.current_sha256, `${at}.current_sha256`, { pattern: HEX_SHA256 });
    if (s.diff === null) expect('diff_sha256', null);
    else checkString(s.diff_sha256, `${at}.diff_sha256`, { pattern: HEX_SHA256 });

    // null would mean "unknown" locally and skip the stale-baseline check on approval.
    const baselineSha = s.baseline_sha256;
    if (status === 'MISSING_BASELINE') {
      if (baselineSha !== 'none') throw invalid(`${at}.baseline_sha256 must be "none" for a missing baseline, got ${show(baselineSha)}.`);
    } else if (typeof baselineSha !== 'string' || !HEX_SHA256.test(baselineSha)) {
      throw invalid(`${at}.baseline_sha256 must be a SHA-256 hex digest, got ${show(baselineSha)}.`);
    }

    // The images themselves: present, real PNGs of sane size, hashes as recorded.
    const files = { current: s.current, diff: s.diff, baselineCopy: compared ? s.baseline_snapshot : null };
    for (const rel of Object.values(files)) {
      if (rel === null) continue;
      const abs = path.join(runDir, ...rel.split('/'));
      let st = null;
      try {
        st = fs.lstatSync(abs);
      } catch { /* reported below */ }
      if (!st || !st.isFile()) throw invalid(`${at}: ${show(rel)} is missing from the input.`);
      checkPng(abs, rel, at, limits);
    }
    const hashOf = (rel) => sha256File(path.join(runDir, ...rel.split('/')));
    const currentHash = hashOf(s.current);
    if (currentHash !== s.current_sha256) throw invalid(`${at}: ${show(s.current)} does not match current_sha256.`);
    if (s.diff !== null && hashOf(s.diff) !== s.diff_sha256) throw invalid(`${at}: ${show(s.diff)} does not match diff_sha256.`);
    if (status === 'NEW_BASELINE' && baselineSha !== currentHash) {
      throw invalid(`${at}.baseline_sha256 must equal the screenshot's hash for a new baseline.`);
    }
    if (compared && hashOf(s.baseline_snapshot) !== baselineSha) {
      throw invalid(`${at}: ${show(s.baseline_snapshot)} does not match baseline_sha256.`);
    }

    return { route, viewport, status, mismatch_percentage: mismatch, baseline_sha256: baselineSha, file, files };
  }));

  return { run, createdAtSql: toSqliteTimestamp(createdAt), snapshots };
}

// ─── Run ids ─────────────────────────────────────────────────────────────────

/** True when an existing row is this same run (an earlier import of the same artifact). */
function isSameRun(row, parsed) {
  const commit = parsed.run.commit_hash ?? (parsed.run.commit_sha ? parsed.run.commit_sha.slice(0, 7) : null);
  return (row.commit_hash ?? null) === commit &&
    row.created_at === parsed.createdAtSql &&
    Number(row.total_snapshots) === parsed.snapshots.length;
}

/**
 * Picks the local id for a run: its own id, or "<id>-imp2", "-imp3", ... when that is
 * taken by a different run (a DB row or a leftover runs/<id>/ folder). An existing row
 * for the same run means it was imported before.
 */
function chooseRunId(parsed, { db, runsDir, reserved, requestedId }) {
  const taken = (id) => reserved.has(id) || pathExists(path.join(runsDir, id));
  if (requestedId) {
    if (getTestRunById(requestedId, db) || taken(requestedId)) {
      throw new ImportError(409, `A run with id "${requestedId}" already exists; choose another --run-id.`);
    }
    return { id: requestedId };
  }
  const base = parsed.run.id;
  for (let n = 1; n <= MAX_ID_SUFFIX; n++) {
    const id = n === 1 ? base : `${base}-imp${n}`;
    if (!RUN_ID_PATTERN.test(id)) break;
    if (reserved.has(id)) continue;
    const row = getTestRunById(id, db);
    if (row) {
      if (isSameRun(row, parsed)) return { id, alreadyImported: true };
      continue;
    }
    if (taken(id)) continue;
    return { id };
  }
  throw new ImportError(409, `Could not find a free id for run "${base}"; pass a run id explicitly.`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * @param {{ kind: 'zip', file: string } | { kind: 'dir', path: string }} source
 * @param {object} options
 * @param {string} options.storageRoot - Storage root (holds runs/, baselines/, the DB)
 * @param {import('better-sqlite3').Database} options.db - Database of that storage root
 * @param {string} [options.runId] - Local id to use (only when the input holds one run)
 * @param {Partial<typeof IMPORT_LIMITS>} [options.limits] - Lower limits (tests)
 * @returns {Promise<{ runs: Array<{ id: string, url: string, status: string,
 *   snapshots: number, renamedFrom?: string, alreadyImported?: true }> }>}
 * @throws {ImportError} See the module comment for the statuses
 */
export async function importRuns(source, { storageRoot, db, runId, limits: limitOverrides } = {}) {
  if (!storageRoot || typeof storageRoot !== 'string') throw new TypeError('importRuns: storageRoot is required');
  if (!db) throw new TypeError('importRuns: db is required');
  if (runId !== undefined && runId !== null && (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId))) {
    throw badInput(`Invalid run id ${show(runId)}: use 1-128 letters, digits, "-" or "_".`);
  }
  const limits = { ...IMPORT_LIMITS, ...limitOverrides };
  const root = path.resolve(storageRoot);
  const runsDir = path.join(root, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });

  // Same filesystem as runs/, so the final move is a rename. Never served: /storage
  // only serves runs/ and baselines/.
  const stagingDir = fs.mkdtempSync(path.join(root, '.import-'));
  const state = {
    stagingDir,
    filesDir: path.join(stagingDir, 'files'),
    limits,
    entries: 0,
    totalBytes: 0,
    manifests: []
  };
  fs.mkdirSync(state.filesDir);

  try {
    if (source?.kind === 'zip' && typeof source.file === 'string') await stageZip(source.file, state);
    else if (source?.kind === 'dir' && typeof source.path === 'string') await stageDir(source.path, state);
    else throw badInput('Nothing to import: expected a zip file or a folder.');

    if (state.manifests.length === 0) {
      throw invalid("No run.json found (artifacts from before run.json existed can't be imported; re-run CI).");
    }

    const runDirs = state.manifests.map((parts) => parts.slice(0, -1).join('/'));
    for (const a of runDirs) {
      for (const b of runDirs) {
        if (a !== b && (a === '' || b.startsWith(`${a}/`))) {
          throw invalid(`The run in ${show(b || '.')} is inside the run in ${show(a || '.')}; import them separately.`);
        }
      }
    }
    if (runId && state.manifests.length > 1) {
      throw badInput(`The input holds ${state.manifests.length} runs; a run id can only be given when importing one.`);
    }

    // Validate everything before changing anything.
    const parsedRuns = state.manifests.map((parts, i) => {
      const label = parts.join('/');
      let json;
      try {
        json = JSON.parse(fs.readFileSync(path.join(state.filesDir, ...parts), 'utf8'));
      } catch (err) {
        throw invalid(`${label}: not valid JSON (${err.message}).`);
      }
      return { ...validateManifest(json, path.join(state.filesDir, ...parts.slice(0, -1)), label, limits), runDir: runDirs[i] };
    });

    // From here on everything is synchronous, so a concurrent import in this process
    // can't pick the same id between the check and the rename.
    const reserved = new Set();
    const plans = parsedRuns.map((parsed) => {
      const choice = chooseRunId(parsed, { db, runsDir, reserved, requestedId: runId });
      reserved.add(choice.id);
      return { parsed, ...choice };
    });

    commitRuns(plans.filter((p) => !p.alreadyImported), { root, runsDir, db, state });

    return {
      runs: plans.map(({ parsed, id, alreadyImported }) => {
        const entry = {
          id,
          url: `/runs/${encodeURIComponent(id)}`,
          status: getTestRunById(id, db).status,
          snapshots: parsed.snapshots.length
        };
        if (id !== parsed.run.id) entry.renamedFrom = parsed.run.id;
        if (alreadyImported) entry.alreadyImported = true;
        return entry;
      })
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Moves each run's validated images into runs/<id>/ (current + diff at the top,
 * compared baselines under baselines/, like the CLI writes them) and records all runs
 * in one transaction. If anything fails, the folders moved so far are removed again.
 */
function commitRuns(plans, { root, runsDir, db, state }) {
  const moved = [];
  try {
    plans.forEach((plan, i) => {
      const { parsed, id } = plan;
      const from = path.join(state.filesDir, ...(parsed.runDir ? parsed.runDir.split('/') : []));
      const out = path.join(state.stagingDir, 'out', String(i));
      fs.mkdirSync(path.join(out, 'baselines'), { recursive: true });
      for (const s of parsed.snapshots) {
        for (const rel of Object.values(s.files)) {
          if (rel) fs.renameSync(path.join(from, ...rel.split('/')), path.join(out, ...rel.split('/')));
        }
      }
      const finalDir = path.join(runsDir, id);
      if (pathExists(finalDir)) throw new ImportError(409, `runs/${id} appeared while importing; try again.`);
      fs.renameSync(out, finalDir);
      moved.push(finalDir);
    });

    const importedAt = toSqliteTimestamp(new Date());
    db.transaction(() => {
      for (const { parsed, id } of plans) {
        const runDir = path.join(runsDir, id);
        createTestRun({
          id,
          commit_hash: parsed.run.commit_hash ?? (parsed.run.commit_sha ? parsed.run.commit_sha.slice(0, 7) : null),
          branch: parsed.run.branch,
          status: parsed.run.status,
          created_at: parsed.createdAtSql,
          imported_at: importedAt
        }, db);
        for (const s of parsed.snapshots) {
          const currentPath = path.join(runDir, s.file);
          createSnapshot({
            run_id: id,
            route: s.route,
            viewport: s.viewport,
            baseline_path: path.join(root, 'baselines', s.file),
            baseline_snapshot_path: s.status === 'NEW_BASELINE'
              ? currentPath
              : s.files.baselineCopy ? path.join(runDir, 'baselines', s.file) : null,
            baseline_sha256: s.baseline_sha256,
            current_path: currentPath,
            diff_path: s.files.diff ? path.join(runDir, s.file.replace(/\.png$/, '-diff.png')) : null,
            mismatch_percentage: s.mismatch_percentage,
            status: s.status
          }, db);
        }
        recalculateRunStatus(id, db);
      }
    })();
  } catch (err) {
    for (const dir of moved) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.error(`[WARN] Could not remove ${dir} after a failed import: ${cleanupErr.message}`);
      }
    }
    throw err;
  }
}
