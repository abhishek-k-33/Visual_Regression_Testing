import fs from 'node:fs';
import path from 'node:path';
import { stripJsonComments, validateStorageDir } from '../cli/config.js';

/**
 * Absolute storage root (holds runs/, baselines/ and the SQLite DB) for a given
 * config storageDir. Precedence: VISUAL_STORAGE_DIR env > storageDir > ./storage.
 *
 * @param {string} [storageDir] - storageDir from visual.config.json (relative to cwd)
 * @returns {string}
 */
export function resolveStorageRoot(storageDir) {
  if (process.env.VISUAL_STORAGE_DIR) return path.resolve(process.env.VISUAL_STORAGE_DIR);
  return path.resolve(process.cwd(), storageDir || 'storage');
}

let configStorageDir; // undefined = visual.config.json not read yet

// Only storageDir matters here, so a config the CLI completes with flags (e.g. no
// baseUrl, passed via --base-url) still works. Read once per process.
function readConfiguredStorageDir() {
  const configPath = path.resolve(process.cwd(), 'visual.config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(stripJsonComments(fs.readFileSync(configPath, 'utf8')));
    return validateStorageDir(parsed?.storageDir);
  } catch (err) {
    console.warn(`[WARN] Ignoring storageDir in ${configPath} (${err.message}); using ./storage. ` +
      'Set VISUAL_STORAGE_DIR to choose the storage folder explicitly.');
    return null;
  }
}

/**
 * Storage root for the dashboard, which has no --config flag: honours
 * VISUAL_STORAGE_DIR, then storageDir from ./visual.config.json, then ./storage.
 * The env var is read on every call so tests can repoint it.
 *
 * @returns {string}
 */
export function getStorageRoot() {
  if (process.env.VISUAL_STORAGE_DIR) return resolveStorageRoot();
  if (configStorageDir === undefined) configStorageDir = readConfiguredStorageDir();
  return resolveStorageRoot(configStorageDir);
}

/**
 * True when `child` is strictly inside `parent` (both absolute).
 * Compares path segments, so "/a/storage-evil" is not inside "/a/storage".
 *
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel);
}

/**
 * Resolves `filePath` and verifies it is a .png located inside `allowedDir`,
 * following symlinks so a link cannot point outside the allowed directory.
 *
 * @param {string} filePath - Absolute, or relative to process.cwd()
 * @param {string} allowedDir - Absolute directory the file must live in
 * @param {object} [options]
 * @param {boolean} [options.mustExist=true] - false allows a not-yet-created target file
 * @returns {string} The resolved real path
 * @throws {Error} "Access denied: ..." when the path is not allowed
 */
export function resolvePngInside(filePath, allowedDir, { mustExist = true } = {}) {
  const resolved = path.resolve(process.cwd(), filePath);

  if (path.extname(resolved).toLowerCase() !== '.png') {
    throw new Error(`Access denied: "${filePath}" is not a .png file.`);
  }

  // Lexical check first, before touching the filesystem.
  if (!isInside(resolved, allowedDir)) {
    throw new Error(`Access denied: "${filePath}" is outside ${allowedDir}.`);
  }

  if (!mustExist) {
    fs.mkdirSync(allowedDir, { recursive: true });
  } else if (!fs.existsSync(allowedDir)) {
    throw new Error(`File not found: "${filePath}".`);
  }
  const realAllowed = fs.realpathSync(allowedDir);

  let real;
  if (fs.existsSync(resolved)) {
    // Existing file (or symlink): check where it really points.
    real = fs.realpathSync(resolved);
  } else if (mustExist) {
    throw new Error(`File not found: "${filePath}".`);
  } else {
    // New target: its parent directory must really be inside the allowed dir.
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    real = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  }

  if (!isInside(real, realAllowed)) {
    throw new Error(`Access denied: "${filePath}" resolves outside ${allowedDir}.`);
  }

  return real;
}
