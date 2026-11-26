#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig, readConfiguredStorageDir } from './config.js';
import { captureScreenshots, getSnapshotFilename, assertValidRunId } from './capture.js';
import { compareSnapshot, sha256, DEFAULT_PIXELMATCH_THRESHOLD } from './compare.js';
import { buildRunManifest, writeRunManifest, toSqliteTimestamp, getToolVersion, MANIFEST_FILENAME } from './manifest.js';
import { createTestRun, createSnapshot, getDb, closeDb } from '../server/db.js';
import { importRuns } from '../server/importRuns.js';
import { sanitizeForDisplay } from '../shared/text.js';
import { resolveStorageRoot } from '../server/paths.js';
import { generateSummaryMarkdown, writeSummaryReport } from './reporter.js';
import { EXIT, STDOUT_TARGET, CliError, buildResult, writeResult, sanitizeMessage, redactUrl, toError } from './result.js';
import { jsonTargetConflict, jsonTargetShapeProblem } from './jsonTarget.js';
import { createLogger } from './logger.js';
import { toDisplayPath } from './display.js';

/**
 * The --json result still owed if the command ends in an error or a crash: set once
 * the target is accepted, cleared once a result was written. state() returns what is
 * known so far ({ run, results }); conflict() re-checks the target right before writing.
 */
let pendingJson = null;

/** Writes the pending --json result for an error (synchronously: safe right before process.exit). */
function writePendingJson(error) {
  const pending = pendingJson;
  pendingJson = null; // at most once
  if (!pending) return;
  try {
    const conflict = pending.conflict();
    if (conflict) {
      console.error(`[ERROR] Not writing the JSON result: ${sanitizeMessage(conflict)}\n`);
      return;
    }
    writeResult(buildResult({ command: pending.command, error: toError(error), ...pending.state() }), pending.target);
  } catch (writeErr) {
    console.error(`[ERROR] Could not write the JSON result to ${sanitizeMessage(pending.target)}: ${sanitizeMessage(String(writeErr?.message ?? writeErr))}\n`);
  }
}

// Anything that escapes the command handlers is a crash: exit 2, never 1 (which means
// "visual differences"), and the --json result (if one is owed) says so too.
function crash(kind) {
  return (reason) => {
    try {
      console.error(`\n[ERROR] ${kind}: ${sanitizeMessage(String(reason?.stack ?? reason))}\n`);
      writePendingJson(reason);
    } finally {
      process.exit(EXIT.ERROR);
    }
  };
}
process.on('unhandledRejection', crash('Unhandled promise rejection'));
process.on('uncaughtException', crash('Uncaught exception'));

function getGitContext() {
  const envBranch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  const envFullSha = process.env.GITHUB_SHA || null;
  try {
    const branch = envBranch || execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const commit_sha = envFullSha || execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { branch, commit_sha, commit_hash: commit_sha.substring(0, 7) };
  } catch {
    return { branch: envBranch || null, commit_sha: envFullSha, commit_hash: envFullSha ? envFullSha.substring(0, 7) : null };
  }
}

const NOT_IDLE_NOTE = '      (page never went network-idle, e.g. analytics or long-polling; captured after the load event)';

const program = new Command();

// Usage errors (unknown option, missing argument...) exit 2; --help and --version exit 0.
// Set before the subcommands are added so they inherit it.
program.exitOverride((err) => process.exit(err.exitCode === 0 ? EXIT.PASS : EXIT.ERROR));

