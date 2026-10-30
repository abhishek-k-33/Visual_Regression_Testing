#!/usr/bin/env node

import { Command } from 'commander';
import path from 'node:path';
import { loadConfig } from './config.js';
import { captureScreenshots } from './capture.js';

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

// Fallback / default action
if (process.argv.length <= 2) {
  program.help();
} else {
  program.parse(process.argv);
}
