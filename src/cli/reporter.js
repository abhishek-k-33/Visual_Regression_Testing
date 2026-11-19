import fs from 'node:fs';
import path from 'node:path';

/**
 * Format a status string with an emoji badge for Markdown display.
 * @param {string} status
 * @returns {string}
 */
export function formatStatusBadge(status) {
  switch (status) {
    case 'MATCH':
      return '🟢 **PASSED**';
    case 'DIFF':
      return '🔴 **FAILED**';
    case 'NEW_BASELINE':
      return '🟡 **NEW BASELINE**';
    default:
      return status;
  }
}

/**
 * Generate a GitHub Flavored Markdown summary report for a visual regression test run.
 * @param {Object} options
 * @param {string} options.runId
 * @param {Object} [options.gitInfo]
 * @param {string} [options.gitInfo.branch]
 * @param {string} [options.gitInfo.commit_hash]
 * @param {number} [options.threshold=0.01]
 * @param {string|number} [options.elapsed='0']
 * @param {number} options.passedCount
 * @param {number} options.failedCount
 * @param {number} options.newBaselineCount
 * @param {Array<Object>} options.results
 * @returns {string}
 */
export function generateSummaryMarkdown(options) {
  const {
    runId,
    gitInfo = {},
    threshold = 0.01,
    elapsed = '0',
    passedCount = 0,
    failedCount = 0,
    newBaselineCount = 0,
    results = []
  } = options;

  const totalSnapshots = results.length;
  const isPassed = failedCount === 0;
  const overallBadge = isPassed
    ? '✅ **PASSED**'
    : `❌ **FAILED (${failedCount} regression${failedCount === 1 ? '' : 's'})**`;

  const thresholdPercent = (threshold * 100).toFixed(2);
  const branchName = gitInfo.branch ? `\`${gitInfo.branch}\`` : '_N/A_';
  const commitHash = gitInfo.commit_hash ? `\`${gitInfo.commit_hash}\`` : '_N/A_';

  const lines = [
    '# 📸 Visual CI Test Report',
    '',
    '| Metric | Value |',
    '| :--- | :--- |',
    `| **Run ID** | \`${runId}\` |`,
    `| **Branch** | ${branchName} |`,
    `| **Commit** | ${commitHash} |`,
    `| **Overall Status** | ${overallBadge} |`,
    `| **Total Snapshots** | ${totalSnapshots} |`,
    `| **Passed (Match)** | ${passedCount} |`,
    `| **Failed (Diff)** | ${failedCount} |`,
    `| **New Baselines** | ${newBaselineCount} |`,
    `| **Execution Time** | ${elapsed}s |`,
    `| **Allowed Threshold** | ${thresholdPercent}% |`,
    '',
    '### Snapshot Breakdown',
    '',
    '| Status | Route | Viewport | Mismatch | Details |',
    '| :--- | :--- | :--- | :--- | :--- |'
  ];

  for (const r of results) {
    const statusCol = formatStatusBadge(r.status);
    const routeCol = `\`${r.route}\``;
    const viewportCol = `\`${r.viewport}\``;
    const mismatchCol = r.mismatchPercentage !== undefined
      ? `\`${r.mismatchPercentage.toFixed(2)}%\``
      : '`0.00%`';

    let detailsCol = 'Baseline matched';
    if (r.status === 'DIFF') {
      detailsCol = `Exceeded threshold (${thresholdPercent}%)`;
    } else if (r.status === 'NEW_BASELINE') {
      detailsCol = 'New baseline master initialized';
    }

    lines.push(`| ${statusCol} | ${routeCol} | ${viewportCol} | ${mismatchCol} | ${detailsCol} |`);
  }

  lines.push('');

  if (!isPassed) {
    lines.push('> ⚠️ **Action Required:** Visual differences were detected.');
    lines.push('> - Review diff screenshots uploaded in the **`visual-regression-diffs`** workflow artifact.');
    lines.push('> - Or inspect interactively on the local dashboard: `http://localhost:4000/runs/' + runId + '`.');
    lines.push('> - If changes are intended, update baselines locally using: `npm run test:visual -- --update-baselines` and commit.');
    lines.push('');
  } else {
    lines.push('> ✨ **All snapshots passed!** No unexpected visual regressions detected.');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Write summary markdown to disk and append to GITHUB_STEP_SUMMARY if available.
 * @param {string} markdown
 * @param {Object} options
 * @param {string} options.runsDir
 * @param {string} [options.summaryFileName='summary.md']
 * @returns {{ runSummaryPath: string, stepSummaryWritten: boolean }}
 */
export function writeSummaryReport(markdown, options = {}) {
  const { runsDir, summaryFileName = 'summary.md' } = options;
  let runSummaryPath = null;
  let stepSummaryWritten = false;

  if (runsDir) {
    try {
      runSummaryPath = path.join(runsDir, summaryFileName);
      fs.mkdirSync(path.dirname(runSummaryPath), { recursive: true });
      fs.writeFileSync(runSummaryPath, markdown, 'utf8');
    } catch (err) {
      console.warn(`  [WARN] Failed to write summary to ${runSummaryPath}: ${err.message}`);
    }
  }

  // Also write to GitHub Actions step summary if running in CI
  const githubStepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (githubStepSummary) {
    try {
      fs.appendFileSync(githubStepSummary, `\n${markdown}\n`, 'utf8');
      stepSummaryWritten = true;
    } catch (err) {
      console.warn(`  [WARN] Failed to write to GITHUB_STEP_SUMMARY: ${err.message}`);
    }
  }

  return { runSummaryPath, stepSummaryWritten };
}
