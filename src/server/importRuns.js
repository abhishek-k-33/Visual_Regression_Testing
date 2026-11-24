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
 *
 * Keeps a server responsive (it also backs POST /api/imports): every file's size,
 * SHA-256 and PNG header are computed while it is streamed into staging, so validation
 * never reads whole files synchronously; the remaining synchronous work is metadata
 * (lstat, rename, mkdir) and the short commit step (id choice -> rename -> one DB
 * transaction), which must stay synchronous so concurrent imports can't pick the same id.
 * One-import-at-a-time and disk-space limits for uploads live in uploadImport.js.
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
// C0/DEL/C1 controls, format characters (bidi overrides U+202A-E, isolates U+2066-9,
// marks U+200E/F, zero-width chars, BOM...), lone surrogates and line/paragraph
// separators: refused in every manifest string and archive entry name, and escaped
// whenever untrusted text is shown (they can rewrite a terminal or disguise text).
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_CHARS_GLOBAL = new RegExp(UNSAFE_CHARS.source, 'gu');
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

/**
 * Makes untrusted text safe to print to a terminal or log: every control, format,
 * surrogate or separator character becomes a visible \u{...} escape.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizeForDisplay(text) {
  return String(text).replace(UNSAFE_CHARS_GLOBAL, (ch) => `\\u{${ch.codePointAt(0).toString(16).toUpperCase()}}`);
}

/** Untrusted value for an error message: quoted, escaped and shortened. */
function show(value) {
  // JSON.stringify escapes C0 only; sanitizeForDisplay handles C1, bidi and the rest.
  const text = sanitizeForDisplay(JSON.stringify(value) ?? String(value));
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

const mb = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;
const PNG_HEADER_BYTES = 24; // signature + IHDR length/type + width + height

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
    trimmed.length === 0 || trimmed.length > MAX_ENTRY_NAME || UNSAFE_CHARS.test(trimmed) ||
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
  // Hash and keep the first bytes while streaming, so validation never re-reads the file.
  const hash = crypto.createHash('sha256');
  let header = Buffer.alloc(0);
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length;
      hash.update(chunk);
      if (header.length < PNG_HEADER_BYTES) {
        header = Buffer.concat([header, chunk.subarray(0, PNG_HEADER_BYTES - header.length)]);
      }
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
  state.files.set(label, { size: written, sha256: hash.digest('hex'), header });
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

// yauzl's own file name checks put the raw entry name into the message.
const YAUZL_NAME_ERRORS = ['invalid characters in fileName: ', 'absolute path: ', 'invalid relative path: '];

/** Our own message for a yauzl error; never its raw text (it can carry an entry name). */
function zipFormatError(err) {
  const message = String(err?.message ?? err);
  const prefix = YAUZL_NAME_ERRORS.find((p) => message.startsWith(p));
  if (prefix) {
    return badInput(`Unsafe file name in the archive: ${show(message.slice(prefix.length))}. Nothing was imported.`);
  }
  return badInput(`Invalid zip archive: ${sanitizeForDisplay(message).slice(0, 300)}`);
}

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
    throw badInput(`Not a valid zip archive: ${sanitizeForDisplay(err.message)}`);
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
    throw zipFormatError(err);
  } finally {
    zip.close();
  }
}

const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
const isAtOrInside = (child, parent) => child === parent || isInside(child, parent);

/**
 * Opens a file found while walking `root` for reading, or returns null when it must be
 * skipped. Defends against the tree changing under us:
 * - O_NOFOLLOW: the file itself can't be a symlink; O_NONBLOCK: a FIFO swapped in can't
 *   block the open (and is then skipped as not a regular file).
 * - After opening, the parent folder's real path must still be inside root and the
 *   file at <real parent>/<name> must be the very file we opened (same dev/inode), so a
 *   parent folder swapped for a symlink (before or after the open) is caught.
 */
function openInsideRoot(root, parentAbs, name) {
  let fd;
  try {
    fd = fs.openSync(path.join(parentAbs, name), OPEN_FLAGS);
  } catch (err) {
    if (['ELOOP', 'ENOENT', 'ENXIO', 'EMLINK'].includes(err.code)) return null; // link, vanished, FIFO/socket
    throw err;
  }
  let keep = false;
  try {
    keep = isOpenedFileInsideRoot(fd, root, parentAbs, name);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      fs.closeSync(fd);
      throw err;
    }
  }
  if (!keep) {
    fs.closeSync(fd);
    return null;
  }
  return fd;
}

