import fs from 'node:fs'; // import node file system
import path from 'node:path';// import node path
import { chromium, errors as playwrightErrors } from 'playwright';// chromium is the engine on which google chrome is based on. Our robot will directly bypass the
// chrome or other browser and use the chromium engine instead which is a lot lighter and faster. 

/**
 * Creates a clean filesystem-friendly slug from a URL route.
 *
 * @param {string} route - The route path (e.g. "/" or "/blog/post-1")
 * @returns {string} Clean file slug
 */
export function getRouteSlug(route) {// converts a web address into a safe legal framework on our computer 
  // what this function does is that if removes / from page names so that it can be saved as a file
  if (!route || route === '/') {
    return 'index'; // returns the name of the homepage which is generally named index.html
  }
  return route
    .replace(/^\/+/, '')// replaces the slashes at the very front of the address. ^ means at the beginning 
    .replace(/\/+$/, '')// replaces the slashes at the very last of the address ,$ means attthe end
    .replace(/[^a-zA-Z0-9_-]/g, '_');// ^ means anything except. replaces anything except atoz and 0to9 ,_,-with _
}

/**
 * Generates standard screenshot filename.
 *
 * @param {string} route - URL route
 * @param {string} viewportName - Viewport identifier
 * @returns {string} Filename (e.g. "index-desktop.png")
 */
export function getSnapshotFilename(route, viewportName) {
  const slug = getRouteSlug(route); // saves the slug of the address to slug variable 
  return `${slug}-${viewportName}.png`; // combines the slug the viewport name and the .png extension to form a clean organized filename
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
export function buildDeterministicStyle(maskSelectors = []) {// this function mutes the css
  let css  = `
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
  `;// this is a custome block of css which is designed to block all the animations on a website .
  // this first line applies the css to each element of the webpage. * in css means all 

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
 * @param {number} [options.navigationTimeout=30000] - Max ms for the page's load event (failing this aborts the capture)
 * @param {number} [options.networkIdleTimeout=10000] - Max ms to additionally wait for network idle (best effort)
 * @returns {Promise<Array<object>>} Array of captured snapshot results
 */
export async function captureScreenshots(config, options = {}) {
  const rawRunId = options.runId || `run_${Date.now()}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(rawRunId)) {
    throw new Error(`Invalid runId "${rawRunId}": must contain only alphanumeric characters, dashes, and underscores.`);
  }
  const runId = rawRunId;
  const navigationTimeout = options.navigationTimeout ?? 30000;
  const networkIdleTimeout = options.networkIdleTimeout ?? 10000;
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
          // The load event is required: a page that can't load is a real failure.
          await page.goto(fullUrl, { waitUntil: 'load', timeout: navigationTimeout });

          // Network idle is best effort. Pages with analytics beacons, long-polling or
          // websockets never go idle; for those, capture the already-loaded page.
          let networkIdle = true;
          try {
            await page.waitForLoadState('networkidle', { timeout: networkIdleTimeout });
          } catch (idleErr) {
            if (!(idleErr instanceof playwrightErrors.TimeoutError)) throw idleErr;
            networkIdle = false;
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
            url: fullUrl,
            networkIdle
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
