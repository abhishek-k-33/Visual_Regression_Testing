import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';

const execFileAsync = promisify(execFile);

const HOST = '127.0.0.1';
const FIXTURE_PATH = path.resolve(process.cwd(), 'tests/fixtures/index.html');
const fixtureHtml = fs.readFileSync(FIXTURE_PATH, 'utf8');

console.log('[VERIFY] Starting local fixture HTTP server...');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fixtureHtml);
});

server.listen(0, HOST, async () => {
  const port = server.address().port;
  console.log(`[VERIFY] Fixture server running at http://${HOST}:${port}`);

  try {
    console.log('[VERIFY] Executing CLI capture command asynchronously...');

    const cliPath = path.resolve(process.cwd(), 'src/cli/index.js');
    const { stdout, stderr } = await execFileAsync('node', [
      cliPath,
      'capture',
      '--run-id',
      'test-init',
      '--base-url',
      `http://${HOST}:${port}`
    ], {
      encoding: 'utf8',
      env: process.env
    });

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    // Verify generated files
    const desktopFile = path.resolve(process.cwd(), 'storage/runs/test-init/index-desktop.png');
    const mobileFile = path.resolve(process.cwd(), 'storage/runs/test-init/index-mobile.png');

    console.log('[VERIFY] Verifying desktop snapshot...');
    if (!fs.existsSync(desktopFile)) {
      throw new Error(`Desktop snapshot not found at: ${desktopFile}`);
    }
    const desktopBuffer = fs.readFileSync(desktopFile);
    const desktopPng = PNG.sync.read(desktopBuffer);
    console.log(`  ✓ Desktop image valid: ${desktopPng.width}x${desktopPng.height} (${(desktopBuffer.length / 1024).toFixed(1)} KB)`);

    if (desktopPng.width !== 1440) {
      throw new Error(`Expected desktop width 1440, received ${desktopPng.width}`);
    }

    console.log('[VERIFY] Verifying mobile snapshot...');
    if (!fs.existsSync(mobileFile)) {
      throw new Error(`Mobile snapshot not found at: ${mobileFile}`);
    }
    const mobileBuffer = fs.readFileSync(mobileFile);
    const mobilePng = PNG.sync.read(mobileBuffer);
    console.log(`  ✓ Mobile image valid: ${mobilePng.width}x${mobilePng.height} (${(mobileBuffer.length / 1024).toFixed(1)} KB)`);

    if (mobilePng.width !== 375) {
      throw new Error(`Expected mobile width 375, received ${mobilePng.width}`);
    }

    console.log('\n======================================================');
    console.log('  PHASE 1 DELIVERABLE VERIFICATION: ALL CHECKS PASSED!');
    console.log('======================================================\n');
  } catch (err) {
    console.error('\n[VERIFY ERROR]', err.message);
    process.exitCode = 1;
  } finally {
    server.close(() => {
      console.log('[VERIFY] Fixture server closed.');
    });
  }
});
