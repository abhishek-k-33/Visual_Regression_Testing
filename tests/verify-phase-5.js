/**
 * Phase 5 Verification Deliverable Script
 *
 * Verifies:
 * 1. GitHub Actions workflow configuration (.github/workflows/visual-ci.yml)
 * 2. Workflow trigger, cache, execution, and artifact upload step integrity
 * 3. Reporter module (src/cli/reporter.js) markdown formatting
 * 4. GITHUB_STEP_SUMMARY integration and file emission
 * 5. CLI index integration and help options
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import {
  generateSummaryMarkdown,
  writeSummaryReport,
  formatStatusBadge
} from '../src/cli/reporter.js';

let passedChecks = 0;
let totalChecks = 0;

function assert(condition, message) {
  totalChecks++;
  if (condition) {
    console.log(`  ✓ ${message}`);
    passedChecks++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    process.exitCode = 1;
  }
}

console.log('──────────────────────────────────────────────────────');
console.log('  Phase 5 Verification: GitHub Actions CI Integration');
console.log('──────────────────────────────────────────────────────\n');

// 1. Workflow file existence
const workflowPath = path.resolve('.github/workflows/visual-ci.yml');
assert(fs.existsSync(workflowPath), '.github/workflows/visual-ci.yml exists');

const workflowContent = fs.readFileSync(workflowPath, 'utf8');

// 2. Workflow triggers and concurrency
assert(workflowContent.includes('push:') && workflowContent.includes('branches: [ main ]'), 'Triggers on push to main');
assert(workflowContent.includes('pull_request:') && workflowContent.includes('branches: [ main ]'), 'Triggers on pull_request to main');
assert(workflowContent.includes('concurrency:'), 'Configures concurrency group to cancel redundant runs');

// 3. Workflow action steps
assert(workflowContent.includes('actions/checkout@v4'), 'Uses actions/checkout@v4');
assert(workflowContent.includes('actions/setup-node@v4'), 'Uses actions/setup-node@v4');
assert(workflowContent.includes('node-version: 22'), 'Configures Node.js 22 runtime');
assert(workflowContent.includes('npm ci'), 'Executes clean dependency install (npm ci)');
assert(workflowContent.includes('npx playwright install --with-deps chromium'), 'Installs Playwright Chromium with system dependencies');
assert(workflowContent.includes('storage/baselines'), 'Caches golden baselines (storage/baselines)');
assert(workflowContent.includes('npm run test:visual'), 'Executes visual regression test suite');
assert(workflowContent.includes('actions/upload-artifact@v4'), 'Uses actions/upload-artifact@v4 for diff archiving');
assert(workflowContent.includes('storage/runs/'), 'Archives runs directory (storage/runs/)');
assert(workflowContent.includes('if: failure()'), 'Only uploads diff artifacts on test failure');

// 4. Reporter module functions
assert(typeof formatStatusBadge === 'function', 'formatStatusBadge is exported');
assert(typeof generateSummaryMarkdown === 'function', 'generateSummaryMarkdown is exported');
assert(typeof writeSummaryReport === 'function', 'writeSummaryReport is exported');

// 5. Test markdown generation for passing run
const passMarkdown = generateSummaryMarkdown({
  runId: 'verify_pass_1',
  gitInfo: { branch: 'main', commit_hash: 'abc1234' },
  threshold: 0.01,
  elapsed: '1.20',
  passedCount: 2,
  failedCount: 0,
  newBaselineCount: 0,
  results: [
    { route: '/', viewport: 'desktop', status: 'MATCH', mismatchPercentage: 0.0 },
    { route: '/', viewport: 'mobile', status: 'MATCH', mismatchPercentage: 0.005 }
  ]
});

assert(passMarkdown.includes('# 📸 Visual CI Test Report'), 'Markdown report has expected title');
assert(passMarkdown.includes('✅ **PASSED**'), 'Passing report contains PASSED badge');
assert(passMarkdown.includes('| `desktop` | `0.00%` | Baseline matched |'), 'Snapshot details formatted properly');
assert(passMarkdown.includes('✨ **All snapshots passed!**'), 'Passing report includes success message');

// 6. Test markdown generation for failing run
const failMarkdown = generateSummaryMarkdown({
  runId: 'verify_fail_2',
  gitInfo: { branch: 'feature-branch', commit_hash: '9876xyz' },
  threshold: 0.01,
  elapsed: '2.40',
  passedCount: 1,
  failedCount: 1,
  newBaselineCount: 0,
  results: [
    { route: '/home', viewport: 'desktop', status: 'MATCH', mismatchPercentage: 0.0 },
    { route: '/contact', viewport: 'mobile', status: 'DIFF', mismatchPercentage: 4.5 }
  ]
});

assert(failMarkdown.includes('❌ **FAILED (1 regression)**'), 'Failing report indicates regression count');
assert(failMarkdown.includes('| 🔴 **FAILED** | `/contact` | `mobile` | `4.50%` |'), 'Failing snapshot row highlights diff percentage');
assert(failMarkdown.includes('⚠️ **Action Required:**'), 'Failing report provides clear developer remediation guidance');

// 7. Test summary report file writing & GITHUB_STEP_SUMMARY integration
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-ci-step-summary-'));
const mockStepSummary = path.join(tmpDir, 'step_summary.log');
fs.writeFileSync(mockStepSummary, '# Prior Workflow Output\n', 'utf8');

const originalStepEnv = process.env.GITHUB_STEP_SUMMARY;
process.env.GITHUB_STEP_SUMMARY = mockStepSummary;

const runsDir = path.join(tmpDir, 'runs', 'verify_run');
const { runSummaryPath, stepSummaryWritten } = writeSummaryReport(passMarkdown, { runsDir });

assert(fs.existsSync(runSummaryPath), 'summary.md written to run directory');
assert(stepSummaryWritten === true, 'writeSummaryReport appends to GITHUB_STEP_SUMMARY in CI');
const stepContent = fs.readFileSync(mockStepSummary, 'utf8');
assert(stepContent.includes('# Prior Workflow Output'), 'GITHUB_STEP_SUMMARY retains prior content');
assert(stepContent.includes('verify_pass_1'), 'GITHUB_STEP_SUMMARY appended with visual CI report');

// Cleanup temp env
if (originalStepEnv !== undefined) {
  process.env.GITHUB_STEP_SUMMARY = originalStepEnv;
} else {
  delete process.env.GITHUB_STEP_SUMMARY;
}
fs.rmSync(tmpDir, { recursive: true, force: true });

// 8. Test CLI index help output
const helpOutput = execSync('node src/cli/index.js test --help', { encoding: 'utf8' });
assert(helpOutput.includes('--summary-file'), 'CLI test command includes --summary-file option');
assert(helpOutput.includes('--update-baselines'), 'CLI test command includes --update-baselines option');

console.log('\n──────────────────────────────────────────────────────');
console.log(`  Phase 5 Verification: ${passedChecks}/${totalChecks} Checks Passed`);
console.log('──────────────────────────────────────────────────────\n');

if (passedChecks !== totalChecks) {
  process.exit(1);
}
