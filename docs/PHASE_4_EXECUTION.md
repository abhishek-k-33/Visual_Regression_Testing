# Engineering Implementation Record: Phase 4
**Project:** Open-Source Visual Regression Testing & CI Tool  
**Date:** November 19, 2026  
**Status:** Completed & Verified  

---

## 1. Executive Summary

Phase 4 introduces containerization using Docker and Docker Compose to achieve 100% deterministic, cross-operating system visual rendering consistency. Variations in font kerning, sub-pixel antialiasing, and default system typefaces across macOS, Windows, and Linux frequently cause false-positive visual regressions when baselines are generated on developer laptops and tested in CI.

By encapsulating Playwright Chromium, standardized Linux font packages, and the review dashboard inside an Ubuntu Noble container, Phase 4 ensures that screenshot pixels render identically regardless of host OS.

---

## 2. Deliverables Completed

### 1. Standardized Playwright Container (`Dockerfile`)
- **Base Image**: `mcr.microsoft.com/playwright:v1.64.1-noble` (Ubuntu 24.04 LTS), bundling compatible Chromium binaries and system rendering dependencies.
- **Typography Normalization**: Installs standardized TrueType/OpenType font packages to ensure consistent text rendering across all platforms:
  - `fonts-noto-color-emoji`
  - `fonts-liberation`
  - `fonts-dejavu-core`
  - `fonts-freefont-ttf`
- **Dependency Install**: Runs `npm ci --omit=dev --ignore-scripts`. `better-sqlite3` (v13+) ships prebuilt N-API binaries, so nothing is compiled; a build step loads SQLite to fail fast if that ever changes. The base image tag must equal the pinned `playwright` version, enforced by `tests/docker.test.js`.
- **Directory Structure & Permissions**: Pre-initializes `/app/storage/baselines` and `/app/storage/runs`.
- **Port Exposure**: Exposes port `4000` for the Web Review Dashboard.
- **Default Entrypoint**: Defaults to starting the Express server (`node src/server/app.js`).

### 2. Multi-Service Container Orchestration (`docker-compose.yml`)
- **Service 1: `dashboard`**:
  - Runs the Web Review Dashboard server on port `4000:4000`.
  - Mounts `./storage:/app/storage` ensuring test runs, baseline promotions, and SQLite metadata are shared with the host machine.
  - Configures `NODE_ENV=production` and `restart: unless-stopped`.
- **Service 2: `runner`**:
  - Runs containerized test execution: `["node", "src/cli/index.js", "test"]`.
  - Mounts `./storage:/app/storage` for direct baseline comparison and diff generation.
  - Mounts `./visual.config.json:/app/visual.config.json:ro` so host configuration edits take effect without container rebuilds.
  - Configures `network_mode: "host"` allowing the runner inside the container to capture web applications running on host `localhost` ports (e.g. `http://localhost:3000`).

### 3. Build Context Optimization (`.dockerignore`)
- Restricts Docker build context by excluding:
  - `node_modules/`
  - `.git/` and `.github/`
  - `.antigravity/`
  - `storage/runs/*`
  - `storage/*.sqlite*`
  - `tests/.tmp*` and transient test artifacts.

### 4. NPM Helper Scripts (`package.json`)
- Added convenient npm scripts:
  - `"docker:build"`: `docker compose build`
  - `"docker:dashboard"`: `docker compose up dashboard`
  - `"docker:test"`: `docker compose run --rm runner`

### 5. Phase 4 Deliverable Verification (`tests/verify-phase-4.js`)
- Automated verification script checking:
  1. `Dockerfile` existence, base image compatibility, font installations, workdir, dependencies, and port exposure.
  2. `docker-compose.yml` service definitions (`dashboard`, `runner`), volume mounts, port bindings, and host networking.
  3. `.dockerignore` file exclusions.
  4. `package.json` Docker script definitions.
- All 23 verification checks passed cleanly.

---

## 3. Verification Metrics

```text
======================================================
  [PHASE 4 VERIFICATION] Docker & Cross-OS Environment
======================================================

✓ Dockerfile exists
✓ Dockerfile uses official Playwright base image
✓ Dockerfile installs Linux typography packages
✓ Dockerfile sets working directory /app
✓ Dockerfile executes npm ci for clean build
✓ Dockerfile copies application source and config
✓ Dockerfile exposes port 4000
✓ Dockerfile configures dashboard start command
✓ docker-compose.yml exists
✓ docker-compose defines "dashboard" service
✓ docker-compose defines "runner" service
✓ docker-compose binds port 4000:4000
✓ docker-compose mounts ./storage volume
✓ docker-compose mounts visual.config.json for runner
✓ docker-compose configures network_mode host for runner
✓ .dockerignore exists
✓ .dockerignore excludes node_modules
✓ .dockerignore excludes .git
✓ .dockerignore excludes SQLite database files
✓ .dockerignore excludes transient runs
✓ package.json has docker:build script
✓ package.json has docker:dashboard script
✓ package.json has docker:test script

======================================================
  [PASS] ALL PHASE 4 DELIVERABLES VERIFIED SUCCESSFULLY
======================================================
```

---

## 4. Next Implementation Milestone

**Milestone:** Phase 5  
**Deliverables:**
1. Automated GitHub Actions workflow (`.github/workflows/visual-ci.yml`) triggering on pull requests and pushes to `main`.
2. Pipeline step summary markdown generation reporting snapshot status and mismatch percentages directly on the GitHub PR page.
3. Artifact archiving for diff images (`actions/upload-artifact`).
