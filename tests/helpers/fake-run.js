/**
 * Writes a valid CI run folder (images + run.json, as `visual-ci test` would) without a
 * browser, for import/upload tests:
 *
 *   writeFakeRun(dir, { runId: 'ci_1', padBytes: 0 })
 *     -> dir/<runId>/{index-desktop.png, index-desktop-diff.png, baselines/index-desktop.png, run.json}
 *
 * padBytes > 0 appends that many zero bytes to each image (still a valid PNG header,
 * which is all the importer inspects) to make a large but cheap artifact.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { buildRunManifest, writeRunManifest } from '../../src/cli/manifest.js';

function png(rgb, padBytes) {
  const img = new PNG({ width: 64, height: 48 });
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = rgb[0];
    img.data[i + 1] = rgb[1];
    img.data[i + 2] = rgb[2];
    img.data[i + 3] = 255;
  }
  const buf = PNG.sync.write(img);
  return padBytes > 0 ? Buffer.concat([buf, Buffer.alloc(padBytes)]) : buf;
}

/**
 * @returns {{ runDir: string, manifest: object }}
 */
export function writeFakeRun(dir, { runId = 'ci_fake', padBytes = 0, branch = 'main', createdAt = new Date('2026-11-24T08:00:00Z') } = {}) {
  const runDir = path.join(dir, runId);
  const baselinesDir = path.join(dir, '.shared-baselines'); // only for the relative "baseline" name
  const file = 'index-desktop.png';
  const current = path.join(runDir, file);
  const diff = path.join(runDir, 'index-desktop-diff.png');
  const baselineCopy = path.join(runDir, 'baselines', file);
  fs.mkdirSync(path.dirname(baselineCopy), { recursive: true });
  fs.writeFileSync(current, png([200, 30, 30], padBytes));
  fs.writeFileSync(diff, png([255, 0, 0], padBytes));
  const baselineBytes = png([30, 30, 200], padBytes);
  fs.writeFileSync(baselineCopy, baselineBytes);

  const manifest = buildRunManifest({
    runId,
    createdAt,
    gitInfo: { branch, commit_sha: 'abcdef0123456789abcdef0123456789abcdef01', commit_hash: 'abcdef0' },
    status: 'FAILED',
    threshold: 0.01,
    pixelmatchThreshold: 0.1,
    strict: true,
    mode: 'compare',
    runDir,
    baselinesDir,
    results: [{
      route: '/', viewport: 'desktop', width: 64, height: 48, status: 'DIFF',
      mismatchPercentage: 100, mismatchedPixels: 3072, totalPixels: 3072,
      currentPath: current, diffPath: diff, baselineSnapshotPath: baselineCopy,
      baselinePath: path.join(baselinesDir, file),
      baselineSha256: crypto.createHash('sha256').update(baselineBytes).digest('hex')
    }]
  });
  writeRunManifest(manifest, runDir);
  return { runDir, manifest };
}
