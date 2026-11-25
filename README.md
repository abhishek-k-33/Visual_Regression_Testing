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
- 📥 **Review CI Runs Locally**: drop the `visual-regression-diffs.zip` artifact on the dashboard (or run `visual-ci import visual-regression-diffs.zip`) to recreate a failed CI run (screenshots, diffs and the baselines CI compared against) locally, after validating every file in the artifact.
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
│   │   ├── index.js               # CLI entry point (`visual-ci capture`, `visual-ci test`, `visual-ci import`)
│   │   ├── capture.js             # Playwright multi-viewport capture engine
│   │   ├── compare.js             # Pixel comparison and canvas dimension normalizer
│   │   ├── manifest.js            # Writes run.json, the per-run record that travels with CI artifacts
│   │   ├── result.js              # `test --json` result (schema visual-ci-result), exit codes, error codes
│   │   ├── errors.js              # CliError: an error carrying a result error code
│   │   ├── display.js             # redactUrl (credentials/tokens), display paths, host path redaction
│   │   ├── jsonTarget.js          # --json target checks (never run.json/summary, even via links or case)
│   │   ├── logger.js              # Human output; moves to stderr with `--json -`
│   │   ├── naming.js              # Screenshot file names; rejects route/viewport pairs that would collide
│   │   ├── config.js              # Config loader with comment-stripping parser
│   │   └── reporter.js            # Markdown report generator & GITHUB_STEP_SUMMARY
│   └── server/                    # Web review dashboard & REST API
│       ├── app.js                 # Express server configuration
│       ├── db.js                  # SQLite schema and queries
│       ├── importRuns.js          # Imports CI runs (artifact zip or folder) safely: validation, limits, id collisions
│       ├── uploadImport.js        # POST /api/imports: capped streaming upload, one import at a time, disk guard
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
│               ├── tabs.js        # Snapshot view tabs (WAI-ARIA tabs pattern)
│               ├── slider.js      # Split slider (ARIA slider: keyboard + pointer events)
│               ├── import-upload.js  # "Import CI run" button and drag-and-drop upload (live dashboard only)
│               ├── review-actions.js # Approve / Reject buttons and "Approve all pending"
│               └── shortcuts.js   # Run page keyboard shortcuts (j/k/a/r/1-3/?) and help dialog
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
    ├── cli-json.test.js           # test --json and exit codes: errors, diffs, stdout mode, target guards, crashes
    ├── result.test.js             # Result builder, error classification, atomic JSON writer
    ├── display.test.js            # URL redaction, host path redaction, display paths
    ├── json-target.test.js        # --json target guard: symlinks, hard links, case folding, directories
    ├── capture-errors.test.js     # Fake Playwright: launch/navigation/mask/close errors are classified right
    ├── demo-app.test.js           # Demo site variants (original page stays byte-identical)
    ├── build-static-demo.test.js  # Static Pages build end to end: statuses, safety checks, links
    ├── per-run-baselines.test.js  # Per-run baseline copies, stale-approval conflicts, DB migration
    ├── approve-all.test.js        # Approve all pending: all-or-nothing batch, conflicts, rollback on failure
    ├── approve-all-api.test.js    # POST /api/runs/:id/approve-all, CSRF, and the run page button
    ├── compare.test.js            # Pixel comparison and padding tests
    ├── config.test.js             # Config validation and path traversal tests
    ├── db.test.js                 # SQLite queries and path jail tests
    ├── manifest.test.js           # run.json written by the CLI for every test run
    ├── import.test.js             # visual-ci import: real CI run, malicious zips, manifest validation, approval, CLI
    ├── upload-import.test.js      # POST /api/imports: CSRF, 413/415/503/507, aborts, sanitised errors, responsiveness
    ├── import-ui.test.js          # Chromium: import by file picker and drag-and-drop, progress, errors, axe, static mode
    ├── docker.test.js             # Docker image tag matches the pinned Playwright version
    ├── server.test.js             # Express REST API and dashboard view tests (incl. route history)
    ├── storage-dir.test.js        # Custom storageDir honoured by CLI and dashboard
    ├── urls.test.js               # Base-path URL helpers
    ├── viewModels.test.js         # Template data shaping, /storage URL mapping, history model, snapshot counts
    ├── theme-contrast.test.js     # Parses styles.css: light theme covers every token, WCAG AA contrast per theme
    ├── responsive-theme.test.js   # Chromium: no sideways scroll at 360/375px in both themes, 44px tap targets, theme toggle
    ├── helpers/                   # Shared test helpers (CSS token/contrast math, seeded dashboard storage)
    ├── reporter.test.js           # Markdown reporter & CI step summary tests
    ├── a11y-axe.test.js           # axe-core scan of every page type in headless Chromium
    ├── keyboard-ui.test.js        # Keyboard & screen-reader behaviour: tabs, slider, shortcuts, skip link
    ├── helpers/ui-fixture.js      # Browser-test fixture: app on a free port, temp storage, generated PNGs
    ├── helpers/zip.js             # Tiny zip writer for tests (builds malicious archives on the fly)
    ├── helpers/fake-run.js        # Writes a valid CI run folder (images + run.json) without a browser
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
| `VISUAL_IMPORT_MAX_UPLOAD_BYTES` | `209715200` (200 MB) | Dashboard | Largest artifact zip the dashboard accepts for import (`POST /api/imports`). The CLI import has no upload cap. |
| `VISUAL_IMPORT_IDLE_TIMEOUT_MS` | `30000` (30 s) | Dashboard | An import upload that receives no data for this long is dropped (frees the one-import-at-a-time slot). |
| `DEMO_PORT` | `4567` | Demo site | Port for `npm run demo:serve` / `npm run demo`. |
| `CI` | *(unset)* | CLI | When `true`, `test` defaults to `--strict`. |

