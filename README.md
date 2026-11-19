# Visual Regression Tool & CI 📸

An open-source, self-hosted visual regression testing engine and interactive review dashboard. An automated, zero-cost alternative to Chromatic and Percy designed for developers, local staging environments, and continuous integration pipelines. Monitors, detects, and tracks pixel-level regressions across HTML, CSS, and responsive viewports.

---

## 🌟 Key Highlights

- 📸 **Deterministic Multi-Viewport Capture**: Playwright-powered headless Chromium capture with automatic CSS transition/animation freezing, caret hiding, and dynamic DOM element masking.
- 🔍 **Pixel-Level Diffing & Dimension Normalization**: Powered by `pixelmatch` and `pngjs` with automatic canvas dimension padding (`PNG.bitblt`) to handle layout shifts without crashes.
- 🗄️ **High-Performance SQLite Persistence**: Embedded SQLite storage (`better-sqlite3`) with Write-Ahead Logging (WAL) mode for fast, concurrent run tracking, Git commit/branch context, and snapshot history.
- 🖥️ **Linear/Vercel-Inspired Review Dashboard**: Full-width dark developer dashboard featuring real-time search, status filtering, pagination, Side-by-Side comparison, Draggable Split Sliders, and Diff Highlight visualizers.
- 🔄 **One-Click Baseline Promotion**: Promote approved visual regressions to new golden baselines on disk directly from the web interface.
- 🔒 **Enterprise-Grade Security**: Path traversal jails on baseline file writes, static file guards preventing SQLite database exposure, and parameterized SQL queries.

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
├── docs/                          # Detailed engineering milestone records
│   ├── PHASE_1_EXECUTION.md       # Foundation & Playwright Capture Engine
│   ├── PHASE_2_EXECUTION.md       # Pixel Diffing & Dimension Normalizer
│   └── PHASE_3_EXECUTION.md       # SQLite Storage & Interactive Dashboard
├── src/
│   ├── cli/                       # CLI commands and screenshot engine
│   │   ├── index.js               # CLI entry point (`visual-ci capture`, `visual-ci test`)
│   │   ├── capture.js             # Playwright multi-viewport capture engine
│   │   ├── compare.js             # Pixel comparison and canvas dimension normalizer
│   │   └── config.js              # Config loader with comment-stripping parser
│   └── server/                    # Web review dashboard & REST API
│       ├── app.js                 # Express server configuration
│       ├── db.js                  # SQLite schema, queries, and path security
│       ├── routes/                # Express routers (`/api`, `/`)
│       │   ├── api.js             # REST API for runs and snapshot approval
│       │   └── views.js           # HTML views for dashboard and run details
│       ├── views/                 # EJS templates (Linear/Vercel dark theme)
│       │   ├── index.ejs          # Main dashboard table with KPI cards
│       │   ├── run-detail.ejs     # Inspection studio (Slider, Side-by-Side, Diff)
│       │   └── layout.ejs         # Global HTML layout
│       └── public/                # Static assets (CSS, client JS)
│           ├── css/styles.css     # Premium dark theme stylesheet
│           └── js/
│               ├── dashboard.js   # Real-time search, filtering, and pagination
│               └── slider.js      # Draggable split-slider and AJAX approval
├── storage/                       # Local artifacts directory (git-ignored)
│   ├── baselines/                 # Golden-master approved reference screenshots
│   ├── runs/                      # Per-run current and diff screenshots
│   └── data.sqlite                # SQLite database file
└── tests/                         # Vitest unit and integration test suites
    ├── capture.test.js            # Capture engine unit tests
    ├── capture-integration.test.js# Deterministic capture integration tests
    ├── compare.test.js            # Pixel comparison and padding tests
    ├── config.test.js             # Config validation and path traversal tests
    ├── db.test.js                 # SQLite queries and path jail tests
    ├── server.test.js             # Express REST API and dashboard view tests
    ├── verify-phase-1.js          # Phase 1 deliverable verification script
    ├── verify-phase-2.js          # Phase 2 deliverable verification script
    └── verify-phase-3.js          # Phase 3 deliverable verification script
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
  "baseUrl": "https://example.com",
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
| `routes` | `string[]` | `["/"]` | Array of relative routes to capture. |
| `viewports` | `object[]` | Desktop & Mobile | Viewport dimensions (`name`, `width`, `height`). |
| `maskSelectors` | `string[]` | `[]` | CSS selectors obscured with black rectangles (`#000000`). |
| `threshold` | `number` | `0.01` | Maximum allowable pixel mismatch ratio (0.01 = 1.0%). |
| `storageDir` | `string` | `"./storage"` | Local directory for storing baselines, runs, and SQLite DB. |

