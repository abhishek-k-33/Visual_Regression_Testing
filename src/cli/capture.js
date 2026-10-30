import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

/**
 * Creates a clean filesystem-friendly slug from a URL route.
 *
 * @param {string} route - The route path (e.g. "/" or "/blog/post-1")
 * @returns {string} Clean file slug
 */
export function getRouteSlug(route) {
  if (!route || route === '/') {
    return 'index';
  }
  return route
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Generates standard screenshot filename.
 *
 * @param {string} route - URL route
 * @param {string} viewportName - Viewport identifier
 * @returns {string} Filename (e.g. "index-desktop.png")
 */
export function getSnapshotFilename(route, viewportName) {
  const slug = getRouteSlug(route);
  return `${slug}-${viewportName}.png`;
}

/**
 * CSS injected into every page to ensure deterministic captures:
 * - Freezes all CSS animations and transitions
 * - Hides the typing caret
 * - Optionally masks specified CSS selectors
 *
 * @param {string[]} [maskSelectors=[]] - CSS selectors to mask
 * @returns {string} Injected CSS string
 */
export function buildDeterministicStyle(maskSelectors = []) {
  let css = `
    *, *::before, *::after {
      -webkit-transition: none !important;
      -moz-transition: none !important;
      -o-transition: none !important;
      -ms-transition: none !important;
      transition: none !important;
      -webkit-animation: none !important;
      -moz-animation: none !important;
      -o-animation: none !important;
      -ms-animation: none !important;
      animation: none !important;
      caret-color: transparent !important;
      scroll-behavior: auto !important;
    }
  `;

  if (maskSelectors && maskSelectors.length > 0) {
    const combinedSelector = maskSelectors.join(', ');
    css += `
      ${combinedSelector} {
        visibility: hidden !important;
      }
    `;
  }

  return css;
}

/**
 * Captures screenshots for all configured routes and viewports.
 *
 * @param {object} config - Validated configuration object
 * @param {object} [options={}] - Execution options
 * @param {string} [options.runId] - Run ID folder name (defaults to "run_<timestamp>")
 * @param {string} [options.outputDir] - Base output directory (defaults to config.storageDir/runs)
 * @param {Function} [options.onProgress] - Callback invoked after each screenshot
 * @returns {Promise<Array<object>>} Array of captured snapshot results
 */
export async function captureScreenshots(config, options = {}) {
  const rawRunId = options.runId || `run_${Date.now()}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(rawRunId)) {
    throw new Error(`Invalid runId "${rawRunId}": must contain only alphanumeric characters, dashes, and underscores.`);
  }
  const runId = rawRunId;
  const baseStorage = options.outputDir || path.resolve(process.cwd(), config.storageDir || 'storage', 'runs');
  const targetDir = path.resolve(baseStorage, runId);

  fs.mkdirSync(targetDir, { recursive: true });

  const deterministicCss = buildDeterministicStyle(config.maskSelectors);
  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    for (const route of config.routes) {
      const fullUrl = `${config.baseUrl}${route}`;

      for (const viewport of config.viewports) {
        const context = await browser.newContext({
          viewport: {
            width: viewport.width,
            height: viewport.height
          },
          deviceScaleFactor: 1
        });

        const page = await context.newPage();

        try {
          // Navigate with networkidle synchronization
          try {
            await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 30000 });
          } catch (navErr) {
            // Fallback to 'load' if networkidle times out (e.g. analytics or long-polling)
            if (navErr.message.includes('timeout')) {
              await page.goto(fullUrl, { waitUntil: 'load', timeout: 15000 });
            } else {
              throw navErr;
            }
          }

          // Inject deterministic styles to freeze animations and mask dynamic elements
          await page.addStyleTag({ content: deterministicCss });

          // Brief pause to allow any synchronous style recalculation
          await page.waitForTimeout(200);

          const filename = getSnapshotFilename(route, viewport.name);
          const filepath = path.join(targetDir, filename);

          // Full page capture
          await page.screenshot({
            path: filepath,
            fullPage: true
          });

          const snapshotResult = {
            runId,
            route,
            viewport: viewport.name,
            width: viewport.width,
            height: viewport.height,
            filepath,
            filename,
            url: fullUrl
          };

          results.push(snapshotResult);

          if (typeof options.onProgress === 'function') {
            options.onProgress(snapshotResult);
          }
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}