program
  .name('visual-ci')
  .description('Visual Regression Testing Engine & CI Tool')
  .version(getToolVersion());

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
      console.log(`  Target Base URL : ${redactUrl(config.baseUrl)}`);
      console.log(`  Routes          : ${config.routes.join(', ')}`);
      console.log(`  Viewports       : ${config.viewports.map((v) => `${v.name} (${v.width}x${v.height})`).join(', ')}`);
      console.log(`  Mask Selectors  : ${config.maskSelectors.length > 0 ? config.maskSelectors.join(', ') : '(none)'}`);
      console.log(`  Run ID          : ${runId}`);
      console.log('──────────────────────────────────────────────────────\n');

      const startTime = Date.now();

      const results = await captureScreenshots(config, {
        runId,
        outputDir: options.outputDir || path.join(resolveStorageRoot(config.storageDir), 'runs'),
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
      console.error(`\n[ERROR] Capture failed: ${sanitizeMessage(String(err?.message ?? err))}\n`);
      process.exit(EXIT.ERROR);
    }
  });

/**
 * The run folder as far as it can be known before the config is loaded (for the
 * --json guard): storageDir is read on its own, falling back to the default.
 */
function guessRunsDir(options, runId) {
  let storageDir;
  try {
    storageDir = readConfiguredStorageDir(options.config) || undefined;
  } catch {
    storageDir = undefined; // loadConfig reports the problem
  }
  return path.join(resolveStorageRoot(storageDir), 'runs', runId);
}

