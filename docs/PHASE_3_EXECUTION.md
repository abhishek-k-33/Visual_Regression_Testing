# Engineering Implementation Record: Phase 3
**Project:** Open-Source Visual Regression Testing & CI Tool  
**Date:** November 19, 2026  
**Status:** Completed, Hardened & Pushed to GitHub (Commit `ed4dfad`)  

---

## 1. Executive Summary

Phase 3 introduces the persistent storage layer and the interactive Web Review Dashboard. The engine now records test runs and snapshot metadata in an embedded SQLite database using `better-sqlite3` with Write-Ahead Logging (WAL) mode for concurrency. A lightweight Express.js server provides both a RESTful JSON API and an EJS-rendered developer dashboard. The dashboard has been designed with a Linear/Vercel-inspired dark aesthetic featuring three interactive comparison modes (Side-by-Side preview, Draggable Split Overlay Slider, and Bright Red Diff Highlight), real-time client-side search/filtering/pagination, and one-click baseline approval workflows.

Following security and QA audits by autonomous subagents (`Diff Auditor & Security Reviewer` and `Browser QA & Visual Verifier`), the implementation underwent strict defensive hardening (path traversal jails, `/storage` database download guards, and XSS escaping) and received full sign-off across all desktop and mobile viewports.

---

## 2. Deliverables Completed

### 1. SQLite Storage & Concurrency Layer (`src/server/db.js`)
- **Schema & WAL Mode**: Initialized `test_runs` and `snapshots` tables linked via foreign key cascading deletes (`ON DELETE CASCADE`). Enabled `journal_mode = WAL` and `foreign_keys = ON` for high-concurrency non-blocking reads and writes.
- **Query Helper Functions**: `createTestRun`, `createSnapshot`, `getAllTestRuns`, `getTestRunById`, `getSnapshotsByRunId`, `getSnapshotById`, `recalculateRunStatus`, `approveSnapshot`, and `rejectSnapshot`.
- **Dynamic Status Recalculation**: `recalculateRunStatus` dynamically transitions parent test run status (`PASSED`, `FAILED`, `APPROVED`, `REJECTED`) based on child snapshot states.
- **Security Hardening (`approveSnapshot`, `src/server/paths.js`)**:
  - Path allowlist: the source must be a `.png` inside `storage/runs/` and the target a `.png` inside `storage/baselines/`. Anything else is refused with `Access denied` (HTTP 403).
  - Paths are resolved with `fs.realpathSync`, so symlinks cannot point outside those directories, and an existing baseline symlink cannot be used to write elsewhere.
  - Containment is checked by path segment (`path.relative`), so a sibling such as `storage-evil/` is not treated as inside `storage/`.
  - *(2026-11-22)* This replaced an earlier denylist that only checked the destination, which allowed any workspace file (e.g. `.env`) to be copied into `storage/` and downloaded.

### 2. Express Web Review Dashboard & REST API (`src/server/app.js`, `src/server/routes/api.js`, `src/server/routes/views.js`)
- **REST API Endpoints (`/api`)**:
  - `GET /api/runs`: Returns all test runs with summary metrics (match counts, diff counts, commit hashes, branches, timestamps).
  - `GET /api/runs/:id`: Returns detailed run payload with all associated child snapshots.
  - *(Removed 2026-11-22)* `POST /api/runs` accepted client-chosen file paths and was unused: the CLI records runs by writing to SQLite directly.
  - `POST /api/snapshots/:id/approve`: Promotes current screenshot to baseline on disk and triggers parent run recalculation.
  - `POST /api/snapshots/:id/reject`: Marks visual diff as rejected.
- **Static Asset & Database Route Guard**:
  - Serves screenshots at `/storage` using an allowlist: only `.png` files under `storage/runs/` or `storage/baselines/` are served. Everything else (SQLite files, `summary.md`, stray files, encoded traversal) returns HTTP 403.
- **Network Binding**: The server listens on `127.0.0.1` by default. Set `HOST=0.0.0.0` to expose it on the network (the Docker image does this, and `docker-compose.yml` publishes the port on host loopback only).
- **Template & XSS Security**:
  - EJS templates utilize HTML-escaped output tags (`<%= ... %>`) for dynamic variables.
  - Sanitized error messages in `src/server/routes/views.js` using `escapeHtml()` prior to error layout rendering.

### 3. Front-End Architecture & UI Redesign (`src/server/views/`, `src/server/public/`)
- **Linear/Vercel-Inspired Dark Palette**:
  - Main background: `#0B1020`, Surface/Cards: `#151F33`, Table: `#111A2B`, Borders: `#26344D`.
  - Primary text: `#F8FAFC`, Secondary text: `#A5B4CF`.
  - Accents: Bright Cyan (`#38BDF8`), Primary Blue (`#2997FF`), Emerald Green (`#10B981`), Approved Purple (`#8B5CF6`), Coral Red (`#F43F5E`).
