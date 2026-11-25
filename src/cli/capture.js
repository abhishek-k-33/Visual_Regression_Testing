import fs from 'node:fs'; // import node file system
import path from 'node:path';// import node path
import { chromium, errors as playwrightErrors } from 'playwright';// chromium is the engine on which google chrome is based on. Our robot will directly bypass the
// chrome or other browser and use the chromium engine instead which is a lot lighter and faster. 

export { getRouteSlug, getSnapshotFilename } from './naming.js';
import { getSnapshotFilename } from './naming.js';
import { CliError } from './errors.js';

/**
 * Throws (INVALID_ARGUMENT) unless the run id is safe to use as a folder name.
 *
 * @param {string} runId
 */
export function assertValidRunId(runId) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new CliError('INVALID_ARGUMENT', `Invalid runId "${runId}": must contain only alphanumeric characters, dashes, and underscores.`);
  }
}

/**
 * CSS injected into every page to ensure deterministic captures:
 * - Freezes all CSS animations and transitions
 * - Hides the typing caret
 * (maskSelectors are not handled here: they are painted as black boxes by
 * page.screenshot's `mask` option, see MASK_COLOR.)
 *
 * @returns {string} Injected CSS string
 */
export const MASK_COLOR = '#000000';

export function buildDeterministicStyle() {// this function mutes the css
  const css = `
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

  return css;
}

/**
 * Fails fast, naming the offending entry, if a maskSelectors entry isn't a valid
 * Playwright selector (pseudo-elements such as ::after are not supported).
 *
 * @param {import('playwright').Page} page
 * @param {string[]} [maskSelectors]
 */
async function assertValidMaskSelectors(page, maskSelectors = []) {
  for (const [i, selector] of maskSelectors.entries()) {
    try {
      await page.locator(selector).count();
    } catch (err) {
      throw new Error(`maskSelectors[${i}] "${selector}" is not a valid selector: ${err.message.split('\n')[0]}`);
    }
  }
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
  const runId = options.runId || `run_${Date.now()}`;
  assertValidRunId(runId);
  const navigationTimeout = options.navigationTimeout ?? 30000;
  const networkIdleTimeout = options.networkIdleTimeout ?? 10000;
  const baseStorage = options.outputDir || path.resolve(process.cwd(), config.storageDir || 'storage', 'runs');
  const targetDir = path.resolve(baseStorage, runId);

  fs.mkdirSync(targetDir, { recursive: true });

  const deterministicCss = buildDeterministicStyle();
  const browser = await chromium.launch({ headless: true });
  const results = [];
  let masksChecked = false;

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
          try {
            await page.goto(fullUrl, { waitUntil: 'load', timeout: navigationTimeout });
          } catch (navErr) {
            // First line only: the rest is Playwright's call log.
            const reason = String(navErr?.message ?? navErr).split('\n')[0];
            throw new CliError('NAVIGATION_FAILED', `Could not load ${fullUrl}: ${reason}`, { cause: navErr });
          }

          // Network idle is best effort. Pages with analytics beacons, long-polling or
          // websockets never go idle; for those, capture the already-loaded page.
          let networkIdle = true;
          try {
            await page.waitForLoadState('networkidle', { timeout: networkIdleTimeout });
          } catch (idleErr) {
            if (!(idleErr instanceof playwrightErrors.TimeoutError)) throw idleErr;
            networkIdle = false;
          }

          if (!masksChecked) {
            await assertValidMaskSelectors(page, config.maskSelectors);
            masksChecked = true;
          }

          // Inject deterministic styles to freeze animations and hide the caret
          await page.addStyleTag({ content: deterministicCss });

          // Brief pause to allow any synchronous style recalculation
          await page.waitForTimeout(200);

          const filename = getSnapshotFilename(route, viewport.name);
          const filepath = path.join(targetDir, filename);

          // Full page capture. Masked elements are painted over with solid black boxes;
          // unlike hiding them with CSS this also covers canvases, iframes and elements
          // whose inline styles would override an injected rule.
          await page.screenshot({
            path: filepath,
            fullPage: true,
            mask: (config.maskSelectors || []).map((selector) => page.locator(selector)),
            maskColor: MASK_COLOR
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
