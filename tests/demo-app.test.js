import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createDemoServer, renderDemoHtml, normalizeDemoVariant, DEMO_VARIANTS } from '../scripts/demo-app.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// The committed CI baselines (storage/baselines/index-*.png) were captured from the
// original page, so its HTML must never change. Same for the regressed page used by
// `npm run demo`.
const ORIGINAL_SHA256 = '15c36c2b8ca4553b78f4e0719371d5f6b2f183607a3794d8c071f69cd5bad654';
const REGRESSED_SHA256 = '8122b4426af2288d0432c905b807bde3d142dd65900ba8c5c8aae970ca37c170';

describe('demo site variants', () => {
  it('keeps the original and regressed pages byte-identical', () => {
    expect(sha256(renderDemoHtml('original'))).toBe(ORIGINAL_SHA256);
    expect(sha256(renderDemoHtml('regressed'))).toBe(REGRESSED_SHA256);
  });

  it('still accepts the older boolean argument', () => {
    expect(renderDemoHtml()).toBe(renderDemoHtml('original'));
    expect(renderDemoHtml(false)).toBe(renderDemoHtml('original'));
    expect(renderDemoHtml(true)).toBe(renderDemoHtml('regressed'));
    expect(normalizeDemoVariant(true)).toBe('regressed');
    expect(normalizeDemoVariant(undefined)).toBe('original');
  });

  it('renders three distinct pages and rejects unknown variants', () => {
    const pages = DEMO_VARIANTS.map((v) => renderDemoHtml(v));
    expect(DEMO_VARIANTS).toEqual(['original', 'regressed', 'redesign']);
    expect(new Set(pages).size).toBe(3);
    for (const html of pages) expect(html).toContain('Visual CI Live Demonstration');
    expect(() => renderDemoHtml('nope')).toThrow(/Unknown demo variant "nope"/);
  });

  it('createDemoServer serves whatever variant the callback returns (string or boolean)', async () => {
    let current = 'original';
    const server = createDemoServer(() => current);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    try {
      for (const value of ['original', 'redesign', 'regressed', true, false]) {
        current = value;
        const res = await fetch(url);
        expect(res.status, String(value)).toBe(200);
        expect(await res.text(), String(value)).toBe(renderDemoHtml(value));
      }
      current = 'bogus';
      expect((await fetch(url)).status).toBe(500);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('defaults to the original page', async () => {
    const server = createDemoServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const html = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
      expect(sha256(html)).toBe(ORIGINAL_SHA256);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('serve-demo.js (npm run demo:serve)', () => {
  const freePort = () => new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });

  // Starts the script, waits for its "listening" line, fetches the page, stops it.
  async function serve(env) {
    const port = await freePort();
    const child = spawn(process.execPath, ['scripts/serve-demo.js'], { env: { ...process.env, DEMO_PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    const ready = await Promise.race([
      new Promise((resolve) => child.stdout.on('data', () => { if (out.includes('listening')) resolve(true); })),
      exited.then(() => false)
    ]);
    if (!ready) return { code: await exited, out };
    try {
      return { html: await (await fetch(`http://127.0.0.1:${port}/`)).text(), out };
    } finally {
      child.kill('SIGTERM');
      await exited;
    }
  }

  it('serves the original page by default', async () => {
    const { html, out } = await serve({ DEMO_VARIANT: '' });
    expect(sha256(html)).toBe(ORIGINAL_SHA256);
    expect(out).toContain('Demo site (original) listening');
  });

  it('serves the variant named by DEMO_VARIANT (the action self-test serves "regressed")', async () => {
    const { html, out } = await serve({ DEMO_VARIANT: 'regressed' });
    expect(sha256(html)).toBe(REGRESSED_SHA256);
    expect(out).toContain('Demo site (regressed) listening');
  });

  it('refuses an unknown DEMO_VARIANT with exit 2', async () => {
    const { code, out } = await serve({ DEMO_VARIANT: 'bogus' });
    expect(code).toBe(2);
    expect(out).toContain('DEMO_VARIANT must be one of original, regressed, redesign');
  });
});
