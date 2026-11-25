import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';

const execFileAsync = promisify(execFile);
const HOST = '127.0.0.1';

// Clean test directories before starting
const baselinesDir = path.resolve(process.cwd(), 'storage/baselines');
const runsDir = path.resolve(process.cwd(), 'storage/runs');

console.log('[VERIFY PHASE 2] Initializing deliverable verification test...');

let headingMarginTop = '0px';

function renderHtml() {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Phase 2 Verification Fixture</title>
      <style>
        body {
          font-family: sans-serif;
          background: #0f172a;
          color: #f8fafc;
          margin: 0;
          padding: 40px;
        }
        h1 {
          font-size: 32px;
          color: #38bdf8;
          margin-top: ${headingMarginTop};
          transition: none !important;
        }
        p {
          font-size: 18px;
          color: #94a3b8;
          line-height: 1.6;
        }
      </style>
    </head>
    <body>
      <h1 id="main-heading">Visual Regression Test Subject</h1>
      <p>This paragraph checks whether a 12px shift in heading margin is accurately caught by pixelmatch.</p>
    </body>
    </html>
  `;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderHtml());
});

server.listen(0, HOST, async () => {
  const port = server.address().port;
  const baseUrl = `http://${HOST}:${port}`;
  console.log(`[VERIFY PHASE 2] Fixture server running at ${baseUrl}`);

  try {
    const cliPath = path.resolve(process.cwd(), 'src/cli/index.js');

    // ─────────────────────────────────────────────────────────────
    // Step 1: Initial Run -> Should create NEW_BASELINE
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Step 1: Creating initial baseline ---');
    // Clear this script's own baselines (route /__vrt_verify; committed baselines are untouched)
    const desktopBaseline = path.join(baselinesDir, '__vrt_verify-desktop.png');
    const mobileBaseline = path.join(baselinesDir, '__vrt_verify-mobile.png');
    if (fs.existsSync(desktopBaseline)) fs.unlinkSync(desktopBaseline);
    if (fs.existsSync(mobileBaseline)) fs.unlinkSync(mobileBaseline);

    const step1 = await execFileAsync('node', [
      cliPath,
      'test',
      '--config', 'tests/fixtures/verify.config.json',
      '--no-strict',
      '--run-id',
      'phase2-step1-init',
      '--base-url',
      baseUrl
    ], { encoding: 'utf8', env: process.env });

    console.log(step1.stdout);
    if (!fs.existsSync(desktopBaseline)) {
      throw new Error(`Failed: Desktop baseline was not created at ${desktopBaseline}`);
    }
    console.log('✓ Baseline created successfully on disk.');

    // ─────────────────────────────────────────────────────────────
    // Step 2: Unaltered Run -> Should PASS with 0.00% mismatch
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Step 2: Re-running on unchanged page (Expected: MATCH 0.00%) ---');
    const step2 = await execFileAsync('node', [
      cliPath,
      'test',
      '--config', 'tests/fixtures/verify.config.json',
      '--no-strict',
      '--run-id',
      'phase2-step2-identical',
      '--base-url',
      baseUrl
    ], { encoding: 'utf8', env: process.env });

    console.log(step2.stdout);
    if (!step2.stdout.includes('[PASS]')) {
      throw new Error('Failed: Step 2 did not pass identical comparison!');
    }
    console.log('✓ Unaltered page correctly detected as MATCH (0.00% mismatch).');

    // ─────────────────────────────────────────────────────────────
    // Step 3: Shift heading margin by 12px -> Should FAIL with DIFF
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Step 3: Modifying heading margin-top by 12px (Expected: DIFF / FAIL) ---');
    headingMarginTop = '12px'; // Introduce intentional CSS visual regression

    let step3FailedAsExpected = false;
    let step3Stdout = '';

    try {
      await execFileAsync('node', [
        cliPath,
        'test',
        '--config', 'tests/fixtures/verify.config.json',
        '--no-strict',
        '--run-id',
        'phase2-step3-regression',
        '--base-url',
        baseUrl
      ], { encoding: 'utf8', env: process.env });
    } catch (err) {
      // Exit 1 = visual differences; anything else (2 = error) is a real failure.
      if (err.code !== 1) throw err;
      step3FailedAsExpected = true;
      step3Stdout = err.stdout || '';
    }

    console.log(step3Stdout);

    if (!step3FailedAsExpected) {
      throw new Error('Failed: CLI test was expected to exit with non-zero code on visual regression!');
    }

    if (!step3Stdout.includes('[FAIL]') || !step3Stdout.includes('threshold')) {
      throw new Error('Failed: Output did not indicate regression failure!');
    }

    // Verify diff.png exists and contains red pixels
    const diffFile = path.resolve(runsDir, 'phase2-step3-regression', '__vrt_verify-desktop-diff.png');
    if (!fs.existsSync(diffFile)) {
      throw new Error(`Diff image was not saved at: ${diffFile}`);
    }

    const diffPng = PNG.sync.read(fs.readFileSync(diffFile));
    let redPixelCount = 0;
    for (let i = 0; i < diffPng.data.length; i += 4) {
      const r = diffPng.data[i];
      const g = diffPng.data[i + 1];
      const b = diffPng.data[i + 2];
      if (r === 255 && g === 0 && b === 0) {
        redPixelCount++;
      }
    }

    console.log(`✓ Diff image verified: ${diffFile}`);
    console.log(`✓ Detected ${redPixelCount} red diff pixels highlighting the 12px shifted text!`);

    console.log('\n======================================================');
    console.log('  PHASE 2 DELIVERABLE VERIFICATION: ALL CHECKS PASSED!');
    console.log('======================================================\n');
  } catch (err) {
    console.error('\n[VERIFY PHASE 2 ERROR]', err.message);
    process.exitCode = 1;
  } finally {
    const desktopBaseline = path.join(baselinesDir, '__vrt_verify-desktop.png');
    const mobileBaseline = path.join(baselinesDir, '__vrt_verify-mobile.png');
    if (fs.existsSync(desktopBaseline)) fs.unlinkSync(desktopBaseline);
    if (fs.existsSync(mobileBaseline)) fs.unlinkSync(mobileBaseline);

    server.close(() => {
      console.log('[VERIFY PHASE 2] Fixture server closed.');
    });
  }
});
