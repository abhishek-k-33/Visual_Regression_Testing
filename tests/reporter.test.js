import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  formatStatusBadge,
  generateSummaryMarkdown,
  writeSummaryReport
} from '../src/cli/reporter.js';

describe('Reporter Module (Phase 5)', () => {
  let tmpDir;
  let originalStepSummary;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-ci-reporter-test-'));
    originalStepSummary = process.env.GITHUB_STEP_SUMMARY;
    // GitHub Actions sets this for every step; tests opt in explicitly
    delete process.env.GITHUB_STEP_SUMMARY;
  });

  afterEach(() => {
    if (originalStepSummary !== undefined) {
      process.env.GITHUB_STEP_SUMMARY = originalStepSummary;
    } else {
      delete process.env.GITHUB_STEP_SUMMARY;
    }
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('formatStatusBadge', () => {
    it('returns green badge for MATCH', () => {
      const badge = formatStatusBadge('MATCH');
      expect(badge).toContain('🟢');
      expect(badge).toContain('PASSED');
    });

    it('returns red badge for DIFF', () => {
      const badge = formatStatusBadge('DIFF');
      expect(badge).toContain('🔴');
      expect(badge).toContain('FAILED');
    });

    it('returns yellow badge for NEW_BASELINE', () => {
      const badge = formatStatusBadge('NEW_BASELINE');
      expect(badge).toContain('🟡');
      expect(badge).toContain('NEW BASELINE');
    });

    it('returns red badge for MISSING_BASELINE', () => {
      const badge = formatStatusBadge('MISSING_BASELINE');
      expect(badge).toContain('🔴');
      expect(badge).toContain('MISSING BASELINE');
    });

    it('returns raw string for unknown status', () => {
      expect(formatStatusBadge('UNKNOWN_STATUS')).toBe('UNKNOWN_STATUS');
    });
  });

  describe('generateSummaryMarkdown', () => {
    it('generates a clean markdown table for a passing test run', () => {
      const markdown = generateSummaryMarkdown({
        runId: 'run_test_123',
        gitInfo: { branch: 'main', commit_hash: 'abc1234' },
        threshold: 0.01,
        elapsed: '1.45',
        passedCount: 2,
        failedCount: 0,
        newBaselineCount: 0,
        results: [
          { route: '/', viewport: 'desktop', status: 'MATCH', mismatchPercentage: 0.0 },
          { route: '/', viewport: 'mobile', status: 'MATCH', mismatchPercentage: 0.005 }
        ]
      });

      expect(markdown).toContain('# 📸 Visual CI Test Report');
      expect(markdown).toContain('`run_test_123`');
      expect(markdown).toContain('`main`');
      expect(markdown).toContain('`abc1234`');
      expect(markdown).toContain('✅ **PASSED**');
      expect(markdown).toContain('| `desktop` | `0.00%` |');
      expect(markdown).toContain('| `mobile` | `0.01%` |');
      expect(markdown).toContain('✨ **All snapshots passed!**');
    });

    it('generates an actionable failure report when regressions occur', () => {
      const markdown = generateSummaryMarkdown({
        runId: 'run_fail_456',
        gitInfo: { branch: 'feat/new-ui', commit_hash: 'def5678' },
        threshold: 0.02,
        elapsed: '2.10',
        passedCount: 1,
        failedCount: 1,
        newBaselineCount: 0,
        results: [
          { route: '/home', viewport: 'desktop', status: 'MATCH', mismatchPercentage: 0.0 },
          { route: '/pricing', viewport: 'mobile', status: 'DIFF', mismatchPercentage: 3.85 }
        ]
      });

      expect(markdown).toContain('❌ **FAILED (1 regression)**');
      expect(markdown).toContain('| 🔴 **FAILED** | `/pricing` | `mobile` | `3.85%` |');
      expect(markdown).toContain('⚠️ **Action Required:** Visual differences were detected.');
      expect(markdown).toContain('visual-regression-diffs');
      expect(markdown).toContain('http://localhost:4000/runs/run_fail_456');
    });

    it('handles new baseline records gracefully', () => {
      const markdown = generateSummaryMarkdown({
        runId: 'run_new_789',
        gitInfo: {},
        threshold: 0.01,
        elapsed: '0.90',
        passedCount: 0,
        failedCount: 0,
        newBaselineCount: 1,
        results: [
          { route: '/docs', viewport: 'desktop', status: 'NEW_BASELINE', mismatchPercentage: 0.0 }
        ]
      });

      expect(markdown).toContain('🟡 **NEW BASELINE**');
      expect(markdown).toContain('New baseline master initialized');
      expect(markdown).toContain('_N/A_');
    });
  });

  describe('writeSummaryReport', () => {
    it('writes summary.md into the specified runsDir', () => {
      const markdown = '# Test Report\nEverything looks good!';
      const runsDir = path.join(tmpDir, 'runs', 'run_test_write');

      const { runSummaryPath, stepSummaryWritten } = writeSummaryReport(markdown, { runsDir });

      expect(runSummaryPath).toBe(path.join(runsDir, 'summary.md'));
      expect(fs.existsSync(runSummaryPath)).toBe(true);
      expect(fs.readFileSync(runSummaryPath, 'utf8')).toBe(markdown);
      expect(stepSummaryWritten).toBe(false);
    });

    it('writes summary to custom nested path when summaryFileName includes subdirectories', () => {
      const markdown = '# Nested Summary';
      const runsDir = path.join(tmpDir, 'runs', 'nested_run');
      const { runSummaryPath } = writeSummaryReport(markdown, {
        runsDir,
        summaryFileName: 'nested/dir/custom-report.md'
      });

      expect(runSummaryPath).toBe(path.join(runsDir, 'nested/dir/custom-report.md'));
      expect(fs.existsSync(runSummaryPath)).toBe(true);
      expect(fs.readFileSync(runSummaryPath, 'utf8')).toBe(markdown);
    });

    it('returns no summary path when the summary could not be written', () => {
      const runsDir = path.join(tmpDir, 'runs', 'unwritable_run');
      fs.mkdirSync(path.join(runsDir, 'summary.md'), { recursive: true }); // a folder in the way
      const { runSummaryPath } = writeSummaryReport('# Report', { runsDir });
      expect(runSummaryPath).toBeNull();
    });

    it('appends to GITHUB_STEP_SUMMARY when the environment variable is set', () => {
      const stepSummaryFile = path.join(tmpDir, 'step_summary.md');
      fs.writeFileSync(stepSummaryFile, 'Existing CI text\n', 'utf8');
      process.env.GITHUB_STEP_SUMMARY = stepSummaryFile;

      const markdown = '## Visual CI Output';
      const runsDir = path.join(tmpDir, 'runs', 'run_ci');

      const { stepSummaryWritten } = writeSummaryReport(markdown, { runsDir });

      expect(stepSummaryWritten).toBe(true);
      const fileContent = fs.readFileSync(stepSummaryFile, 'utf8');
      expect(fileContent).toContain('Existing CI text');
      expect(fileContent).toContain('## Visual CI Output');
    });
  });
});
