# Engineering Implementation Record: Phase 2
**Project:** Open-Source Visual Regression Testing & CI Tool  
**Date:** November 14, 2026  
**Status:** Completed & Verified  

---

## 1. Executive Summary

Phase 2 implements the core Pixel Diffing Engine and Dynamic Dimension Normalization system (`src/cli/compare.js`). Captured screenshots are compared pixel-by-pixel against golden master baseline images using `pixelmatch` and `pngjs`. Layout shifts that cause height or width variations are automatically handled via transparent canvas padding. If no baseline exists for a route and viewport combination, the engine automatically promotes the current snapshot as the initial baseline (`NEW_BASELINE`). The CLI interface now features the `visual-ci test` command (`npm run test:visual`) to execute automated comparison runs and report visual regression metrics.

---

## 2. Deliverables Completed

1. **Pixel Diffing & Normalization Engine (`src/cli/compare.js`)**:
   - **`padImage(png, targetWidth, targetHeight)`**: Automatically expands smaller PNG canvases to the maximum bounding box (`max(width)`, `max(height)`) using `PNG.bitblt`, filling padded areas with transparent pixels (`RGBA: 0, 0, 0, 0`) to prevent mismatched dimension crashes in `pixelmatch`.
   - **`compareImages(baselineBuffer, currentBuffer, options)`**: Decodes PNG buffers, computes bounding dimensions, runs anti-aliasing-aware pixel comparisons (`pixelmatch`), paints differing pixels in bright red (`[255, 0, 0]`), and calculates precise mismatch percentages.
   - **`compareSnapshot(snapshot, options)`**: Resolves baseline paths, creates missing baselines on initial execution (`NEW_BASELINE`), evaluates mismatch percentage against `config.threshold`, and writes `diff.png` artifacts to the run directory.

2. **JSON Comment Tolerant Config Loader (`src/cli/config.js`)**:
   - Implemented `stripJsonComments(jsonString)` parser to safely strip single-line (`//`) and block (`/* ... */`) comments while preserving string literals and URLs. Allows human comments in `visual.config.json` without violating strict JSON parser constraints.

3. **CLI Automated Visual Test Command (`src/cli/index.js`)**:
   - Registered `visual-ci test` (`npm run test:visual`).
   - Executes multi-viewport capture, compares all captured snapshots against `storage/baselines/`, logs badge-formatted terminal outputs (`[PASS]`, `[FAIL]`, `[NEW BASELINE]`), and returns exit code `0` on success or `1` on visual regressions.
   - Added `--update-baselines` flag to allow one-click baseline overwriting.

4. **Vitest Unit & Integration Suites (`tests/compare.test.js`)**:
   - 9 comprehensive unit tests covering identical image matching (0.00%), color diff detection, dimension mismatch canvas padding, initial baseline promotion, and threshold tolerance.
   - Full test suite expanded to 34 passing tests across 4 test suites.

5. **Phase 2 Verification Deliverable (`tests/verify-phase-2.js`)**:
   - Spun up local fixture server on an ephemeral port.
   - Step 1: Verified automatic baseline creation (`NEW_BASELINE`).
   - Step 2: Verified unchanged re-run produced `MATCH` (0.00% mismatch).
   - Step 3: Shifted heading `margin-top` by `12px`, ran comparison, and verified detection:
     - Flagged regression with non-zero exit code.
     - Generated `index-desktop-diff.png` with 7,061 bright red diff pixels highlighting the shifted heading.

---

## 3. Test Suite Verification Metrics

```text
 ✓ tests/config.test.js (15 tests)
 ✓ tests/capture.test.js (9 tests)
 ✓ tests/compare.test.js (9 tests)
 ✓ tests/capture-integration.test.js (1 test)

 Test Files  4 passed (4)
      Tests  34 passed (34)
```

---

## 4. Next Implementation Milestone

**Milestone:** Phase 3  
**Deliverables:**
1. SQLite metadata schema initialization (`test_runs`, `snapshots`) using `better-sqlite3` in `src/server/db.js`.
2. REST API endpoints (`POST /api/runs`, `POST /api/snapshots/:id/approve`, `POST /api/snapshots/:id/reject`).
3. Express + EJS Review Dashboard UI (`index.ejs`, `run-detail.ejs`) with draggable overlay sliders and side-by-side visual diff inspectors.
