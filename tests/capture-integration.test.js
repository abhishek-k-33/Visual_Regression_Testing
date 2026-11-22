import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { captureScreenshots } from '../src/cli/capture.js';

describe('Capture Engine Integration', () => {
  let server;
  let port;
  const fixturePath = path.resolve(process.cwd(), 'tests/fixtures/index.html');
  const fixtureHtml = fs.readFileSync(fixturePath, 'utf8');
  const outputDir = path.resolve(process.cwd(), 'tests/.tmp_capture');

  // Pages that keep a request open forever, like analytics beacons or long-polling
  const html = (body) => `<!doctype html><html><body style="background:#fff">${body}</body></html>`;
  const routes = {
    '/': fixtureHtml,
    // Loads fine, then holds a fetch open forever: never reaches network idle
    '/long-polling': html('<h1>Live feed</h1><script>fetch("/hang")</script>'),
    // The image never arrives, so the load event never fires
    '/never-loads': html('<h1>Broken</h1><img src="/hang">')
  };

  const configFor = (route, overrides = {}) => ({
    baseUrl: `http://127.0.0.1:${port}`,
    routes: [route],
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    maskSelectors: [],
    threshold: 0.01,
    storageDir: 'storage',
    ...overrides
  });

  beforeAll(async () => {
    fs.rmSync(outputDir, { recursive: true, force: true });
    server = http.createServer((req, res) => {
      if (req.url === '/hang') return; // never respond
      const page = routes[req.url];
      if (page === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page);
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      server.closeAllConnections(); // drop the requests left hanging on purpose
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('captures full-page screenshots across multiple viewports deterministically', async () => {
    const config = {
      baseUrl: `http://127.0.0.1:${port}`,
      routes: ['/'],
      viewports: [
        { name: 'desktop', width: 1440, height: 900 },
        { name: 'mobile', width: 375, height: 812 }
      ],
      maskSelectors: ['.timestamp', '.dynamic-ad'],
      threshold: 0.01,
      storageDir: 'storage'
    };

    const runId = `test_integration_${Date.now()}`;
    const results = await captureScreenshots(config, { runId, outputDir });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.networkIdle)).toBe(true);

    // Verify desktop snapshot
    const desktopResult = results.find((r) => r.viewport === 'desktop');
    expect(desktopResult).toBeDefined();
    expect(fs.existsSync(desktopResult.filepath)).toBe(true);

    const desktopPng = PNG.sync.read(fs.readFileSync(desktopResult.filepath));
    expect(desktopPng.width).toBe(1440);
    expect(desktopPng.height).toBeGreaterThanOrEqual(900);

    // Verify mobile snapshot
    const mobileResult = results.find((r) => r.viewport === 'mobile');
    expect(mobileResult).toBeDefined();
    expect(fs.existsSync(mobileResult.filepath)).toBe(true);

    const mobilePng = PNG.sync.read(fs.readFileSync(mobileResult.filepath));
    expect(mobilePng.width).toBe(375);
    expect(mobilePng.height).toBeGreaterThanOrEqual(812);
  }, 30000);

  it('captures a page that never goes network-idle instead of failing', async () => {
    const started = Date.now();
    const [result] = await captureScreenshots(configFor('/long-polling'), {
      runId: 'long_polling',
      outputDir,
      networkIdleTimeout: 1000
    });

    expect(result.networkIdle).toBe(false);
    const png = PNG.sync.read(fs.readFileSync(result.filepath));
    expect(png.width).toBe(800);
    // One navigation plus the idle budget, not a second full page load
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20000);

  it('still fails when the page never finishes loading', async () => {
    await expect(
      captureScreenshots(configFor('/never-loads'), {
        runId: 'never_loads',
        outputDir,
        navigationTimeout: 1500
      })
    ).rejects.toThrow(/Timeout 1500ms exceeded/);
  }, 20000);

  it('still fails when the server is unreachable', async () => {
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));

    await expect(
      captureScreenshots(configFor('/', { baseUrl: `http://127.0.0.1:${deadPort}` }), {
        runId: 'unreachable',
        outputDir
      })
    ).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
  }, 20000);
});