---

## 📟 CLI Commands

> **Changed in this version:** errors now exit with code **2** instead of 1. Exit code 1 means only "visual differences found" (or a missing baseline in strict mode), so CI scripts can tell a regression from a broken run. See [Exit codes](#exit-codes).

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
- `--json <file>`: Also write a machine-readable result to `<file>` (relative to the working directory; parent folders are created). It is written atomically (temp file + rename), and also when the run fails with an error or crashes. `--json -` writes the JSON to **stdout** and sends all human output, warnings included, to stderr, so `node src/cli/index.js test --json - | jq .status` works. Details:
  - Through npm, use `npm run -s test:visual -- --json -`: without `-s` npm prints its own banner to stdout, ahead of the JSON.
  - Through Docker Compose, use `docker compose run -T runner node src/cli/index.js test --json -`: with a TTY (the default) stderr is merged into stdout.
  - The target must be a file name: a directory (`.`, `out/`) is refused, and so is the run's own `run.json` or markdown summary, however it is reached (a symlinked folder or `VISUAL_STORAGE_DIR`, a link to the file, or a different letter case on macOS/Windows).
  - Once the target is accepted, any file already at that path is removed before the run starts, so a reused path never shows an older run's result. A refused target is never touched. Usage errors (unknown flag, missing value) are rejected before the command runs and leave the path alone, so always check the exit code before reading the file.

#### Exit codes

| Code | Meaning |
| :--- | :--- |
| `0` | Every snapshot matched (or got a new baseline: first run, `--update-baselines`). |
| `1` | Visual differences: at least one `DIFF`, or a `MISSING_BASELINE` in strict mode. |
| `2` | Error: config not found or invalid, a page that could not load, Playwright's browser not installed, an invalid argument or usage error (unknown flag, missing value), or a crash. Also used by `capture` and `import` when they fail. |

`--help` and `--version` exit `0`. A usage error is rejected before the command runs, so it writes no JSON file (and leaves an existing one alone): treat "exit 2" with a missing or older-than-the-run JSON as a usage error.

#### JSON result (`--json`)

Schema `visual-ci-result`, version `1`. Future versions only add fields; existing ones keep their name, type and meaning.

```json
{
  "schema": "visual-ci-result",
  "version": 1,
  "tool": { "name": "visual-ci", "version": "1.0.0" },
  "command": "test",
  "status": "failed",
  "exit_code": 1,
  "error": null,
  "run": {
    "id": "run_1764000000000",
    "mode": "compare",
    "strict": true,
    "base_url": "http://127.0.0.1:4567",
    "branch": "main",
    "commit_sha": "3f2c…",
    "created_at": "2026-11-25T10:00:00.000Z",
    "duration_ms": 5321,
    "threshold_percentage": 1,
    "run_dir": "storage/runs/run_1764000000000",
    "manifest": "storage/runs/run_1764000000000/run.json",
    "summary": "storage/runs/run_1764000000000/summary.md"
  },
  "counts": { "total": 2, "passed": 1, "changed": 1, "missing_baseline": 0, "new_baseline": 0 },
  "snapshots": [
    {
      "route": "/",
      "viewport": "desktop",
      "status": "DIFF",
      "mismatch_percentage": 3.42,
      "current": "storage/runs/run_1764000000000/index-desktop.png",
      "baseline": "storage/baselines/index-desktop.png",
      "baseline_snapshot": "storage/runs/run_1764000000000/baselines/index-desktop.png",
      "diff": "storage/runs/run_1764000000000/index-desktop-diff.png"
    }
  ]
}
```

- `status` is `passed` (exit 0), `failed` (exit 1) or `error` (exit 2); `exit_code` is the process exit code.
- `error` is `null`, or `{ "code", "message" }` with `code` one of `CONFIG_NOT_FOUND`, `CONFIG_INVALID` (including an invalid `maskSelectors` entry), `NAVIGATION_FAILED` (a page that could not load), `BROWSER_MISSING` (Chromium or its system libraries not installed: run `npx playwright install --with-deps chromium`), `INVALID_ARGUMENT`, `INTERNAL` (anything else, including crashes). Messages are sanitised: control and bidi characters are escaped, the working directory is shown as `.` and the home directory as `~`.
- **No secrets:** `base_url` and every message (JSON and terminal) have URL credentials (`user:pass@`) removed and the values of token-like query parameters (`token`, `access_token`, `auth`, `key`, `apikey`, `api_key`, `password`, `secret`, `sig`, `signature`, any case) replaced by `***`.
- `run` is `null` when the run never started (e.g. the config could not be loaded). On a later error it holds what is known; `manifest` and `summary` are `null` when those files were not written.
- `mode` is `compare` or `update-baselines`. `threshold_percentage` and `mismatch_percentage` are percentages (`1` = 1%), rounded to 6 decimals.
- Snapshot `status` is `MATCH`, `DIFF`, `NEW_BASELINE` or `MISSING_BASELINE`.
- `baseline` is the **shared** baseline file in `baselines/` (for `MISSING_BASELINE`, where it is expected; the file does not exist). Approvals change it later, so it can differ from what this run compared against.
- `baseline_snapshot` is the **run's own copy** of the baseline it was compared against, inside the run folder, so it travels with the CI artifact (`storage/runs/`): use it to show "before" for a run, e.g. in a PR comment. For a new baseline it is the run's screenshot; `null` when there was no baseline.
- `diff` is `null` when no comparison was made.
- `counts`: `passed` = `MATCH`, `changed` = `DIFF`, `missing_baseline`, `new_baseline`, and `total`.
- **Paths** are relative to the working directory and use `/`, so they mean the same inside the Docker runner (workspace `/app`) and on the host checkout that mounts `storage/`. A path outside the working directory (e.g. `VISUAL_STORAGE_DIR=/tmp/vrt`) is given absolute.

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

### 6. Review a CI Run Locally (dashboard upload or `visual-ci import`)
When the visual check fails in GitHub Actions, review it in your own dashboard instead of unpacking images by hand:

1. Open the failed workflow run on GitHub and download the **`visual-regression-diffs`** artifact (bottom of the run's *Summary* page). You get `visual-regression-diffs.zip`.
2. Import it, from your checkout of the branch, in either of two ways:
   - **In the dashboard** (`npm start`, then [http://localhost:4000](http://localhost:4000)): click **Import CI run** and pick the zip, or drop the zip anywhere on the dashboard page. When it is done the dashboard opens the imported run (or lists them, if the artifact held several); errors are shown under the page heading.
   - **On the command line:**
     ```bash
     npx visual-ci import ~/Downloads/visual-regression-diffs.zip
     # or: node src/cli/index.js import ~/Downloads/visual-regression-diffs.zip
     ```
     It prints each imported run with its dashboard link, e.g. `http://localhost:4000/runs/run_1732440000000` (using `PORT` if you set it).
3. Imported runs carry an **Imported** badge on the dashboard and in the run header.

```text
visual-ci import <path> [options]

  <path>                 The artifact .zip, a folder holding <run-id>/run.json (e.g. an unpacked
                         artifact), a single run folder, or its run.json
  -c, --config <path>    Config to read storageDir from (only storageDir is used; no baseUrl needed)
  -r, --run-id <id>      Local id for the run (only when importing a single run)
```

- **Where it goes:** the same storage folder the dashboard uses (`VISUAL_STORAGE_DIR`, else `storageDir` from the config, else `./storage`). Screenshots, diffs and the per-run baseline copies go to `runs/<id>/`; your shared `baselines/` folder is never written by an import.
- **Ids:** a run keeps its CI id. If that id is already used by a different local run (compared ignoring case, as macOS and Windows file systems do), it is imported as `<id>-imp2` (then `-imp3`, ...). Importing the same artifact again changes nothing and says *already imported*. `--run-id` picks the id yourself (it must be free).
- **Approving an imported run:** approval copies the CI screenshot into your local `baselines/`, then you commit it as usual. It only works while your local baseline is **exactly the one CI compared against** (CI's hash is kept from `run.json`). If it differs (your branch is behind or ahead of the commit CI tested, or the baseline was changed or approved since), the run page says *"Your local baseline differs from the one CI compared against, so approving would be refused"* and disables **Approve** for that snapshot (and **Approve all pending**); the API answers `409 Conflict`. Check out the commit CI tested (or update your branch) or re-run the tests locally, then review that result. Reject still works.
- **Only artifacts with `run.json`:** artifacts from before `run.json` existed can't be imported (*"no run.json found"*); re-run CI.
- **What is checked:** the archive is untrusted. Only `run.json` and `*.png` files are extracted, into a private staging folder inside the storage root that is removed afterwards. Absolute paths, `..`, backslashes, control or invisible formatting characters in names (e.g. terminal escape sequences, bidi overrides), symlinks and duplicate entries are refused or skipped; anything quoted from the archive in a message is escaped. When importing a folder, symlinks are never followed below the folder you name, and a folder or file swapped for a symlink or a pipe while it is being read is skipped; at most 2000 entries, 50 MB per image, 1 MB per `run.json` and 500 MB in total, counted while unpacking, not taken from the archive's headers. Every `run.json` is validated strictly (schema and version, run id, routes, viewports, statuses, numbers; no control or bidi characters in any string); file names are re-derived from each snapshot's route and viewport rather than trusted; every referenced image must be a real PNG (at most 16384 x 65536 pixels) whose SHA-256 matches the manifest, and the compared baseline's hash must be present. If any run in the input fails a check, nothing is imported.
- **Dashboard upload limits:** the zip may be at most **200 MB** (`VISUAL_IMPORT_MAX_UPLOAD_BYTES`; the page refuses a bigger file before sending it, and the server stops reading once the limit is passed). **One import at a time:** a second upload while one is running is refused with `503` and `Retry-After` (not queued); try again when the first has finished. **Idle timeout:** an upload that sends nothing for 30 s (`VISUAL_IMPORT_IDLE_TIMEOUT_MS`) is disconnected and its temp file removed, so a stalled client can't hold the one-import slot. **Disk guard:** an upload is refused with `507` when the storage folder's disk, or the disk of `runs/` (where the archive is unpacked, if it is a different one), has less than max(2 x the upload limit, 1 GB) free (skipped where the platform can't tell). Server-side failures answer `500` with only an error code; the details are in the dashboard's log. The command-line import has none of these limits besides the archive checks above.
- **Who can import:** anyone who can reach the dashboard can import runs, the same trust level as approving baselines (there is no login). Keep the default `HOST=127.0.0.1` unless you are on a trusted network; uploads get the same cross-site (CSRF) and DNS-rebinding protection as approvals (see *Cross-site protection* above).
- **The server stays responsive while importing:** each file's SHA-256 and PNG header are computed while it is unpacked, so validation never reads whole files synchronously, and the dashboard keeps answering other requests during an import.
- **Same code for both:** the work is done by `importRuns(source, { storageRoot, db, runId })` in `src/server/importRuns.js`, which reports failures with an HTTP-style `status` (`400` unreadable or unsafe input, `409` id taken, `413` too large, `422` no valid run).
- **Interrupted imports:** an upload is streamed to a hidden `.upload-*` file and the archive unpacked into a hidden `.import-*` folder in the storage root; both are removed afterwards whatever happens (also when the browser cancels the upload), and leftovers of a crashed process are cleaned up by the next import once they are an hour old. Hidden (dot-named) paths are never served under `/storage`.

### 7. Build the Static Demo (GitHub Pages)
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
- **Import CI run**: button (and drop target for the whole page) that uploads a CI artifact zip; see [Review a CI Run Locally](#6-review-a-ci-run-locally-dashboard-upload-or-visual-ci-import). Not shown in the read-only static demo.
- **Real-Time Toolbar**: Client-side filter toggle buttons (`All`, `Passed`, `Approved`, `Regressions`) and quick search input.
- **Test Runs Table**: Displays status pills, cyan monospace Run IDs, Git context badges (`🌿 branch`, `#commit`; long branch names are truncated, full name on hover), snapshot counts per status (only the ones present: diff, rejected, new baseline, approved, match), creation times (UTC), and prominent **Inspect** buttons.
- **Pagination**: Minimal footer with item range indicator and navigation controls.

### Run Detail Studio (`GET /runs/:id`)
An unknown run id returns the error page with status `404`. For every route and viewport, three interactive visual tabs are available:
1. **Side-by-Side View**: Compares the baseline *as it was when the run happened* with the current execution in aligned frames. Each run keeps a copy of the baseline it compared against in `runs/<id>/baselines/`, so later approvals don't change what an old run shows. (Runs recorded before this was added show the current baseline instead.)
2. **Interactive Overlay Slider**: Draggable vertical divider (mouse, pen and touch via Pointer Events) to wipe between before and after images in real time. It is also a keyboard slider (see below).
3. **Diff Highlight View**: Full-resolution image canvas with differing pixels painted in bright neon red alongside exact mismatch percentages.
4. **One-Click Baseline Promotion**: Clicking **"Approve & Update Baseline"** copies the current screenshot over the baseline file on disk and transitions the status to `APPROVED`. If the baseline has changed since the run (e.g. a newer run was approved first), approval is refused with `409 Conflict` rather than silently reverting the newer baseline; re-run the tests and review the fresh result. Approving is still allowed when the baseline already equals the run's screenshot. Runs recorded before this check existed are not protected.
5. **Imported runs** (`visual-ci import`): marked **Imported** (with the import time in the header). For each snapshot awaiting review, the page checks whether your local baseline is still the one CI compared against; if not, it shows a notice and disables Approve (and Approve all pending), since approval would be refused with `409`.
6. **Approve all pending**: when a run has snapshots awaiting review (`DIFF` or `MISSING_BASELINE`), the run header shows **"Approve all pending (N)"**. After a confirmation it approves them all at once, **all or nothing**: every snapshot is checked first, and if any baseline has changed since the run, nothing is approved and the conflicting route/viewport pairs are listed. If a baseline changes while the batch is running, or copying a file or saving to the database fails part-way, every baseline already replaced is put back (old baselines are kept as hidden backups until the batch succeeds; if one can't be restored, the error says which and where its backup is). Approved and rejected snapshots are left as they are. In the static demo it is simulated like the single buttons.

**REST API** (writes need the `X-Requested-With` header, see *Cross-site protection* above):

| Method & path | Does |
| :--- | :--- |
| `GET /api/runs` | Lists runs with snapshot counts |
| `GET /api/runs/:id` | One run and its snapshots |
| `POST /api/snapshots/:id/approve` | Promotes one screenshot to the baseline (`409` if the baseline changed since the run) |
| `POST /api/snapshots/:id/reject` | Marks one snapshot rejected |
| `POST /api/imports` | Imports a CI artifact: the raw zip as the body (`Content-Type: application/zip`, `application/x-zip-compressed` or `application/octet-stream`, no multipart). `201 { success, runs: [{ id, url, status, snapshots, renamedFrom?, alreadyImported? }] }`, or `200` when every run was already imported; errors `{ success: false, error }` with `400`/`422` (unreadable or invalid artifact), `413` (over the upload limit or an archive limit), `415` (wrong content type), `503` + `Retry-After` (another import is running), `507` (low disk space), `500` (server-side failure; generic message, details in the log). Example: `curl -X POST -H 'X-Requested-With: cli' -H 'Content-Type: application/zip' --data-binary @visual-regression-diffs.zip http://localhost:4000/api/imports` |
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
- `tests/responsive-theme.test.js` checks in headless Chromium that the dashboard, a run with diffs, a history page and the error page never scroll sideways at 360px and 375px in either theme, including inside their tables (which become cards on phones). On tablets (681–1200px) wide tables may scroll inside their own box, but the page itself never does.

### Route History (`GET /history/:slug/:viewport`)
How one route has looked at one viewport over time, e.g. `/history/index/desktop` for `/` on desktop. The slug is the same one the route's baseline file uses (`index-desktop.png`), so route spellings that share a baseline (such as `/a/b` and `/a_b`) share a history. Viewport names must match `[A-Za-z0-9_-]{1,64}`; unknown or invalid ones return a `404` page.
- **Header**: route, viewport and a link to the current shared baseline image (when one exists).
- **Sparkline**: server-rendered inline SVG of the mismatch percentage, oldest to newest, with min / max / latest (also in its `aria-label`). No chart library.
- **One row per run** (latest 100, newest first; a card per run on phones, thumbnail on top): link to that run's snapshot card, time (UTC), branch and commit, status pill, mismatch %, and a lazy-loaded thumbnail of the screenshot.
- **Baseline changed marker**: shown on a run that was compared against a different baseline than the run before it (e.g. the first run after an approval), and as a dashed line on the sparkline. Runs recorded before baseline hashes existed are not marked.

### Accessibility & Keyboard Shortcuts
The dashboard can be used with the keyboard alone and with a screen reader:
- **Skip link**: the first <kbd>Tab</kbd> on every page shows *Skip to main content*, which jumps to the page's `<main id="main">` landmark. Every focusable element shows a visible focus ring (`:focus-visible`).
- **Comparison tabs** follow the WAI-ARIA tabs pattern: only the selected tab is in the Tab order; <kbd>←</kbd>/<kbd>→</kbd> move between tabs (wrapping), <kbd>Home</kbd>/<kbd>End</kbd> jump to the first/last, and the inactive panels are `hidden`.
- **Comparison slider** is a `role="slider"` named after the route and viewport, with values like *40% current, 60% baseline*: <kbd>←</kbd>/<kbd>→</kbd> (and <kbd>↓</kbd>/<kbd>↑</kbd>) ±5, <kbd>Page Down</kbd>/<kbd>Page Up</kbd> ±20, <kbd>Home</kbd> 0, <kbd>End</kbd> 100.
- **Screen readers**: screenshots have alt text naming the route, viewport and image (baseline, current or diff); decorative icons are hidden; dashboard filters are `aria-pressed` toggle buttons and the search box has a label. Approve/reject results are announced through a polite live region; errors appear next to the snapshot (or the run header) in a `role="alert"` region instead of a blocking `alert()`. Screenshot frames that scroll (tall pages) can be focused and scrolled from the keyboard.

**Run page shortcuts** (press <kbd>?</kbd> or the *Press ? for keyboard shortcuts* button in the run header for the help dialog):

| Key | Does |
| :--- | :--- |
| <kbd>j</kbd> / <kbd>k</kbd> | Next / previous snapshot card. The first <kbd>j</kbd> goes to the first card still awaiting review; after that every card in page order. The current card is outlined and focused. |
| <kbd>a</kbd> | Approve the current snapshot (same as its **Approve & Update Baseline** button) |
| <kbd>r</kbd> | Reject the current snapshot (same as its **Reject** button, including the confirmation) |
| <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> | Side-by-side, slider or diff view of the current snapshot |
| <kbd>?</kbd> | Open the shortcuts help; <kbd>Esc</kbd> closes it |

Clicking or tabbing into a card also makes it the current one. Shortcuts are ignored while you type in a field, with <kbd>Ctrl</kbd>/<kbd>Alt</kbd>/<kbd>Cmd</kbd> held, on key repeat and while a dialog is open. There is deliberately no shortcut for *Approve all pending*. Single-key shortcuts can conflict with screen readers and speech input (WCAG 2.1.4), so the help dialog has a switch to turn them off; the choice is saved in the browser's `localStorage` (if storage is blocked, the switch still works until reload). They work the same in the static demo, where approvals are simulated.

`tests/a11y-axe.test.js` runs [axe-core](https://github.com/dequelabs/axe-core) on the dashboard, a run page (also with the slider and the help dialog open), an imported run with stale-baseline notices, a history page and the error page, and fails on any *serious* or *critical* violation, with every rule enabled (including `color-contrast`) in both the dark and light themes.

---

## 🚀 GitHub Actions CI Pipeline

The project includes pre-configured automation for GitHub Actions (`.github/workflows/visual-ci.yml`):

- **Automatic PR & Push Testing**: Runs the Vitest suite and the visual regression checks whenever a PR or commit is pushed to `main`.
- **Tests a real target**: Serves the bundled demo site and captures it, rather than an external website that can change underneath the tests.
- **Committed baselines**: Baselines come from the git checkout, so every commit is compared against the baselines approved for it.
- **Same rendering as baselines**: Builds the project's Docker image and runs the tests inside it.
- **Strict mode**: A missing baseline fails the job instead of silently passing.
- **Rich Markdown Step Summaries**: Generates a formatted table of every tested route, viewport, mismatch percentage, and pass/fail badge directly in the GitHub Actions run summary (`GITHUB_STEP_SUMMARY`).
- **Diff Artifact Downloads**: On any visual regression failure, `storage/runs/` is zipped and uploaded as a workflow artifact (`visual-regression-diffs`) for quick inspection. Each run folder includes `run.json`, a machine-readable record of the run (status, git info, and per snapshot: route, viewport, status, mismatch, file names and the compared baseline's hash), so a CI run can be re-created without its database: `visual-ci import visual-regression-diffs.zip` loads it into your local dashboard (see [Review a CI Run Locally](#6-review-a-ci-run-locally-dashboard-upload-or-visual-ci-import)).

### Live demo on GitHub Pages (`.github/workflows/pages.yml`)

- **Build**: on pushes and pull requests to `main` that touch `src/`, `scripts/`, the package files or the workflow, runs `scripts/build-static-demo.js` (see [Build the Static Demo](#7-build-the-static-demo-github-pages)) with the repository name as the base path, and uploads `_site` as the Pages artifact. On pull requests it only builds, so a change that breaks the demo fails the PR.
- **Deploy**: on `main` (or a manual run from `main`), deploys the artifact with `actions/deploy-pages` and smoke-tests that the dashboard and the `demo-05-regression` run page return `200`.
- **Setup**: the repository's Pages source must be set to *GitHub Actions* (Settings → Pages).

---

## 🧪 Testing & Verification

The project includes unit, integration, and deliverable verification suites:

```bash
# Run all 519 Vitest unit, integration & browser tests
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
 ✓ tests/cli-json.test.js (25 tests)
 ✓ tests/result.test.js (25 tests)
 ✓ tests/display.test.js (8 tests)
 ✓ tests/json-target.test.js (7 tests)
 ✓ tests/capture-errors.test.js (8 tests)
 ✓ tests/demo-app.test.js (5 tests)
 ✓ tests/build-static-demo.test.js (14 tests)
 ✓ tests/db.test.js (19 tests)
 ✓ tests/docker.test.js (3 tests)
 ✓ tests/manifest.test.js (19 tests)
 ✓ tests/import.test.js (103 tests)
 ✓ tests/upload-import.test.js (24 tests)
 ✓ tests/import-ui.test.js (11 tests)
 ✓ tests/per-run-baselines.test.js (11 tests)
 ✓ tests/approve-all.test.js (21 tests)
 ✓ tests/approve-all-api.test.js (12 tests)
 ✓ tests/server.test.js (51 tests)
 ✓ tests/storage-dir.test.js (3 tests)
 ✓ tests/urls.test.js (3 tests)
 ✓ tests/viewModels.test.js (32 tests)
 ✓ tests/theme-contrast.test.js (9 tests)
 ✓ tests/responsive-theme.test.js (9 tests)
 ✓ tests/reporter.test.js (12 tests)
 ✓ tests/a11y-axe.test.js (14 tests)
 ✓ tests/keyboard-ui.test.js (20 tests)

 Test Files  30 passed (30)
      Tests  519 passed (519)
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
