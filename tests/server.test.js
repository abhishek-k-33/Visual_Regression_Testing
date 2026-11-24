import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import app from '../src/server/app.js';
import { initDb, closeDb, createTestRun, createSnapshot } from '../src/server/db.js';
import { isAllowedHost } from '../src/server/security.js';
import { indexModel, runDetailModel, historyModel } from '../src/server/viewModels.js';
import { pageLocals } from '../src/server/urls.js';

const SAME_ORIGIN_WRITE = { method: 'POST', headers: { 'X-Requested-With': 'test' } };

// Raw request so tests can set Host and other headers fetch() won't let us forge.
function rawRequest(port, { method = 'GET', path: reqPath, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Express Review Dashboard & REST API', () => {
  let server;
  let baseUrl;
  let previousStorageEnv;
  const testTmpDir = path.resolve(process.cwd(), 'tests/.tmp_server');
  const storageRoot = path.join(testTmpDir, 'storage');
  const dbPath = path.join(testTmpDir, 'server_test.sqlite');
  const baselineFile = path.join(storageRoot, 'baselines', 'index-desktop.png');
  const currentFile = path.join(storageRoot, 'runs', 'api-run-1', 'index-desktop.png');
  let snapshotId;
  const historySnaps = {};

  beforeAll(async () => {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.mkdirSync(path.dirname(currentFile), { recursive: true });

    // Point the server's storage at the temp dir so tests never touch real storage/
    previousStorageEnv = process.env.VISUAL_STORAGE_DIR;
    process.env.VISUAL_STORAGE_DIR = storageRoot;

    const db = initDb(dbPath);

    // Seed data the way the CLI does: direct DB writes
    createTestRun({ id: 'api-run-1', commit_hash: 'c0ffee1', branch: 'feature/nav', status: 'FAILED' }, db);
    snapshotId = createSnapshot({
      run_id: 'api-run-1',
      route: '/',
      viewport: 'desktop',
      baseline_path: baselineFile,
      current_path: currentFile,
      diff_path: path.join(storageRoot, 'runs', 'api-run-1', 'index-desktop-diff.png'),
      mismatch_percentage: 1.5,
      status: 'DIFF'
    }, db).id;

    // History fixtures: route "/hist/page" (slug hist_page) at viewport "tablet", oldest first.
    // hist-4 spells the route "/hist_page": same slug, same baseline file, same history.
    for (const [id, createdAt, route, status, sha, mismatch] of [
      ['hist-1', '2026-01-01 10:00:00', '/hist/page', 'NEW_BASELINE', 'A', 0],
      ['hist-2', '2026-01-02 10:00:00', '/hist/page', 'DIFF', 'A', 4.25],
      ['hist-3', '2026-01-03 10:00:00', '/hist/page', 'MATCH', 'B', 0],
      ['hist-4', '2026-01-04 10:00:00', '/hist_page', 'MATCH', 'B', 0]
    ]) {
      createTestRun({ id, status: status === 'DIFF' ? 'FAILED' : 'PASSED', created_at: createdAt, branch: 'main', commit_hash: `c-${id}` }, db);
      historySnaps[id] = createSnapshot({
        run_id: id, route, viewport: 'tablet', status, baseline_sha256: sha, mismatch_percentage: mismatch,
        baseline_path: path.join(storageRoot, 'baselines', 'hist_page-tablet.png'),
        current_path: path.join(storageRoot, 'runs', id, 'hist_page-tablet.png')
      }, db).id;
    }

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    closeDb();
    if (previousStorageEnv === undefined) delete process.env.VISUAL_STORAGE_DIR;
    else process.env.VISUAL_STORAGE_DIR = previousStorageEnv;
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  });

  it('GET / returns 200 and renders dashboard HTML', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Visual Regression Test Runs');
    expect(html).toContain('Dashboard');
  });

  it('POST /api/runs no longer exists (clients cannot register file paths)', async () => {
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'test' },
      body: JSON.stringify({ id: 'x', snapshots: [] })
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/runs returns list of runs', async () => {
    const res = await fetch(`${baseUrl}/api/runs`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.runs.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/runs/:id returns run details and snapshots', async () => {
    const res = await fetch(`${baseUrl}/api/runs/api-run-1`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.run.id).toBe('api-run-1');
    expect(data.snapshots).toHaveLength(1);
    expect(data.snapshots[0].route).toBe('/');
    // Same per-status counts as the run list (GET /api/runs)
    for (const key of ['diff_count', 'match_count', 'new_baseline_count', 'approved_count', 'rejected_count']) {
      expect(data.run, key).toHaveProperty(key);
    }
  });

  it('GET /runs/:id renders run details HTML view', async () => {
    const res = await fetch(`${baseUrl}/runs/api-run-1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('api-run-1');
    expect(html).toContain('Side-by-Side');
    expect(html).toContain('Approve & Update Baseline');
  });

  describe('theme and dashboard labels (M6)', () => {
    const PAGE_URLS = ['/', '/runs/api-run-1', '/history/hist_page/tablet', '/history/nope/tablet'];

    it('sets the theme in <head> before the stylesheet loads, on every page', async () => {
      for (const url of PAGE_URLS) {
        const html = await (await fetch(`${baseUrl}${url}`)).text();
        const head = html.slice(0, html.indexOf('</head>'));
        const script = head.indexOf("localStorage.getItem('vrt-theme')");
        expect(script, url).toBeGreaterThan(-1);
        expect(script, url).toBeLessThan(head.indexOf('rel="stylesheet"'));
        expect(head, url).toContain("matchMedia('(prefers-color-scheme: light)')");
        expect(head, url).toContain("setAttribute('data-theme', t)");
      }
    });

    it('renders the theme toggle and loads js/theme.js on every page', async () => {
      for (const url of PAGE_URLS) {
        const html = await (await fetch(`${baseUrl}${url}`)).text();
        expect(html, url).toMatch(/<button type="button" class="theme-toggle" data-theme-toggle aria-pressed="true"[^>]*>/);
        expect(html, url).toContain('<span class="visually-hidden">Dark theme</span>');
        expect(html.match(/<script type="module" src="\/js\/theme\.js"><\/script>/g), url).toHaveLength(1);
        // Without JS nothing sets data-theme: the server never renders one.
        expect(html, url).not.toMatch(/<html[^>]*data-theme=/);
      }
    });

    it('serves theme.js without imports from outside its folder', async () => {
      const res = await fetch(`${baseUrl}/js/theme.js`);
      expect(res.status).toBe(200);
      const src = await res.text();
      expect(src).toContain("STORAGE_KEY = 'vrt-theme'");
      for (const m of src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) expect(m[1]).toMatch(/^\.\//);
    });

    it('labels dashboard and run times as UTC and shows meaningful snapshot counts', async () => {
      const index = await (await fetch(`${baseUrl}/`)).text();
      expect(index).toContain('<th scope="col" style="width: 180px;">Created (UTC)</th>');
      expect(index).toContain('<time datetime="2026-01-01T10:00:00Z">2026-01-01 10:00:00 UTC</time>');
      const row = (id) => index.split('<tr').find((r) => r.includes(`data-run-id="${id}"`));
      // hist-1 only created a baseline: no more "0 match"
      expect(row('hist-1')).toContain('<span class="new-count">• 1 new baseline</span>');
      expect(row('hist-1')).not.toContain('match');
      expect(row('hist-2')).toContain('<span class="diff-count">• 1 diff</span>');
      expect(row('hist-3')).toContain('<span class="match-count">• 1 match</span>');
      expect(row('hist-3')).toContain('1 snapshot</span>');
      expect(row('hist-1')).toContain('data-label="Run ID"');

      const run = await (await fetch(`${baseUrl}/runs/hist-2`)).text();
      expect(run).toContain('Created on <time datetime="2026-01-02T10:00:00Z">2026-01-02 10:00:00 UTC</time>');
    });
  });

  describe('accessibility markup (M5)', () => {
    let detail;
    beforeAll(async () => {
      detail = await (await fetch(`${baseUrl}/runs/api-run-1`)).text();
    });

    it('every page has a skip link to <main id="main">', async () => {
      for (const page of ['/', '/runs/api-run-1', '/history/hist_page/tablet', '/runs/nope']) {
        const html = await (await fetch(`${baseUrl}${page}`)).text();
        expect(html, page).toMatch(/<body>\s*<a class="skip-link" href="#main">Skip to main content<\/a>/);
        expect(html.match(/<main [^>]*id="main"/g), page).toHaveLength(1);
        expect(html.match(/<h1[ >]/g), page).toHaveLength(1);
      }
    });

    it('run detail: comparison tabs follow the WAI-ARIA tabs pattern', () => {
      const id = `snapshot-${snapshotId}`;
      expect(detail).toContain(`<article class="snapshot-card" id="${id}" data-status="DIFF" tabindex="-1" aria-labelledby="${id}-heading">`);
      expect(detail).toContain(`<h2 class="visually-hidden" id="${id}-heading">Snapshot / at desktop</h2>`);
      expect(detail).toContain('role="tablist" aria-label="Comparison views for / at desktop"');
      for (const [key, selected] of [['side-by-side', true], ['slider', false], ['diff', false]]) {
        expect(detail).toContain(`role="tab" id="${id}-tab-${key}" aria-controls="${id}-panel-${key}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}"`);
        const panel = detail.match(new RegExp(`<div class="tab-panel[^"]*" data-panel="${key}" ([^>]*)>`))[1];
        expect(panel).toContain(`role="tabpanel" id="${id}-panel-${key}" aria-labelledby="${id}-tab-${key}" tabindex="0"`);
        expect(panel.includes('hidden'), key).toBe(!selected);
      }
      expect(detail).not.toContain('<nav class="tabs-nav"');
    });

    it('run detail: the comparison slider is an ARIA slider named after the route and viewport', () => {
      expect(detail).toContain('class="slider-divider" role="slider" tabindex="0" aria-label="Comparison slider for / at desktop" ' +
        'aria-orientation="horizontal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" aria-valuetext="50% current, 50% baseline"');
      expect(detail).toContain('<div class="slider-handle-pill" aria-hidden="true">');
    });

    it('run detail: screenshot alt text names the route, viewport and image', () => {
      expect(detail).toContain('alt="Baseline screenshot of / at desktop"');
      expect(detail).toContain('alt="Current screenshot of / at desktop"');
      expect(detail).toContain('alt="Diff of / at desktop: differing pixels highlighted in red"');
      expect(detail).not.toMatch(/alt="(Baseline|Current|Diff) (screenshot|image)"/);
    });

    it('run detail: decorative SVGs are hidden, buttons are typed and described, errors have alert regions', () => {
      // Page content after the shared navbar (whose brand icon sits inside a named link)
      for (const svg of detail.split('</header>')[1].match(/<svg[^>]*>/g)) expect(svg).toContain('aria-hidden="true"');
      expect(detail).toMatch(/<button type="button" class="btn btn-approve" data-id="\d+" aria-describedby="snapshot-\d+-heading">/);
      expect(detail).toMatch(/<button type="button" class="btn btn-reject" data-id="\d+" aria-describedby="snapshot-\d+-heading">/);
      // One per card plus one for "Approve all pending"
      expect(detail.match(/<div class="action-error" role="alert" data-action-error><\/div>/g)).toHaveLength(2);
    });

    it('run detail: loads shortcuts.js, shows the hint and renders the help dialog', () => {
      expect(detail).toContain('<script type="module" src="/js/shortcuts.js"></script>');
      expect(detail).toContain('<button type="button" class="shortcuts-hint" data-shortcuts-open aria-haspopup="dialog" aria-controls="shortcuts-dialog">Press <kbd>?</kbd> for keyboard shortcuts</button>');
      expect(detail).toContain('<dialog id="shortcuts-dialog" class="shortcuts-dialog" aria-labelledby="shortcuts-dialog-title">');
      expect(detail).toContain('<input type="checkbox" id="shortcuts-enabled" checked');
      expect(detail).toContain('<label for="shortcuts-enabled">Single-key shortcuts</label>');
    });

    it('dashboard: filter toggle buttons, a labelled search box, hidden icons, no shortcuts script', async () => {
      const html = await (await fetch(`${baseUrl}/`)).text();
      expect(html).toContain('<div class="filter-tabs" role="group" aria-label="Filter runs by status">');
      expect(html).toContain('<button type="button" class="filter-tab active" data-filter="all" aria-pressed="true">');
      expect(html.match(/aria-pressed="false"/g)).toHaveLength(3);
      expect(html).not.toContain('role="tab"');
      expect(html).toContain('<label for="dashboard-search" class="visually-hidden">Filter runs by ID, branch or commit</label>');
      for (const svg of html.split('</header>')[1].match(/<svg[^>]*>/g)) expect(svg).toContain('aria-hidden="true"');
      expect(html).toContain('<span>Inspect<span class="visually-hidden"> run api-run-1</span></span>');
      expect(html).not.toContain('shortcuts.js');
    });

    it('GET /runs/<unknown> answers 404 with a visible, escaped error message', async () => {
      const res = await fetch(`${baseUrl}/runs/${encodeURIComponent('no-such-<run>')}`);
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain('<h1>Run not found</h1>');
      expect(html).toContain('<p>Test run &#34;no-such-&lt;run&gt;&#34; not found.</p>');
      expect(html).not.toContain('test-runs-table'); // not the dashboard any more
    });
  });

  describe('history page (GET /history/:slug/:viewport)', () => {
    it('lists every run of the route at the viewport, newest first, with links, thumbnails and UTC times', async () => {
      const res = await fetch(`${baseUrl}/history/hist_page/tablet`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<title>History: /hist_page @ tablet</title>');
      expect(html).toContain('<span class="breadcrumb-current crumb-middle">History</span>');

      const runLinks = [...html.matchAll(/href="\/runs\/([^"#]+)#snapshot-(\d+)" class="run-id-link"/g)].map((m) => [m[1], Number(m[2])]);
      expect(runLinks).toEqual(['hist-4', 'hist-3', 'hist-2', 'hist-1'].map((id) => [id, historySnaps[id]]));

      expect(html).toContain('<time datetime="2026-01-02T10:00:00Z">2026-01-02 10:00:00 UTC</time>');
      expect(html.match(/<img class="history-thumb" src="\/storage\/runs\/hist-\d\/hist_page-tablet\.png" loading="lazy" alt="Screenshot of \/hist[/_]page at tablet in run hist-\d">/g)).toHaveLength(4);
      expect(html).toContain('<span class="status-pill status-pill-failed">DIFF</span>');
      expect(html).toContain('4.25%');
      expect(html).toContain('#c-hist-2');
      expect(html).toMatch(/<svg class="history-sparkline"[^>]* role="img" aria-label="Mismatch over 4 runs, oldest to newest: min 0\.00%, max 4\.25%, latest 0\.00%"/);

      // hist-3 is the first run compared against baseline B
      expect(html.match(/<span>Baseline changed<\/span>/g)).toHaveLength(1);
      expect(html.split('<tr').find((row) => row.includes('<span>Baseline changed</span>'))).toContain(`/runs/hist-3#snapshot-${historySnaps['hist-3']}`);

      // No shared baseline file on disk -> no link to one
      expect(html).not.toContain('View current baseline');
      expect(html).toContain('No shared baseline exists');
    });

    it('escapes hostile route and branch names everywhere on the history page', async () => {
      const route = '/"><script>alert(1)</script>';
      createTestRun({ id: 'xss-run', status: 'FAILED', branch: '<img src=x onerror=alert(2)>', commit_hash: '"><svg onload=alert(3)>' });
      createSnapshot({
        run_id: 'xss-run', route, viewport: 'desktop', status: 'DIFF', mismatch_percentage: 2,
        current_path: path.join(storageRoot, 'runs', 'xss-run', 'x.png')
      });
      const slug = encodeURIComponent((await import('../src/cli/naming.js')).getRouteSlug(route));
      const res = await fetch(`${baseUrl}/history/${slug}/desktop`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toMatch(/<script>alert|<img src=x|<svg onload/);
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    });

    it('links the current shared baseline when it exists', async () => {
      const file = path.join(storageRoot, 'baselines', 'hist_page-tablet.png');
      fs.writeFileSync(file, 'PNG');
      try {
        const html = await (await fetch(`${baseUrl}/history/hist_page/tablet`)).text();
        expect(html).toContain('<a href="/storage/baselines/hist_page-tablet.png" class="btn-inspect">View current baseline</a>');
      } finally {
        fs.rmSync(file);
      }
    });

    it('returns a 404 page for unknown slugs, unknown viewports and invalid viewports', async () => {
      for (const page of [
        '/history/no_such_route/tablet',
        '/history/hist_page/watch',
        '/history/hist_page/tab.let',
        `/history/hist_page/${'x'.repeat(65)}`,
        '/history/hist%2Fpage/tablet'
      ]) {
        const res = await fetch(`${baseUrl}${page}`);
        expect(res.status, page).toBe(404);
        const html = await res.text();
        expect(html, page).toContain('History not found');
        expect(html, page).not.toContain('history-sparkline');
      }
      // Encoded dot segments sent raw (fetch would normalise them away)
      const { port } = server.address();
      for (const reqPath of ['/history/hist_page/%2E%2E', '/history/%2E%2E/tablet', '/history/hist_page/..%2Ftablet']) {
        const res = await rawRequest(port, { path: reqPath, headers: { Host: `127.0.0.1:${port}` } });
        expect(res.status, reqPath).toBe(404);
        expect(res.body, reqPath).toContain('History not found');
      }
    });

    it('run detail cards link to their history and keep snapshot anchors', async () => {
      const html = await (await fetch(`${baseUrl}/runs/api-run-1`)).text();
      expect(html).toContain(`id="snapshot-${snapshotId}"`);
      expect(html).toContain('<a href="/history/index/desktop" class="history-link" aria-label="History of / at desktop">History</a>');
      const histRun = await (await fetch(`${baseUrl}/runs/hist-1`)).text();
      expect(histRun).toContain('href="/history/hist_page/tablet"');
      expect(histRun).toContain(`id="snapshot-${historySnaps['hist-1']}"`);
    });
  });

  describe('base path (sub-path hosting)', () => {
    // Every local href/src/action must go through url(), so a sub-path build works.
    function expectAllLocalUrlsUnder(html, prefix, label) {
      const urls = [...html.matchAll(/\s(?:href|src|action|srcset|formaction|poster)=["']([^"']*)["']/g)].map((m) => m[1]);
      const local = urls.filter((u) => !/^(https?:|#|data:)/i.test(u));
      expect(local.length, label).toBeGreaterThan(0);
      for (const u of local) expect(u, `${label}: ${u}`).toMatch(new RegExp(`^${prefix}/`));
    }

    async function withBase(base, fn) {
      const previous = app.locals.base;
      app.locals.base = base;
      try {
        return await fn();
      } finally {
        app.locals.base = previous;
      }
    }

    it('prefixes every local URL on the dashboard and run pages, and exposes data-base', async () => {
      await withBase('/x', async () => {
        for (const page of ['/', '/runs/api-run-1', '/runs/no-such-run', '/history/nope/desktop']) {
          const html = await (await fetch(`${baseUrl}${page}`)).text();
          expect(html, page).toContain('data-base="/x"');
          expect(html, page).toContain('data-mode="live"');
          expectAllLocalUrlsUnder(html, '/x', page);
        }
        const runPage = await (await fetch(`${baseUrl}/runs/api-run-1`)).text();
        expect(runPage).toContain('src="/x/storage/runs/api-run-1/index-desktop.png"');
        expect(runPage).toContain('<script type="module" src="/x/js/review-actions.js"></script>');
      });
      expect(app.locals.base).toBe('');
    });

    it('prefixes every local URL on the history page (live base and static pageLocals)', async () => {
      await withBase('/x', async () => {
        const html = await (await fetch(`${baseUrl}/history/hist_page/tablet`)).text();
        expect(html).toContain('data-base="/x"');
        expectAllLocalUrlsUnder(html, '/x', 'history (live)');
        expect(html).toContain(`href="/x/runs/hist-2#snapshot-${historySnaps['hist-2']}"`);
      });

      const html = await new Promise((resolve, reject) => {
        app.render('history', { ...historyModel({ slug: 'hist_page', viewport: 'tablet', storageRoot }), ...pageLocals({ base: '/x', mode: 'static' }) },
          (err, out) => (err ? reject(err) : resolve(out)));
      });
      expect(html).toContain('data-mode="static"');
      expect(html).toContain('class="demo-banner"');
      expectAllLocalUrlsUnder(html, '/x', 'history (static)');
      expect(html).toContain('src="/x/storage/runs/hist-1/hist_page-tablet.png"');
      expect(html).toContain('href="/x/css/styles.css"');
      expect(app.locals.base).toBe('');
      expect(app.locals.mode).toBe('live');
    });

    it('prefixes every local URL on the error page', async () => {
      const html = await withBase('/x', () => new Promise((resolve, reject) => {
        app.render('layout', { title: 'Error', heading: 'Boom', message: '<b>bad</b>' }, (err, out) => (err ? reject(err) : resolve(out)));
      }));
      expect(html).toContain('data-base="/x"');
      expect(html).toContain('<h1>Boom</h1>'); // the page's one h1 (was an h2 under no h1)
      expect(html).toContain('&lt;b&gt;bad&lt;/b&gt;');
      expect(html).not.toContain('slider.js');
      expectAllLocalUrlsUnder(html, '/x', 'error page');
    });

    it('renders under a sub-path via pageLocals() render options without touching app.locals', async () => {
      const html = await new Promise((resolve, reject) => {
        app.render('index', { ...indexModel(), ...pageLocals({ base: '/y/', mode: 'static' }) },
          (err, out) => (err ? reject(err) : resolve(out)));
      });
      expect(html).toContain('data-base="/y"');
      expect(html).toContain('data-mode="static"');
      expectAllLocalUrlsUnder(html, '/y', 'pageLocals render');
      expect(app.locals.base).toBe('');
      expect(app.locals.mode).toBe('live');
    });

    describe('static demo mode (GitHub Pages build)', () => {
      const BANNER = 'class="demo-banner"';
      const render = (view, model) => new Promise((resolve, reject) => {
        app.render(view, model, (err, out) => (err ? reject(err) : resolve(out)));
      });

      it('shows the demo banner on the dashboard, run and error pages in static mode', async () => {
        const locals = { ...pageLocals({ base: '/demo', mode: 'static' }), repoUrl: 'https://github.com/example/repo' };
        const pages = {
          index: await render('index', { ...indexModel(), ...locals }),
          run: await render('run-detail', { ...runDetailModel({ runId: 'api-run-1', storageRoot }), ...locals }),
          error: await render('layout', { title: 'Page not found', heading: 'Page not found', message: '', ...locals })
        };
        for (const [name, html] of Object.entries(pages)) {
          expect(html, name).toContain(BANNER);
          expect(html, name).toContain('approvals are simulated and reset when you reload');
          expect(html, name).toContain('href="https://github.com/example/repo"');
          expect(html, name).toContain('data-mode="static"');
          expectAllLocalUrlsUnder(html, '/demo', name);
        }
        // Approve/Reject stay in the page; review-actions.js simulates them in static mode
        expect(pages.run).toContain('Approve & Update Baseline');
        expect(pages.run).toContain('<script type="module" src="/demo/js/review-actions.js"></script>');
        expect(app.locals.mode).toBe('live');
      });

      it('never shows the demo banner in live mode', async () => {
        for (const page of ['/', '/runs/api-run-1', '/runs/no-such-run']) {
          const html = await (await fetch(`${baseUrl}${page}`)).text();
          expect(html, page).toContain('data-mode="live"');
          expect(html, page).not.toContain(BANNER);
        }
        const rendered = await render('run-detail', { ...runDetailModel({ runId: 'api-run-1', storageRoot }), ...pageLocals() });
        expect(rendered).not.toContain(BANNER);
      });

      it('omits the GitHub link when no repoUrl is given', async () => {
        const html = await render('index', { ...indexModel(), ...pageLocals({ mode: 'static' }) });
        expect(html).toContain(BANNER);
        expect(html).not.toContain('demo-banner-link');
      });
    });

    it('encodes run ids in links and the encoded link opens the run', async () => {
      const odd = 'feat/x#1 a';
      createTestRun({ id: odd, status: 'PASSED' });
      const index = await (await fetch(`${baseUrl}/`)).text();
      const href = `/runs/${encodeURIComponent(odd)}`;
      expect(index).toContain(`href="${href}"`);
      const res = await fetch(`${baseUrl}${href}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('feat/x#1 a');
    });

    it('renders root-relative URLs with the default empty base', async () => {
      const html = await (await fetch(`${baseUrl}/`)).text();
      expect(html).toContain('data-base=""');
      expect(html).toContain('href="/css/styles.css"');
      expect(html).toContain('<script type="module" src="/js/dashboard.js"></script>');
      expect(html).toContain('<div id="live-region" class="visually-hidden" role="status" aria-live="polite"></div>');
    });

    it('serves the dashboard ES modules', async () => {
      for (const file of ['common.js', 'tabs.js', 'slider.js', 'review-actions.js', 'dashboard.js']) {
        const res = await fetch(`${baseUrl}/js/${file}`);
        expect(res.status, file).toBe(200);
        expect(res.headers.get('content-type'), file).toMatch(/javascript/);
        // Imports must be relative so they resolve under any base path
        const src = await res.text();
        for (const m of src.matchAll(/^import .* from '([^']+)'/gm)) expect(m[1], file).toMatch(/^\.\//);
      }
    });
  });

  describe('cross-site request protection', () => {
    async function expectSnapshotUntouched() {
      expect(fs.readFileSync(baselineFile, 'utf8')).toBe('OLD_IMAGE');
      const data = await (await fetch(`${baseUrl}/api/runs/api-run-1`)).json();
      expect(data.snapshots[0].status).toBe('DIFF');
    }

    beforeAll(() => {
      fs.writeFileSync(baselineFile, 'OLD_IMAGE');
      fs.writeFileSync(currentFile, 'NEW_IMAGE');
    });

    it('blocks a plain cross-site form POST (no custom header)', async () => {
      for (const action of ['approve', 'reject']) {
        const res = await fetch(`${baseUrl}/api/snapshots/${snapshotId}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' },
          body: ''
        });
        expect(res.status, action).toBe(403);
        expect((await res.json()).error).toMatch(/Cross-site request blocked/);
      }
      await expectSnapshotUntouched();
    });

    it('blocks a POST without the custom header even with no Origin', async () => {
      const res = await fetch(`${baseUrl}/api/snapshots/${snapshotId}/approve`, { method: 'POST' });
      expect(res.status).toBe(403);
      await expectSnapshotUntouched();
    });

    it('blocks a POST whose Origin does not match the Host', async () => {
      for (const origin of ['https://evil.example', 'http://localhost:1', 'null']) {
        const res = await fetch(`${baseUrl}/api/snapshots/${snapshotId}/approve`, {
          method: 'POST',
          headers: { 'X-Requested-With': 'x', Origin: origin }
        });
        expect(res.status, origin).toBe(403);
      }
      await expectSnapshotUntouched();
    });

    it('blocks a POST the browser marks as cross-site via Sec-Fetch-Site', async () => {
      for (const site of ['cross-site', 'same-site']) {
        const res = await fetch(`${baseUrl}/api/snapshots/${snapshotId}/approve`, {
          method: 'POST',
          headers: { 'X-Requested-With': 'x', 'Sec-Fetch-Site': site }
        });
        expect(res.status, site).toBe(403);
      }
      await expectSnapshotUntouched();
    });

    it('allows a same-origin browser POST (matching Origin + Sec-Fetch-Site)', async () => {
      const res = await fetch(`${baseUrl}/api/snapshots/999999/reject`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'x', Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' }
      });
      // Gets past the CSRF check to the route itself, which 404s on the unknown ID
      expect(res.status).toBe(404);
    });

    it('rejects DNS-rebinding requests with a foreign Host header, including reads', async () => {
      const { port } = server.address();
      const reads = ['/', '/api/runs', '/storage/runs/api-run-1/index-desktop.png'];
      for (const reqPath of reads) {
        const res = await rawRequest(port, { path: reqPath, headers: { Host: `evil.example:${port}` } });
        expect(res.status, reqPath).toBe(403);
      }
      const write = await rawRequest(port, {
        method: 'POST',
        path: `/api/snapshots/${snapshotId}/approve`,
        headers: { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}`, 'X-Requested-With': 'x' }
      });
      expect(write.status).toBe(403);
      await expectSnapshotUntouched();
    });

    it('accepts localhost, IP-literal hosts and ALLOWED_HOSTS entries', async () => {
      const { port } = server.address();
      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `192.168.1.20:${port}`]) {
        const res = await rawRequest(port, { path: '/api/runs', headers: { Host: host } });
        expect(res.status, host).toBe(200);
      }

      const previous = process.env.ALLOWED_HOSTS;
      process.env.ALLOWED_HOSTS = 'ci-box.internal, Review.Example.com';
      try {
        for (const host of [`ci-box.internal:${port}`, 'review.example.com']) {
          const res = await rawRequest(port, { path: '/api/runs', headers: { Host: host } });
          expect(res.status, host).toBe(200);
        }
      } finally {
        if (previous === undefined) delete process.env.ALLOWED_HOSTS;
        else process.env.ALLOWED_HOSTS = previous;
      }
    });

    it('isAllowedHost handles edge cases', () => {
      expect(isAllowedHost(undefined)).toBe(false);
      expect(isAllowedHost('')).toBe(false);
      expect(isAllowedHost('LOCALHOST:4000')).toBe(true);
      expect(isAllowedHost('localhost.:4000')).toBe(true);
      expect(isAllowedHost('localhost.evil.example')).toBe(false);
      expect(isAllowedHost('127.0.0.1.nip.io')).toBe(false);
      expect(isAllowedHost('not a host')).toBe(false);
    });
  });

  it('GET /runs/:id shows a missing baseline without a broken image or slider', async () => {
    createTestRun({ id: 'missing-run', status: 'FAILED' });
    createSnapshot({
      run_id: 'missing-run',
      route: '/new-page',
      viewport: 'desktop',
      baseline_path: path.join(storageRoot, 'baselines', 'new-page-desktop.png'),
      current_path: path.join(storageRoot, 'runs', 'missing-run', 'new-page-desktop.png'),
      status: 'MISSING_BASELINE'
    });

    const html = await (await fetch(`${baseUrl}/runs/missing-run`)).text();
    expect(html).toContain('MISSING BASELINE');
    expect(html).toContain('Approving will make the current screenshot its baseline');
    expect(html).toContain('Approve & Update Baseline');
    expect(html).not.toContain('/storage/baselines/new-page-desktop.png');
    expect(html).not.toContain('data-tab="slider"');
  });

  it('stale approval: shows the run own baseline copy and approve returns 409', async () => {
    const runDir = path.join(storageRoot, 'runs', 'stale-run');
    fs.mkdirSync(runDir, { recursive: true });
    const staleBaseline = path.join(storageRoot, 'baselines', 'stale-desktop.png');
    const runCopy = path.join(runDir, 'baselines', 'stale-desktop.png');
    fs.mkdirSync(path.dirname(runCopy), { recursive: true });
    const runCurrent = path.join(runDir, 'stale-desktop.png');
    fs.writeFileSync(runCopy, 'BASELINE_AT_RUN_TIME');
    fs.writeFileSync(runCurrent, 'STALE_CURRENT');
    fs.writeFileSync(staleBaseline, 'NEWER_APPROVED_BASELINE');

    createTestRun({ id: 'stale-run', status: 'FAILED' });
    const snap = createSnapshot({
      run_id: 'stale-run',
      route: '/stale',
      viewport: 'desktop',
      baseline_path: staleBaseline,
      baseline_snapshot_path: runCopy,
      baseline_sha256: 'hash-of-the-baseline-at-run-time',
      current_path: runCurrent,
      status: 'DIFF'
    });

    const html = await (await fetch(`${baseUrl}/runs/stale-run`)).text();
    expect(html).toContain('/storage/runs/stale-run/baselines/stale-desktop.png');
    expect(html).not.toContain('/storage/baselines/stale-desktop.png');

    const res = await fetch(`${baseUrl}/api/snapshots/${snap.id}/approve`, SAME_ORIGIN_WRITE);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/^Conflict: the baseline has changed/);
    expect(fs.readFileSync(staleBaseline, 'utf8')).toBe('NEWER_APPROVED_BASELINE');
  });

  it('shows images for runs recorded under another storage root (Docker vs host)', async () => {
    createTestRun({ id: 'docker-run', status: 'FAILED' });
    createSnapshot({
      run_id: 'docker-run',
      route: '/',
      viewport: 'desktop',
      baseline_path: '/app/storage/baselines/index-desktop.png',
      baseline_snapshot_path: '/app/storage/runs/docker-run/baselines/index-desktop.png',
      baseline_sha256: 'x',
      current_path: '/app/storage/runs/docker-run/index-desktop.png',
      diff_path: '/somewhere/else/entirely.png',
      status: 'DIFF'
    });
    const html = await (await fetch(`${baseUrl}/runs/docker-run`)).text();
    expect(html).toContain('src="/storage/runs/docker-run/baselines/index-desktop.png"');
    expect(html).toContain('src="/storage/runs/docker-run/index-desktop.png"');
    expect(html).not.toContain('/somewhere/else');
    expect(html).not.toContain('src=""');
  });

  it('POST /api/snapshots/:id/approve promotes baseline and updates status to APPROVED', async () => {
    fs.writeFileSync(baselineFile, 'OLD_IMAGE');
    fs.writeFileSync(currentFile, 'NEW_IMAGE');

    const res = await fetch(`${baseUrl}/api/snapshots/${snapshotId}/approve`, SAME_ORIGIN_WRITE);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.snapshot.status).toBe('APPROVED');
    expect(data.runStatus).toBe('APPROVED');
    expect(fs.readFileSync(baselineFile, 'utf8')).toBe('NEW_IMAGE');
  });

  it('POST /api/snapshots/:id/reject updates status to REJECTED', async () => {
    const res = await fetch(`${baseUrl}/api/snapshots/${snapshotId}/reject`, SAME_ORIGIN_WRITE);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.snapshot.status).toBe('REJECTED');
    expect(data.runStatus).toBe('REJECTED');
  });

  it('serves PNG screenshots from storage/runs and storage/baselines', async () => {
    const res = await fetch(`${baseUrl}/storage/runs/api-run-1/index-desktop.png`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('NEW_IMAGE');
  });

  it('refuses non-PNG and out-of-scope files under /storage', async () => {
    fs.writeFileSync(path.join(storageRoot, 'data.sqlite'), 'DB');
    fs.writeFileSync(path.join(storageRoot, 'runs', 'api-run-1', 'summary.md'), 'MD');
    fs.writeFileSync(path.join(storageRoot, 'stray.png'), 'STRAY');

    for (const p of [
      '/storage/data.sqlite',
      '/storage/data.sqlite-wal',
      '/storage/runs/api-run-1/summary.md',
      '/storage/stray.png'
    ]) {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status, p).toBe(403);
      expect(await res.text(), p).toBe('Access denied');
    }
  });

  it('refuses encoded traversal paths sent raw (bypassing client URL normalization)', async () => {
    fs.writeFileSync(path.join(storageRoot, 'stray.png'), 'STRAY');
    const { port } = server.address();
    for (const rawPath of [
      '/storage/runs/%2e%2e/%2e%2e/stray.png',
      '/storage/runs/..%2f..%2fstray.png',
      '/storage/baselines/..%2fstray.png'
    ]) {
      const status = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
          res.resume();
          resolve(res.statusCode);
        }).on('error', reject);
      });
      expect(status, rawPath).toBe(403);
    }
  });

  it('never serves hidden (dot-named) folders or files under /storage', async () => {
    const hiddenRun = path.join(storageRoot, 'runs', '.import-abc123', 'x');
    fs.mkdirSync(hiddenRun, { recursive: true });
    fs.writeFileSync(path.join(hiddenRun, 'index-desktop.png'), 'STAGED');
    fs.writeFileSync(path.join(storageRoot, 'runs', 'api-run-1', '.hidden.png'), 'HIDDEN');
    for (const p of ['/storage/runs/.import-abc123/x/index-desktop.png', '/storage/runs/api-run-1/.hidden.png']) {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status, p).toBe(403);
    }
  });

  it('returns 404 for a missing screenshot', async () => {
    const res = await fetch(`${baseUrl}/storage/runs/api-run-1/missing.png`);
    expect(res.status).toBe(404);
  });

  it('regression: a snapshot pointing at a secrets file cannot be approved or downloaded', async () => {
    // Simulate a malicious row (previously insertable via POST /api/runs)
    const secretFile = path.join(testTmpDir, '.env');
    fs.writeFileSync(secretFile, 'FAKE_SECRET=hunter2');
    const leakTarget = path.join(storageRoot, 'baselines', 'leak.png');

    createTestRun({ id: 'attack-run', status: 'FAILED' });
    const evil = createSnapshot({
      run_id: 'attack-run',
      route: '/',
      viewport: 'desktop',
      baseline_path: leakTarget,
      current_path: secretFile,
      status: 'DIFF'
    });

    const approve = await fetch(`${baseUrl}/api/snapshots/${evil.id}/approve`, SAME_ORIGIN_WRITE);
    expect(approve.status).toBe(403);
    expect(fs.existsSync(leakTarget)).toBe(false);

    const download = await fetch(`${baseUrl}/storage/baselines/leak.png`);
    expect(download.status).toBe(404);
  });
});
