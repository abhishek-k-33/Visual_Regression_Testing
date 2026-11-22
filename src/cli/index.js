#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { captureScreenshots, getSnapshotFilename } from './capture.js';
import { compareSnapshot } from './compare.js';
import { createTestRun, createSnapshot } from '../server/db.js';
import { generateSummaryMarkdown, writeSummaryReport } from './reporter.js';

function getGitContext() {
  const envBranch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  const envSha = process.env.GITHUB_SHA ? process.env.GITHUB_SHA.substring(0, 7) : null;
  try {
    const branch = envBranch || execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const commit_hash = envSha || execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { branch, commit_hash };
  } catch {
    return { branch: envBranch || null, commit_hash: envSha || null };
  }
}

const NOT_IDLE_NOTE = '      (page never went network-idle, e.g. analytics or long-polling; captured after the load event)';

const program = new Command();

program
  .name('visual-ci')
  .description('Visual Regression Testing Engine & CI Tool')
  .version('1.0.0');

program
  .command('capture')
  .description('Capture deterministic full-page screenshots across configured viewports')
  .option('-c, --config <path>', 'Path to visual.config.json')
  .option('-r, --run-id <id>', 'Identifier for the test run')
  .option('-u, --base-url <url>', 'Override target baseUrl')
  .option('-o, --output-dir <path>', 'Custom directory to store output screenshots')
  .action(async (options) => {
    try {
      const overrides = {};
      if (options.baseUrl) {
        overrides.baseUrl = options.baseUrl;
      }

      const config = loadConfig(options.config, overrides);
      const runId = options.runId || `run_${Date.now()}`;

      console.log('──────────────────────────────────────────────────────');
      console.log('  Visual Regression Testing Tool: Headless Capture');
      console.log('──────────────────────────────────────────────────────');
      console.log(`  Target Base URL : ${config.baseUrl}`);
      console.log(`  Routes          : ${config.routes.join(', ')}`);
      console.log(`  Viewports       : ${config.viewports.map((v) => `${v.name} (${v.width}x${v.height})`).join(', ')}`);
      console.log(`  Mask Selectors  : ${config.maskSelectors.length > 0 ? config.maskSelectors.join(', ') : '(none)'}`);
      console.log(`  Run ID          : ${runId}`);
      console.log('──────────────────────────────────────────────────────\n');

      const startTime = Date.now();

      const results = await captureScreenshots(config, {
        runId,
        outputDir: options.outputDir,
        onProgress: (snap) => {
          const relPath = path.relative(process.cwd(), snap.filepath);
          console.log(`  [OK] ${snap.route} @ ${snap.viewport} (${snap.width}x${snap.height}) -> ${relPath}`);
          if (!snap.networkIdle) console.log(NOT_IDLE_NOTE);
        }
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log('\n──────────────────────────────────────────────────────');
      console.log(`  Capture Complete: ${results.length} screenshots saved in ${elapsed}s`);
      console.log('──────────────────────────────────────────────────────\n');
    } catch (err) {
      console.error(`\n[ERROR] Capture failed: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('test')
  .description('Capture screenshots and compare against baseline golden masters')
  .option('-c, --config <path>', 'Path to visual.config.json')
  .option('-r, --run-id <id>', 'Identifier for the test run')
  .option('-u, --base-url <url>', 'Override target baseUrl')
  .option('--update-baselines', 'Promote all current screenshots to baseline images')
  .option('-s, --summary-file <path>', 'Custom file name or relative path for markdown summary')
  .action(async (options) => {
    try {
      const overrides = {};
      if (options.baseUrl) {
        overrides.baseUrl = options.baseUrl;
      }

      const config = loadConfig(options.config, overrides);
      const runId = options.runId || `run_${Date.now()}`;
      const baselinesDir = path.resolve(process.cwd(), config.storageDir, 'baselines');
      const runsDir = path.resolve(process.cwd(), config.storageDir, 'runs', runId);

      console.log('──────────────────────────────────────────────────────');
      console.log('  Visual Regression Testing Tool: Compare & Test');
      console.log('──────────────────────────────────────────────────────');
      console.log(`  Target Base URL : ${config.baseUrl}`);
      console.log(`  Routes          : ${config.routes.join(', ')}`);
      console.log(`  Viewports       : ${config.viewports.map((v) => `${v.name} (${v.width}x${v.height})`).join(', ')}`);
      console.log(`  Threshold       : ${config.threshold * 100}%`);
      console.log(`  Run ID          : ${runId}`);
      console.log('──────────────────────────────────────────────────────\n');

      const startTime = Date.now();

      console.log('  Step 1: Capturing screenshots...');
      const snapshots = await captureScreenshots(config, {
        runId,
        onProgress: (snap) => {
          console.log(`    📸 Captured ${snap.route} @ ${snap.viewport}`);
          if (!snap.networkIdle) console.log(NOT_IDLE_NOTE);
        }
      });

      console.log('\n  Step 2: Comparing against baselines...');
      const results = [];
      let passedCount = 0;
      let failedCount = 0;
      let newBaselineCount = 0;

      for (const snap of snapshots) {
        if (options.updateBaselines) {
          fs.mkdirSync(baselinesDir, { recursive: true });
          const baselineFilename = getSnapshotFilename(snap.route, snap.viewport);
          const baselinePath = path.join(baselinesDir, baselineFilename);
          fs.copyFileSync(snap.filepath, baselinePath);
          console.log(`    [UPDATED BASELINE] ${snap.route} @ ${snap.viewport}`);
          newBaselineCount++;
          results.push({ ...snap, status: 'NEW_BASELINE', mismatchPercentage: 0, baselinePath });
          continue;
        }

        const comp = compareSnapshot(snap, {
          baselinesDir,
          diffDir: runsDir,
          allowedThreshold: config.threshold
        });

        results.push(comp);

        if (comp.status === 'NEW_BASELINE') {
          newBaselineCount++;
          console.log(`    [NEW BASELINE] ${comp.route} @ ${comp.viewport} -> Baseline created`);
        } else if (comp.status === 'MATCH') {
          passedCount++;
          console.log(`    [PASS] ${comp.route} @ ${comp.viewport} (${comp.mismatchPercentage.toFixed(2)}% mismatch)`);
        } else {
          failedCount++;
          console.log(`    [FAIL] ${comp.route} @ ${comp.viewport} (${comp.mismatchPercentage.toFixed(2)}% mismatch > ${config.threshold * 100}% threshold)`);
        }
      }

      const gitInfo = getGitContext();

      // Record test run & snapshots in SQLite database for web review dashboard
      try {
        const overallStatus = failedCount > 0 ? 'FAILED' : 'PASSED';

        createTestRun({
          id: runId,
          commit_hash: gitInfo.commit_hash,
          branch: gitInfo.branch,
          status: overallStatus
        });

        for (const r of results) {
          createSnapshot({
            run_id: runId,
            route: r.route,
            viewport: r.viewport,
            baseline_path: r.baselinePath || null,
            current_path: r.currentPath || r.filepath,
            diff_path: r.diffPath || null,
            mismatch_percentage: r.mismatchPercentage || 0,
            status: r.status
          });
        }
      } catch (dbErr) {
        console.warn(`  [WARN] Failed to record run in database: ${dbErr.message}`);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

      // Generate GitHub-flavored markdown summary report
      const summaryMarkdown = generateSummaryMarkdown({
        runId,
        gitInfo,
        threshold: config.threshold,
        elapsed,
        passedCount,
        failedCount,
        newBaselineCount,
        results
      });

      const summaryOptions = { runsDir };
      if (options.summaryFile) {
        summaryOptions.summaryFileName = options.summaryFile;
      }
      const { runSummaryPath, stepSummaryWritten } = writeSummaryReport(summaryMarkdown, summaryOptions);

      console.log('\n──────────────────────────────────────────────────────');
      console.log('  Visual Regression Test Summary');
      console.log('──────────────────────────────────────────────────────');
      console.log(`  Total Snapshots  : ${results.length}`);
      console.log(`  Passed (Match)   : ${passedCount}`);
      console.log(`  Failed (Diff)    : ${failedCount}`);
      console.log(`  New Baselines    : ${newBaselineCount}`);
      console.log(`  Execution Time   : ${elapsed}s`);
      console.log('──────────────────────────────────────────────────────');
      console.log(`  Review Dashboard : http://localhost:4000/runs/${runId}`);
      if (runSummaryPath) {
        const relSummary = path.relative(process.cwd(), runSummaryPath);
        console.log(`  Summary Report   : ${relSummary}`);
      }
      if (stepSummaryWritten) {
        console.log('  CI Step Summary  : Appended to GITHUB_STEP_SUMMARY');
      }
      console.log('──────────────────────────────────────────────────────\n');

      if (failedCount > 0) {
        console.error(`[FAILURE] Visual regressions detected in ${failedCount} snapshot(s).\n`);
        process.exit(1);
      } else {
        console.log('[SUCCESS] All snapshots passed without visual regressions!\n');
        process.exit(0);
      }
    } catch (err) {
      console.error(`\n[ERROR] Test run failed: ${err.message}\n`);
      process.exit(1);
    }
  });

// Fallback / default action
if (process.argv.length <= 2) {
  program.help();
} else {
  program.parse(process.argv);
}
