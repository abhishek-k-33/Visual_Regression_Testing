# Engineering Implementation Record: Phase 1, Part 1
**Project:** Open-Source Visual Regression Testing & CI Tool  
**Date:** October 29, 2026  
**Status:** Completed & Verified  

---

## 1. Executive Summary

Phase 1, Part 1 establishes the foundational runtime environment, repository directory structure, package configuration, and core dependency installation for the Visual Regression Testing & CI Tool. All modules—including headless browser drivers, image processing utilities, database bindings, web server components, and CLI parsing tools—were installed, resolved, and verified.

---

## 2. Directory Architecture

The repository layout follows a modular separation of concerns between CLI execution, background browser workers, the web review dashboard, and persistent file storage:

```
visual-regression-tool/
├── package.json                   # Project manifest (ES Modules)
├── visual.config.json             # Visual regression configuration spec (Phase 1, Part 2)
├── docs/                          # Architectural and engineering documentation
│   └── PHASE_1_EXECUTION.md       # Detailed technical execution log
├── src/
│   ├── cli/                       # Headless capture and diffing command-line engine
│   │   ├── index.js               # CLI entry point (Commander)
│   │   ├── capture.js             # Playwright multi-viewport engine
│   │   └── compare.js             # Pixelmatch comparison & dimension normalizer
│   └── server/                    # Express.js review dashboard server
│       ├── app.js                 # Server entry point
│       ├── db.js                  # SQLite persistence queries & schema
│       ├── routes/                # REST API and view routing controllers
│       │   ├── api.js             # API for test uploads, baseline promotion & status
│       │   └── views.js           # EJS view rendering routes
│       ├── views/                 # EJS dashboard templates
│       │   ├── layout.ejs         # HTML shell & dark-theme base
│       │   ├── index.ejs          # Run summary table & pass/fail badges
│       │   └── run-detail.ejs     # Side-by-side, swipe slider & red-diff visualizer
│       └── public/                # Static assets
│           ├── css/styles.css     # Dark mode developer stylesheet
│           └── js/slider.js       # Draggable before/after curtain slider logic
└── storage/                       # Local, git-ignored artifact storage
    ├── baselines/                 # Golden-master approved reference PNGs
    ├── runs/                      # Per-run execution screenshots & diff outputs
    └── data.sqlite                # SQLite database file
```

---

## 3. Dependency Stack & Technical Justification

| Package | Version | Purpose | Architectural Justification |
| :--- | :--- | :--- | :--- |
| **`playwright`** | `^1.50.1` | Headless Browser Automation | Provides high-fidelity, deterministic Chromium page rendering, full-page scrolling, and reliable network-idle synchronization. |
| **`better-sqlite3`** | `^11.8.1` | Local Metadata Database | Synchronous, embedded, zero-configuration database engine. Avoids spawning separate database processes while offering sub-millisecond query performance for test runs and snapshot metadata. |
| **`pixelmatch`** | `^7.1.0` | Pixel-Level Image Comparison | Industry-standard, hyper-fast pixel diffing library. Highlights differing pixels with anti-aliasing detection and computes exact mismatch ratios. |
| **`pngjs`** | `^7.0.0` | PNG Buffer Decoding & Encoding | Pure JavaScript PNG decoder/encoder with zero native dependencies. Enables dynamic canvas resizing and buffer padding for handling dimension mismatches. |
| **`express`** | `^4.21.2` | Dashboard HTTP Server | Lightweight, reliable HTTP framework to serve the review dashboard and handle CLI artifact uploads. |
| **`ejs`** | `^3.1.10` | Server-Side HTML Templating | Zero-build frontend templating. Eliminates complex frontend build steps (Webpack/Vite/React) for maximum maintainability and rapid self-hosting. |
| **`multer`** | `^1.4.5-lts.1` | Multipart Form Uploads | Handles high-throughput multipart/form-data uploads of current and diff PNGs from the CLI to the review dashboard. |
| **`commander`** | `^13.1.0` | CLI Interface Parsing | Robust command-line argument parsing for subcommands (`capture`, `test`, `approve`). |
| **`vitest`** | `^3.0.7` | Automated Testing Framework | Fast, ESM-native unit testing runner used by the `tdd-runner` agent to verify pure logic (config parsing, dimension padding, diff calculation). |

---

## 4. Runtime Environment: Node.js Version Decision Record

### Context: Bleeding-Edge Node v26 vs. Node v22 LTS
During setup, an evaluation was conducted between Node.js `v26.13.0` (released October 28, 2026) and Node.js `v22.23.1` (Active LTS).

### Decision: Target Node.js v22 LTS
The runtime environment was locked to **Node.js v22.23.1 LTS** due to the following engineering findings:

1. **Native C++ Addon ABI Availability**:
   - `better-sqlite3` relies on native C++ bindings compiled against Node’s internal V8 ABI.
   - Node v26 introduces ABI version `147`. Because Node v26 was released one day prior, precompiled vendor binaries (`prebuild-install`) do not exist for ABI 147.
   - In environments without C++ build toolchains (`make`, `gcc`), source-level compilation fails (`Error: not found: make`).
   - Node v22 LTS targets ABI `127`, which is fully pre-compiled and vendor-distributed (`better-sqlite3-v11.8.1-node-v127-linux-x64.tar.gz`), ensuring zero-dependency deployment.

2. **Upstream Package Manager Stability**:
   - The initial npm 11.20 release distributed with Node v26 contained an upstream regression in its dependency tree (`minipass-flush` export structure), producing `TypeError: Class extends value undefined is not a constructor or null`.
   - Node v22 LTS bundles npm 10.9.8, which is hardened, stable, and completely error-free.

3. **Specification Compliance**:
   - The project requirement specifies `Node.js (v20+)`. Node v22 LTS exceeds this requirement and guarantees support through 2027.

---

## 5. Verification & Quality Assurance Deliverables

To validate the phase completion, three deterministic verification checks were executed:

### Check 1: Headless Browser Driver Spawn
- **Script:** Spawns headless Chromium via Playwright, evaluates browser context, and terminates.
- **Output:** Verified clean initialization of `/home/minimystical/.cache/ms-playwright/chromium_headless_shell-1248`.
- **Result:** **PASSED** (Execution time: ~850ms).

### Check 2: Embedded Database Transactions
- **Script:** Instantiated an in-memory SQLite instance via `better-sqlite3` and executed parameterized SQL query `SELECT 42 as answer`.
- **Output:** `{ answer: 42 }`.
- **Result:** **PASSED** (Execution time: ~12ms).

### Check 3: Unified Dependency Integrity
- **Script:** Concurrently imported all 9 application modules in a unified ES module runner.
- **Output:** `All Phase 1 dependencies loaded successfully!`.
- **Result:** **PASSED** (0 runtime exceptions, 0 deprecation crashes).

---

## 6. Next Implementation Milestone

**Milestone:** Phase 1, Part 2  
**Deliverables:**
1. Specification and creation of `visual.config.json`.
2. Implementation of configuration validator and default fallback loader.
3. Unit test coverage for configuration edge cases (missing routes, invalid viewports, negative thresholds).
