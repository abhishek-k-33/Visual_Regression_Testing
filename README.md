# Visual Regression Tool & CI 📸

An open-source, self-hosted visual regression testing engine and interactive review dashboard. An automated, zero-cost alternative to Chromatic and Percy designed for developers, local staging environments, and continuous integration pipelines. Monitors, detects, and tracks pixel-level regressions across HTML, CSS, and responsive viewports.

> **[Live demo](https://abhishek-k-33.github.io/Visual_Regression_Testing/)**: try the review dashboard in your browser, nothing to install. Open the failing `demo-05-regression` run, compare the screenshots side by side, with the slider and as a diff, then approve or reject it (approvals are simulated and reset on reload).

---

## 🌟 Key Highlights

- 📸 **Deterministic Multi-Viewport Capture**: Playwright-powered headless Chromium capture with automatic CSS transition/animation freezing, caret hiding, and dynamic DOM element masking.
- 🔍 **Pixel-Level Diffing & Dimension Normalization**: Powered by `pixelmatch` and `pngjs` with automatic canvas dimension padding (`PNG.bitblt`) to handle layout shifts without crashes.
- 🗄️ **High-Performance SQLite Persistence**: Embedded SQLite storage (`better-sqlite3`) with Write-Ahead Logging (WAL) mode for fast, concurrent run tracking, Git commit/branch context, and snapshot history.
- 🖥️ **Linear/Vercel-Inspired Review Dashboard**: Full-width developer dashboard (dark and light themes, phone-friendly layout, WCAG AA contrast) featuring real-time search, status filtering, pagination, Side-by-Side comparison, Draggable Split Sliders, and Diff Highlight visualizers.
- 🔄 **One-Click Baseline Promotion**: Promote approved visual regressions to new golden baselines on disk directly from the web interface.
- 🔒 **Security Basics**: Baseline promotion restricted to PNGs inside `storage/runs/` → `storage/baselines/` (symlink-aware), `/storage` serves only screenshot PNGs, localhost-only binding by default, and parameterized SQL queries.

---

## 🛠️ Architecture & Workflow

```text
 ┌──────────────────────┐      ┌─────────────────────────┐      ┌───────────────────────┐
 │                      │      │                         │      │                       │
 │  visual.config.json  ├─────►│ Playwright Capture     ├─────►│ Pixel Diffing Engine  │
 │  (routes, viewports) │      │ (Deterministic Freeze)  │      │ (Dimension Normalizer)│
 └──────────────────────┘      └─────────────────────────┘      └───────────┬───────────┘
                                                                            │
 ┌──────────────────────┐      ┌─────────────────────────┐                  │
 │                      │      │                         │                  ▼
 │  Promote Baseline    │◄─────┤ Web Review Dashboard    │◄───── SQLite Persistence
 │  (Overwrites Master) │      │ (Slider, Side-by-Side)  │       (storage/data.sqlite)
 └──────────────────────┘      └─────────────────────────┘
```

1. **Capture:** Playwright launches headless Chromium, injects deterministic CSS rules to halt animations, masks volatile elements (e.g., ads, timestamps), and takes full-page screenshots across all configured viewports.
2. **Compare:** The engine loads the approved baseline image from `storage/baselines/`. If dimensions differ, it transparently pads the smaller image to match the larger bounding box, runs anti-aliasing-aware pixel diffing, highlights differing pixels in neon red, and computes the mismatch percentage.
3. **Persist:** Test runs, Git metadata (branch name and commit hash), mismatch metrics, and filepaths are stored in `storage/data.sqlite`.
4. **Review & Approve:** Developers open the review dashboard (`http://localhost:4000`), inspect diffs via the interactive split slider, and approve intentional changes with a single click.

---

## 💻 Tech Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Runtime** | Node.js (v22+ LTS) | Native ES modules (`"type": "module"`) |
| **Browser Engine** | Playwright (Chromium) | Multi-viewport deterministic rendering |
| **Diff Engine** | Pixelmatch & PNGjs | Pixel comparison, dimension normalization |
| **Backend Framework** | Express.js (v4) | RESTful API & static asset serving |
| **View Engine** | EJS (Embedded JavaScript) | Server-rendered responsive templates |
| **Database** | SQLite (`better-sqlite3`) | Embedded database with WAL concurrency |
| **CLI Framework** | Commander.js (v13) | Command-line interface and flags |
| **Test Suite** | Vitest (v3) | Unit and integration testing |

---

## 📁 Directory Structure

```text
Visual Regression Testing Project/
├── package.json                   # Scripts and project dependencies
├── visual.config.json             # Visual regression test specifications
├── Dockerfile                     # Standardized Playwright + Ubuntu font container
├── docker-compose.yml             # Orchestration for dashboard & test runner
├── .dockerignore                  # Docker build context exclusions
├── .github/                       # GitHub automation
│   └── workflows/
│       ├── visual-ci.yml          # GitHub Actions visual regression pipeline
│       └── pages.yml              # Builds the static demo and deploys it to GitHub Pages
├── docs/                          # Detailed engineering milestone records
│   ├── PHASE_1_EXECUTION.md       # Foundation & Playwright Capture Engine
│   ├── PHASE_2_EXECUTION.md       # Pixel Diffing & Dimension Normalizer
│   ├── PHASE_3_EXECUTION.md       # SQLite Storage & Interactive Dashboard
│   ├── PHASE_4_EXECUTION.md       # Cross-Platform Docker Containerization
│   └── PHASE_5_EXECUTION.md       # GitHub Actions CI & Markdown Reporting
├── src/
│   ├── cli/                       # CLI commands and screenshot engine
│   │   ├── index.js               # CLI entry point (`visual-ci capture`, `visual-ci test`)
│   │   ├── capture.js             # Playwright multi-viewport capture engine
│   │   ├── compare.js             # Pixel comparison and canvas dimension normalizer
│   │   ├── manifest.js            # Writes run.json, the per-run record that travels with CI artifacts
│   │   ├── naming.js              # Screenshot file names; rejects route/viewport pairs that would collide
│   │   ├── config.js              # Config loader with comment-stripping parser
│   │   └── reporter.js            # Markdown report generator & GITHUB_STEP_SUMMARY
│   └── server/                    # Web review dashboard & REST API
│       ├── app.js                 # Express server configuration
│       ├── db.js                  # SQLite schema and queries
│       ├── paths.js               # Storage root and PNG path allowlist checks
│       ├── security.js            # Host allowlist + CSRF checks for the unauthenticated dashboard
│       ├── viewModels.js          # Shapes DB rows into what the templates render (incl. /storage URLs)
│       ├── urls.js                # url()/pageLocals(): base-path handling so pages also work under a sub-path
│       ├── routes/                # Express routers (`/api`, `/`)
│       │   ├── api.js             # REST API for runs and snapshot approval
│       │   └── views.js           # HTML views: dashboard, run details, route history
│       ├── views/                 # EJS templates (Linear/Vercel style, dark + light themes)
│       │   ├── partials/          # Shared header (head, theme init script, navbar) and footer (scripts)
│       │   ├── index.ejs          # Main dashboard table with KPI cards
│       │   ├── run-detail.ejs     # Inspection studio (Slider, Side-by-Side, Diff)
│       │   ├── history.ejs        # One route + viewport across runs (sparkline, thumbnails)
│       │   └── layout.ejs         # Error page
│       └── public/                # Static assets (CSS, client JS as ES modules)
│           ├── css/styles.css     # Stylesheet: colour tokens on :root (dark) + :root[data-theme="light"]
│           └── js/
│               ├── common.js      # Base path, API URL and screen-reader announce helpers
│               ├── theme.js       # Light/dark toggle (every page), remembers the choice
│               ├── dashboard.js   # Real-time search, filtering, and pagination
│               ├── tabs.js        # Snapshot view tabs
│               ├── slider.js      # Draggable split-slider
│               └── review-actions.js # Approve / Reject buttons and "Approve all pending"
├── scripts/
│   ├── demo-app.js                # Static demo site (the visual CI target) with original/regressed/redesign variants
│   ├── serve-demo.js              # Serves the demo site on :4567 (npm run demo:serve)
│   ├── demo.js                    # Interactive regression demo (npm run demo)
│   ├── demo.config.json           # Demo-only config (route /__vrt_demo), never touches committed baselines
│   ├── build-static-demo.js       # Builds the read-only GitHub Pages demo (npm run demo:pages)
│   └── pages-demo.config.json     # Config for the Pages demo runs (temp storage only)
├── storage/                       # Local artifacts directory
│   ├── baselines/                 # Golden-master baselines (committed to git, reviewed in PRs)
│   ├── runs/                      # Per run: screenshots, diffs, compared-baseline copies and run.json (git-ignored)
│   └── data.sqlite                # SQLite database file (git-ignored)
└── tests/                         # Vitest unit and integration test suites
    ├── capture.test.js            # Capture engine unit tests
    ├── capture-integration.test.js# Deterministic capture integration tests
    ├── cli-strict.test.js         # CLI strict mode: missing baselines fail in CI
    ├── demo-app.test.js           # Demo site variants (original page stays byte-identical)
    ├── build-static-demo.test.js  # Static Pages build end to end: statuses, safety checks, links
    ├── per-run-baselines.test.js  # Per-run baseline copies, stale-approval conflicts, DB migration
    ├── approve-all.test.js        # Approve all pending: all-or-nothing batch, conflicts, rollback on failure
    ├── approve-all-api.test.js    # POST /api/runs/:id/approve-all, CSRF, and the run page button
    ├── compare.test.js            # Pixel comparison and padding tests
    ├── config.test.js             # Config validation and path traversal tests
    ├── db.test.js                 # SQLite queries and path jail tests
    ├── manifest.test.js           # run.json written by the CLI for every test run
    ├── docker.test.js             # Docker image tag matches the pinned Playwright version
    ├── server.test.js             # Express REST API and dashboard view tests (incl. route history)
    ├── storage-dir.test.js        # Custom storageDir honoured by CLI and dashboard
    ├── urls.test.js               # Base-path URL helpers
    ├── viewModels.test.js         # Template data shaping, /storage URL mapping, history model, snapshot counts
    ├── theme-contrast.test.js     # Parses styles.css: light theme covers every token, WCAG AA contrast per theme
    ├── responsive-theme.test.js   # Chromium: no sideways scroll at 360/375px in both themes, 44px tap targets, theme toggle
    ├── helpers/                   # Shared test helpers (CSS token/contrast math, seeded dashboard storage)
    ├── reporter.test.js           # Markdown reporter & CI step summary tests
    ├── verify-phase-1.js          # Phase 1 deliverable verification script
    ├── verify-phase-2.js          # Phase 2 deliverable verification script
    ├── verify-phase-3.js          # Phase 3 deliverable verification script
    ├── verify-phase-4.js          # Phase 4 deliverable verification script
    └── verify-phase-5.js          # Phase 5 deliverable verification script
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: `v22.x` LTS or higher
- **npm**: `10.x` or higher

### Installation

```bash
# Clone the repository
git clone https://github.com/abhishek-k-33/Visual_Regression_Testing.git
cd Visual_Regression_Testing

# Install dependencies
npm install

# Install Playwright Chromium binary and system dependencies
npx playwright install chromium
```

---

## ⚙️ Configuration (`visual.config.json`)

Configure your target URL, routes, viewports, and masking rules in `visual.config.json`. The loader supports comments (`//` and `/* */`):

```json
{
  "baseUrl": "http://127.0.0.1:4567",
  "routes": [
    "/",
    "/pricing",
    "/about"
  ],
  "viewports": [
    {
      "name": "desktop",
      "width": 1440,
      "height": 900
    },
    {
      "name": "mobile",
      "width": 375,
      "height": 812
    }
  ],
  "maskSelectors": [
    ".advertisement",
    "[data-dynamic-timestamp]",
    "#live-chat-widget"
  ],
  "threshold": 0.01,
  "storageDir": "./storage"
}
```

### Configuration Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `baseUrl` | `string` | *(Required)* | The base URL of the web application being tested. |
| `routes` | `string[]` | `["/"]` | Array of relative routes to capture. Each route/viewport pair must map to its own file name (e.g. `/a/b` and `/a_b` both become `a_b-<viewport>.png`), or the config is rejected. |
| `viewports` | `object[]` | Desktop & Mobile | Viewport dimensions (`name`, `width`, `height`). |
| `maskSelectors` | `string[]` | `[]` | Selectors whose elements are painted over with solid black boxes (`#000000`) in the screenshot, using Playwright's screenshot `mask`. CSS selectors work (Playwright selector syntax is also accepted); pseudo-elements such as `::after` are not supported, and an invalid entry fails the capture with an error naming it. |
| `threshold` | `number` | `0.01` | Maximum allowable pixel mismatch ratio (0.01 = 1.0%). |
| `storageDir` | `string` | `"./storage"` | Directory (inside the project) for baselines, runs and the SQLite DB. The CLI and the dashboard both use it; the dashboard reads it from `./visual.config.json`. `docker-compose.yml` mounts `./storage`, so update the volumes if you change it, and add `<storageDir>/runs/` to `.gitignore` (databases are already ignored). |

### Environment Variables
The app reads these from the environment (it does not load a `.env` file):

| Variable | Default | Used by | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | `4000` | Dashboard | Port to listen on. |
| `HOST` | `127.0.0.1` | Dashboard | Interface to bind; `0.0.0.0` exposes it on your network (no authentication). |
| `ALLOWED_HOSTS` | *(none)* | Dashboard | Comma-separated hostnames allowed in the `Host` header besides `localhost` and IP addresses. |
| `VISUAL_STORAGE_DIR` | *(unset)* | CLI & dashboard | Overrides `storageDir` for both (e.g. to point the dashboard at a config passed with `--config`). |
| `DEMO_PORT` | `4567` | Demo site | Port for `npm run demo:serve` / `npm run demo`. |
| `CI` | *(unset)* | CLI | When `true`, `test` defaults to `--strict`. |

---

## 📟 CLI Commands

### 1. Run Automated Visual Regression Tests
Captures screenshots across all viewports, compares against golden baselines, records results in SQLite, and reports metrics. The repo is configured against the bundled demo site, so start it first (or point `baseUrl` at your own app):

```bash
npm run demo:serve      # in another terminal
npm run test:visual
```
*Or using the CLI directly:*
```bash
node src/cli/index.js test
```

#### CLI Flags
- `-c, --config <path>`: Specify a custom configuration file path.
- `-r, --run-id <id>`: Assign a custom identifier to the test run (defaults to `run_<timestamp>`).
- `-u, --base-url <url>`: Override the `baseUrl` (useful for staging/preview environments).
- `-s, --summary-file <path>`: Custom file name or path for the markdown test report.
- `--update-baselines`: Automatically promote all current screenshots to golden master baselines.
- `--strict` / `--no-strict`: In strict mode a route with no baseline **fails** (`MISSING_BASELINE`) instead of adopting the current screenshot as its baseline. Strict is the default when `CI=true`, so CI can never pass by comparing a page to itself.

### 2. Capture Screenshots Only
Capture deterministic full-page screenshots without diffing:

```bash
npm run capture
```

### 3. Start the Web Review Dashboard
Launches the Express dashboard and REST API server:

```bash
npm start
```

*Access the dashboard at:* **[http://localhost:4000](http://localhost:4000)**

The server listens on `127.0.0.1` only. To reach it from other machines, start it with `HOST=0.0.0.0 npm start`. The dashboard has no authentication, so only do this on a trusted network.

**Cross-site protection.** Because the dashboard has no login, the server defends against other websites driving it through your browser:

- **CSRF:** `POST` requests to `/api` must carry an `X-Requested-With` header, and are refused if the browser reports a cross-site `Origin` or `Sec-Fetch-Site`. Scripts calling the API need to send the header, e.g. `curl -X POST -H 'X-Requested-With: cli' http://localhost:4000/api/snapshots/42/approve`.
- **DNS rebinding:** requests are only served when the `Host` header is `localhost` or an IP address. If you reach the dashboard through a hostname (e.g. `ci-box.internal` or a reverse proxy), list it: `ALLOWED_HOSTS=ci-box.internal npm start` (comma-separated).
- **Behind a reverse proxy:** the proxy must forward the browser's original `Host` header unchanged, including any port (e.g. nginx `proxy_set_header Host $http_host;`; Caddy and Traefik do this by default). Otherwise approve/reject is refused with *"Origin does not match Host"*, and rebinding protection for reads is weakened.

### 4. Run Inside Docker (Cross-OS Rendering Consistency)
To eliminate font and sub-pixel antialiasing differences across macOS, Windows, and Linux:

```bash
# Build the standardized Playwright container
npm run docker:build

# Run visual regression tests inside the container
npm run docker:test

# Start the review dashboard inside the container
npm run docker:dashboard
```

### 5. Managing Baselines
Approved baselines live in `storage/baselines/` and are **committed to git**. That keeps them in sync with the code on every branch, and GitHub shows the image diff when a PR changes one.

Create or update them **inside the Docker image**, the same environment CI uses, so fonts and anti-aliasing match pixel for pixel:

```bash
npm run demo:serve                 # or start your own app
npm run docker:update-baselines    # writes storage/baselines/*.png
git add storage/baselines && git commit -m "test: update visual baselines"
```

Baselines captured outside the container (or approved in the dashboard after a non-Docker run) may differ slightly from CI's rendering. `npm run demo` and the `verify-phase-*` scripts use their own `__vrt_*.png` baselines, which are git-ignored.

With rootful Docker on Linux, files the container writes into `storage/` are owned by root. Hand them back with `sudo chown -R "$(id -u):$(id -g)" storage` (not needed with Docker Desktop or rootless Podman).

### 6. Build the Static Demo (GitHub Pages)
Builds the read-only dashboard behind the [live demo](https://abhishek-k-33.github.io/Visual_Regression_Testing/) into `_site/` (git-ignored):

```bash
npm run demo:pages
# = node scripts/build-static-demo.js --out _site --base /Visual_Regression_Testing
```

It serves the bundled demo site, runs the real CLI five times in a throwaway temp storage folder (baseline, pass, an intentional redesign that gets approved, pass, and a regression left for review), then renders the dashboard, run and history pages (`history/<slug>/<viewport>.html` for every route and viewport) with the same templates in *static* mode: a demo banner is shown and Approve/Reject only update the page. Only the screenshots the pages show are copied; the build fails if the output would contain a database, `run.json`, Markdown summaries or a broken link. `--base` is the sub-path the site is served under (`/` for a domain root); `--repo-url` sets the banner's GitHub link. Your own `storage/` is never read or changed.

---

## 🖥️ Web Review Dashboard

The dashboard provides a **Linear/Vercel-inspired developer interface**:

### Main Dashboard (`GET /`)
- **Three KPI Statistics Cards**:
  - **Total Runs**: Displays overall test executions with blue gradient and play icon.
  - **Passed / Approved**: Shows successful runs with emerald green gradient and check icon.
  - **Visual Regressions**: Highlights failing runs with coral red gradient and alert icon.
- **Real-Time Toolbar**: Client-side filtering tabs (`All`, `Passed`, `Approved`, `Regressions`) and quick search input.
- **Test Runs Table**: Displays status pills, cyan monospace Run IDs, Git context badges (`🌿 branch`, `#commit`; long branch names are truncated, full name on hover), snapshot counts per status (only the ones present: diff, rejected, new baseline, approved, match), creation times (UTC), and prominent **Inspect** buttons.
- **Pagination**: Minimal footer with item range indicator and navigation controls.

### Run Detail Studio (`GET /runs/:id`)
For every route and viewport, three interactive visual tabs are available:
1. **Side-by-Side View**: Compares the baseline *as it was when the run happened* with the current execution in aligned frames. Each run keeps a copy of the baseline it compared against in `runs/<id>/baselines/`, so later approvals don't change what an old run shows. (Runs recorded before this was added show the current baseline instead.)
2. **Interactive Overlay Slider**: Draggable vertical divider (mouse and touch enabled) to wipe between before and after images in real time.
3. **Diff Highlight View**: Full-resolution image canvas with differing pixels painted in bright neon red alongside exact mismatch percentages.
4. **One-Click Baseline Promotion**: Clicking **"Approve & Update Baseline"** copies the current screenshot over the baseline file on disk and transitions the status to `APPROVED`. If the baseline has changed since the run (e.g. a newer run was approved first), approval is refused with `409 Conflict` rather than silently reverting the newer baseline; re-run the tests and review the fresh result. Approving is still allowed when the baseline already equals the run's screenshot. Runs recorded before this check existed are not protected.
5. **Approve all pending**: when a run has snapshots awaiting review (`DIFF` or `MISSING_BASELINE`), the run header shows **"Approve all pending (N)"**. After a confirmation it approves them all at once, **all or nothing**: every snapshot is checked first, and if any baseline has changed since the run, nothing is approved and the conflicting route/viewport pairs are listed. If a baseline changes while the batch is running, or copying a file or saving to the database fails part-way, every baseline already replaced is put back (old baselines are kept as hidden backups until the batch succeeds; if one can't be restored, the error says which and where its backup is). Approved and rejected snapshots are left as they are. In the static demo it is simulated like the single buttons.

**REST API** (writes need the `X-Requested-With` header, see *Cross-site protection* above):

| Method & path | Does |
| :--- | :--- |
| `GET /api/runs` | Lists runs with snapshot counts |
| `GET /api/runs/:id` | One run and its snapshots |
| `POST /api/snapshots/:id/approve` | Promotes one screenshot to the baseline (`409` if the baseline changed since the run) |
| `POST /api/snapshots/:id/reject` | Marks one snapshot rejected |
| `POST /api/runs/:id/approve-all` | Approves every pending snapshot of the run, all or nothing: `200 { success, approved: [ids], runStatus, snapshots }` (`approved: []` when nothing is pending), `409 { success: false, error, conflicts: [{ id, route, viewport }] }`, `404` for an unknown run |

Each snapshot card links to the **History** of its route and viewport (see below), and has an `id="snapshot-<id>"` anchor that the history page links to.

### Themes (light / dark)
- **How the theme is picked**: an inline script in `<head>` (before the stylesheet, so there is no flash of the wrong theme) sets `<html data-theme="light|dark">`. A choice you made with the toggle wins; otherwise it follows the system setting (`prefers-color-scheme`), and keeps following live system changes until you pick one. Without JavaScript the dashboard stays dark.
- **Toggle**: the sun/moon button in the navbar (`aria-pressed="true"` means dark is on). It stores your choice in `localStorage` under the key **`vrt-theme`** (`"light"` or `"dark"`); clear that key to go back to following the system. Other open tabs follow the change. Works the same in the static GitHub Pages demo, under its sub-path.
- **Colours** are custom properties: `:root` holds the dark palette, `:root[data-theme="light"]` overrides every colour token. Screenshots and diff images are never recoloured. `tests/theme-contrast.test.js` checks that the key text/background pairs (text on every surface, links, status pills, buttons, KPI cards, demo banner) meet WCAG AA (4.5:1 text, 3:1 large text and control borders) in both themes.

### Phones (680px and narrower)
- The runs table and the history table become stacked cards with a label per field; long run ids and branch names are cut with an ellipsis.
- Filter tabs form a 2x2 grid and the search box takes the full width.
- On run pages, Approve / Reject (and Approve all pending) stack full width with tap targets at least 44px tall, baseline and current screenshots stack, and the slider handle is bigger (dragging it no longer scrolls the page).
- `tests/responsive-theme.test.js` checks in headless Chromium that the dashboard, a run with diffs, a history page and the error page never scroll sideways at 360px and 375px in either theme.

### Route History (`GET /history/:slug/:viewport`)
How one route has looked at one viewport over time, e.g. `/history/index/desktop` for `/` on desktop. The slug is the same one the route's baseline file uses (`index-desktop.png`), so route spellings that share a baseline (such as `/a/b` and `/a_b`) share a history. Viewport names must match `[A-Za-z0-9_-]{1,64}`; unknown or invalid ones return a `404` page.
- **Header**: route, viewport and a link to the current shared baseline image (when one exists).
- **Sparkline**: server-rendered inline SVG of the mismatch percentage, oldest to newest, with min / max / latest (also in its `aria-label`). No chart library.
- **One row per run** (latest 100, newest first; a card per run on phones, thumbnail on top): link to that run's snapshot card, time (UTC), branch and commit, status pill, mismatch %, and a lazy-loaded thumbnail of the screenshot.
- **Baseline changed marker**: shown on a run that was compared against a different baseline than the run before it (e.g. the first run after an approval), and as a dashed line on the sparkline. Runs recorded before baseline hashes existed are not marked.

---

## 🚀 GitHub Actions CI Pipeline

The project includes pre-configured automation for GitHub Actions (`.github/workflows/visual-ci.yml`):

- **Automatic PR & Push Testing**: Runs the Vitest suite and the visual regression checks whenever a PR or commit is pushed to `main`.
- **Tests a real target**: Serves the bundled demo site and captures it, rather than an external website that can change underneath the tests.
- **Committed baselines**: Baselines come from the git checkout, so every commit is compared against the baselines approved for it.
- **Same rendering as baselines**: Builds the project's Docker image and runs the tests inside it.
- **Strict mode**: A missing baseline fails the job instead of silently passing.
- **Rich Markdown Step Summaries**: Generates a formatted table of every tested route, viewport, mismatch percentage, and pass/fail badge directly in the GitHub Actions run summary (`GITHUB_STEP_SUMMARY`).
- **Diff Artifact Downloads**: On any visual regression failure, `storage/runs/` is zipped and uploaded as a workflow artifact (`visual-regression-diffs`) for quick inspection. Each run folder includes `run.json`, a machine-readable record of the run (status, git info, and per snapshot: route, viewport, status, mismatch, file names and the compared baseline's hash), so a CI run can be re-created without its database.

### Live demo on GitHub Pages (`.github/workflows/pages.yml`)

- **Build**: on pushes and pull requests to `main` that touch `src/`, `scripts/`, the package files or the workflow, runs `scripts/build-static-demo.js` (see [Build the Static Demo](#6-build-the-static-demo-github-pages)) with the repository name as the base path, and uploads `_site` as the Pages artifact. On pull requests it only builds, so a change that breaks the demo fails the PR.
- **Deploy**: on `main` (or a manual run from `main`), deploys the artifact with `actions/deploy-pages` and smoke-tests that the dashboard and the `demo-05-regression` run page return `200`.
- **Setup**: the repository's Pages source must be set to *GitHub Actions* (Settings → Pages).

---

## 🧪 Testing & Verification

The project includes unit, integration, and deliverable verification suites:

```bash
# Run all 261 Vitest unit & integration tests
npm test

# Run Phase 1 Deliverable Verification (Capture & Masking)
node tests/verify-phase-1.js

# Run Phase 2 Deliverable Verification (Pixel Diffing & Layout Shifts)
node tests/verify-phase-2.js

# Run Phase 3 Deliverable Verification (Database, Dashboard & Approvals)
node tests/verify-phase-3.js

# Run Phase 4 Deliverable Verification (Docker & Cross-OS Environment)
node tests/verify-phase-4.js

# Run Phase 5 Deliverable Verification (GitHub Actions CI & Markdown Reports)
node tests/verify-phase-5.js
```

### Verification Results
```text
 ✓ tests/config.test.js (21 tests)
 ✓ tests/capture.test.js (8 tests)
 ✓ tests/compare.test.js (11 tests)
 ✓ tests/capture-integration.test.js (6 tests)
 ✓ tests/cli-strict.test.js (5 tests)
 ✓ tests/demo-app.test.js (5 tests)
 ✓ tests/build-static-demo.test.js (13 tests)
 ✓ tests/db.test.js (19 tests)
 ✓ tests/docker.test.js (3 tests)
 ✓ tests/manifest.test.js (19 tests)
 ✓ tests/per-run-baselines.test.js (11 tests)
 ✓ tests/approve-all.test.js (21 tests)
 ✓ tests/approve-all-api.test.js (12 tests)
 ✓ tests/server.test.js (42 tests)
 ✓ tests/storage-dir.test.js (3 tests)
 ✓ tests/urls.test.js (3 tests)
 ✓ tests/viewModels.test.js (32 tests)
 ✓ tests/theme-contrast.test.js (9 tests)
 ✓ tests/responsive-theme.test.js (7 tests)
 ✓ tests/reporter.test.js (11 tests)

 Test Files  20 passed (20)
      Tests  261 passed (261)
```

---

## 📚 Engineering Logs & Milestones

Detailed implementation specifications, security audits, and architectural records:
- **[Phase 1 Implementation Record](docs/PHASE_1_EXECUTION.md)**: Playwright engine, deterministic animation freezing, dynamic DOM masking.
- **[Phase 2 Implementation Record](docs/PHASE_2_EXECUTION.md)**: Pixel diffing engine, canvas dimension normalization, baseline promotion.
- **[Phase 3 Implementation Record](docs/PHASE_3_EXECUTION.md)**: SQLite storage, REST API, interactive review dashboard, and security hardening.
- **[Phase 4 Implementation Record](docs/PHASE_4_EXECUTION.md)**: Cross-platform Docker containerization, volume sharing, and font normalization.
- **[Phase 5 Implementation Record](docs/PHASE_5_EXECUTION.md)**: GitHub Actions CI workflow, PR gating, Markdown step summaries, and diff archiving.

---

## 🗺️ Roadmap

- [x] **Phase 1:** Multi-viewport capture engine & deterministic DOM freezing.
- [x] **Phase 2:** Pixel diffing engine, dimension normalizer & CLI test command.
- [x] **Phase 3:** Embedded SQLite storage, REST API & interactive review dashboard.
- [x] **Phase 4:** Cross-platform Docker containerization (`Dockerfile`, `docker-compose.yml`) for OS-independent rendering consistency.
- [x] **Phase 5:** GitHub Actions CI workflow with automated PR checks, Markdown step summaries, and diff artifact uploads.

---

## 📄 License

MIT © Abhishek
