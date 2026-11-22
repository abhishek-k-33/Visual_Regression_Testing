import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * run.json: a self-contained, machine-readable record of one test run, written into
 * the run's folder (runs/<id>/run.json). CI uploads storage/runs/ as an artifact, so
 * the record travels with the screenshots and a run can be re-created elsewhere
 * (e.g. imported into a local dashboard) without the SQLite database.
 *
 * Paths are relative and use "/": current, diff and baseline_snapshot are relative to
 * the run folder; baseline is relative to the shared baselines/ folder.
 * Units: threshold_percentage and mismatch_percentage are both percentages (1 = 1%).
 * baseline_sha256 is the hash of the baseline that was compared, or 'none' if there
 * was no baseline; current_sha256/diff_sha256 let an importer verify the images.
 */

export const MANIFEST_SCHEMA = 'visual-ci-run';
export const MANIFEST_VERSION = 1;
export const MANIFEST_FILENAME = 'run.json';

let toolVersion;

/** The tool's version from package.json, read on first use ('unknown' if unreadable). */
export function getToolVersion() {
  if (toolVersion === undefined) {
    try {
      toolVersion = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
    } catch {
      toolVersion = 'unknown';
    }
  }
  return toolVersion;
}

const hashFile = (file) => (file ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);

/** SQLite's CURRENT_TIMESTAMP format (UTC), so DB rows and manifests sort alike. */
export function toSqliteTimestamp(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function relativeInside(dir, file, label) {
  if (!file) return null;
  const rel = path.relative(dir, file);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Cannot record ${label} "${file}": it is not inside ${dir}`);
  }
  return rel.split(path.sep).join('/');
}

/**
 * @param {object} options
 * @param {string} options.runId
 * @param {Date} options.createdAt
 * @param {{ branch?: string|null, commit_hash?: string|null, commit_sha?: string|null }} [options.gitInfo]
 * @param {'PASSED'|'FAILED'} options.status
 * @param {number} options.threshold - Allowed mismatch ratio from the config (0.01 = 1%)
 * @param {number} options.pixelmatchThreshold - Per-pixel colour sensitivity used
 * @param {boolean} options.strict - Whether missing baselines failed instead of being created
 * @param {'compare'|'update-baselines'} options.mode
 * @param {string} options.runDir - Absolute path of runs/<id>
 * @param {string} options.baselinesDir - Absolute path of the shared baselines folder
 * @param {object[]} options.results - Comparison results as produced by the CLI
 * @returns {object} The manifest
 */
export function buildRunManifest({
  runId, createdAt, gitInfo = {}, status, threshold, pixelmatchThreshold, strict, mode,
  runDir, baselinesDir, results
}) {
  const snapshots = results.map((r) => {
    const currentPath = r.currentPath || r.filepath;
    return {
      route: r.route,
      viewport: r.viewport,
      viewport_size: r.width && r.height ? { width: r.width, height: r.height } : null,
      status: r.status,
      mismatch_percentage: r.mismatchPercentage || 0,
      mismatched_pixels: r.mismatchedPixels ?? null,
      total_pixels: r.totalPixels ?? null,
      current: relativeInside(runDir, currentPath, 'screenshot'),
      current_sha256: hashFile(currentPath),
      diff: relativeInside(runDir, r.diffPath, 'diff image'),
      diff_sha256: hashFile(r.diffPath),
      baseline_snapshot: relativeInside(runDir, r.baselineSnapshotPath, 'baseline copy'),
      baseline: relativeInside(baselinesDir, r.baselinePath, 'baseline'),
      baseline_sha256: r.baselineSha256 || 'none'
    };
  });

  // Backstop for colliding file names (config validation should already prevent them)
  for (const key of ['current', 'diff', 'baseline']) {
    const seen = new Set();
    for (const s of snapshots) {
      if (s[key] === null) continue;
      if (seen.has(s[key])) throw new Error(`Two snapshots share the ${key} file "${s[key]}"`);
      seen.add(s[key]);
    }
  }

  return {
    schema: MANIFEST_SCHEMA,
    version: MANIFEST_VERSION,
    tool: { name: 'visual-ci', version: getToolVersion() },
    run: {
      id: runId,
      commit_hash: gitInfo.commit_hash || null,
      commit_sha: gitInfo.commit_sha || null,
      branch: gitInfo.branch || null,
      status,
      created_at: createdAt.toISOString(),
      mode,
      strict,
      threshold_percentage: Math.round(threshold * 100 * 1e6) / 1e6, // 0.07 * 100 is 7.000000000000001
      pixelmatch_threshold: pixelmatchThreshold
    },
    snapshots
  };
}

/**
 * Writes run.json into the run folder (via a temp file + rename, so a reader never
 * sees a half-written file).
 *
 * @returns {string} Path of the written manifest
 */
export function writeRunManifest(manifest, runDir) {
  fs.mkdirSync(runDir, { recursive: true });
  const target = path.join(runDir, MANIFEST_FILENAME);
  const temp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  return target;
}
