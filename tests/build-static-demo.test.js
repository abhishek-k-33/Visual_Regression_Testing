import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { verifyOutput, resolveLocalUrl, extractUrls, DEMO_RUNS } from '../scripts/build-static-demo.js';

const SCRIPT = path.resolve('scripts/build-static-demo.js');
const BASE = '/vrt-test';

function runBuild(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd: process.cwd() }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: stdout + stderr });
    });
  });
}

function walk(dir, root = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, root) : [path.relative(root, full).split(path.sep).join('/')];
  });
}

const hashDir = (dir) => (fs.existsSync(dir)
  ? Object.fromEntries(walk(dir).map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')]))
  : {});

describe('link resolution helpers', () => {
  it('maps page URLs the way GitHub Pages serves them', () => {
    expect(resolveLocalUrl('/b/', '/b')).toEqual({ file: 'index.html' });
    expect(resolveLocalUrl('/b', '/b')).toEqual({ file: 'index.html' });
    expect(resolveLocalUrl('/b/runs/demo-05-regression', '/b')).toEqual({ file: 'runs/demo-05-regression.html' });
    expect(resolveLocalUrl('/b/css/styles.css', '/b')).toEqual({ file: 'css/styles.css' });
    expect(resolveLocalUrl('/b/storage/runs/x/a%20b.png', '/b')).toEqual({ file: 'storage/runs/x/a b.png' });
    expect(resolveLocalUrl('/', '')).toEqual({ file: 'index.html' });
    expect(resolveLocalUrl('/other/x', '/b').error).toMatch(/does not start with the base/);
    expect(resolveLocalUrl('/b/../secret', '/b').error).toMatch(/\.\./);
    expect(resolveLocalUrl('//evil.example/x', '').error).toMatch(/protocol-relative/);
  });

  it('extracts and entity-decodes href/src values', () => {
    expect(extractUrls('<a href="/x?a=1&amp;b=2">x</a><img src=\'/y.png\'>')).toEqual(['/x?a=1&b=2', '/y.png']);
  });
});

describe('verifyOutput safety checks', () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-verify-'));
    const page = (body) => `<html data-mode="static"><link href="/b/css/styles.css">${body}</html>`;
    fs.mkdirSync(path.join(dir, 'css'));
    fs.writeFileSync(path.join(dir, 'css', 'styles.css'), '');
    fs.writeFileSync(path.join(dir, '.nojekyll'), '');
    fs.writeFileSync(path.join(dir, '404.html'), page('<a href="/b/">home</a>'));
    fs.writeFileSync(path.join(dir, 'index.html'), page('<a href="/b/runs/missing">x</a><img src="/elsewhere.png"><a href="https://x.example">ok</a><a href="#top">ok</a>'));
    fs.writeFileSync(path.join(dir, 'data.sqlite'), '');
    fs.mkdirSync(path.join(dir, 'storage', 'runs', 'r1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'storage', 'runs', 'r1', 'run.json'), '{}');
    fs.writeFileSync(path.join(dir, 'storage', 'runs', 'r1', 'summary.md'), '');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reports forbidden files, unexpected files and broken or off-base links', () => {
    const problems = verifyOutput(dir, '/b').join('\n');
    expect(problems).toMatch(/forbidden database file in output: data\.sqlite/);
    expect(problems).toMatch(/forbidden run manifest in output: storage\/runs\/r1\/run\.json/);
    expect(problems).toMatch(/forbidden Markdown summary in output: storage\/runs\/r1\/summary\.md/);
    expect(problems).toMatch(/\/b\/runs\/missing -> runs\/missing\.html does not exist/);
    expect(problems).toMatch(/\/elsewhere\.png does not start with the base/);
    expect(problems).not.toMatch(/x\.example|#top|404\.html/);
  });
});

describe('static demo build (end to end)', () => {
  let workDir;
  let out;
  let result;
  const storageDir = path.resolve('storage');
  let baselinesBefore;

  beforeAll(async () => {
    baselinesBefore = hashDir(path.join(storageDir, 'baselines'));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-pages-build-'));
    out = path.join(workDir, 'site');
    result = await runBuild(['--out', out, '--base', BASE]);
  }, 120000);

  afterAll(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  const read = (rel) => fs.readFileSync(path.join(out, rel), 'utf8');

  it('succeeds and writes the dashboard, five run pages, 404 and .nojekyll', () => {
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('Static demo built');
    for (const rel of ['index.html', '404.html', '.nojekyll', 'css/styles.css', 'js/common.js', 'js/review-actions.js']) {
      expect(fs.existsSync(path.join(out, rel)), rel).toBe(true);
    }
    expect(DEMO_RUNS.map((r) => r.id)).toEqual(['demo-01-baseline', 'demo-02-pass', 'demo-03-redesign', 'demo-04-pass', 'demo-05-regression']);
    for (const { id } of DEMO_RUNS) expect(fs.existsSync(path.join(out, 'runs', `${id}.html`)), id).toBe(true);
    expect(fs.readdirSync(path.join(out, 'runs')).sort()).toEqual(DEMO_RUNS.map((r) => `${r.id}.html`));
  });

  it('records the expected statuses: redesign approved, regression left pending', () => {
    const index = read('index.html');
    const statuses = Object.fromEntries([...index.matchAll(/data-run-id="([^"]+)" data-status="([^"]+)"/g)].map((m) => [m[1], m[2]]));
    expect(statuses).toEqual({
      'demo-01-baseline': 'PASSED',
      'demo-02-pass': 'PASSED',
      'demo-03-redesign': 'APPROVED',
      'demo-04-pass': 'PASSED',
      'demo-05-regression': 'FAILED'
    });

    const redesign = read('runs/demo-03-redesign.html');
    expect(redesign.match(/<span>APPROVED<\/span>/g)).toHaveLength(3); // run pill + 2 snapshots
    expect(redesign).not.toContain('btn-approve');

    const regression = read('runs/demo-05-regression.html');
    expect(regression.match(/class="btn btn-approve"/g)).toHaveLength(2);
    expect(regression.match(/% Mismatch<\/span>/g)).toHaveLength(2);
    expect(regression).toContain('data-tab="slider"');
    expect(regression).toContain('data-tab="diff"');

    expect(read('runs/demo-02-pass.html').match(/MATCH \(0\.00%\)/g)).toHaveLength(2);
  });

  it('renders every page in static mode with the demo banner', () => {
    for (const rel of ['index.html', '404.html', ...DEMO_RUNS.map((r) => `runs/${r.id}.html`)]) {
      const html = read(rel);
      expect(html, rel).toContain(`data-base="${BASE}"`);
      expect(html, rel).toContain('data-mode="static"');
      expect(html, rel).toContain('class="demo-banner"');
    }
  });

  it('contains no database, summaries, manifests or unexpected files', () => {
    const files = walk(out);
    expect(files.filter((f) => /\.sqlite|\.db$|\.md$|run\.json$/i.test(f))).toEqual([]);
    for (const f of files) {
      expect(f).toMatch(/^(\.nojekyll|\.vrt-static-demo|index\.html|404\.html|runs\/[\w-]+\.html|css\/[\w.-]+\.css|js\/[\w.-]+\.js|storage\/runs\/[\w./-]+\.png)$/);
    }
  });

  it('every local href/src starts with the base and resolves to a file in the output', () => {
    const files = new Set(walk(out));
    let checked = 0;
    for (const rel of [...files].filter((f) => f.endsWith('.html'))) {
      for (const m of read(rel).matchAll(/\s(?:href|src)="([^"]*)"/g)) {
        const url = m[1];
        if (/^(#|https?:|data:)/.test(url)) continue;
        expect(url, `${rel}: ${url}`).toMatch(new RegExp(`^${BASE}(/|$)`));
        let p = decodeURIComponent(url.slice(BASE.length)) || '/';
        if (p.endsWith('/')) p += 'index.html';
        else if (!path.posix.extname(p)) p += '.html';
        expect(files.has(p.slice(1)), `${rel}: ${url} -> ${p}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(verifyOutput(out, BASE)).toEqual([]);
  });

  it('leaves the repository storage alone', () => {
    expect(hashDir(path.join(storageDir, 'baselines'))).toEqual(baselinesBefore);
    const runsDir = path.join(storageDir, 'runs');
    const leaked = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((d) => d.startsWith('demo-0')) : [];
    expect(leaked).toEqual([]);
  });

  it('refuses to overwrite a folder that is not a previous build', async () => {
    const precious = path.join(workDir, 'precious');
    fs.mkdirSync(precious);
    fs.writeFileSync(path.join(precious, 'notes.txt'), 'keep me');
    const { code, out: output } = await runBuild(['--out', precious, '--base', BASE]);
    expect(code).toBe(1);
    expect(output).toMatch(/doesn't look like a previous build/);
    expect(fs.readFileSync(path.join(precious, 'notes.txt'), 'utf8')).toBe('keep me');
  }, 30000);

  it('refuses a gh-pages-like folder that only has .nojekyll, and any git checkout', async () => {
    const ghPages = path.join(workDir, 'gh-pages-clone');
    fs.mkdirSync(ghPages);
    fs.writeFileSync(path.join(ghPages, '.nojekyll'), '');
    fs.writeFileSync(path.join(ghPages, 'index.html'), 'their site');
    let result = await runBuild(['--out', ghPages, '--base', BASE]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/no \.vrt-static-demo marker/);
    expect(fs.readFileSync(path.join(ghPages, 'index.html'), 'utf8')).toBe('their site');

    fs.mkdirSync(path.join(ghPages, '.git'));
    fs.writeFileSync(path.join(ghPages, '.vrt-static-demo'), 'Generated by scripts/build-static-demo.js; safe to delete and rebuild.\n');
    result = await runBuild(['--out', ghPages, '--base', BASE]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/is a git checkout/);
    expect(fs.existsSync(path.join(ghPages, '.git'))).toBe(true);
  }, 30000);
});
