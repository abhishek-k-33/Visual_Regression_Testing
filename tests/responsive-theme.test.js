/**
 * Browser checks for the M6 theme and phone layout, in real headless Chromium:
 * no horizontal scrolling at 360/375px on every page type in both themes, 44px tap
 * targets for approve/reject, and the theme toggle / system-preference behaviour.
 * The dashboard runs in-process on an ephemeral port with a temp storage folder.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import app from '../src/server/app.js';
import { closeDb } from '../src/server/db.js';
import { seedDashboard, LONG_RUN_ID } from './helpers/seed-dashboard.js';

const PHONE_WIDTHS = [360, 375];
const THEMES = ['dark', 'light'];
const PAGES = {
  index: '/',
  run: `/runs/${LONG_RUN_ID}`,
  history: '/history/index/desktop',
  error: '/history/does-not-exist/desktop'
};

describe('theme and phone layout in Chromium', { timeout: 60_000 }, () => {
  let tmpDir;
  let previousStorageEnv;
  let server;
  let baseUrl;
  let browser;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-m6-'));
    previousStorageEnv = process.env.VISUAL_STORAGE_DIR;
    process.env.VISUAL_STORAGE_DIR = tmpDir;
    seedDashboard(tmpDir);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDb();
    if (previousStorageEnv === undefined) delete process.env.VISUAL_STORAGE_DIR;
    else process.env.VISUAL_STORAGE_DIR = previousStorageEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A context with a stored theme choice (or none), recording console errors. */
  async function openContext({ width = 375, height = 800, theme, colorScheme = 'dark', javaScriptEnabled = true } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme, javaScriptEnabled });
    if (theme) await context.addInitScript((t) => window.localStorage.setItem('vrt-theme', t), theme);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      // The error page is served with a real 404 status, which Chromium also logs.
      if (msg.type() === 'error' && !msg.location().url.includes(PAGES.error)) errors.push(msg.text());
    });
    return { context, page, errors };
  }

  for (const theme of THEMES) {
    it(`no horizontal overflow at ${PHONE_WIDTHS.join(' / ')}px in the ${theme} theme`, async () => {
      const problems = [];
      for (const width of PHONE_WIDTHS) {
        const { context, page, errors } = await openContext({ width, theme });
        for (const [name, url] of Object.entries(PAGES)) {
          const res = await page.goto(baseUrl + url, { waitUntil: 'load' });
          expect(res.status(), name).toBe(name === 'error' ? 404 : 200);
          const m = await page.evaluate(() => ({
            theme: document.documentElement.dataset.theme,
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            // Overflow absorbed by a scrolling table container never reaches the page
            scrollers: [...document.querySelectorAll('.table-responsive')]
              .filter((el) => el.scrollWidth > el.clientWidth + 1)
              .map((el) => `${el.scrollWidth}/${el.clientWidth}`)
          }));
          expect(m.theme, `${name} @ ${width}`).toBe(theme);
          if (m.scrollWidth > m.clientWidth) problems.push(`${name} @ ${width}px: scrollWidth ${m.scrollWidth} > ${m.clientWidth}`);
          if (m.scrollers.length) problems.push(`${name} @ ${width}px: table scrolls sideways (${m.scrollers.join(', ')})`);
        }
        expect(errors, `console errors @ ${width}`).toEqual([]);
        await context.close();
      }
      expect(problems).toEqual([]);
    });
  }

  it('stacks approve / reject full width with >= 44px tap targets on phones', async () => {
    for (const width of PHONE_WIDTHS) {
      const { context, page } = await openContext({ width, theme: 'dark' });
      await page.goto(baseUrl + PAGES.run);
      const card = page.locator('.snapshot-card').first();
      const cardBox = await card.boundingBox();
      const approve = await card.locator('.btn-approve').boundingBox();
      const reject = await card.locator('.btn-reject').boundingBox();
      for (const box of [approve, reject]) {
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThan(cardBox.width * 0.8);
      }
      expect(reject.y).toBeGreaterThanOrEqual(approve.y + approve.height); // stacked, not side by side
      expect((await page.locator('.btn-approve-all').boundingBox()).height).toBeGreaterThanOrEqual(44);

      await card.locator('.tab-btn[data-tab="slider"]').click();
      const handle = await card.locator('.slider-handle-pill').boundingBox();
      expect(handle.width).toBeGreaterThanOrEqual(44);
      expect(handle.height).toBeGreaterThanOrEqual(44);
      await context.close();
    }
  });

  it('shows the runs table as labelled cards with the long run id truncated', async () => {
    const { context, page } = await openContext({ width: 360, theme: 'light' });
    await page.goto(baseUrl + PAGES.index);
    const row = page.locator(`tr[data-run-id="${LONG_RUN_ID}"]`);
    expect(await row.evaluate((tr) => getComputedStyle(tr).display)).toBe('flex');
    expect(await row.locator('td[data-label="Run ID"]').evaluate((td) => getComputedStyle(td, '::before').content)).toBe('"Run ID" / ""');
    const link = row.locator('.run-id-link');
    expect(await link.evaluate((a) => getComputedStyle(a).textOverflow)).toBe('ellipsis');
    expect(await link.evaluate((a) => a.scrollWidth > a.clientWidth)).toBe(true);
    await context.close();
  });

  it('follows the system preference live while nothing is stored', async () => {
    const { context, page, errors } = await openContext({ colorScheme: 'light' });
    await page.goto(baseUrl + PAGES.index);
    expect(await page.getAttribute('html', 'data-theme')).toBe('light');
    expect(await page.getAttribute('[data-theme-toggle]', 'aria-pressed')).toBe('false');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => page.getAttribute('html', 'data-theme')).toBe('dark');
    expect(await page.getAttribute('[data-theme-toggle]', 'aria-pressed')).toBe('true');
    expect(await page.evaluate(() => window.localStorage.getItem('vrt-theme'))).toBeNull();
    expect(errors).toEqual([]);
    await context.close();
  });

  it('toggle switches the theme, remembers it across reloads and beats the system preference', async () => {
    const { context, page, errors } = await openContext({ width: 1400, colorScheme: 'dark' });
    await page.goto(baseUrl + PAGES.run);
    const toggle = page.getByRole('button', { name: 'Dark theme' });
    expect(await toggle.getAttribute('aria-pressed')).toBe('true');
    expect(await toggle.isVisible()).toBe(true);
    const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await toggle.click();
    expect(await page.getAttribute('html', 'data-theme')).toBe('light');
    expect(await toggle.getAttribute('aria-pressed')).toBe('false');
    expect(await page.evaluate(() => window.localStorage.getItem('vrt-theme'))).toBe('light');
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(lightBg).not.toBe(darkBg);

    await page.reload();
    expect(await page.getAttribute('html', 'data-theme')).toBe('light');
    await page.emulateMedia({ colorScheme: 'dark' }); // a stored choice wins over system changes
    await page.goto(baseUrl + PAGES.history);
    expect(await page.getAttribute('html', 'data-theme')).toBe('light');

    await page.getByRole('button', { name: 'Dark theme' }).click();
    await page.reload();
    expect(await page.getAttribute('html', 'data-theme')).toBe('dark');
    expect(errors).toEqual([]);
    await context.close();
  });

  it('tablet / small-laptop widths: the page never scrolls sideways, and history fits at 1024px', async () => {
    // Wide tables may scroll inside their own .table-responsive box on tablets (the
    // dashboard table always did); the page itself must not. Long branch names used to
    // push the history table past its box at 1024px.
    const problems = [];
    for (const width of [768, 1024]) {
      const { context, page } = await openContext({ width, height: 900, theme: 'dark' });
      for (const name of ['index', 'history']) {
        await page.goto(baseUrl + PAGES[name]);
        const m = await page.evaluate(() => ({
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          tables: [...document.querySelectorAll('.table-responsive')]
            .filter((el) => el.scrollWidth > el.clientWidth + 1)
            .map((el) => `${el.scrollWidth}/${el.clientWidth}`)
        }));
        if (m.page > 0) problems.push(`${name} @ ${width}px: page scrolls sideways by ${m.page}px`);
        if (name === 'history' && width === 1024 && m.tables.length) problems.push(`history @ 1024px: table ${m.tables.join(', ')}`);
      }
      await context.close();
    }
    expect(problems).toEqual([]);
  });

  it('keeps a toggled theme when storage is blocked and the system theme changes', async () => {
    const { context, page } = await openContext({ width: 1024, colorScheme: 'dark' });
    await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
    });
    await page.goto(baseUrl + PAGES.index);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await page.locator('[data-theme-toggle]').click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await context.close();
  });

  it('stays dark with the toggle hidden when JavaScript is off', async () => {
    const { context, page } = await openContext({ colorScheme: 'light', javaScriptEnabled: false });
    await page.goto(baseUrl + PAGES.index);
    expect(await page.getAttribute('html', 'data-theme')).toBeNull();
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(11, 16, 32)');
    expect(await page.locator('[data-theme-toggle]').isVisible()).toBe(false);
    await context.close();
  });
});
