/**
 * Keyboard and screen-reader behaviour of the dashboard in headless Chromium: skip link,
 * filter toggle buttons, comparison tabs, the comparison slider, the run page's single-key
 * shortcuts and help dialog, and action errors shown in role="alert" regions (no alert()).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import { startUiServer } from './helpers/ui-fixture.js';
import { runDetailModel } from '../src/server/viewModels.js';

describe('keyboard & screen-reader behaviour (headless Chromium)', () => {
  let ui;
  let browser;
  const contexts = [];

  beforeAll(async () => {
    ui = await startUiServer();
    browser = await chromium.launch();
  }, 60000);

  afterAll(async () => {
    await Promise.all(contexts.map((c) => c.close().catch(() => {})));
    await browser?.close();
    await ui?.close();
  });

  /**
   * Opens a page and records console errors, page errors and native dialogs. confirm()
   * dialogs are answered with `page.confirmAnswer` (default true); alert()s are dismissed
   * (and recorded, so tests can assert there were none).
   */
  async function open(path, { contextOptions, initScript } = {}) {
    const context = await browser.newContext(contextOptions);
    contexts.push(context);
    if (initScript) await context.addInitScript(initScript);
    const page = await context.newPage();
    const errors = [];
    const dialogs = [];
    page.confirmAnswer = true;
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', async (d) => {
      dialogs.push({ type: d.type(), message: d.message() });
      if (d.type() === 'confirm' && page.confirmAnswer) await d.accept();
      else await d.dismiss();
    });
    if (path) await page.goto(`${ui.baseUrl}${path}`);
    return { page, context, errors, dialogs };
  }

  const card = (page, i) => page.locator('.snapshot-card').nth(i);
  const currentIndex = (page) => page.evaluate(() => {
    const all = [...document.querySelectorAll('.snapshot-card')];
    const current = all.filter((c) => c.classList.contains('is-current'));
    if (current.length > 1) throw new Error('more than one current card');
    return all.indexOf(current[0]);
  });
  const activeId = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);

  describe('skip link and landmarks', () => {
    for (const path of ['/', '/runs/ui-review', '/history/index/desktop', '/runs/no-such-run']) {
      it(`is the first Tab stop and moves focus to <main id="main"> on ${path}`, async () => {
        const { page, errors } = await open(path);
        await page.keyboard.press('Tab');
        const skip = page.locator('.skip-link');
        await expect.poll(() => skip.evaluate((el) => el === document.activeElement)).toBe(true);
        expect(await skip.textContent()).toBe('Skip to main content');
        // Slides on screen while focused (links have a short transition)
        await expect.poll(async () => (await skip.boundingBox()).y).toBeGreaterThanOrEqual(0);
        await page.keyboard.press('Enter');
        await expect.poll(() => activeId(page)).toBe('main');
        expect(await page.locator('main#main').count()).toBe(1);
        // The error page is served with status 404, which Chromium logs for the document itself.
        expect(errors.filter((e) => !(path === '/runs/no-such-run' && /status of 404/.test(e)))).toEqual([]);
      }, 30000);
    }
  });

  describe('dashboard', () => {
    it('filter buttons are aria-pressed toggles and the search field has a label', async () => {
      const { page, errors } = await open('/');
      const group = page.getByRole('group', { name: 'Filter runs by status' });
      const all = group.getByRole('button', { name: /All Runs/ });
      const passed = group.getByRole('button', { name: /Passed/ });
      expect(await all.getAttribute('aria-pressed')).toBe('true');
      expect(await passed.getAttribute('aria-pressed')).toBe('false');
      await passed.focus();
      await page.keyboard.press('Enter');
      expect(await passed.getAttribute('aria-pressed')).toBe('true');
      expect(await all.getAttribute('aria-pressed')).toBe('false');
      expect(await page.locator('tr[data-run-id="ui-review"]').isVisible()).toBe(false);

      const search = page.getByLabel('Filter runs by ID, branch or commit');
      expect(await search.getAttribute('id')).toBe('dashboard-search');
      expect(errors).toEqual([]);
    }, 30000);
  });

  describe('comparison tabs (WAI-ARIA tabs pattern)', () => {
    it('exposes tablist/tab/tabpanel with ids, aria-controls and a roving tabindex', async () => {
      const { page, errors } = await open('/runs/ui-review');
      const c = card(page, 1); // "/" desktop, DIFF: all three views
      const tablist = c.getByRole('tablist');
      expect(await tablist.getAttribute('aria-label')).toBe('Comparison views for / at desktop');
      const tabs = c.getByRole('tab');
      expect(await tabs.count()).toBe(3);

      const state = () => c.evaluate((el) => [...el.querySelectorAll('[role="tab"]')].map((t) => {
        const panel = document.getElementById(t.getAttribute('aria-controls'));
        return {
          selected: t.getAttribute('aria-selected'),
          tabindex: t.getAttribute('tabindex'),
          panelRole: panel?.getAttribute('role'),
          labelledBy: panel?.getAttribute('aria-labelledby') === t.id,
          panelTabindex: panel?.getAttribute('tabindex'),
          hidden: panel?.hidden
        };
      }));
      const expectSelected = async (i) => {
        const s = await state();
        s.forEach((t, j) => {
          expect(t).toMatchObject({ selected: String(i === j), tabindex: i === j ? '0' : '-1', panelRole: 'tabpanel', labelledBy: true, panelTabindex: '0', hidden: i !== j });
        });
        expect(await page.evaluate(() => document.activeElement.getAttribute('role'))).toBe('tab');
        expect(await page.evaluate(() => document.activeElement.getAttribute('aria-selected'))).toBe('true');
      };

      await tabs.nth(0).focus();
      await page.keyboard.press('ArrowRight');
      await expectSelected(1);
      await page.keyboard.press('End');
      await expectSelected(2);
      await page.keyboard.press('ArrowRight'); // wraps
      await expectSelected(0);
      await page.keyboard.press('ArrowLeft'); // wraps
      await expectSelected(2);
      await page.keyboard.press('Home');
      await expectSelected(0);

      // Tab leaves the tablist for the selected panel (only one tab is in the Tab order)
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement.getAttribute('role'))).toBe('tabpanel');

      // A snapshot without a baseline has only the side-by-side view
      expect(await card(page, 3).getByRole('tab').count()).toBe(1);
      expect(errors).toEqual([]);
    }, 30000);
  });

  describe('comparison slider', () => {
    it('is an ARIA slider driven by arrows, Page Up/Down, Home/End and pointer drags', async () => {
      const { page, errors } = await open('/runs/ui-review');
      const c = card(page, 1);
      await c.getByRole('tab', { name: 'Interactive Slider' }).click();
      const slider = c.getByRole('slider', { name: 'Comparison slider for / at desktop' });
      const value = async () => ({
        now: await slider.getAttribute('aria-valuenow'),
        text: await slider.getAttribute('aria-valuetext')
      });
      expect(await slider.getAttribute('aria-valuemin')).toBe('0');
      expect(await slider.getAttribute('aria-valuemax')).toBe('100');
      expect(await value()).toEqual({ now: '50', text: '50% current, 50% baseline' });
      expect(await c.locator('.slider-view-container').evaluate((el) => getComputedStyle(el).touchAction)).toBe('pan-y');

      await slider.focus();
      await page.keyboard.press('ArrowRight');
      expect(await value()).toEqual({ now: '55', text: '55% current, 45% baseline' });
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      expect((await value()).now).toBe('45');
      await page.keyboard.press('PageUp');
      expect((await value()).now).toBe('65');
      await page.keyboard.press('PageDown');
      expect((await value()).now).toBe('45');
      await page.keyboard.press('Home');
      expect(await value()).toEqual({ now: '0', text: '0% current, 100% baseline' });
      await page.keyboard.press('ArrowLeft');
      expect((await value()).now).toBe('0'); // clamped
      await page.keyboard.press('End');
      expect(await value()).toEqual({ now: '100', text: '100% current, 0% baseline' });
      await page.keyboard.press('PageUp');
      expect((await value()).now).toBe('100');
      expect(await c.locator('.slider-img-over-wrapper').evaluate((el) => el.style.width)).toBe('100%');
      expect(await slider.evaluate((el) => el.style.left)).toBe('100%');

      // Pointer drag (pointer events + capture): from the handle, back at the middle (at 0 or
      // 100% it is half clipped), to a quarter of the width
      await page.keyboard.press('PageDown');
      await page.keyboard.press('PageDown');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      expect((await value()).now).toBe('50');
      const box = await c.locator('.slider-view-container').boundingBox();
      const handle = await c.locator('.slider-handle-pill').boundingBox();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.6, handle.y + handle.height / 2, { steps: 4 });
      await page.mouse.move(box.x + box.width * 0.25, handle.y + handle.height / 2, { steps: 4 });
      await page.mouse.up();
      expect(Math.abs(Number((await value()).now) - 25)).toBeLessThanOrEqual(1);
      expect(await slider.evaluate((el) => el === document.activeElement)).toBe(true);

      // Click elsewhere on the image: the divider jumps there and takes focus
      await page.locator('body').focus();
      await page.mouse.click(box.x + box.width * 0.8, handle.y + handle.height / 2);
      expect(Math.abs(Number((await value()).now) - 80)).toBeLessThanOrEqual(1);
      expect(await slider.evaluate((el) => el === document.activeElement)).toBe(true);
      await page.keyboard.press('ArrowRight');
      expect(Math.abs(Number((await value()).now) - 85)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    }, 30000);
  });

  describe('keyboard shortcuts', () => {
    it('j/k move the current card (pending first, then every card) and 1/2/3 switch its view', async () => {
      ui.createReviewRun('kb-nav');
      const { page, errors } = await open('/runs/kb-nav');
      expect(await currentIndex(page)).toBe(-1);

      await page.keyboard.press('j'); // first pending card, not the first (MATCH) card
      expect(await currentIndex(page)).toBe(1);
      expect(await card(page, 1).getAttribute('aria-current')).toBe('true');
      expect(await card(page, 1).evaluate((el) => el === document.activeElement)).toBe(true);
      await page.keyboard.press('j');
      await page.keyboard.press('j');
      expect(await currentIndex(page)).toBe(3);
      await page.keyboard.press('j'); // stays on the last card
      expect(await currentIndex(page)).toBe(3);
      await page.keyboard.press('k');
      await page.keyboard.press('k');
      await page.keyboard.press('k'); // all cards, including the non-pending first one
      expect(await currentIndex(page)).toBe(0);
      expect(await card(page, 1).getAttribute('aria-current')).toBeNull();

      await page.keyboard.press('j');
      const selectedTab = () => card(page, 1).locator('[role="tab"][aria-selected="true"]').getAttribute('data-tab');
      await page.keyboard.press('3');
      expect(await selectedTab()).toBe('diff');
      expect(await card(page, 1).locator('[data-panel="diff"]').isVisible()).toBe(true);
      await page.keyboard.press('2');
      expect(await selectedTab()).toBe('slider');
      await page.keyboard.press('1');
      expect(await selectedTab()).toBe('side-by-side');
      expect(await card(page, 1).evaluate((el) => el === document.activeElement)).toBe(true); // focus stays on the card

      // The MISSING_BASELINE card has no slider/diff: 3 leaves it on side-by-side
      await page.keyboard.press('j');
      await page.keyboard.press('j');
      await page.keyboard.press('3');
      expect(await card(page, 3).locator('[role="tab"][aria-selected="true"]').getAttribute('data-tab')).toBe('side-by-side');
      expect(errors).toEqual([]);
    }, 30000);

    it('a approves the current card like its Approve button (no confirm)', async () => {
      const { cards } = ui.createReviewRun('kb-approve');
      const { page, errors, dialogs } = await open('/runs/kb-approve');
      await page.keyboard.press('a'); // nothing selected yet: nothing happens
      expect(await card(page, 1).getAttribute('data-status')).toBe('DIFF');

      await page.keyboard.press('j');
      await page.keyboard.press('a');
      await expect.poll(() => card(page, 1).getAttribute('data-status')).toBe('APPROVED');
      expect(dialogs).toEqual([]);
      await expect.poll(() => page.locator('#live-region').textContent()).toBe('/ desktop approved. Baseline updated.');
      expect(await card(page, 1).evaluate((el) => el === document.activeElement)).toBe(true);

      const res = await fetch(`${ui.baseUrl}/api/runs/kb-approve`);
      const { snapshots } = await res.json();
      expect(snapshots.find((s) => s.id === cards[1].id).status).toBe('APPROVED');
      expect(errors).toEqual([]);
    }, 30000);

    it('r rejects the current card after the same confirm as its Reject button', async () => {
      const { cards } = ui.createReviewRun('kb-reject');
      const { page, errors, dialogs } = await open('/runs/kb-reject');
      await page.keyboard.press('j');
      await page.keyboard.press('j');
      expect(await currentIndex(page)).toBe(2);

      page.confirmAnswer = false;
      await page.keyboard.press('r');
      await expect.poll(() => dialogs.length).toBe(1);
      expect(dialogs[0]).toEqual({ type: 'confirm', message: 'Are you sure you want to reject this visual diff?' });
      expect(await card(page, 2).getAttribute('data-status')).toBe('DIFF');

      page.confirmAnswer = true;
      await page.keyboard.press('r');
      await expect.poll(() => card(page, 2).getAttribute('data-status')).toBe('REJECTED');
      expect(dialogs.map((d) => d.type)).toEqual(['confirm', 'confirm']);
      const { snapshots } = await (await fetch(`${ui.baseUrl}/api/runs/kb-reject`)).json();
      expect(snapshots.find((s) => s.id === cards[2].id).status).toBe('REJECTED');
      expect(errors).toEqual([]);
    }, 30000);

    it('? opens the help dialog with focus inside; Esc closes it and restores focus', async () => {
      const { page, errors } = await open('/runs/ui-review');
      const dialog = page.locator('#shortcuts-dialog');
      await page.keyboard.press('j');
      await page.keyboard.press('?');
      await expect.poll(() => dialog.evaluate((d) => d.open)).toBe(true);
      expect(await page.evaluate(() => document.activeElement.closest('dialog')?.id)).toBe('shortcuts-dialog');
      expect(await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).isVisible()).toBe(true);
      const text = await dialog.textContent();
      for (const key of ['Next snapshot', 'Previous snapshot', 'Approve the current snapshot', 'Reject the current snapshot', 'Side-by-side, slider or diff', 'Esc']) {
        expect(text).toContain(key);
      }

      await page.keyboard.press('j'); // ignored while the dialog is open
      expect(await currentIndex(page)).toBe(1);
      await page.keyboard.press('Escape');
      await expect.poll(() => dialog.evaluate((d) => d.open)).toBe(false);
      expect(await card(page, 1).evaluate((el) => el === document.activeElement)).toBe(true);

      // The visible hint opens it too, and focus returns to the hint
      const hint = page.getByRole('button', { name: 'Press ? for keyboard shortcuts' });
      await hint.click();
      await expect.poll(() => dialog.evaluate((d) => d.open)).toBe(true);
      await page.getByRole('button', { name: 'Close keyboard shortcuts' }).click();
      await expect.poll(() => dialog.evaluate((d) => d.open)).toBe(false);
      expect(await hint.evaluate((el) => el === document.activeElement)).toBe(true);
      expect(errors).toEqual([]);
    }, 30000);

    it('are ignored while typing in a field, with Ctrl/Alt/Meta held, and on key repeat', async () => {
      const { page, errors } = await open('/runs/ui-review');
      // The run page has no text field of its own; add a search box and an editable area.
      await page.evaluate(() => {
        const main = document.getElementById('main');
        main.insertAdjacentHTML('afterbegin', '<label>Search <input id="probe-input" type="search"></label><div id="probe-editable" contenteditable="true">x</div>');
      });
      await page.locator('#probe-input').focus();
      await page.keyboard.type('jka?123');
      expect(await page.locator('#probe-input').inputValue()).toBe('jka?123');
      await page.locator('#probe-editable').focus();
      await page.keyboard.press('j');
      expect(await currentIndex(page)).toBe(-1);
      expect(await page.locator('#shortcuts-dialog').evaluate((d) => d.open)).toBe(false);

      await page.evaluate(() => document.activeElement.blur());
      for (const combo of ['Control+j', 'Alt+j', 'Meta+j', 'Shift+J']) {
        await page.keyboard.press(combo);
        expect(await currentIndex(page), combo).toBe(-1);
      }

      await page.keyboard.down('j');
      await page.keyboard.down('j'); // auto-repeat
      await page.keyboard.down('j');
      await page.keyboard.up('j');
      expect(await currentIndex(page)).toBe(1); // one step, not three
      expect(errors).toEqual([]);
    }, 30000);

    it('can be turned off in the help dialog; the choice persists across reloads', async () => {
      const { page, errors } = await open('/runs/ui-review');
      const dialog = page.locator('#shortcuts-dialog');
      const toggle = page.getByRole('checkbox', { name: 'Single-key shortcuts' });
      await page.keyboard.press('?');
      expect(await toggle.isChecked()).toBe(true);
      await toggle.focus();
      await page.keyboard.press('Space');
      expect(await toggle.isChecked()).toBe(false);
      expect(await page.evaluate(() => localStorage.getItem('vrt:shortcuts-enabled'))).toBe('false');
      await page.keyboard.press('Escape');

      const offHint = page.getByRole('button', { name: 'Keyboard shortcuts are off' });
      for (const reload of [false, true]) {
        if (reload) await page.reload();
        await page.locator('body').click({ position: { x: 1, y: 1 } });
        await page.keyboard.press('j');
        await page.keyboard.press('?');
        expect(await currentIndex(page), `reload=${reload}`).toBe(-1);
        expect(await dialog.evaluate((d) => d.open)).toBe(false);
        expect(await offHint.isVisible()).toBe(true);
      }

      // Turned back on from the hint button
      await offHint.click();
      expect(await toggle.isChecked()).toBe(false);
      await toggle.check();
      await page.keyboard.press('Escape');
      await page.keyboard.press('j');
      expect(await currentIndex(page)).toBe(1);
      expect(await page.evaluate(() => localStorage.getItem('vrt:shortcuts-enabled'))).toBe('true');
      expect(errors).toEqual([]);
    }, 30000);

    it('still work when localStorage is unavailable', async () => {
      const { page, errors } = await open('/runs/ui-review', {
        initScript: () => {
          Object.defineProperty(window, 'localStorage', { get() { throw new Error('SecurityError: storage disabled'); } });
        }
      });
      await page.keyboard.press('j');
      expect(await currentIndex(page)).toBe(1);
      await page.keyboard.press('?');
      await page.getByRole('checkbox', { name: 'Single-key shortcuts' }).uncheck(); // not saved, still applied
      await page.keyboard.press('Escape');
      await page.keyboard.press('j');
      expect(await currentIndex(page)).toBe(1);
      expect(errors).toEqual([]);
    }, 30000);

    it('work in the static demo, where approve/reject are simulated', async () => {
      ui.createReviewRun('kb-static');
      const html = await ui.renderStatic('run-detail', runDetailModel({ runId: 'kb-static' }));
      const { page, context, errors, dialogs } = await open(null);
      const apiCalls = [];
      page.on('request', (r) => { if (r.url().includes('/api/')) apiCalls.push(r.url()); });
      await context.route(`${ui.baseUrl}/static-demo/run`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
      await page.goto(`${ui.baseUrl}/static-demo/run`);
      expect(await page.locator('html').getAttribute('data-mode')).toBe('static');

      await page.keyboard.press('j');
      await page.keyboard.press('a');
      await expect.poll(() => card(page, 1).getAttribute('data-status')).toBe('APPROVED');
      expect(await card(page, 1).locator('.demo-note').count()).toBe(1);
      await page.keyboard.press('j');
      await page.keyboard.press('r');
      await expect.poll(() => card(page, 2).getAttribute('data-status')).toBe('REJECTED');
      expect(dialogs.map((d) => d.type)).toEqual(['confirm']);
      expect(apiCalls).toEqual([]);

      const { snapshots } = await (await fetch(`${ui.baseUrl}/api/runs/kb-static`)).json();
      expect(snapshots.map((s) => s.status)).toEqual(['MATCH', 'DIFF', 'DIFF', 'MISSING_BASELINE']); // nothing saved
      expect(errors).toEqual([]);
    }, 30000);
  });

  describe('action errors', () => {
    it('show in the card role="alert" region instead of alert(), and restore the button', async () => {
      ui.createReviewRun('kb-error');
      const { page, context, dialogs } = await open(null);
      let mode = 'json';
      await context.route('**/api/snapshots/*/approve', (route) => (mode === 'json'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Disk full' }) })
        : route.abort('connectionrefused')));
      await page.goto(`${ui.baseUrl}/runs/kb-error`);

      const c = card(page, 1);
      const approve = c.getByRole('button', { name: 'Approve & Update Baseline' });
      const alertRegion = c.getByRole('alert');
      expect(await alertRegion.textContent()).toBe('');

      await approve.focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => alertRegion.textContent()).toBe('Approval failed: Disk full');
      expect(await approve.isEnabled()).toBe(true);
      expect(await approve.evaluate((el) => el === document.activeElement)).toBe(true);

      mode = 'abort';
      await page.keyboard.press('a'); // the card is current (focus is inside it)
      await expect.poll(() => alertRegion.textContent()).toMatch(/^Network error: /);
      expect(await c.getAttribute('data-status')).toBe('DIFF');

      // Approve all: a non-JSON error page from a proxy
      await context.route('**/api/runs/*/approve-all', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad gateway</h1>' }));
      await page.getByRole('button', { name: /Approve all pending/ }).click();
      await expect.poll(() => page.locator('.detail-header-card [role="alert"]').textContent())
        .toBe('Approve all failed: the server responded with HTTP 502');

      expect(dialogs.filter((d) => d.type === 'alert')).toEqual([]);
      expect(dialogs.map((d) => d.type)).toEqual(['confirm']); // only approve-all's own confirm
    }, 30000);
  });
});
