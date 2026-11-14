import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { padImage, compareImages, compareSnapshot } from '../src/cli/compare.js';

describe('Pixel Diffing Engine (compare.js)', () => {
  const testTmpDir = path.resolve(process.cwd(), 'tests/.tmp_compare');
  const baselinesDir = path.join(testTmpDir, 'baselines');
  const runsDir = path.join(testTmpDir, 'runs');

  beforeEach(() => {
    fs.mkdirSync(baselinesDir, { recursive: true });
    fs.mkdirSync(runsDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testTmpDir)) {
      fs.rmSync(testTmpDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper to create a solid color PNG buffer.
   */
  function createSolidPng(width, height, r, g, b, a = 255) {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (width * y + x) * 4;
        png.data[idx] = r;
        png.data[idx + 1] = g;
        png.data[idx + 2] = b;
        png.data[idx + 3] = a;
      }
    }
    return PNG.sync.write(png);
  }

  describe('padImage', () => {
    it('returns the same instance if dimensions already match target', () => {
      const png = new PNG({ width: 50, height: 50 });
      const padded = padImage(png, 50, 50);
      expect(padded).toBe(png);
    });

    it('pads smaller width and height with transparent pixels while preserving content', () => {
      const original = new PNG({ width: 10, height: 10 });
      original.data.fill(255); // solid white

      const padded = padImage(original, 20, 30);
      expect(padded.width).toBe(20);
      expect(padded.height).toBe(30);

      // Check original content preserved at (0, 0)
      expect(padded.data[0]).toBe(255);
      expect(padded.data[1]).toBe(255);
      expect(padded.data[2]).toBe(255);
      expect(padded.data[3]).toBe(255);

      // Check padded area at (15, 25) is transparent (RGBA: 0, 0, 0, 0)
      const paddedIdx = (padded.width * 25 + 15) * 4;
      expect(padded.data[paddedIdx]).toBe(0);
      expect(padded.data[paddedIdx + 1]).toBe(0);
      expect(padded.data[paddedIdx + 2]).toBe(0);
      expect(padded.data[paddedIdx + 3]).toBe(0);
    });
  });

  describe('compareImages', () => {
    it('detects a 0% mismatch for identical images', () => {
      const buf1 = createSolidPng(20, 20, 100, 150, 200);
      const buf2 = createSolidPng(20, 20, 100, 150, 200);

      const result = compareImages(buf1, buf2);
      expect(result.mismatchedPixels).toBe(0);
      expect(result.mismatchPercentage).toBe(0);
      expect(result.dimensions.padded).toBe(false);
    });

    it('detects pixel differences and marks them red in the diff image', () => {
      const buf1 = createSolidPng(20, 20, 255, 255, 255); // white
      const buf2 = createSolidPng(20, 20, 0, 0, 0);       // black

      const result = compareImages(buf1, buf2);
      expect(result.mismatchedPixels).toBe(400); // all 20x20 pixels differ
      expect(result.mismatchPercentage).toBe(100);

      // Verify diff image has red pixels (255, 0, 0, 255)
      expect(result.diffPng.data[0]).toBe(255);
      expect(result.diffPng.data[1]).toBe(0);
      expect(result.diffPng.data[2]).toBe(0);
      expect(result.diffPng.data[3]).toBe(255);
    });

    it('handles dimension mismatches by normalizing canvas size without crashing', () => {
      const smallBuf = createSolidPng(20, 20, 255, 255, 255); // 20x20
      const tallBuf = createSolidPng(20, 40, 255, 255, 255);  // 20x40 (grew taller)

      const result = compareImages(smallBuf, tallBuf);
      expect(result.dimensions.padded).toBe(true);
      expect(result.dimensions.diff.width).toBe(20);
      expect(result.dimensions.diff.height).toBe(40);
      expect(result.totalPixels).toBe(800);

      // Top 20x20 matches, bottom 20x20 differs (400 mismatched pixels)
      expect(result.mismatchedPixels).toBe(400);
      expect(result.mismatchPercentage).toBe(50);
    });
  });

  describe('compareSnapshot', () => {
    it('promotes current screenshot to new baseline when baseline does not exist', () => {
      const currentPath = path.join(runsDir, 'index-desktop.png');
      const pngBuf = createSolidPng(10, 10, 50, 100, 150);
      fs.writeFileSync(currentPath, pngBuf);

      const snapshot = {
        route: '/',
        viewport: 'desktop',
        filepath: currentPath
      };

      const result = compareSnapshot(snapshot, {
        baselinesDir,
        diffDir: runsDir
      });

      expect(result.status).toBe('NEW_BASELINE');
      expect(fs.existsSync(result.baselinePath)).toBe(true);
      expect(result.diffPath).toBeNull();
    });

    it('marks snapshot as MATCH when baseline exists and images are identical', () => {
      const baselinePath = path.join(baselinesDir, 'index-desktop.png');
      const currentPath = path.join(runsDir, 'index-desktop.png');
      const pngBuf = createSolidPng(20, 20, 100, 100, 100);

      fs.writeFileSync(baselinePath, pngBuf);
      fs.writeFileSync(currentPath, pngBuf);

      const snapshot = {
        route: '/',
        viewport: 'desktop',
        filepath: currentPath
      };

      const result = compareSnapshot(snapshot, {
        baselinesDir,
        diffDir: runsDir
      });

      expect(result.status).toBe('MATCH');
      expect(result.mismatchedPixels).toBe(0);
      expect(result.mismatchPercentage).toBe(0);
      expect(fs.existsSync(result.diffPath)).toBe(true);
    });

    it('marks snapshot as DIFF when changes exceed allowed threshold', () => {
      const baselinePath = path.join(baselinesDir, 'index-desktop.png');
      const currentPath = path.join(runsDir, 'index-desktop.png');

      fs.writeFileSync(baselinePath, createSolidPng(50, 50, 255, 255, 255));
      fs.writeFileSync(currentPath, createSolidPng(50, 50, 0, 0, 0));

      const snapshot = {
        route: '/',
        viewport: 'desktop',
        filepath: currentPath
      };

      const result = compareSnapshot(snapshot, {
        baselinesDir,
        diffDir: runsDir,
        allowedThreshold: 0.01 // 1% threshold
      });

      expect(result.status).toBe('DIFF');
      expect(result.mismatchPercentage).toBe(100);
      expect(fs.existsSync(result.diffPath)).toBe(true);
    });

    it('tolerates small pixel changes within allowed threshold as MATCH', () => {
      // 100x100 = 10,000 pixels. 0.01 threshold allows up to 100 pixels (1.0%).
      const img1 = new PNG({ width: 100, height: 100 });
      img1.data.fill(255);

      const img2 = new PNG({ width: 100, height: 100 });
      img2.data.fill(255);
      // Alter only 50 pixels out of 10,000 (0.5% mismatch)
      for (let i = 0; i < 50 * 4; i += 4) {
        img2.data[i] = 0;
      }

      const baselinePath = path.join(baselinesDir, 'index-desktop.png');
      const currentPath = path.join(runsDir, 'index-desktop.png');

      fs.writeFileSync(baselinePath, PNG.sync.write(img1));
      fs.writeFileSync(currentPath, PNG.sync.write(img2));

      const snapshot = {
        route: '/',
        viewport: 'desktop',
        filepath: currentPath
      };

      const result = compareSnapshot(snapshot, {
        baselinesDir,
        diffDir: runsDir,
        allowedThreshold: 0.01 // 1.0% threshold
      });

      expect(result.status).toBe('MATCH');
      expect(result.mismatchPercentage).toBe(0.5);
    });

    it('allows baseline update by overwriting existing baseline file', () => {
      const baselinePath = path.join(baselinesDir, 'index-desktop.png');
      const currentPath = path.join(runsDir, 'index-desktop.png');

      // Baseline was white
      fs.writeFileSync(baselinePath, createSolidPng(20, 20, 255, 255, 255));
      // Current is blue
      fs.writeFileSync(currentPath, createSolidPng(20, 20, 0, 0, 255));

      // Update baseline by copying current over baseline
      fs.copyFileSync(currentPath, baselinePath);

      // Now re-running comparison yields MATCH
      const snapshot = {
        route: '/',
        viewport: 'desktop',
        filepath: currentPath
      };

      const result = compareSnapshot(snapshot, {
        baselinesDir,
        diffDir: runsDir,
        allowedThreshold: 0.01
      });

      expect(result.status).toBe('MATCH');
      expect(result.mismatchedPixels).toBe(0);
      expect(result.mismatchPercentage).toBe(0);
    });
  });
});
