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

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fixtureHtml);
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
      await new Promise((resolve) => server.close(resolve));
    }
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
    const results = await captureScreenshots(config, { runId });

    expect(results).toHaveLength(2);

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
});
