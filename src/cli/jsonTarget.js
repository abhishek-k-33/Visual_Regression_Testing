import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST_FILENAME } from './manifest.js';
import { STDOUT_TARGET } from './result.js';

/**
 * Checks for the `test --json <file>` target. The JSON must never replace the run's
 * own run.json or markdown summary (that would make the run impossible to import),
 * however the path is spelled: through a symlinked folder, a symlinked
 * VISUAL_STORAGE_DIR, a hard link, or a different letter case on macOS/Windows.
 */

const caseInsensitive = (platform) => platform === 'darwin' || platform === 'win32';

/**
 * Like fs.realpathSync, but for a path that may not exist yet: the deepest existing
 * ancestor is resolved and the rest appended.
 *
 * @param {string} p - Absolute path
 * @returns {string}
 */
export function realpathLoose(p) {
  const tail = [];
  let current = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function sameFile(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false; // one of them does not exist (yet)
  }
}

/** The run files a --json target may not be. Paths built with path.join, like their writers do. */
export function protectedRunFiles(runsDir, summaryFile) {
  return [
    { file: path.join(runsDir, MANIFEST_FILENAME), label: `run's ${MANIFEST_FILENAME}` },
    { file: path.join(runsDir, summaryFile || 'summary.md'), label: "run's markdown summary" }
  ];
}

/**
 * Why a --json target can't be used, or null. Compares, for the run's run.json and
 * summary: the resolved paths; the real paths of their folders plus the file name
 * (case-folded on macOS/Windows); and, when both exist, device + inode. Call it up
 * front (cheap, catches most mistakes) and again right before writing, when the run
 * folder exists and symlinks resolve.
 *
 * @param {string|undefined} target - The --json value (relative to cwd)
 * @param {{ runsDir?: string|null, summaryFile?: string, cwd?: string, platform?: string }} options
 * @returns {string|null}
 */
export function jsonTargetConflict(target, { runsDir, summaryFile, cwd = process.cwd(), platform = process.platform } = {}) {
  if (!target || target === STDOUT_TARGET || !runsDir) return null;
  const file = path.resolve(cwd, target);
  const fold = (p) => (caseInsensitive(platform) ? p.toLowerCase() : p);
  const real = (p) => fold(path.join(realpathLoose(path.dirname(p)), path.basename(p)));
  const realTarget = real(file);

  for (const { file: runFile, label } of protectedRunFiles(runsDir, summaryFile)) {
    if (fold(file) === fold(runFile) || realTarget === real(runFile) || sameFile(file, runFile)) {
      return `--json cannot be "${target}": that is the ${label}`;
    }
  }
  return null;
}

/**
 * Why a --json target is not a file name, or null: empty, an existing directory, or a
 * path ending in a separator ("out/").
 *
 * @param {string|undefined} target
 * @param {{ cwd?: string }} [options]
 * @returns {string|null}
 */
export function jsonTargetShapeProblem(target, { cwd = process.cwd() } = {}) {
  if (target === undefined || target === STDOUT_TARGET) return null;
  if (target.trim() === '') return '--json needs a file name, or "-" for stdout';
  const isDir = /[\\/]$/.test(target) || (() => {
    try {
      return fs.statSync(path.resolve(cwd, target)).isDirectory();
    } catch {
      return false;
    }
  })();
  return isDir ? `--json cannot be "${target}": that is a directory; give a file name such as result.json` : null;
}
