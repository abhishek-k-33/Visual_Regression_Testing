/**
 * The dashboard's "Import CI run" control in headless Chromium, against the real app:
 * file picker, drag and drop, progress and errors, phone layout, axe, static mode.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { startUiServer } from './helpers/ui-fixture.js';
import { writeFakeRun } from './helpers/fake-run.js';
import { writeZip, folderEntries } from './helpers/zip.js';
import { indexModel } from '../src/server/viewModels.js';

let ui;
let browser;
let work;

beforeAll(async () => {
  ui = await startUiServer();
  browser = await chromium.launch();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-import-ui-'));
}, 60000);

afterAll(async () => {
  await browser?.close();
  await ui?.close();
  fs.rmSync(work, { recursive: true, force: true });
});

/** A CI artifact zip holding the given runs (each a small valid run). */
function artifact(...runIds) {
  const entries = runIds.flatMap((runId) => {
    const { runDir } = writeFakeRun(fs.mkdtempSync(path.join(work, 'ci-')), { runId });
    return folderEntries(runDir, runId);
  });
  return writeZip(path.join(work, `${runIds.join('+')}.zip`), entries);
}

describe('Import CI run (dashboard)', () => {
  let context;
  let page;

  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await page.goto(`${ui.baseUrl}/`);
  });

  afterEach(async () => {
    await context.close();
    expect(fs.readdirSync(ui.storageRoot).filter((f) => f.startsWith('.upload-'))).toEqual([]);
  });

  it('picking a file uploads it and opens the imported run', async () => {
    const button = page.getByRole('button', { name: 'Import CI run' });
    await expect.poll(() => button.isVisible()).toBe(true);
    expect(await button.getAttribute('aria-describedby')).toBe('import-hint');

    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
    expect(chooser.isMultiple()).toBe(false);
    await chooser.setFiles(artifact('ci_ui_pick'));
    await page.waitForURL(`${ui.baseUrl}/runs/ci_ui_pick`);

    await expect.poll(() => page.locator('.detail-title-row .imported-badge').textContent()).toBe('Imported');
    const loaded = await page.locator('.tab-panel.active img').evaluateAll((imgs) => imgs.map((i) => i.complete && i.naturalWidth > 0));
    expect(loaded).toEqual([true, true]);
  });

  it('dropping a zip on the page shows a hint, then uploads and opens the run', async () => {
    const zip = fs.readFileSync(artifact('ci_ui_drop'));
    const dataTransfer = await page.evaluateHandle(({ bytes, name }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/zip' }));
      return dt;
    }, { bytes: [...zip], name: 'visual-regression-diffs.zip' });

    const overlay = page.locator('[data-drop-overlay]');
    expect(await overlay.isVisible()).toBe(false);
    await page.dispatchEvent('main', 'dragenter', { dataTransfer });
    await expect.poll(() => overlay.isVisible()).toBe(true);
    expect(await overlay.textContent()).toContain('Drop the artifact .zip to import it');
    await page.dispatchEvent('main', 'dragleave', { dataTransfer });
    await expect.poll(() => overlay.isVisible()).toBe(false);

    await page.dispatchEvent('main', 'dragenter', { dataTransfer });
    await page.dispatchEvent('main', 'drop', { dataTransfer });
    await page.waitForURL(`${ui.baseUrl}/runs/ci_ui_drop`);
    expect(await page.locator('.detail-title-row .imported-badge').textContent()).toBe('Imported');
  });

  it('shows progress and blocks a second submit while uploading', async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/imports', async (route) => {
      await held;
      await route.continue();
    });
    // Counted from before the first upload starts: a listener added later may or may not
    // see the held request's event (it raced on slow CI runners).
    let uploads = 0;
    page.on('request', (r) => { if (new URL(r.url()).pathname.endsWith('/api/imports')) uploads += 1; });
    const button = page.locator('#import-run-btn'); // its accessible name changes while busy
    await page.setInputFiles('#import-file', artifact('ci_ui_busy'));

    await expect.poll(() => button.isDisabled()).toBe(true);
    expect(await button.getAttribute('aria-busy')).toBe('true');
    expect(await button.textContent()).toContain('Importing…');
    const status = page.locator('[data-import-status]');
    expect(await status.getAttribute('role')).toBe('status');
    expect(await status.textContent()).toContain('Importing ci_ui_busy.zip');

    // Another file dropped meanwhile is not uploaded.
    await expect.poll(() => uploads).toBe(1); // the held upload
    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([80, 75, 5, 6])], 'other.zip', { type: 'application/zip' }));
      return dt;
    });
    await page.dispatchEvent('main', 'drop', { dataTransfer });

    release();
    await page.waitForURL(`${ui.baseUrl}/runs/ci_ui_busy`);
    expect(uploads).toBe(1); // only the held upload: the drop added none
  });

  it('keeps the empty status region rendered, so its first message is announced', async () => {
    const status = page.locator('[data-import-status]');
    expect(await status.textContent()).toBe('');
    expect(await status.evaluate((el) => getComputedStyle(el).display)).not.toBe('none');
    // Still exposed to assistive technology while empty (a live region must exist
    // before its content changes).
    const snapshot = await page.locator('main').ariaSnapshot();
    expect(snapshot).toMatch(/- status/);
  });

  it('an artifact with several runs lists links to each (announced once, by the status region)', async () => {
    await page.setInputFiles('#import-file', artifact('ci_ui_multi_a', 'ci_ui_multi_b'));
    const status = page.locator('[data-import-status]');
    await expect.poll(() => status.locator('a').count()).toBe(2);
    expect(await status.textContent()).toContain('Imported 2 runs');
    // Not repeated through the page's other live region (announce() writes after 50 ms).
    await page.waitForTimeout(250);
    expect(await page.locator('#live-region').textContent()).toBe('');
    expect(await status.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href'))))
      .toEqual(['/runs/ci_ui_multi_a', '/runs/ci_ui_multi_b']);
    expect(await page.getByRole('button', { name: 'Import CI run' }).isDisabled()).toBe(false);
  });

  it('errors go to the role="alert" region: a non-zip (refused before upload) and a server error', async () => {
    const alertRegion = page.locator('[data-import-error]');
    expect(await alertRegion.getAttribute('role')).toBe('alert');
    let uploads = 0;
    page.on('request', (r) => { if (r.url().endsWith('/api/imports')) uploads += 1; });

    const notes = path.join(work, 'notes.txt');
    fs.writeFileSync(notes, 'hello');
    await page.setInputFiles('#import-file', notes);
    await expect.poll(() => alertRegion.textContent()).toContain('"notes.txt" is not a .zip file');
    expect(uploads).toBe(0);

    const bogus = path.join(work, 'bogus.zip');
    fs.writeFileSync(bogus, 'not really a zip');
    await page.setInputFiles('#import-file', bogus);
    await expect.poll(() => alertRegion.textContent()).toContain('Import failed: Not a valid zip archive');
    expect(uploads).toBe(1);
    expect(await page.getByRole('button', { name: 'Import CI run' }).isDisabled()).toBe(false);
    expect(page.url()).toBe(`${ui.baseUrl}/`);
  });

  it('refuses a file over the server\'s upload limit before sending it', async () => {
    const previous = process.env.VISUAL_IMPORT_MAX_UPLOAD_BYTES;
    process.env.VISUAL_IMPORT_MAX_UPLOAD_BYTES = '100';
    try {
      await page.reload();
      expect(await page.locator('.import-control').getAttribute('data-max-upload-bytes')).toBe('100');
      await page.setInputFiles('#import-file', artifact('ci_ui_big'));
      await expect.poll(() => page.locator('[data-import-error]').textContent()).toContain('uploads are limited to 100 bytes');
      // The command from the page's data-cli-command (how visual-ci runs where the dashboard
      // runs: a checkout here), never a bare `npx visual-ci`.
      expect(await page.locator('.import-control').getAttribute('data-cli-command')).toBe('node src/cli/index.js');
      expect(await page.locator('[data-import-error]').textContent()).toContain('Use the command line instead: node src/cli/index.js import <file>');
    } finally {
      if (previous === undefined) delete process.env.VISUAL_IMPORT_MAX_UPLOAD_BYTES;
      else process.env.VISUAL_IMPORT_MAX_UPLOAD_BYTES = previous;
    }
  });

  it('has a >= 44px tap target on phones and no sideways scrolling', async () => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.reload();
    const box = await page.getByRole('button', { name: 'Import CI run' }).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  for (const theme of ['dark', 'light']) {
    it(`axe: no serious/critical violations with the drop hint and an error showing (${theme})`, async () => {
      await page.emulateMedia({ colorScheme: theme });
      await page.reload();
      const notes = path.join(work, 'notes.txt');
      fs.writeFileSync(notes, 'hello');
      await page.setInputFiles('#import-file', notes);
      await expect.poll(() => page.locator('[data-import-error]').textContent()).toContain('not a .zip');
      const dataTransfer = await page.evaluateHandle(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['x'], 'a.zip'));
        return dt;
      });
      await page.dispatchEvent('main', 'dragenter', { dataTransfer });
      await expect.poll(() => page.locator('[data-drop-overlay]').isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);

      const results = await new AxeBuilder({ page }).analyze();
      const blocking = results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
      expect(blocking, blocking.join('\n')).toEqual([]);
    }, 30000);
  }
});

describe('static (GitHub Pages) mode', () => {
  it('renders no import control and does not load its script', async () => {
    const html = await ui.renderStatic('index', indexModel({ db: ui.db }));
    expect(html).not.toContain('import-run-btn');
    expect(html).not.toContain('data-drop-overlay');
    expect(html).not.toContain('import-upload.js');
    expect(html).toContain('/js/dashboard.js');
  });
});