---

## 📟 CLI Commands

### 1. Run Automated Visual Regression Tests
Captures screenshots across all viewports, compares against golden baselines, records results in SQLite, and reports metrics:

```bash
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
- `--update-baselines`: Automatically promote all current screenshots to golden master baselines.

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

---

## 🖥️ Web Review Dashboard

The dashboard provides a **Linear/Vercel-inspired developer interface**:

### Main Dashboard (`GET /`)
- **Three KPI Statistics Cards**:
  - **Total Runs**: Displays overall test executions with blue gradient and play icon.
  - **Passed / Approved**: Shows successful runs with emerald green gradient and check icon.
  - **Visual Regressions**: Highlights failing runs with coral red gradient and alert icon.
- **Real-Time Toolbar**: Client-side filtering tabs (`All`, `Passed`, `Approved`, `Regressions`) and quick search input.
- **Test Runs Table**: Displays status pills, cyan monospace Run IDs, Git context badges (`🌿 branch`, `#commit`), snapshot counts (matches in green, diffs in red), timestamps, and prominent **Inspect** buttons.
- **Pagination**: Minimal footer with item range indicator and navigation controls.

### Run Detail Studio (`GET /runs/:id`)
For every route and viewport, three interactive visual tabs are available:
1. **Side-by-Side View**: Compares approved baseline and current execution in aligned frames.
2. **Interactive Overlay Slider**: Draggable vertical divider (mouse and touch enabled) to wipe between before and after images in real time.
3. **Diff Highlight View**: Full-resolution image canvas with differing pixels painted in bright neon red alongside exact mismatch percentages.
4. **One-Click Baseline Promotion**: Clicking **"Approve & Update Baseline"** copies the current screenshot over the baseline file on disk and transitions the status to `APPROVED`.

---

## 🧪 Testing & Verification

The project includes unit, integration, and deliverable verification suites:

```bash
# Run all 52 Vitest unit & integration tests
npm test

# Run Phase 1 Deliverable Verification (Capture & Masking)
node tests/verify-phase-1.js

# Run Phase 2 Deliverable Verification (Pixel Diffing & Layout Shifts)
node tests/verify-phase-2.js

# Run Phase 3 Deliverable Verification (Database, Dashboard & Approvals)
node tests/verify-phase-3.js
```

### Verification Results
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

## 📚 Engineering Logs & Milestones

Detailed implementation specifications, security audits, and architectural records:
- **[Phase 1 Implementation Record](docs/PHASE_1_EXECUTION.md)**: Playwright engine, deterministic animation freezing, dynamic DOM masking.
- **[Phase 2 Implementation Record](docs/PHASE_2_EXECUTION.md)**: Pixel diffing engine, canvas dimension normalization, baseline promotion.
- **[Phase 3 Implementation Record](docs/PHASE_3_EXECUTION.md)**: SQLite storage, REST API, interactive review dashboard, and security hardening.

---

## 🗺️ Roadmap

- [x] **Phase 1:** Multi-viewport capture engine & deterministic DOM freezing.
- [x] **Phase 2:** Pixel diffing engine, dimension normalizer & CLI test command.
- [x] **Phase 3:** Embedded SQLite storage, REST API & interactive review dashboard.
- [ ] **Phase 4:** Cross-platform Docker containerization (`Dockerfile`, `docker-compose.yml`) for OS-independent rendering consistency.
- [ ] **Phase 5:** GitHub Actions CI workflow with automated PR checks and artifact uploads.

---

## 📄 License

MIT © Abhishek