- **Page Heading**: Square rounded icon container (`56px × 56px`) with Blue/Purple gradient (`#2563EB` to `#7C3AED`), white picture icon, bold title (`32px`), subtitle, and active engine status badge.
- **Three KPI Statistics Cards**:
  1. **Total Runs**: Rich blue gradient (`#142C55` to `#0756A5`), border `#285DA0`, circular left icon with white play icon, and subtle dual-stroke SVG curves.
  2. **Passed / Approved**: Emerald green gradient (`#103D36` to `#065F46`), border `#167A62`, circular left icon with mint check-circle, and green SVG curves.
  3. **Visual Regressions**: Dark burgundy gradient (`#351B30` to `#4C1932`), border `#79334B`, circular left icon with coral alert icon, and red SVG curves.
- **Spacious Layout**: 92% desktop viewport width (capped at `1600px`) with balanced side margins.
- **Interactive Toolbar (`src/server/public/js/dashboard.js`)**: Real-time client-side filter tabs (`All`, `Passed`, `Approved`, `Regressions`), search input filtering by ID/branch/commit, and responsive table pagination (10 items/page).
- **Run Inspection Studio (`run-detail.ejs`)**:
  - 3 tabs per snapshot: Side-by-Side aligned frames, Interactive Draggable Split Overlay Slider (mouse and touch enabled), and Diff Highlight canvas.
  - One-click AJAX baseline approval button with in-place DOM badge updating.

### 4. CLI Integration (`src/cli/index.js`)
- Automatic Git metadata extraction (`git rev-parse --abbrev-ref HEAD` and `git rev-parse --short HEAD`).
- Non-fatal SQLite persistence on every `visual-ci test` run.
- Prints direct review link in terminal: `http://localhost:4000/runs/<runId>`.

### 5. Vitest Test Suites (`tests/db.test.js`, `tests/server.test.js`)
- Expanded test coverage to **52 unit and integration tests** across 6 test suites:
  - SQLite table creation, run creation, child snapshot association, status recalculations, baseline promotions, and path jail traversal attacks.
  - Express REST endpoints, HTML template rendering, static file route guards, and 403 Forbidden enforcement on database files.

### 6. Phase 3 Deliverable Verification (`tests/verify-phase-3.js`)
- End-to-end automated verification testing all lifecycle steps:
  1. Initial baseline run and SQLite persistence (`PASSED`, `NEW_BASELINE`).
  2. Induced visual regression (heading color & text shift).
  3. Regression detection by CLI, non-zero exit code 1, and SQLite status `FAILED` with `DIFF` snapshot (2.58% mismatch).
  4. Web dashboard verification of interactive slider and approve action button.
  5. Execution of `POST /api/snapshots/:id/approve`, confirming baseline file update on disk and status transition to `APPROVED`.
  6. Subsequent test run passing cleanly with 0.00% mismatch against the newly promoted baseline.

---

## 3. Subagent Audits & Verification

- **Diff Auditor & Security Reviewer:**
  - Audited all SQL queries, file write operations, and template variables.
  - Verified path traversal restrictions and `/storage` database route guards.
  - Verified 100% test pass rate (**52/52 tests passed**).
  - **Verdict:** `APPROVED FOR COMMIT`.
- **Browser QA & Visual Verifier:**
  - Tested live browser rendering using Playwright Chromium across desktop large (`1536 × 864`), standard desktop (`1440 × 900`), and mobile (`375 × 812`).
  - Verified filter tabs, real-time search, pagination, tab switching, and split slider dragging.
  - Verified **0 console errors and 0 warnings**.
  - **Verdict:** `SIGN-OFF: APPROVED (100% GREEN)`.

---

## 4. Test Suite Verification Metrics

```text
 ✓ tests/config.test.js (17 tests)
 ✓ tests/capture.test.js (9 tests)
 ✓ tests/compare.test.js (10 tests)
 ✓ tests/capture-integration.test.js (1 test)
 ✓ tests/db.test.js (7 tests)
 ✓ tests/server.test.js (8 tests)

 Test Files  6 passed (6)
      Tests  52 passed (52)
   Duration  3.75s
```

---

## 5. Next Implementation Milestone

**Milestone:** Phase 4  
**Deliverables:**
1. Cross-platform Docker containerization (`Dockerfile`, `docker-compose.yml`) ensuring deterministic Chromium font rendering across macOS, Windows, and Linux.
2. Complete GitHub Actions CI workflow (`.github/workflows/visual-regression.yml`) for automated pull request checks and artifact uploads.
