/**
 * Automated accessibility check: axe-core on every page type of the dashboard, rendered by
 * the real app in headless Chromium. Fails on any `serious` or `critical` violation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { startUiServer } from './helpers/ui-fixture.js';

// color-contrast is disabled for now: the colour palette and contrast are being reworked
// in a separate milestone (M6), which re-enables this rule.
const DISABLED_RULES = ['color-contrast'];

const PAGES = [
  { name: 'dashboard', path: '/' },
  { name: 'run detail with diffs (buttons, tabs, slider)', path: '/runs/ui-review' },
  { name: 'run detail, slider tab open', path: '/runs/ui-review', openSlider: true },
  { name: 'run detail, help dialog open', path: '/runs/ui-review', openHelp: true },
  { name: 'history', path: '/history/index/desktop' },
  { name: 'error page (unknown run, 404)', path: '/runs/no-such-run', status: 404 }
];

describe('axe accessibility scan (serious/critical violations)', () => {
  let ui;
  let browser;

  beforeAll(async () => {
    ui = await startUiServer();
    browser = await chromium.launch();
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await ui?.close();
  });

  for (const page of PAGES) {
    it(`${page.name}: ${page.path}`, async () => {
      const context = await browser.newContext();
      const tab = await context.newPage();
      try {
        const res = await tab.goto(`${ui.baseUrl}${page.path}`, { waitUntil: 'load' });
        expect(res.status()).toBe(page.status ?? 200);
        if (page.openSlider) {
          await tab.locator('.snapshot-card').nth(1).getByRole('tab', { name: 'Interactive Slider' }).click();
        }
        if (page.openHelp) {
          await tab.keyboard.press('?');
          await expect.poll(() => tab.locator('#shortcuts-dialog').evaluate((d) => d.open)).toBe(true);
        }

        const results = await new AxeBuilder({ page: tab }).disableRules(DISABLED_RULES).analyze();
        const blocking = results.violations
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => `${v.impact} ${v.id}: ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`);
        expect(blocking, blocking.join('\n')).toEqual([]);
        expect(results.passes.length).toBeGreaterThan(10); // axe really ran
      } finally {
        await context.close();
      }
    }, 30000);
  }
});
