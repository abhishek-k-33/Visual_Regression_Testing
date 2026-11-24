import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { importRuns, ImportError, sanitizeForDisplay } from './importRuns.js';

/**
 * POST /api/imports: a CI artifact zip uploaded from the dashboard, imported with the
 * same importRuns() the CLI uses.
 *
 * The body is the raw zip (no multipart), streamed to a dot-named temp file inside the
 * storage root (never served: /storage refuses dot-named segments) and removed again
 * whatever happens. Guards, in order:
 *   415 Content-Type is not a zip / octet-stream
 *   503 another import is running in this process (with Retry-After; no queue)
 *   413 Content-Length, or the bytes actually received, exceed the upload cap
 *   507 not enough free disk space (when the platform can tell)
 * then importRuns' own 400/409/413/422. Messages are always sanitised.
 *
 * Who may call it is decided earlier, by the same Host allowlist and CSRF checks as
 * approving a snapshot (see security.js).
 */

export const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const UPLOAD_CONTENT_TYPES = Object.freeze(['application/zip', 'application/x-zip-compressed', 'application/octet-stream']);
export const RETRY_AFTER_SECONDS = 15;
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 1000;
const MIN_FREE_BYTES = 1024 * 1024 * 1024;
const UPLOAD_PREFIX = '.upload-';
const STALE_UPLOAD_MS = 60 * 60 * 1000;

/** "200 MB", "512 KB", "900 bytes" */
export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * The upload cap: VISUAL_IMPORT_MAX_UPLOAD_BYTES (a positive integer) or 200 MB.
 * Read on every request so it can be changed without a restart (and by tests).
 */
export function maxUploadBytes() {
  const raw = process.env.VISUAL_IMPORT_MAX_UPLOAD_BYTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_UPLOAD_BYTES;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_UPLOAD_BYTES;
}

/**
 * How long an upload may go without receiving a byte before it is dropped (so a stalled
 * client can't hold the one-import lock): VISUAL_IMPORT_IDLE_TIMEOUT_MS or 30 s.
 */
export function idleTimeoutMs() {
  const raw = process.env.VISUAL_IMPORT_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_IDLE_TIMEOUT_MS;
}

/** Free space the disk must have before an upload is accepted: max(2 x cap, 1 GB). */
export const requiredFreeBytes = (cap) => Math.max(2 * cap, MIN_FREE_BYTES);

let busy = false;

/** True while an upload is being received or imported (one at a time per process). */
export function isImportBusy() {
  return busy;
}

/**
 * Refuses with 507 when any of `dirs` is on a disk with less than `needed` bytes free.
 * Each folder is checked on its own: the upload lands in the storage root, but the
 * archive is unpacked next to runs/ or inside it when runs/ is another filesystem.
 * Skipped where fs.statfs is missing or fails (e.g. unsupported filesystems).
 */
async function assertFreeSpace(dirs, needed) {
  if (typeof fs.promises.statfs !== 'function') return;
  for (const dir of dirs) {
    let stats;
    try {
      stats = await fs.promises.statfs(dir);
    } catch {
      continue;
    }
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(free)) continue;
    if (free < needed) {
      throw new ImportError(507, `Not enough free disk space to import: ${formatBytes(free)} free, at least ${formatBytes(needed)} needed.`);
    }
  }
}

/** A stack trace for the log: every line sanitised, the line breaks kept. */
const loggableStack = (err) => String(err?.stack || err?.message || err).split('\n').map(sanitizeForDisplay).join('\n');

/** Removes .upload-* temp files over an hour old (left by a crash). Never follows links. */
async function removeStaleUploads(storageRoot, now = Date.now()) {
  let names;
  try {
    names = await fs.promises.readdir(storageRoot);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(UPLOAD_PREFIX)) continue;
    const file = path.join(storageRoot, name);
    try {
      const st = await fs.promises.lstat(file);
      if (st.isFile() && now - st.mtimeMs > STALE_UPLOAD_MS) await fs.promises.rm(file, { force: true });
    } catch { /* not worth failing an upload over */ }
  }
}

function mediaType(req) {
  return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
}

/**
 * Sends an error. When the request body was not (fully) read, the connection is closed
 * after the response and the rest of the body is discarded rather than stored.
 */
function sendError(req, res, status, message, { bodyUnread = false, headers = {} } = {}) {
  if (res.headersSent || res.destroyed) return;
  if (bodyUnread) res.set('Connection', 'close');
  res.set(headers);
  res.status(status).json({ success: false, error: sanitizeForDisplay(message) });
  if (bodyUnread) {
    req.unpipe();
    req.resume();
  }
}

