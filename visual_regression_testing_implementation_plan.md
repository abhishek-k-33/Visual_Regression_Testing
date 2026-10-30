# Project Specification & Implementation Plan: Open-Source Visual Regression Testing & CI Tool

## 1. Project Overview

Build a self-hosted, open-source Visual Regression Testing and CI tool (an alternative to Percy/Chromatic) using Node.js, Express, EJS, Playwright, and Docker. 

The system captures screenshots of web pages across multiple viewports, masks dynamic DOM elements (timestamps, ads, animations), performs pixel-by-pixel comparison against baseline images, serves an interactive visual diff review dashboard, and integrates with GitHub Actions CI.

---

## 2. Tech Stack & Constraints

* **Runtime & Backend:** Node.js (v20+), Express.js
* **Frontend / Templating:** EJS, Vanilla CSS (clean, modern dark-mode developer UI), Vanilla JS (for side-by-side and draggable overlay slider)
* **Database:** SQLite via `better-sqlite3` (zero-config, file-based storage for test runs and diff metadata)
* **Browser Automation:** `playwright` (Chromium headless)
* **Image Processing & Diffing:** `pngjs`, `pixelmatch`
* **DevOps & CI:** Docker (`mcr.microsoft.com/playwright` base image), Docker Compose, GitHub Actions
* **Code Style:** Clean, modular CommonJS or ES Modules, readable standard control flow (avoid nested ternary statements), minimal boilerplate comments.

---

## 3. Target Directory Structure

* `visual-regression-tool/`
  * `package.json`
  * `visual.config.json` — Default sample configuration file
  * `Dockerfile` — Playwright + Node environment for consistent font rendering
  * `docker-compose.yml` — Orchestrates the server and persistent volume storage
  * `.github/workflows/visual-ci.yml` — Automated GitHub Actions workflow
  * `src/`
    * `cli/`
      * `index.js` — CLI entry point (triggers capture, compare, and API upload)
      * `capture.js` — Playwright multi-viewport screenshot & DOM masking engine
      * `compare.js` — Pixelmatch + pngjs image normalization and diffing
    * `server/`
      * `app.js` — Express server setup
      * `db.js` — SQLite schema initialization and queries
      * `routes/`
        * `api.js` — REST API for CLI uploads, approvals, and rejections
        * `views.js` — EJS view rendering routes
      * `views/`
        * `layout.ejs` — Base HTML layout
        * `index.ejs` — Dashboard listing all test runs and pass/fail badges
        * `run-detail.ejs` — Interactive diff inspector (Side-by-Side, Slider, Diff)
      * `public/`
        * `css/styles.css` — Dashboard styling & image comparison slider styles
        * `js/slider.js` — Frontend logic for interactive before/after slider
  * `storage/` — Git-ignored local storage for images & SQLite DB
    * `baselines/` — Approved baseline PNGs
    * `runs/` — Subfolders per Run ID containing `current.png` & `diff.png`
    * `data.sqlite` — SQLite database file

---

## 4. Phased Implementation Plan

Execute this project sequentially in 5 phases. **Do not skip ahead.** After completing each phase, run the specified verification project/test before moving to the next phase.

### Phase 1: Project Setup & Headless Multi-Viewport Capture Engine

**Goal:** Build the configuration parser and Playwright screenshot engine with dynamic DOM masking.

1. Initialize `package.json` and install dependencies: `express`, `ejs`, `playwright`, `pngjs`, `pixelmatch`, `better-sqlite3`, `multer`, `commander` (or `minimist`).
2. Create `visual.config.json` supporting:
   * `baseUrl`: Target website URL (e.g., `http://localhost:3000`)
   * `routes`: Array of paths (e.g., `["/", "/about", "/blog"]`)
   * `viewports`: Array of objects (e.g., `[{"name": "desktop", "width": 1440, "height": 900}, {"name": "mobile", "width": 375, "height": 812}]`)
   * `maskSelectors`: Array of CSS selectors to hide/mask before capture (e.g., `[".timestamp", ".dynamic-ad", "img.avatar"]`)
   * `threshold`: Allowed pixel mismatch ratio (e.g., `0.01`)
3. Implement `src/cli/capture.js`:
   * Launch headless Chromium via Playwright.
   * For each route and viewport:
     * Navigate with `waitUntil: 'networkidle'`.
     * Disable CSS animations and transitions via injected `<style>` so screenshots are deterministic.
     * Apply region masking: For every selector in `maskSelectors`, inject CSS setting `visibility: hidden !important` or cover the bounding box with a solid `#000000` overlay.
     * Capture a full-page PNG screenshot.

**Phase 1 Verification Deliverable:**
* Create a dummy test page or run against `https://example.com`.
* Run `node src/cli/index.js capture` and verify that deterministic desktop and mobile PNGs are saved into `storage/runs/test-init/`.

---

### Phase 2: Pixel Diffing Engine & Dimension Normalization

**Goal:** Compare captured screenshots against baselines and compute pixel mismatch metrics.

