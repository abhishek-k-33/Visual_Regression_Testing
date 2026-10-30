# Visual Regression Tool & CI

An open-source, self-hosted visual regression testing engine and review dashboard. An automated, zero-cost alternative to Chromatic and Percy designed for developers, local staging environments, and GitHub Actions CI pipelines. Monitors and detects visual regressions across CSS, HTML, and responsive viewports.

---

## Features

- 📸 **Deterministic Multi-Viewport Capture**: Headless Chromium automation via Playwright with automatic CSS animation freezing and dynamic DOM element masking.
- 🔍 **Pixel-Level Diffing**: Powered by `pixelmatch` and `pngjs` with automatic canvas dimension normalization for layout shifts and growing pages.
- 🗄️ **Zero-Config Embedded Storage**: SQLite (`better-sqlite3`) for instant, file-based test run history and snapshot tracking.
- 🖥️ **Interactive Review Dashboard**: Modern dark-mode Express + EJS web interface with Side-by-Side comparison, Draggable Overlay Sliders, and Diff Highlight visualizers.
- 🔄 **One-Click Baseline Promotion**: Promote approved changes to new baselines directly from the web interface.
- ⚡ **CI/CD Integration**: Native GitHub Actions pipeline integration failing PRs on unapproved regressions and posting markdown summary tables.

---

## Tech Stack

- **Runtime:** Node.js (v22+ LTS)
- **Browser Engine:** Playwright (Chromium)
- **Diff Engine:** Pixelmatch, PNGjs
- **Server:** Express.js, EJS, Multer
- **Database:** SQLite (`better-sqlite3`)
- **CLI:** Commander.js
- **Testing:** Vitest

---

## Directory Structure

```
visual-regression-tool/
├── package.json                   # Project scripts and dependencies
├── visual.config.json             # Visual regression test configuration
├── docs/                          # Detailed engineering records
│   └── PHASE_1_EXECUTION.md       # Phase 1, Part 1 implementation record
├── src/
│   ├── cli/                       # CLI commands, screenshot & diffing engines
│   │   ├── index.js               # CLI entry point
│   │   ├── capture.js             # Playwright multi-viewport engine
│   │   └── compare.js             # Pixel comparison & dimension normalizer
│   └── server/                    # Express dashboard & REST API
│       ├── app.js                 # Server entry point
│       ├── db.js                  # SQLite database schema and queries
│       ├── routes/                # API and view routes
│       └── views/                 # EJS dashboard templates
└── storage/                       # Local artifact storage (git-ignored)
    ├── baselines/                 # Golden-master approved reference images
    ├── runs/                      # Per-run current & diff screenshots
    └── data.sqlite                # SQLite database
```

---

## Getting Started

### Prerequisites
- Node.js `v22.x` or higher
- npm `10.x` or higher

### Installation
```bash
# Clone the repository
git clone <repository-url>
cd visual-regression-tool

# Install dependencies
npm install

# Install Playwright browser binaries
npx playwright install chromium
```

---

## Documentation & Engineering Logs

- Detailed implementation milestones and architectural decisions are tracked under the [`docs/`](./docs/) directory.
- See [`docs/PHASE_1_EXECUTION.md`](./docs/PHASE_1_EXECUTION.md) for the complete Phase 1, Part 1 setup record.