/**
 * Express handler body for POST /api/imports. Never rejects: every outcome is a response
 * (or nothing, when the client went away).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} options
 * @param {string} options.storageRoot
 * @param {import('better-sqlite3').Database} options.db
 * @param {number} [options.maxBytes] - Upload cap (defaults to maxUploadBytes())
 * @param {number} [options.idleMs] - Drop the upload after this long without data (defaults to idleTimeoutMs())
 */
export async function handleImportUpload(req, res, { storageRoot, db, maxBytes = maxUploadBytes(), idleMs = idleTimeoutMs() }) {
  const type = mediaType(req);
  if (!UPLOAD_CONTENT_TYPES.includes(type)) {
    return sendError(req, res, 415,
      `Upload the artifact as a raw .zip body (Content-Type ${UPLOAD_CONTENT_TYPES.join(', ')}), got "${type || 'none'}".`,
      { bodyUnread: true });
  }
  if (busy) {
    return sendError(req, res, 503, 'Another import is in progress. Try again when it has finished.',
      { bodyUnread: true, headers: { 'Retry-After': String(RETRY_AFTER_SECONDS) } });
  }

  busy = true;
  // pipeline() destroys `req` on ANY error (e.g. the temp file can't be created), so
  // only a destroyed socket means the client went away.
  const { socket } = req;
  let tempFile = null;
  let bodyDone = false;
  let idleTimer = null;
  let reply; // sent only after the temp file is gone and the lock is free
  try {
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > maxBytes) {
      throw new ImportError(413, `The upload is larger than the ${formatBytes(maxBytes)} limit.`);
    }
    const runsDir = path.join(storageRoot, 'runs');
    await fs.promises.mkdir(runsDir, { recursive: true });
    await assertFreeSpace([storageRoot, runsDir], requiredFreeBytes(maxBytes));
    await removeStaleUploads(storageRoot);

    tempFile = path.join(storageRoot, `${UPLOAD_PREFIX}${crypto.randomBytes(12).toString('hex')}.zip`);
    // A client that stops sending is disconnected; that takes the client-abort path below.
    idleTimer = setTimeout(() => socket.destroy(), idleMs);
    let received = 0;
    const cap = new Transform({
      transform(chunk, _encoding, callback) {
        idleTimer.refresh();
        received += chunk.length;
        if (received > maxBytes) return callback(new ImportError(413, `The upload is larger than the ${formatBytes(maxBytes)} limit.`));
        return callback(null, chunk);
      }
    });
    await pipeline(req, cap, fs.createWriteStream(tempFile, { flags: 'wx', mode: 0o600 }));
    clearTimeout(idleTimer);
    bodyDone = true;
    if (received === 0) throw new ImportError(400, 'The upload was empty: send the artifact .zip as the request body.');

    const { runs } = await importRuns({ kind: 'zip', file: tempFile }, { storageRoot, db });
    // 201 when at least one run was created; 200 when everything was already imported.
    reply = {
      status: runs.some((r) => !r.alreadyImported) ? 201 : 200,
      body: {
        success: true,
        runs: runs.map(({ id, url, status, snapshots, renamedFrom, alreadyImported }) => ({
          id, url, status, snapshots,
          ...(renamedFrom ? { renamedFrom } : {}),
          ...(alreadyImported ? { alreadyImported } : {})
        }))
      }
    };
  } catch (err) {
    if (socket.destroyed && !(err instanceof ImportError)) {
      reply = null; // the client aborted (or stalled and was dropped): nobody to answer
    } else if (err instanceof ImportError) {
      reply = { status: err.status, error: err.message };
    } else {
      // Details (paths, stack) go to the server log only, never to the client.
      console.error(`[ERROR] Import upload failed:\n${loggableStack(err)}`);
      reply = { status: 500, error: `Import failed because of a server error (${err.code ?? 'see the server log'}).` };
    }
  } finally {
    clearTimeout(idleTimer);
    if (tempFile) await fs.promises.rm(tempFile, { force: true }).catch(() => {});
    busy = false;
  }

  if (!reply || res.destroyed) return;
  if (reply.error !== undefined) sendError(req, res, reply.status, reply.error, { bodyUnread: !bodyDone });
  else res.status(reply.status).json(reply.body);
}
