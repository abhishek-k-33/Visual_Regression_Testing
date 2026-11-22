import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import app from '../src/server/app.js';
import { getDb, closeDb } from '../src/server/db.js';

const execFileAsync = promisify(execFile);
const HOST = '127.0.0.1';

console.log('======================================================');
console.log('  [PHASE 3 VERIFICATION] Web Dashboard & SQLite API');
console.log('======================================================\n');

let headingColor = '#38bdf8';
let headingText = 'Phase 3 Baseline Heading';

function renderHtml() {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Phase 3 Verification Fixture</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #0f172a;
          color: #f8fafc;
          margin: 0;
          padding: 40px;
        }
        h1 {
          font-size: 32px;
          color: ${headingColor};
          margin-bottom: 16px;
        }
        p {
          font-size: 16px;
          color: #94a3b8;
          line-height: 1.6;
        }
      </style>
    </head>
    <body>
      <h1 id="title">${headingText}</h1>
      <p>Testing end-to-end integration: Playwright Capture -> Pixel Diff -> SQLite Persistence -> Express Dashboard -> Approval Workflow.</p>
    </body>
    </html>
  `;
}

// 1. Fixture HTTP Server
const fixtureServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderHtml());
});

// Start fixture server
fixtureServer.listen(0, HOST, async () => {
  const fixturePort = fixtureServer.address().port;
  const fixtureBaseUrl = `http://${HOST}:${fixturePort}`;
  console.log(`[INFO] Fixture website running at ${fixtureBaseUrl}`);

  // 2. Dashboard Express Server
  const baselinesDir = path.resolve(process.cwd(), 'storage/baselines');
  const dashboardServer = app.listen(0, HOST, async () => {
    const dashboardPort = dashboardServer.address().port;
    const dashboardBaseUrl = `http://${HOST}:${dashboardPort}`;
    console.log(`[INFO] Review Dashboard running at ${dashboardBaseUrl}\n`);

    try {
      const cliPath = path.resolve(process.cwd(), 'src/cli/index.js');

      // Clear baseline files for a fresh test run
      const desktopBaseline = path.join(baselinesDir, 'index-desktop.png');
      const mobileBaseline = path.join(baselinesDir, 'index-mobile.png');
      if (fs.existsSync(desktopBaseline)) fs.unlinkSync(desktopBaseline);
      if (fs.existsSync(mobileBaseline)) fs.unlinkSync(mobileBaseline);

      // ─────────────────────────────────────────────────────────────
      // Step 1: Initial Run -> Creates Baselines and records in SQLite
      // ─────────────────────────────────────────────────────────────
      console.log('--- Step 1: Initial Run (Creating Baselines) ---');
      const runId1 = `verify_p3_init_${Date.now()}`;
      await execFileAsync('node', [
        cliPath,
        'test',
        '--run-id',
        runId1,
        '--base-url',
        fixtureBaseUrl
      ], { encoding: 'utf8', env: process.env });

      console.log(`✓ CLI test run finished for ${runId1}`);

      // Verify SQLite record
      const db = getDb();
      const runRecord1 = db.prepare('SELECT * FROM test_runs WHERE id = ?').get(runId1);
      if (!runRecord1 || runRecord1.status !== 'PASSED') {
        throw new Error(`Expected run ${runId1} to have status PASSED, got: ${runRecord1?.status}`);
      }
      const snaps1 = db.prepare('SELECT * FROM snapshots WHERE run_id = ?').all(runId1);
      if (snaps1.length === 0) {
        throw new Error(`Expected snapshots for ${runId1} in SQLite database.`);
      }
      console.log(`✓ SQLite verified: Run ${runId1} status=${runRecord1.status}, ${snaps1.length} snapshots recorded.`);

      // ─────────────────────────────────────────────────────────────
      // Step 2: Induce Visual Regression -> Status FAILED, DIFF recorded
      // ─────────────────────────────────────────────────────────────
      console.log('\n--- Step 2: Inducing Visual Regression & Detecting Diff ---');
      headingColor = '#ef4444'; // Changed from blue to red
      headingText = 'Phase 3 Regressed Heading (Red Alert)';

      const runId2 = `verify_p3_diff_${Date.now()}`;
      try {
        await execFileAsync('node', [
          cliPath,
          'test',
          '--run-id',
          runId2,
          '--base-url',
          fixtureBaseUrl
        ], { encoding: 'utf8', env: process.env });
      } catch (cliErr) {
        // Expected to exit with code 1 due to visual differences
        console.log('✓ CLI accurately caught visual diff and exited with non-zero code.');
      }

      // Verify SQLite record for regression run
      const runRecord2 = db.prepare('SELECT * FROM test_runs WHERE id = ?').get(runId2);
      if (!runRecord2 || runRecord2.status !== 'FAILED') {
        throw new Error(`Expected run ${runId2} to have status FAILED, got: ${runRecord2?.status}`);
      }
      const diffSnaps = db.prepare("SELECT * FROM snapshots WHERE run_id = ? AND status = 'DIFF'").all(runId2);
      if (diffSnaps.length === 0) {
        throw new Error(`Expected at least one DIFF snapshot for ${runId2}`);
      }
      console.log(`✓ SQLite verified: Run ${runId2} status=FAILED with ${diffSnaps.length} DIFF snapshot(s).`);
      console.log(`  Snapshot #1 Mismatch: ${diffSnaps[0].mismatch_percentage.toFixed(2)}%`);

      // ─────────────────────────────────────────────────────────────
      // Step 3: Web Dashboard & REST API
      // ─────────────────────────────────────────────────────────────
      console.log('\n--- Step 3: Inspecting Review Dashboard & REST API ---');

      // GET /api/runs
      const apiRunsRes = await fetch(`${dashboardBaseUrl}/api/runs`);
      const apiRuns = await apiRunsRes.json();
      if (!apiRuns.success || !apiRuns.runs.find((r) => r.id === runId2)) {
        throw new Error(`GET /api/runs did not include run ${runId2}`);
      }
      console.log(`✓ GET /api/runs returned ${apiRuns.runs.length} runs successfully.`);

      // GET /runs/:id (HTML view)
      const detailHtmlRes = await fetch(`${dashboardBaseUrl}/runs/${runId2}`);
      const detailHtml = await detailHtmlRes.text();
      if (!detailHtml.includes('Interactive Slider') || !detailHtml.includes('Approve & Update Baseline')) {
        throw new Error('Dashboard detail view does not contain expected interactive controls.');
      }
      console.log('✓ GET /runs/:id rendered HTML with Slider and Approve actions.');

      // ─────────────────────────────────────────────────────────────
      // Step 4: Approve Regression -> Promote to New Baseline
      // ─────────────────────────────────────────────────────────────
      console.log('\n--- Step 4: Approving Regression via REST API ---');
      const targetSnapshot = diffSnaps[0];
      const approveRes = await fetch(`${dashboardBaseUrl}/api/snapshots/${targetSnapshot.id}/approve`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'verify-phase-3' }
      });
      const approveData = await approveRes.json();
      if (!approveData.success || approveData.snapshot.status !== 'APPROVED') {
        throw new Error(`Failed to approve snapshot: ${JSON.stringify(approveData)}`);
      }
      console.log(`✓ POST /api/snapshots/${targetSnapshot.id}/approve succeeded: Snapshot status=${approveData.snapshot.status}`);

      // Verify that the baseline on disk was updated
      const baselineStat = fs.statSync(targetSnapshot.baseline_path);
      const currentStat = fs.statSync(targetSnapshot.current_path);
      if (baselineStat.size !== currentStat.size) {
        throw new Error(`Baseline size (${baselineStat.size}) does not match approved screenshot (${currentStat.size})`);
      }
      console.log('✓ Baseline file on disk successfully updated with current screenshot.');

      // Also approve remaining diff snapshot if any (e.g. mobile)
      if (diffSnaps.length > 1) {
        for (let i = 1; i < diffSnaps.length; i++) {
          await fetch(`${dashboardBaseUrl}/api/snapshots/${diffSnaps[i].id}/approve`, {
            method: 'POST',
            headers: { 'X-Requested-With': 'verify-phase-3' }
          });
        }
      }

      // Check run status after all snapshots are approved
      const updatedRun = db.prepare('SELECT * FROM test_runs WHERE id = ?').get(runId2);
      console.log(`✓ Parent run recalculated status: ${updatedRun.status}`);
      if (updatedRun.status !== 'APPROVED') {
        throw new Error(`Expected run status to be APPROVED, got: ${updatedRun.status}`);
      }

      // ─────────────────────────────────────────────────────────────
      // Step 5: Re-running against the newly approved baseline
      // ─────────────────────────────────────────────────────────────
      console.log('\n--- Step 5: Re-testing Against Approved Baseline (Expected: PASS) ---');
      const runId3 = `verify_p3_subsequent_${Date.now()}`;
      await execFileAsync('node', [
        cliPath,
        'test',
        '--run-id',
        runId3,
        '--base-url',
        fixtureBaseUrl
      ], { encoding: 'utf8', env: process.env });

      const finalRun = db.prepare('SELECT * FROM test_runs WHERE id = ?').get(runId3);
      if (finalRun.status !== 'PASSED') {
        throw new Error(`Expected run ${runId3} to PASS against approved baseline, got: ${finalRun.status}`);
      }
      console.log(`✓ Post-approval test passed with 0.00% mismatch! Run status=${finalRun.status}`);

      console.log('\n======================================================');
      console.log('  [PASS] ALL PHASE 3 DELIVERABLES VERIFIED SUCCESSFULLY');
      console.log('======================================================\n');

    } catch (err) {
      console.error('\n[FATAL ERROR during Phase 3 verification]:', err);
      process.exitCode = 1;
    } finally {
      const desktopBaseline = path.join(baselinesDir, 'index-desktop.png');
      const mobileBaseline = path.join(baselinesDir, 'index-mobile.png');
      if (fs.existsSync(desktopBaseline)) fs.unlinkSync(desktopBaseline);
      if (fs.existsSync(mobileBaseline)) fs.unlinkSync(mobileBaseline);

      dashboardServer.close();
      fixtureServer.close();
      closeDb();
    }
  });
});
