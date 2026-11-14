import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { getSnapshotFilename } from './capture.js';

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
  const pixelmatchThreshold = options.threshold !== undefined ? options.threshold : 0.1;

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
 * @returns {object} Snapshot comparison record
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

  // If no baseline exists, promote current screenshot as initial baseline
  if (!fs.existsSync(baselinePath)) {
    fs.copyFileSync(currentPath, baselinePath);
    return {
      route,
      viewport,
      baselinePath,
      currentPath,
      diffPath: null,
      mismatchedPixels: 0,
      totalPixels: 0,
      mismatchPercentage: 0,
      status: 'NEW_BASELINE',
      dimensions: null
    };
  }

  // Baseline exists: execute pixel-by-pixel comparison
  const baselineBuffer = fs.readFileSync(baselinePath);
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
    currentPath,
    diffPath,
    mismatchedPixels: comparison.mismatchedPixels,
    totalPixels: comparison.totalPixels,
    mismatchPercentage: comparison.mismatchPercentage,
    status,
    dimensions: comparison.dimensions
  };
}
