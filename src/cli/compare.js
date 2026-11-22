import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { getSnapshotFilename } from './naming.js';

/** pixelmatch per-pixel colour sensitivity (0 = exact, 1 = lenient) used by default. */
export const DEFAULT_PIXELMATCH_THRESHOLD = 0.1;

/**
 * Pads a PNG image to target dimensions if it is smaller than maxWidth or maxHeight.
 * The padded canvas is transparent (RGBA: 0, 0, 0, 0).
 *
 * @param {PNG} png - Original decoded PNG instance
 * @param {number} targetWidth - Width to pad to
 * @param {number} targetHeight - Height to pad to
 * @returns {PNG} The padded PNG instance or original if already matching
 */
export function padImage(png, targetWidth, targetHeight) {
  if (png.width === targetWidth && png.height === targetHeight) {
    return png;
  }

  const padded = new PNG({ width: targetWidth, height: targetHeight });
  // PNG instances in pngjs default to all zeros (transparent RGBA: 0, 0, 0, 0)
  PNG.bitblt(png, padded, 0, 0, png.width, png.height, 0, 0);
  return padded;
}

/**
 * Compares two PNG buffers pixel-by-pixel, automatically normalizing canvas dimensions.
 *
 * @param {Buffer} baselineBuffer - Baseline PNG file buffer
 * @param {Buffer} currentBuffer - Current screenshot PNG file buffer
 * @param {object} [options={}] - Comparison options
 * @param {number} [options.threshold=0.1] - Pixelmatch color sensitivity threshold (0 to 1)
 * @returns {object} Comparison results and diff PNG
 */
export function compareImages(baselineBuffer, currentBuffer, options = {}) {
  const img1 = PNG.sync.read(baselineBuffer);
  const img2 = PNG.sync.read(currentBuffer);

  const maxWidth = Math.max(img1.width, img2.width);
  const maxHeight = Math.max(img1.height, img2.height);

  const padded1 = padImage(img1, maxWidth, maxHeight);
  const padded2 = padImage(img2, maxWidth, maxHeight);

  const diff = new PNG({ width: maxWidth, height: maxHeight });
  const pixelmatchThreshold = options.threshold !== undefined ? options.threshold : DEFAULT_PIXELMATCH_THRESHOLD;

  const mismatchedPixels = pixelmatch(
    padded1.data,
    padded2.data,
    diff.data,
    maxWidth,
    maxHeight,
    {
      threshold: pixelmatchThreshold,
      includeAA: false, // detect anti-aliasing to avoid false positive edge blur
      diffColor: [255, 0, 0], // highlight differences in bright red
      diffColorAlt: [255, 0, 0]
    }
  );

  const totalPixels = maxWidth * maxHeight;
  const mismatchPercentage = totalPixels > 0
    ? Number(((mismatchedPixels / totalPixels) * 100).toFixed(4))
    : 0;

  return {
    mismatchedPixels,
    totalPixels,
    mismatchPercentage,
    diffPng: diff,
    diffBuffer: PNG.sync.write(diff),
    dimensions: {
      baseline: { width: img1.width, height: img1.height },
      current: { width: img2.width, height: img2.height },
      diff: { width: maxWidth, height: maxHeight },
      padded: img1.width !== img2.width || img1.height !== img2.height
    }
  };
}

/**
 * Recorded as baseline_sha256 when a run found no baseline at all, so approval can
 * later require that there still is none (independent of the snapshot's status).
 */
export const NO_BASELINE = 'none';

/**
 * @param {Buffer} buffer
 * @returns {string} Hex SHA-256 digest
 */