program
  .command('test')
  .description('Capture screenshots and compare against baseline golden masters')
  .option('-c, --config <path>', 'Path to visual.config.json')
  .option('-r, --run-id <id>', 'Identifier for the test run')
  .option('-u, --base-url <url>', 'Override target baseUrl')
  .option('--update-baselines', 'Promote all current screenshots to baseline images')
  .option('-s, --summary-file <path>', 'Custom file name or relative path for markdown summary')
  .option('--strict', 'Fail on missing baselines instead of creating them (default when CI=true)')
  .option('--no-strict', 'Create missing baselines from the current screenshots, even in CI')
  .option('--json <file>', 'Also write a machine-readable result (schema visual-ci-result v1) to <file> (relative to the working directory); "-" writes it to stdout and moves all other output to stderr')
  .action(async (options) => {
    const jsonTarget = options.json;
    const log = createLogger({ stdoutReserved: jsonTarget === STDOUT_TARGET });
    const startTime = Date.now();
    const results = [];
    let run = null; // what the JSON result reports about the run, once it is known
    let runsDir = null; // the run folder: guessed before the config is loaded, then exact
    const checkJsonTarget = () => jsonTargetConflict(jsonTarget, { runsDir, summaryFile: options.summaryFile });
    const refuseJsonTarget = (message) => {
      pendingJson = null; // never write to (or delete) a refused target
      return new CliError('INVALID_ARGUMENT', message);
    };

    try {
      const shapeProblem = jsonTargetShapeProblem(jsonTarget);
      if (shapeProblem) throw refuseJsonTarget(shapeProblem);
      if (jsonTarget !== undefined) {
        pendingJson = { command: 'test', target: jsonTarget, conflict: checkJsonTarget, state: () => ({ run, results }) };
      }

      const runId = options.runId || `run_${startTime}`;
      assertValidRunId(runId);
      runsDir = guessRunsDir(options, runId);
      const earlyConflict = checkJsonTarget();
      if (earlyConflict) throw refuseJsonTarget(earlyConflict);
      // The target is accepted: remove a result left by an earlier run, so a reused
      // path never shows an old outcome (this run writes a new one, error or not).
      if (jsonTarget !== undefined && jsonTarget !== STDOUT_TARGET) {
        fs.rmSync(path.resolve(process.cwd(), jsonTarget), { force: true });
      }

      const overrides = {};
      if (options.baseUrl) {
        overrides.baseUrl = options.baseUrl;
      }

      const config = loadConfig(options.config, overrides);
      // Same root the dashboard uses (VISUAL_STORAGE_DIR > storageDir > ./storage),
      // so baselines, screenshots and the database always end up together.
      const storageRoot = resolveStorageRoot(config.storageDir);
      const baselinesDir = path.join(storageRoot, 'baselines');
      runsDir = path.join(storageRoot, 'runs', runId);
      const strict = options.strict ?? process.env.CI === 'true';
      const mode = options.updateBaselines ? 'update-baselines' : 'compare';
      // path.join like writeSummaryReport (path.resolve would let "/run.json" through).
      if (options.summaryFile && path.join(runsDir, options.summaryFile) === path.join(runsDir, MANIFEST_FILENAME)) {
        throw new CliError('INVALID_ARGUMENT', `--summary-file cannot be "${options.summaryFile}": that is the run's ${MANIFEST_FILENAME}`);
      }
      const conflict = checkJsonTarget();
      if (conflict) throw refuseJsonTarget(conflict);

      const gitInfo = getGitContext();
      run = {
        id: runId,
        mode,
        strict,
        baseUrl: config.baseUrl,
        gitInfo,
        createdAt: new Date(startTime),
        threshold: config.threshold,
        runDir: runsDir,
        manifestPath: null,
        summaryPath: null
      };

      log.info('──────────────────────────────────────────────────────');
      log.info('  Visual Regression Testing Tool: Compare & Test');
      log.info('──────────────────────────────────────────────────────');
      log.info(`  Target Base URL : ${redactUrl(config.baseUrl)}`);
      log.info(`  Routes          : ${config.routes.join(', ')}`);
      log.info(`  Viewports       : ${config.viewports.map((v) => `${v.name} (${v.width}x${v.height})`).join(', ')}`);
      log.info(`  Threshold       : ${config.threshold * 100}%`);
      log.info(`  Run ID          : ${runId}`);
      log.info(`  Storage         : ${path.relative(process.cwd(), storageRoot) || '.'}`);
      log.info(`  Missing baseline: ${strict ? 'fail (strict)' : 'create from current screenshot'}`);
      log.info('──────────────────────────────────────────────────────\n');

      log.info('  Step 1: Capturing screenshots...');
      const snapshots = await captureScreenshots(config, {
        runId,
        outputDir: path.join(storageRoot, 'runs'),
        onProgress: (snap) => {
          log.info(`    📸 Captured ${snap.route} @ ${snap.viewport}`);
          if (!snap.networkIdle) log.info(NOT_IDLE_NOTE);
        }
      });

      log.info('\n  Step 2: Comparing against baselines...');
      let passedCount = 0;
      let failedCount = 0;
      let newBaselineCount = 0;

      for (const snap of snapshots) {
        if (options.updateBaselines) {
          fs.mkdirSync(baselinesDir, { recursive: true });
          const baselineFilename = getSnapshotFilename(snap.route, snap.viewport);
          const baselinePath = path.join(baselinesDir, baselineFilename);
          fs.copyFileSync(snap.filepath, baselinePath);
          log.info(`    [UPDATED BASELINE] ${snap.route} @ ${snap.viewport}`);
          newBaselineCount++;
          results.push({
            ...snap,
            status: 'NEW_BASELINE',
            mismatchPercentage: 0,
            baselinePath,
            baselineSnapshotPath: snap.filepath,
            baselineSha256: sha256(fs.readFileSync(baselinePath))
          });
          continue;
        }

        const comp = compareSnapshot(snap, {
          baselinesDir,
          diffDir: runsDir,
          allowedThreshold: config.threshold,
          createMissingBaselines: !strict
        });

        results.push({ ...comp, width: snap.width, height: snap.height });

        if (comp.status === 'NEW_BASELINE') {
          newBaselineCount++;
          log.info(`    [NEW BASELINE] ${comp.route} @ ${comp.viewport} -> Baseline created`);
        } else if (comp.status === 'MISSING_BASELINE') {
          failedCount++;
          const rel = path.relative(process.cwd(), comp.baselinePath);
          log.info(`    [FAIL] ${comp.route} @ ${comp.viewport} -> no baseline at ${rel} (create it with --update-baselines and commit it)`);
        } else if (comp.status === 'MATCH') {
          passedCount++;
          log.info(`    [PASS] ${comp.route} @ ${comp.viewport} (${comp.mismatchPercentage.toFixed(2)}% mismatch)`);
        } else {
          failedCount++;
          log.info(`    [FAIL] ${comp.route} @ ${comp.viewport} (${comp.mismatchPercentage.toFixed(2)}% mismatch > ${config.threshold * 100}% threshold)`);
        }
      }

      const overallStatus = failedCount > 0 ? 'FAILED' : 'PASSED';
      const createdAt = new Date();
      run.createdAt = createdAt; // same timestamp as run.json and the database row

      // Machine-readable run record next to the screenshots (travels with CI artifacts).
      // Written before the database so a DB failure can't lose it.
      try {
        run.manifestPath = writeRunManifest(buildRunManifest({
          runId,
          createdAt,
          gitInfo,
          status: overallStatus,
          threshold: config.threshold,
          pixelmatchThreshold: DEFAULT_PIXELMATCH_THRESHOLD,
          strict,
          mode,
          runDir: runsDir,
          baselinesDir,
          results
        }), runsDir);
      } catch (manifestErr) {
        log.warn(`  [WARN] Failed to write run.json: ${manifestErr.message}`);
      }

      // Record test run & snapshots in SQLite database for web review dashboard
      try {
        const db = getDb(path.join(storageRoot, 'data.sqlite'));
        createTestRun({
          id: runId,
          commit_hash: gitInfo.commit_hash,
          branch: gitInfo.branch,
          status: overallStatus,
          created_at: toSqliteTimestamp(createdAt)
        }, db);

        for (const r of results) {
          createSnapshot({
            run_id: runId,
            route: r.route,
            viewport: r.viewport,
            baseline_path: r.baselinePath || null,
            baseline_snapshot_path: r.baselineSnapshotPath || null,
            baseline_sha256: r.baselineSha256 || null,
            current_path: r.currentPath || r.filepath,
            diff_path: r.diffPath || null,
            mismatch_percentage: r.mismatchPercentage || 0,
            status: r.status
          }, db);
        }
      } catch (dbErr) {
        log.warn(`  [WARN] Failed to record run in database: ${dbErr.message}`);
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
      run.summaryPath = runSummaryPath;
      run.durationMs = Date.now() - startTime;

      const result = buildResult({ command: 'test', run, results });
      let jsonFile = null;
      if (jsonTarget !== undefined) {
        // Again now that the run folder exists, so symlinks and hard links resolve.
        const lateConflict = checkJsonTarget();
        if (lateConflict) throw refuseJsonTarget(lateConflict);
        try {
          jsonFile = writeResult(result, jsonTarget);
          pendingJson = null;
        } catch (writeErr) {
          pendingJson = null; // it would fail again
          throw new CliError('INTERNAL', `Could not write the JSON result to ${jsonTarget}: ${writeErr.message}`, { cause: writeErr });
        }
      }

      log.info('\n──────────────────────────────────────────────────────');
      log.info('  Visual Regression Test Summary');
      log.info('──────────────────────────────────────────────────────');
      log.info(`  Total Snapshots  : ${results.length}`);
      log.info(`  Passed (Match)   : ${passedCount}`);
      log.info(`  Failed (Diff)    : ${failedCount}`);
      log.info(`  New Baselines    : ${newBaselineCount}`);
      log.info(`  Execution Time   : ${elapsed}s`);
      log.info('──────────────────────────────────────────────────────');
      log.info(`  Review Dashboard : http://localhost:4000/runs/${runId}`);
      if (runSummaryPath) {
        const relSummary = path.relative(process.cwd(), runSummaryPath);
        log.info(`  Summary Report   : ${relSummary}`);
      }
      if (jsonFile && jsonFile !== STDOUT_TARGET) {
        log.info(`  JSON Result      : ${toDisplayPath(jsonFile)}`); // absolute when outside the working directory
      }
      if (stepSummaryWritten) {
        log.info('  CI Step Summary  : Appended to GITHUB_STEP_SUMMARY');
      }
      log.info('──────────────────────────────────────────────────────\n');

      if (result.exit_code === EXIT.DIFF) {
        log.error(`[FAILURE] Visual regressions detected in ${failedCount} snapshot(s).\n`);
      } else {
        log.info('[SUCCESS] All snapshots passed without visual regressions!\n');
      }
      process.exit(result.exit_code);
    } catch (err) {
      // If anything here throws, the crash handler still writes the pending JSON and exits 2.
      log.error(`\n[ERROR] Test run failed: ${sanitizeMessage(String(err?.message ?? err))}\n`);
      if (run) run.durationMs = Date.now() - startTime;
      writePendingJson(err);
      process.exit(EXIT.ERROR);
    }
  });

/** Zip (by magic bytes or extension) or folder; a run.json file means its folder. */
function detectImportSource(input) {
  const abs = path.resolve(process.cwd(), input);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`Not found: ${input}`);
  }
  if (st.isDirectory()) return { kind: 'dir', path: abs };
  if (!st.isFile()) throw new Error(`${input} is not a zip file or a folder`);
  if (path.basename(abs) === MANIFEST_FILENAME) return { kind: 'dir', path: path.dirname(abs) };

  const head = Buffer.alloc(4);
  const fd = fs.openSync(abs, 'r');
  try {
    fs.readSync(fd, head, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  const magic = head.toString('latin1');
  if (magic === 'PK\x03\x04' || magic === 'PK\x05\x06' || path.extname(abs).toLowerCase() === '.zip') {
    return { kind: 'zip', file: abs };
  }
  throw new Error(`${input} is not a zip file or a folder`);
}

program
  .command('import')
  .description('Import CI run(s) (the visual-regression-diffs artifact zip, or a run folder) into the local dashboard')
  .argument('<path>', 'Artifact .zip, a folder holding <run-id>/run.json, or a run folder')
  .option('-c, --config <path>', 'Path to visual.config.json (only storageDir is used)')
  .option('-r, --run-id <id>', 'Local id for the imported run (only when importing a single run)')
  .action(async (input, options) => {
    let db;
    try {
      const storageRoot = resolveStorageRoot(readConfiguredStorageDir(options.config) || undefined);
      const source = detectImportSource(input);
      db = getDb(path.join(storageRoot, 'data.sqlite'));
      const { runs } = await importRuns(source, { storageRoot, db, runId: options.runId });

      const dashboardPort = process.env.PORT || 4000; // the port `npm start` will use
      const fresh = runs.filter((r) => !r.alreadyImported).length;
      const where = path.relative(process.cwd(), storageRoot) || '.';
      console.log(fresh === 0
        ? `\n  Nothing new to import into ${where}: already imported`
        : `\n  Imported ${fresh} run${fresh === 1 ? '' : 's'} into ${where}`);
      for (const run of runs) {
        const notes = [];
        if (run.renamedFrom) notes.push(`renamed from ${run.renamedFrom}: that id was already taken`);
        if (run.alreadyImported) notes.push('already imported, nothing changed');
        const plural = run.snapshots === 1 ? '' : 's';
        console.log(`    ${run.id}  ${run.status}, ${run.snapshots} snapshot${plural}${notes.length ? `  (${notes.join('; ')})` : ''}`);
        console.log(`      http://localhost:${dashboardPort}${run.url}`);
      }
      console.log('\n  Open the dashboard with `npm start` to review them.\n');
    } catch (err) {
      // Backstop: messages can quote names from the archive (importRuns already escapes them).
      console.error(`\n[ERROR] Import failed: ${sanitizeForDisplay(String(err?.message ?? err))}\n`);
      process.exitCode = EXIT.ERROR;
    } finally {
      if (db) closeDb();
    }
  });

// Fallback / default action
if (process.argv.length <= 2) {
  program.help();
} else {
  program.parseAsync(process.argv).catch(crash('Command failed'));
}
