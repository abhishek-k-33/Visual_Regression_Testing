# Engineering Implementation Record: Phase 3
**Project:** Open-Source Visual Regression Testing & CI Tool  
**Date:** November 14, 2026  
**Status:** Completed & Verified  

---

## 1. Executive Summary

Phase 3 introduces the persistent storage layer and the interactive Web Review Dashboard. The engine now records test runs and snapshot metadata in an embedded SQLite database using `better-sqlite3` with Write-Ahead Logging (WAL) mode for concurrency. A lightweight Express.js server provides both a RESTful JSON API and an EJS-rendered developer dashboard. The dashboard features three interactive comparison modes (Side-by-Side preview, Draggable Before/After Split Slider, and Bright Red Diff Highlight) alongside one-click baseline approval and rejection workflows.

---

## 2. Deliverables Completed

1. **SQLite Storage & Concurrency Layer (`src/server/db.js`)**:
   - Initialized schema with `test_runs` and `snapshots` tables linked via foreign key cascading deletes.
   - Enabled `journal_mode = WAL` and `foreign_keys = ON` for high-throughput concurrent reads and writes.
   - Query helpers: `createTestRun`, `createSnapshot`, `getAllTestRuns`, `getTestRunById`, `getSnapshotsByRunId`, `getSnapshotById`, `recalculateRunStatus`, `approveSnapshot`, and `rejectSnapshot`.
   - `approveSnapshot`: Automatically promotes and overwrites the current snapshot onto the baseline file on disk (`storage/baselines/`) and transitions snapshot status to `APPROVED`.
   - `recalculateRunStatus`: Automatically updates the parent run status (`PASSED`, `FAILED`, `APPROVED`, `REJECTED`) based on the statuses of its child snapshots.

2. **Express Web Review Dashboard & REST API (`src/server/app.js`, `src/server/routes/api.js`, `src/server/routes/views.js`)**:
   - **REST API Endpoints (`/api`)**:
     - `GET /api/runs`: Lists all test runs with summary metrics (snapshot counts, branches, commit hashes, timestamps).
     - `GET /api/runs/:id`: Detailed run payload with all associated snapshots.
     - `POST /api/runs`: Receives and persists CLI test run batches and snapshot metrics.
     - `POST /api/snapshots/:id/approve`: Approves visual diff, promotes current image to baseline, and triggers run recalculation.
     - `POST /api/snapshots/:id/reject`: Marks visual diff as rejected.
   - **Dashboard Views (`/`)**:
     - `GET /`: Clean dark-mode dashboard displaying run history table with status badges and commit/branch tags.
     - `GET /runs/:id`: Inspection studio with 3 visual tabs per snapshot:
       1. **Side-by-Side View**: Compares baseline and current screenshots in aligned side-by-side frames.
       2. **Interactive Split Slider**: Draggable vertical slider overlay allowing real-time wipe comparison (supports mouse drag and touch events).
       3. **Diff Highlight View**: Full-resolution view of the bright neon red diff canvas with exact mismatch percentage badges.
     - Static image mount: Serves local screenshots directly via `/storage`.

3. **Front-End Interactivity & Design (`src/server/public/css/styles.css`, `src/server/public/js/slider.js`)**:
   - Modern developer-first dark mode palette with responsive typography, pills, badges, and smooth tab switching.
   - Draggable split-slider implementation with touch support (`pointerdown`, `pointermove`, `pointerup`), boundary clamping (0% to 100%), and smooth drag handling.
   - Seamless AJAX baseline approval and rejection buttons with instant in-place DOM badge updating.

4. **CLI Integration (`src/cli/index.js`)**:
   - Automated git context extraction (active branch and commit hash).
   - CLI `visual-ci test` automatically records execution metadata, status, mismatch metrics, and snapshot paths in SQLite after every test run.
   - Outputs a direct dashboard link (`http://localhost:4000/runs/<runId>`) upon completion.

5. **Vitest Unit & Integration Suites (`tests/db.test.js`, `tests/server.test.js`)**:
   - Expanded test coverage with 15 new tests (7 SQLite layer and path security tests, 8 Express, REST API & file protection integration tests).
   - Total test suite now stands at **52 passing tests** across 6 test suites.

6. **Phase 3 Deliverable Verification (`tests/verify-phase-3.js`)**:
   - Automated end-to-end verification script testing the full loop:
     1. Initial baseline run and SQLite persistence (`PASSED`, `NEW_BASELINE`).
     2. Deliberate visual regression injection (heading color & text change).
     3. Regression detection by CLI, non-zero exit code, and SQLite status `FAILED` with `DIFF` snapshot (2.58% mismatch).
     4. Dashboard verification of interactive slider and approve action button.
     5. Execution of `POST /api/snapshots/:id/approve`, confirming baseline file update on disk and run status transition to `APPROVED`.
     6. Subsequent test run passing cleanly with 0.00% mismatch against the newly promoted baseline.

---

## 3. Test Suite Verification Metrics

```text
 ✓ tests/config.test.js (17 tests)
 ✓ tests/capture.test.js (9 tests)
 ✓ tests/compare.test.js (10 tests)
 ✓ tests/capture-integration.test.js (1 test)
 ✓ tests/db.test.js (7 tests)
 ✓ tests/server.test.js (8 tests)

 Test Files  6 passed (6)
      Tests  52 passed (52)
```

---

## 4. Next Implementation Milestone

**Milestone:** Phase 4  
**Deliverables:**
1. Cross-platform Docker containerization (`Dockerfile`, `docker-compose.yml`) ensuring deterministic Chromium font rendering across macOS, Windows, and Linux.
2. Complete GitHub Actions CI workflow (`.github/workflows/visual-regression.yml`) for automated pull request checks and artifact uploads.
3. End-to-end documentation in `README.md`.