export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Compares a single captured snapshot against its baseline master.
 * Handles initial baseline promotion if no baseline exists yet.
 *
 * @param {object} snapshot - Captured snapshot metadata
 * @param {string} snapshot.route - Page route
 * @param {string} snapshot.viewport - Viewport name
 * @param {string} snapshot.filepath - Current screenshot filepath
 * @param {object} options - Execution options
 * @param {string} options.baselinesDir - Directory where approved baselines live
 * @param {string} options.diffDir - Directory where diff images should be saved
 * @param {number} [options.allowedThreshold=0.01] - Max allowed mismatch percentage ratio (0.01 = 1%)
 * @param {number} [options.pixelmatchThreshold=0.1] - Color sensitivity for pixelmatch
 * @param {boolean} [options.createMissingBaselines=true] - When false (strict/CI mode), a missing
 *   baseline is reported as MISSING_BASELINE instead of being created from the current screenshot
 * @returns {object} Snapshot comparison record. baselineSnapshotPath is a per-run copy of the
 *   compared baseline; baselineSha256 lets approval detect that the shared baseline moved on.
 */
export function compareSnapshot(snapshot, options) {
  const { route, viewport, filepath: currentPath } = snapshot;
  const baselinesDir = options.baselinesDir;
  const diffDir = options.diffDir;
  const allowedThresholdRatio = options.allowedThreshold !== undefined ? options.allowedThreshold : 0.01;
  const allowedPercentage = allowedThresholdRatio * 100;

  fs.mkdirSync(baselinesDir, { recursive: true });
  fs.mkdirSync(diffDir, { recursive: true });

  const filename = getSnapshotFilename(route, viewport);
  const baselinePath = path.join(baselinesDir, filename);
  const diffFilename = `${path.parse(filename).name}-diff.png`;
  const diffPath = path.join(diffDir, diffFilename);
  // Copy of the exact baseline this run compared against. storage/baselines/ keeps
  // changing as later runs are approved; the run's own record must not.
  // Kept in a subfolder so it can't collide with another viewport's screenshot.
  const baselineSnapshotPath = path.join(diffDir, 'baselines', filename);

  // No baseline yet: either adopt the current screenshot (local first run) or,
  // in strict mode, fail so CI can never "pass" by comparing a page to itself.
  if (!fs.existsSync(baselinePath)) {
    const createBaseline = options.createMissingBaselines !== false;
    if (createBaseline) fs.copyFileSync(currentPath, baselinePath);
    return {
      // NEW_BASELINE: the baseline *is* this run's screenshot. MISSING: there is none.
      baselineSnapshotPath: createBaseline ? currentPath : null,
      baselineSha256: createBaseline ? sha256(fs.readFileSync(currentPath)) : NO_BASELINE,
      route,
      viewport,
      baselinePath,
      currentPath,
      diffPath: null,
      mismatchedPixels: 0,
      totalPixels: 0,
      mismatchPercentage: 0,
      status: createBaseline ? 'NEW_BASELINE' : 'MISSING_BASELINE',
      dimensions: null
    };
  }

  // Baseline exists: execute pixel-by-pixel comparison
  const baselineBuffer = fs.readFileSync(baselinePath);
  fs.mkdirSync(path.dirname(baselineSnapshotPath), { recursive: true });
  fs.writeFileSync(baselineSnapshotPath, baselineBuffer);
  const currentBuffer = fs.readFileSync(currentPath);

  const comparison = compareImages(baselineBuffer, currentBuffer, {
    threshold: options.pixelmatchThreshold
  });

  // Write diff image to disk
  fs.writeFileSync(diffPath, comparison.diffBuffer);

  const isMatch = comparison.mismatchedPixels === 0 || comparison.mismatchPercentage <= allowedPercentage;
  const status = isMatch ? 'MATCH' : 'DIFF';

  return {
    route,
    viewport,
    baselinePath,
    baselineSnapshotPath,
    baselineSha256: sha256(baselineBuffer),
    currentPath,
    diffPath,
    mismatchedPixels: comparison.mismatchedPixels,
    totalPixels: comparison.totalPixels,
    mismatchPercentage: comparison.mismatchPercentage,
    status,
    dimensions: comparison.dimensions
  };
}
