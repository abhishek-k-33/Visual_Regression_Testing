import fs from 'node:fs';
import path from 'node:path';

/**
 * Absolute path of the storage root (holds runs/, baselines/ and the SQLite DB).
 * Read at call time so tests can point it elsewhere via VISUAL_STORAGE_DIR.
 *
 * @returns {string}
 */
export function getStorageRoot() {
  return path.resolve(process.env.VISUAL_STORAGE_DIR || path.join(process.cwd(), 'storage'));
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