1. Implement `src/cli/compare.js`:
   * Read `baseline.png` and `current.png` using `pngjs`.
   * **Handle height/width mismatches:** If a page grew taller or shorter between changes, pad the smaller PNG buffer with transparent or white pixels so both images share the exact `max(width)` and `max(height)` before passing them to `pixelmatch`.
   * Run `pixelmatch(img1.data, img2.data, diff.data, width, height, { threshold: 0.1 })`.
   * Write `diff.png` to disk.
   * Calculate `mismatchPercentage = (mismatchedPixels / (width * height)) * 100`.
   * If no `baseline.png` exists yet for a route + viewport combination, automatically copy `current.png` as the initial `baseline.png` and mark the status as `NEW_BASELINE`.

**Phase 2 Verification Deliverable:**
* Generate a baseline screenshot of a local HTML page, modify a heading's CSS margin by `12px`, re-run the comparison, and verify that `diff.png` highlights the shifted text in red and outputs the exact mismatch percentage in the terminal.

---

### Phase 3: SQLite Storage & Express + EJS Visual Review Dashboard

**Goal:** Build a web server and UI to inspect visual regressions and approve/reject changes.

1. Implement `src/server/db.js` with two tables:
   * `test_runs`: `id` (TEXT PK), `commit_hash` (TEXT), `branch` (TEXT), `created_at` (DATETIME), `status` (TEXT: `PASSED`, `FAILED`, `APPROVED`).
   * `snapshots`: `id` (INTEGER PK), `run_id` (TEXT FK), `route` (TEXT), `viewport` (TEXT), `baseline_path` (TEXT), `current_path` (TEXT), `diff_path` (TEXT), `mismatch_percentage` (REAL), `status` (TEXT: `MATCH`, `DIFF`, `NEW_BASELINE`, `APPROVED`).
2. Implement `src/server/routes/api.js`:
   * `POST /api/runs`: Receives test run results from the CLI and records them in SQLite.
   * `POST /api/snapshots/:id/approve`: Copies `current_path` over `baseline_path` in `storage/baselines/`, updates snapshot status to `APPROVED`, and recalculates parent run status.
   * `POST /api/snapshots/:id/reject`: Marks the snapshot and parent run as `REJECTED`.
3. Implement `src/server/views/` (EJS Dashboard):
   * `index.ejs`: Displays all test runs with summary cards, commit hash, timestamp, total snapshots, and pass/fail status badges.
   * `run-detail.ejs`: For each snapshot in a run, provide 3 interactive tabs:
     1. **Side-by-Side View:** Baseline on the left, Current on the right.
     2. **Interactive Overlay Slider:** Current image layered over Baseline with a draggable vertical range slider (`src/server/public/js/slider.js`).
     3. **Diff Highlight View:** Shows `diff.png` with the mismatch percentage badge.
   * Include **"Approve & Update Baseline"** and **"Reject"** buttons on each diff card.

**Phase 3 Verification Deliverable:**
* Start the Express server (`npm run server`), trigger a CLI test run (`npm run test:visual`), open `http://localhost:4000`, inspect the visual diff using the interactive slider, and click "Approve" to verify the baseline file updates on disk.

---

### Phase 4: Dockerizing the Environment (Cross-OS Rendering Consistency)

**Goal:** Eliminate font and anti-aliasing differences between Windows/macOS and Linux by running Playwright and the server inside Docker.

1. Create `Dockerfile`:
   * Base image: `mcr.microsoft.com/playwright:v1.48.0-jammy` (includes pre-installed Chromium and Linux fonts).
   * Set working directory `/app`, copy `package*.json`, run `npm ci`, and copy source files.
2. Create `docker-compose.yml`:
   * Service 1: `dashboard` (runs `node src/server/app.js` on port `4000`, mounts `./storage:/app/storage`).
   * Service 2: `runner` (runs `node src/cli/index.js`, shares `./storage:/app/storage` and connects to target host network).

**Phase 4 Verification Deliverable:**
* Run `docker compose up --build dashboard` and execute a containerized test run via `docker compose run --rm runner`. Verify screenshots render cleanly inside the Linux container and appear on `http://localhost:4000`.

---

### Phase 5: GitHub Actions CI Pipeline Integration

**Goal:** Automate visual regression checks on every Pull Request and fail the CI check if unapproved visual diffs exceed the threshold.

1. Update `src/cli/index.js`:
   * Exit with process code `1` (`process.exit(1)`) if any snapshot status is `DIFF` (mismatch > threshold), or `0` if all snapshots pass.
   * Generate a `summary.md` markdown table listing every route, viewport, mismatch percentage, and status.
2. Create `.github/workflows/visual-ci.yml`:
   * Trigger on `pull_request` and `push` to `main`.
   * Use the Playwright container or setup Node + Playwright browsers.
   * Cache the `storage/baselines` directory across workflow runs using `actions/cache`.
   * Start the target application in the background, wait until it responds on its port, and run `node src/cli/index.js`.
   * Upload `storage/runs/` as a GitHub Actions workflow artifact (`actions/upload-artifact`) so developers can download the diff images directly from CI.
   * Write `summary.md` to `$GITHUB_STEP_SUMMARY` so a formatted visual report table appears directly on the GitHub Actions run page.

**Phase 5 Verification Deliverable:**
* Trigger the workflow locally or push to a test repository, introduce an intentional CSS layout shift on a branch, and verify the CI pipeline catches the visual regression and outputs the markdown summary table.
