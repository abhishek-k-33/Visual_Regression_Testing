# Engineering Implementation Record: Phase 5
**Project:** Open-Source Visual Regression Testing & CI Tool  
**Date:** November 19, 2026  
**Status:** Completed & Verified  

> **Update (November 22, 2026):** The baseline caching described below was replaced. Restoring baselines from an Actions cache meant approved baselines never reached CI, and a cold cache made every run pass. Baselines are now committed in `storage/baselines/`. CI builds the project's Docker image, tests the bundled demo site instead of `example.com`, and runs in `--strict` mode, where a missing baseline fails the job. See the README sections *Managing Baselines* and *GitHub Actions CI Pipeline* for the current setup.

---

## 1. Executive Summary

Phase 5 delivers full automation for visual regression testing by integrating the engine into GitHub Actions CI workflows. On every pull request and push to the primary branch, the CI pipeline automatically:
1. Provisions the Node.js 22 runtime and caches dependencies.
2. Installs headless Chromium and OS graphics rendering libraries.
3. Restores golden baseline images from GitHub Actions cache.
4. Executes headless multi-viewport screenshot captures and pixel comparison tests.
5. Emits a structured, GitHub-flavored Markdown report table (`summary.md`) directly into `GITHUB_STEP_SUMMARY`.
6. Enforces pull request gating by exiting with code `1` whenever visual regressions exceed the configured threshold.
7. Archives diff screenshots and visual artifacts as downloadable workflow artifacts (`actions/upload-artifact@v4`) upon test failure.

---

## 2. Deliverables Completed

### 1. GitHub Actions Workflow (`.github/workflows/visual-ci.yml`)
- **Triggers**:
  - `push` on `main`
  - `pull_request` on `main`
  - `workflow_dispatch` for manual on-demand test runs.
- **Concurrency Management**: Uses `github.workflow` and `github.ref` to automatically cancel redundant superseded runs on subsequent branch pushes.
- **Caching Strategy**:
  - **Playwright Binaries**: Caches `~/.cache/ms-playwright` keyed by `package-lock.json` hash to accelerate CI job execution times.
  - **Golden Baselines**: Caches `storage/baselines` with branch-level keys (`visual-baselines-${{ runner.os }}-${{ github.ref_name }}`) and a fallback to `main` (`visual-baselines-${{ runner.os }}-main`), ensuring PR branches compare against the main baseline.
- **Fail-Safe Artifact Upload**: If visual regressions cause the test step to fail (`if: failure()`), all run artifacts (`storage/runs/`) are archived with a 7-day retention period for instant developer download.

### 2. Markdown CI Reporter (`src/cli/reporter.js`)
- **`formatStatusBadge(status)`**: Converts test statuses (`MATCH`, `DIFF`, `NEW_BASELINE`) into clean GitHub Markdown status badges with visual indicators (🟢, 🔴, 🟡).
- **`generateSummaryMarkdown(options)`**:
  - Renders an executive summary table listing Run ID, Git Branch, Commit SHA, Overall Status, Total Snapshots, Passed/Failed breakdown, Execution Time, and Configured Threshold.
  - Renders a snapshot breakdown table listing each Route, Viewport, Mismatch Percentage, and Status Details.
  - Generates developer remediation guidelines on failure, linking to the artifact archive and local dashboard inspect commands.
- **`writeSummaryReport(markdown, options)`**:
  - Writes `summary.md` inside the run directory (`storage/runs/<runId>/summary.md`).
  - Automatically detects `process.env.GITHUB_STEP_SUMMARY` and appends the Markdown report so GitHub Actions displays it directly in the workflow summary tab.

### 3. CLI Integration & Git Context (`src/cli/index.js`)
- **Git Context Detection**: Enhanced `getGitContext()` to automatically read `GITHUB_HEAD_REF`, `GITHUB_REF_NAME`, and `GITHUB_SHA` in CI environments before falling back to local git commands.
- **Summary File Output**: Added `--summary-file <path>` CLI option to customize report output location.
- **Terminal Feedback**: Displays the relative path to `summary.md` and confirms whether step summaries were delivered to GitHub Actions.

---

## 3. Workflow Specification

```yaml
name: Visual Regression CI

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]
  workflow_dispatch:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  visual-tests:
    name: Visual Regression Tests
    runs-on: ubuntu-latest

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Setup Node.js 22
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'npm'

      - name: Install Node Dependencies
        run: npm ci

      - name: Cache Playwright Chromium
        uses: actions/cache@v4
        id: playwright-cache
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ runner.os }}-${{ hashFiles('package-lock.json') }}

      - name: Install Playwright Browsers & OS Dependencies
        if: steps.playwright-cache.outputs.cache-hit != 'true'
        run: npx playwright install --with-deps chromium

      - name: Install Playwright OS Dependencies (Cache Hit)
        if: steps.playwright-cache.outputs.cache-hit == 'true'
        run: npx playwright install-deps chromium

      - name: Restore Golden Baselines Cache
        uses: actions/cache@v4
        with:
          path: storage/baselines
          key: visual-baselines-${{ runner.os }}-${{ github.ref_name }}
          restore-keys: |
            visual-baselines-${{ runner.os }}-main
            visual-baselines-${{ runner.os }}-

      - name: Run Visual Regression Tests
        run: npm run test:visual

      - name: Upload Diff Artifacts on Failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: visual-regression-diffs
          path: storage/runs/
          retention-days: 7
          if-no-files-found: ignore
```

---

## 4. Verification & Testing

### Verification Suite Results
- **Reporter Unit Tests (`tests/reporter.test.js`)**: 10/10 tests passed.
  - Status badge formatting.
  - Markdown report generation for passing and failing runs.
  - New baseline record formatting.
  - Custom nested summary file output paths.
  - `GITHUB_STEP_SUMMARY` file write and append behavior.
- **Phase 5 Verification Script (`tests/verify-phase-5.js`)**: 30/30 checks passed.
  - Workflow file structure, triggers, action versions, and permissions.
  - Playwright and baseline caching configurations.
  - Step summary file writing.
  - CLI `--summary-file` parameter parsing.
- **Full Test Suite (`npm test`)**: 62/62 unit tests passed across 7 test files.
- **All Phase Verifiers (`verify-phase-1.js` through `verify-phase-5.js`)**: All 5 phases passing in sequence.