function isOpenedFileInsideRoot(fd, root, parentAbs, name) {
  const opened = fs.fstatSync(fd);
  if (!opened.isFile()) return false;
  const realParent = fs.realpathSync(parentAbs);
  if (!isAtOrInside(realParent, root)) return false;
  const there = fs.lstatSync(path.join(realParent, name));
  return there.isFile() && there.dev === opened.dev && there.ino === opened.ino;
}

/**
 * Copies a folder's run.json / *.png files. Symlinks are never followed below the
 * folder given (that folder itself may be a symlink: it is what the user asked for):
 * entries are checked with lstat, folders are only entered when their real path is
 * still inside the root, and files are opened with openInsideRoot. Listings are read
 * lazily so the entry limit applies before a huge folder is loaded.
 */
async function stageDir(dir, state) {
  let root;
  try {
    root = fs.realpathSync(dir);
    if (!fs.statSync(root).isDirectory()) throw badInput(`${show(dir)} is not a folder.`);
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw badInput(`Cannot read the folder ${show(dir)}: ${sanitizeForDisplay(err.code || err.message)}.`);
  }
  const staging = fs.statSync(state.stagingDir);

  async function walk(abs, relParts) {
    const handle = fs.opendirSync(abs);
    try {
      for (let dirent = handle.readSync(); dirent !== null; dirent = handle.readSync()) {
        countEntry(state);
        const name = dirent.name;
        // Names we could never reference (or print safely) are skipped, not staged.
        if (name.length > 255 || UNSAFE_CHARS.test(name)) continue;
        const parts = [...relParts, name];
        const child = path.join(abs, name);
        let st;
        try {
          st = fs.lstatSync(child);
        } catch (err) {
          if (err.code === 'ENOENT') continue;
          throw err;
        }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (parts.length >= MAX_FILE_DEPTH) continue;
          // Importing the storage folder itself must not walk into this import's staging copy.
          if (st.ino === staging.ino && st.dev === staging.dev) continue;
          if (!isAtOrInside(fs.realpathSync(child), root)) continue;
          await walk(child, parts);
          continue;
        }
        if (!st.isFile()) continue;
        const kind = classify(parts);
        if (!kind) continue;
        const fd = openInsideRoot(root, abs, name);
        if (fd === null) continue;
        const stream = fs.createReadStream(null, { fd }); // closes fd when destroyed
        try {
          await stageFile(stream, parts, kind, state);
        } finally {
          stream.destroy();
        }
      }
    } finally {
      handle.closeSync();
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
  if ((!allowEmpty && v.length === 0) || (max && v.length > max) || UNSAFE_CHARS.test(v)) {
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

/** Checks a staged file's first bytes (recorded while staging) for a sane PNG. */
function checkPng(header, rel, where, limits) {
  if (header.length < PNG_HEADER_BYTES || !header.subarray(0, 8).equals(PNG_SIGNATURE)) {
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
 * @param {(rel: string) => ({ size: number, sha256: string, header: Buffer } | undefined)} stagedFile
 *   What staging recorded for a path relative to the run.json's folder (undefined if
 *   nothing was staged there)
 * @param {string} label - Where the manifest came from, for messages
 * @param {object} limits
 * @returns {{ run: object, createdAtSql: string, snapshots: object[] }}
 */
export function validateManifest(manifest, stagedFile, label, limits = IMPORT_LIMITS) {
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
      const info = stagedFile(rel);
      if (!info) throw invalid(`${at}: ${show(rel)} is missing from the input.`);
      checkPng(info.header, rel, at, limits);
    }
    const hashOf = (rel) => stagedFile(rel).sha256;
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
 *
 * Ids are compared case-insensitively ("Run_A" and "run_a" are the same folder on
 * macOS and Windows), so a run is never given an id that differs from an existing one
 * only in case.
 *
 * @param {object} ctx
 * @param {Set<string>} ctx.reserved - Lower-cased ids already picked in this import
 * @param {Set<string>} ctx.folders - Lower-cased names in runs/
 */
function chooseRunId(parsed, { db, reserved, folders, requestedId }) {
  const likeRows = db.prepare('SELECT id FROM test_runs WHERE id = ? COLLATE NOCASE');
  const taken = (id) => {
    const key = id.toLowerCase();
    return reserved.has(key) || folders.has(key) || likeRows.all(id).length > 0;
  };
  if (requestedId) {
    if (taken(requestedId)) {
      throw new ImportError(409, `A run with id "${requestedId}" already exists (ids are compared ignoring case); choose another run id.`);
    }
    return { id: requestedId };
  }
  const base = parsed.run.id;
  for (let n = 1; n <= MAX_ID_SUFFIX; n++) {
    const id = n === 1 ? base : `${base}-imp${n}`;
    if (!RUN_ID_PATTERN.test(id)) break;
    if (reserved.has(id.toLowerCase())) continue;
    const row = getTestRunById(id, db);
    if (row && isSameRun(row, parsed)) return { id, alreadyImported: true };
    if (taken(id)) continue;
    return { id };
  }
  throw new ImportError(409, `Could not find a free id for run "${base}"; pass a run id explicitly.`);
}

// ─── Staging folders ─────────────────────────────────────────────────────────

/** Staging folders older than this are leftovers of a crashed import. */
export const STALE_STAGING_MS = 60 * 60 * 1000;
const STAGING_PREFIX = '.import-';

/**
 * Removes `.import-*` folders older than STALE_STAGING_MS from the given folders (left
 * behind if a process died mid-import). Only real directories (lstat, links are never
 * followed); failures are only logged, since they must not block a new import.
 */
async function removeStaleStaging(dirs, now = Date.now()) {
  for (const dir of dirs) {
    let names;
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(STAGING_PREFIX)) continue;
      const p = path.join(dir, name);
      try {
        const st = await fs.promises.lstat(p);
        if (st.isDirectory() && now - st.mtimeMs > STALE_STAGING_MS) await fs.promises.rm(p, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[WARN] Could not remove the old import folder ${sanitizeForDisplay(p)}: ${sanitizeForDisplay(err.message)}`);
      }
    }
  }
}

/**
 * Renames a finished run folder into runs/. When runs/ is on another filesystem (e.g.
 * a symlink to another disk) the rename fails with EXDEV: then the folder is copied to
 * a hidden temp folder inside runs/ first, so the run still appears in one rename.
 */
function moveIntoRuns(out, finalDir, runsDir) {
  try {
    fs.renameSync(out, finalDir);
    return;
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }
  const tmp = fs.mkdtempSync(path.join(runsDir, STAGING_PREFIX));
  try {
    fs.cpSync(out, tmp, { recursive: true, errorOnExist: true, force: false });
    fs.renameSync(tmp, finalDir);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
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
  await fs.promises.mkdir(runsDir, { recursive: true });
  await removeStaleStaging([root, runsDir]);

  // On the same filesystem as runs/, so the final move is a rename: next to runs/
  // normally, inside it when runs/ is another filesystem (e.g. a symlink to another
  // disk). Never served either way: /storage refuses dot-named path segments.
  const [rootStat, runsStat] = await Promise.all([fs.promises.stat(root), fs.promises.stat(runsDir)]);
  const stagingParent = rootStat.dev === runsStat.dev ? root : runsDir;
  const stagingDir = await fs.promises.mkdtemp(path.join(stagingParent, STAGING_PREFIX));
  const state = {
    stagingDir,
    filesDir: path.join(stagingDir, 'files'),
    limits,
    entries: 0,
    totalBytes: 0,
    manifests: [],
    files: new Map() // staged path -> { size, sha256, header }
  };
  await fs.promises.mkdir(state.filesDir);

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
    const parsedRuns = [];
    for (const [i, parts] of state.manifests.entries()) {
      const label = parts.join('/');
      let json;
      try {
        json = JSON.parse(await fs.promises.readFile(path.join(state.filesDir, ...parts), 'utf8'));
      } catch (err) {
        // V8's message quotes part of the input, so it is sanitised like any other text.
        throw invalid(`${label}: not valid JSON (${sanitizeForDisplay(err.message).slice(0, 200)}).`);
      }
      const prefix = runDirs[i] ? `${runDirs[i]}/` : '';
      const stagedFile = (rel) => state.files.get(prefix + rel);
      parsedRuns.push({ ...validateManifest(json, stagedFile, label, limits), runDir: runDirs[i] });
    }

    // From here on everything is synchronous, so a concurrent import in this process
    // can't pick the same id between the check and the rename.
    const reserved = new Set();
    const folders = new Set(fs.readdirSync(runsDir).map((name) => name.toLowerCase()));
    const plans = parsedRuns.map((parsed) => {
      const choice = chooseRunId(parsed, { db, reserved, folders, requestedId: runId });
      reserved.add(choice.id.toLowerCase());
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
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
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
      moveIntoRuns(out, finalDir, runsDir);
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
        console.error(`[WARN] Could not remove ${dir} after a failed import: ${sanitizeForDisplay(cleanupErr.message)}`);
      }
    }
    throw err;
  }
}
