import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A fake Playwright, so each failure (launch, navigation, close) can be produced on demand.
const fake = vi.hoisted(() => ({ launch: null }));
vi.mock('playwright', () => ({
  chromium: { launch: (...args) => fake.launch(...args) },
  errors: { TimeoutError: class TimeoutError extends Error {} }
}));

const { captureScreenshots, toLaunchError, toNavigationError } = await import('../src/cli/capture.js');
const { classifyError } = await import('../src/cli/result.js');

function fakeBrowser({ goto = async () => {}, count = async () => 0, contextClose = async () => {}, browserClose = async () => {} } = {}) {
  const page = {
    goto,
    waitForLoadState: async () => {},
    locator: () => ({ count }),
    addStyleTag: async () => {},
    waitForTimeout: async () => {},
    screenshot: async ({ path: file }) => fs.writeFileSync(file, 'png')
  };
  return {
    newContext: async () => ({ newPage: async () => page, close: contextClose }),
    close: browserClose
  };
}

const config = {
  baseUrl: 'http://user:s3cret@127.0.0.1:9',
  routes: ['/'],
  viewports: [{ name: 'desktop', width: 100, height: 100 }],
  maskSelectors: ['.ok', 'div[[bad']
};

describe('capture error classification', () => {
  let outputDir;
  let warn;
  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-capture-errors-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const capture = (cfg = config) => captureScreenshots(cfg, { runId: 'r1', outputDir });
  const rejection = (promise) => promise.then(() => { throw new Error('expected a rejection'); }, (err) => err);

  it('a browser that is not installed is BROWSER_MISSING, with the install command', async () => {
    fake.launch = async () => { throw new Error("browserType.launch: Executable doesn't exist at /home/me/.cache/ms-playwright/chromium-1/chrome\n╔═══╗"); };
    const err = await rejection(capture());
    expect(classifyError(err)).toBe('BROWSER_MISSING');
    expect(err.message).toContain('npx playwright install chromium');
  });

  it('missing system libraries are BROWSER_MISSING, pointing at --with-deps', async () => {
    fake.launch = async () => { throw new Error('browserType.launch: \n╔══╗\n║ Host system is missing dependencies to run browsers. ║\n║ sudo npx playwright install-deps ║'); };
    const err = await rejection(capture());
    expect(classifyError(err)).toBe('BROWSER_MISSING');
    expect(err.message).toContain('npx playwright install --with-deps chromium');
  });

  it('other launch errors are left alone (INTERNAL)', () => {
    const original = new Error('spawn EACCES');
    expect(toLaunchError(original)).toBe(original);
    expect(classifyError(toLaunchError(original))).toBe('INTERNAL');
  });

  it('a page that cannot load is NAVIGATION_FAILED, with the URL redacted', async () => {
    fake.launch = async () => fakeBrowser({ goto: async () => { throw new Error('page.goto: net::ERR_EMPTY_RESPONSE at http://user:s3cret@127.0.0.1:9/\nCall log:\n  - navigating'); } });
    const err = await rejection(capture());
    expect(classifyError(err)).toBe('NAVIGATION_FAILED');
    expect(err.message).toBe('Could not load http://127.0.0.1:9/: page.goto: net::ERR_EMPTY_RESPONSE at http://127.0.0.1:9/');
  });

  it('the browser closing during goto is INTERNAL, not NAVIGATION_FAILED', async () => {
    fake.launch = async () => fakeBrowser({ goto: async () => { throw new Error('page.goto: Target page, context or browser has been closed'); } });
    const err = await rejection(capture());
    expect(classifyError(err)).toBe('INTERNAL');
    expect(classifyError(toNavigationError(new Error('page.goto: Target closed'), 'http://x.test'))).toBe('INTERNAL');
  });

  it('an invalid maskSelectors entry is CONFIG_INVALID', async () => {
    fake.launch = async () => fakeBrowser({
      count: async function count() { throw new Error('Unexpected token "[" while parsing selector "div[[bad"\nmore'); }
    });
    const err = await rejection(capture());
    expect(classifyError(err)).toBe('CONFIG_INVALID');
    expect(err.message).toMatch(/^maskSelectors\[0\] ".ok" is not a valid selector: Unexpected token/);
  });

  it('a failing context.close()/browser.close() never replaces the original error: it is a warning', async () => {
    fake.launch = async () => fakeBrowser({
      goto: async () => { throw new Error('page.goto: net::ERR_EMPTY_RESPONSE at http://127.0.0.1:9/'); },
      contextClose: async () => { throw new Error('context close boom'); },
      browserClose: async () => { throw new Error('browser close boom'); }
    });
    const err = await rejection(capture());
    expect(classifyError(err)).toBe('NAVIGATION_FAILED');
    const warnings = warn.mock.calls.map((args) => args.join(' '));
    expect(warnings.some((w) => w.includes('[WARN] Could not close the browser context: context close boom'))).toBe(true);
    expect(warnings.some((w) => w.includes('[WARN] Could not close the browser: browser close boom'))).toBe(true);
  });

  it('a close failure after a good capture is only a warning too', async () => {
    fake.launch = async () => fakeBrowser({ browserClose: async () => { throw new Error('browser close boom'); } });
    const results = await capture({ ...config, maskSelectors: [] });
    expect(results).toHaveLength(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('browser close boom');
  });
});
