import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mdCode,
  renderComment,
  upsertStickyComment,
  stickyMarker,
  hasMarker,
  shouldCreateComment,
  loadReportForComment,
  run,
  COMMENT_ID_PATTERN,
  COMMENT_OUTPUT_NAMES,
  MAX_COMMENT_LENGTH,
  MAX_TABLE_ROWS
} from '../src/ci/prComment.js';
import { mdCode as sharedMdCode, truncate } from '../src/shared/text.js';

/**
 * A tiny CommonMark code-span reader: the content of the span that starts at the
 * beginning of `md`, or null if `md` is not exactly one code span. Used to prove that
 * no input can close mdCode's span early.
 */
function readCodeSpan(md) {
  const open = md.match(/^`+/)?.[0];
  if (!open) return null;
  for (let i = open.length; i < md.length;) {
    const run = md.slice(i).match(/^`+/)?.[0];
    if (!run) { i++; continue; }
    if (run.length === open.length) {
      if (i + run.length !== md.length) return null; // closed before the end
      let content = md.slice(open.length, i);
      if (content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') content = content.slice(1, -1);
      return content;
    }
    i += run.length;
  }
  return null;
}
/** What a table cell holding mdCode output shows: GitHub unescapes \| before reading the span. */
const cellContent = (md) => readCodeSpan(md.replace(/\\\|/g, '|'));

describe('mdCode: untrusted text as a code span', () => {
  it('wraps plain text in single backticks, unchanged', () => {
    expect(mdCode('/pricing')).toBe('`/pricing`');
    expect(mdCode('desktop')).toBe('`desktop`');
    expect(mdCode(42)).toBe('`42`');
  });

  it.each([
    ['one backtick inside', 'a`b'],
    ['a run of three', 'x```y'],
    ['runs of 1, 2 and 4', 'a`b``c````d'],
    ['a leading backtick', '`start'],
    ['a trailing backtick', 'end`'],
    ['only backticks', '```'],
    ['spaces around', ' padded '],
    ['spaces around backticks', ' `x` ']
  ])('uses a fence longer than any backtick run, padding when needed: %s', (_label, text) => {
    const md = mdCode(text, { table: false });
    const longest = Math.max(0, ...(text.match(/`+/g) || []).map((r) => r.length));
    expect(md.match(/^`+/)[0].length).toBe(longest + 1);
    expect(readCodeSpan(md)).toBe(text); // shows exactly the text, and nothing closes the span early
  });

  it('escapes | as \\| (table cells), and leaves it alone with table: false', () => {
    expect(mdCode('a|b')).toBe('`a\\|b`');
    expect(mdCode('a|b', { table: false })).toBe('`a|b`');
    expect(cellContent(mdCode('| x | `y` |'))).toBe('| x | `y` |');
    expect(mdCode('a\\|b')).toBe('`a\\\\|b`'); // a backslash before the pipe stays visible
  });

  it.each([
    ['an @mention', '@octocat please look'],
    ['a team mention', '@org/team'],
    ['an image tag with a handler', '<img src=x onerror=alert(1)>'],
    ['a javascript: link', '[click](javascript:alert(1))'],
    ['an image', '![i](https://evil.example/t.png)'],
    ['an autolink', '<https://evil.example>'],
    ['an HTML comment that looks like our marker', '<!-- visual-ci:sticky id=default -->'],
    ['emphasis and a heading', '# **bold** _x_']
  ])('neutralises %s: it stays inside a single code span', (_label, text) => {
    const md = mdCode(text);
    expect(md.startsWith('`')).toBe(true);
    expect(cellContent(md)).toBe(text);
  });

  it('escapes bidi overrides, control characters and newlines, so the span stays on one line', () => {
    const md = mdCode('safe\u202eexe.png\u0007\u001b[31m\nrow 2\r\u2028x');
    expect(md).toBe('`safe\\u{202E}exe.png\\u{7}\\u{1B}[31m\\u{A}row 2\\u{D}\\u{2028}x`');
    expect(md).not.toMatch(/[\n\r\u202e\u0007\u001b\u2028]/);
  });

  it('turns empty input into an empty-looking span instead of literal backticks', () => {
    expect(mdCode('')).toBe('`  `');
    expect(mdCode(null)).toBe('`  `');
    expect(mdCode(undefined)).toBe('`  `');
  });

  it('is the shared helper (the step summary uses the same one)', () => {
    expect(mdCode).toBe(sharedMdCode);
  });

  it('truncate never splits a surrogate pair and marks the cut', () => {
    expect(truncate('📸📸📸', 2)).toBe('📸…');
    expect(truncate('abc', 3)).toBe('abc');
  });
});

// ─── renderComment ───────────────────────────────────────────────────────────

const snapshot = (overrides = {}) => ({
  route: '/', viewport: 'desktop', status: 'MATCH', mismatch_percentage: 0,
  current: 'x.png', baseline: 'b.png', baseline_snapshot: null, diff: null, ...overrides
});
function report(overrides = {}) {
  return {
    schema: 'visual-ci-result',
    version: 1,
    status: 'passed',
    exit_code: 0,
    error: null,
    run: { id: 'gh-1-1', run_dir: 'storage/runs/gh-1-1' },
    counts: { total: 4, passed: 4, changed: 0, missing_baseline: 0, new_baseline: 0 },
    snapshots: [snapshot(), snapshot({ viewport: 'mobile' }), snapshot({ route: '/pricing' }), snapshot({ route: '/pricing', viewport: 'mobile' })],
    ...overrides
  };
}
const failedReport = (snapshots, counts = {}) => report({
  status: 'failed',
  exit_code: 1,
  snapshots,
  counts: {
    total: snapshots.length,
    passed: snapshots.filter((s) => s.status === 'MATCH').length,
    changed: snapshots.filter((s) => s.status === 'DIFF').length,
    missing_baseline: snapshots.filter((s) => s.status === 'MISSING_BASELINE').length,
    new_baseline: 0,
    ...counts
  }
});
const OPTIONS = {
  commentId: 'default',
  artifactUrl: 'https://github.com/o/r/actions/runs/4242/artifacts/9001',
  artifactName: 'visual-regression-diffs',
  runUrl: 'https://github.com/o/r/actions/runs/4242',
  repo: 'o/r',
  runId: 4242,
  headSha: 'abcdef0123456789abcdef0123456789abcdef01',
  now: new Date('2026-11-26T09:30:12Z')
};
const tableRows = (md) => md.split('\n').filter((l) => /^\| (🔴|🟠) /.test(l));

describe('renderComment', () => {
  it('starts with the hidden marker for the comment id', () => {
    expect(renderComment(report(), OPTIONS).split('\n')[0]).toBe('<!-- visual-ci:sticky id=default -->');
    expect(renderComment(report(), { ...OPTIONS, commentId: 'chrome-1.2_x' }).split('\n')[0]).toBe('<!-- visual-ci:sticky id=chrome-1.2_x -->');
  });

  it.each(['', 'a b', 'x-->', '<!--', 'a'.repeat(65), 'tab\t', 'ü'])('refuses the comment id %j', (id) => {
    expect(() => renderComment(report(), { ...OPTIONS, commentId: id })).toThrow(/comment-id/);
  });

  it('a pass: says all N match, no table, no import snippet without an artifact', () => {
    const md = renderComment(report(), { ...OPTIONS, artifactUrl: '', artifactName: '' });
    expect(md).toContain('### ✅ Visual CI passed');
    expect(md).toContain('All 4 snapshots match the baselines.');
    expect(tableRows(md)).toEqual([]);
    expect(md).not.toContain('| Status |');
    expect(md).not.toContain('gh run download');
    expect(md).not.toContain('[Artifact');
    expect(md).toContain('[Workflow run and step summary](https://github.com/o/r/actions/runs/4242)');
    expect(md).toContain('commit `abcdef0` · updated 2026-11-26 09:30 UTC');
  });

  it('a pass that created baselines says so', () => {
    const md = renderComment(report({ counts: { total: 2, passed: 0, changed: 0, missing_baseline: 0, new_baseline: 2 } }), OPTIONS);
    expect(md).toContain('All 2 snapshots match the baselines, 2 new baselines created.');
  });

  it('a diff: headline with counts and a table of the changed snapshots only', () => {
    const md = renderComment(failedReport([
      snapshot(),
      snapshot({ route: '/pricing', status: 'DIFF', mismatch_percentage: 3.456789 }),
      snapshot({ route: '/tiny', viewport: 'mobile', status: 'DIFF', mismatch_percentage: 0.004 }),
      snapshot({ route: '/new', status: 'MISSING_BASELINE', mismatch_percentage: 0 }),
      snapshot({ route: '/fresh', status: 'NEW_BASELINE' })
    ]), OPTIONS);
    expect(md).toContain('### ❌ Visual CI found visual changes');
    expect(md).toContain('5 snapshots: 2 changed, 1 missing baseline, 1 passed.');
    expect(md).toContain('| Status | Route | Viewport | Mismatch |');
    expect(tableRows(md)).toEqual([
      '| 🔴 Changed | `/pricing` | `desktop` | 3.46% |',
      '| 🔴 Changed | `/tiny` | `mobile` | <0.01% |',
      '| 🟠 Missing baseline | `/new` | `desktop` | — |'
    ]);
    expect(md).not.toContain('/fresh');
  });

  it('a diff with an artifact: links it and shows the import snippet', () => {
    const md = renderComment(failedReport([snapshot({ status: 'DIFF', mismatch_percentage: 2 })]), OPTIONS);
    expect(md).toContain('[Artifact `visual-regression-diffs`](https://github.com/o/r/actions/runs/4242/artifacts/9001)');
    expect(md).toContain("gh run download 4242 -R o/r -n 'visual-regression-diffs' -D vrt-4242 && npx visual-ci import vrt-4242");
    expect(md).toContain('```sh\n');
  });

  it('quotes an artifact name with spaces in the snippet, and leaves it out for an invalid repo or run id', () => {
    const r = failedReport([snapshot({ status: 'DIFF' })]);
    expect(renderComment(r, { ...OPTIONS, artifactName: 'visual diffs web' })).toContain("-n 'visual diffs web' -D vrt-4242");
    expect(renderComment(r, { ...OPTIONS, repo: 'o/r;rm -rf ~' })).not.toContain('gh run download');
    expect(renderComment(r, { ...OPTIONS, runId: '1 && x' })).not.toContain('gh run download');
    expect(renderComment(r, { ...OPTIONS, artifactName: "x'$(id)" })).not.toContain('gh run download');
  });

  it('a missing baseline only (strict mode) is a failure with its row', () => {
    const md = renderComment(failedReport([snapshot({ status: 'MISSING_BASELINE' })]), OPTIONS);
    expect(md).toContain('1 snapshot: 0 changed, 1 missing baseline, 0 passed.');
    expect(tableRows(md)).toEqual(['| 🟠 Missing baseline | `/` | `desktop` | — |']);
  });

  it('an error: code and sanitised message; the artifact is for debugging only, no import snippet', () => {
    const md = renderComment(report({
      status: 'error',
      exit_code: 2,
      error: { code: 'NAVIGATION_FAILED', message: 'page.goto: net::ERR\u202e @admin [x](javascript:1) <img src=x>\nnext' },
      counts: { total: 0, passed: 0, changed: 0, missing_baseline: 0, new_baseline: 0 },
      snapshots: []
    }), OPTIONS);
    expect(md).toContain('### ⚠️ Visual CI failed with an error');
    expect(md).toContain('`NAVIGATION_FAILED`: `page.goto: net::ERR\\u{202E} @admin [x](javascript:1) <img src=x>\\u{A}next`');
    expect(md).toContain('for debugging only');
    expect(md).toContain('cannot be imported');
    expect(md).not.toContain('gh run download');
  });

  it('an error with an odd code or a huge message stays bounded', () => {
    const md = renderComment(report({ status: 'error', exit_code: 2, error: { code: '<b>x</b>', message: 'm'.repeat(10000) }, snapshots: [] }), OPTIONS);
    expect(md).toContain('`INTERNAL`: `');
    expect(md.length).toBeLessThan(2000);
  });

  it('no report (visual-ci never ran) is an error comment', () => {
    for (const r of [null, undefined, {}, { status: 'great' }]) {
      const md = renderComment(r, OPTIONS);
      expect(md).toContain('### ⚠️ Visual CI failed with an error');
      expect(md).toContain('`NO_RESULT`');
    }
  });

  it('no artifact: no artifact link and no snippet, even on a diff', () => {
    const md = renderComment(failedReport([snapshot({ status: 'DIFF' })]), { ...OPTIONS, artifactUrl: '' });
    expect(md).not.toContain('[Artifact');
    expect(md).not.toContain('gh run download');
    expect(md).toContain('[Workflow run and step summary]');
  });

  it('only https links, with parentheses encoded so they cannot end the link', () => {
    const r = failedReport([snapshot({ status: 'DIFF' })]);
    expect(renderComment(r, { ...OPTIONS, artifactUrl: 'javascript:alert(1)' })).not.toContain('[Artifact');
    expect(renderComment(r, { ...OPTIONS, runUrl: 'http://github.com/x' })).not.toContain('[Workflow run');
    expect(renderComment(r, { ...OPTIONS, runUrl: 'https://github.com/a)(b' })).toContain('(https://github.com/a%29%28b)');
  });

  it('a commit that is not a SHA is left out', () => {
    expect(renderComment(report(), { ...OPTIONS, headSha: '`@x`' })).not.toContain('commit ');
  });

  it('a non-default comment id is named in the headline', () => {
    expect(renderComment(report(), { ...OPTIONS, commentId: 'firefox' })).toContain('### ✅ Visual CI passed (`firefox`)');
  });

  it(`shows at most ${MAX_TABLE_ROWS} rows, then "…and N more"`, () => {
    const snaps = Array.from({ length: 73 }, (_, i) => snapshot({ route: `/page-${i}`, status: 'DIFF', mismatch_percentage: 1 }));
    const md = renderComment(failedReport(snaps), OPTIONS);
    expect(tableRows(md)).toHaveLength(MAX_TABLE_ROWS);
    expect(md).toContain('…and 23 more: see the step summary or the artifact.');
    expect(md).toContain('`/page-49`');
    expect(md).not.toContain('`/page-50`');
  });

  it('caps the comment at 60,000 characters with huge route names: rows go first, marker and headline stay', () => {
    const snaps = Array.from({ length: 60 }, (_, i) => snapshot({ route: `/${i}-${'x'.repeat(100000)}`, status: 'DIFF', mismatch_percentage: 5 }));
    const md = renderComment(failedReport(snaps), OPTIONS);
    expect(MAX_COMMENT_LENGTH).toBe(60000);
    expect(md.length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
    expect(md.split('\n')[0]).toBe('<!-- visual-ci:sticky id=default -->');
    expect(md).toContain('### ❌ Visual CI found visual changes');
    expect(md).toContain('60 snapshots: 60 changed, 0 passed.');
    const shown = tableRows(md).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(MAX_TABLE_ROWS);
    expect(md).toContain(`…and ${60 - shown} more (the comment size limit)`);
    expect(md).toContain('[Workflow run and step summary]'); // the links and the footer survive
    expect(md).toContain('updated 2026-11-26 09:30 UTC');
  });

  it('control characters in routes expand when escaped; the cap still holds', () => {
    const snaps = Array.from({ length: 50 }, () => snapshot({ route: '\u202e'.repeat(5000), status: 'DIFF' }));
    expect(renderComment(failedReport(snaps), OPTIONS).length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
  });

  it('a route with backticks, pipes and markup stays inside its cell', () => {
    const md = renderComment(failedReport([snapshot({ route: '/a`|`b | @x <img src=x onerror=y>', viewport: 'm|``', status: 'DIFF', mismatch_percentage: 1 })]), OPTIONS);
    const [row] = tableRows(md);
    const cells = row.replace(/\\\|/g, '\u0000').split('|').slice(1, -1).map((c) => c.trim().replace(/\u0000/g, '\\|'));
    expect(cells).toHaveLength(4);
    expect(cellContent(cells[1])).toBe('/a`|`b | @x <img src=x onerror=y>');
    expect(cellContent(cells[2])).toBe('m|``');
  });
});

// ─── upsertStickyComment ─────────────────────────────────────────────────────

const MARKER = stickyMarker('default');
const BOT = { login: 'github-actions[bot]', type: 'Bot' };

/** A fake Octokit: listComments pages of `pageSize`, paginate follows them, writes are recorded. */
function fakeGithub(comments, { pageSize = 100, failWith } = {}) {
  const calls = { list: [], update: [], create: [] };
  let nextId = 5000;
  const github = {
    rest: {
      issues: {
        listComments: async (params) => {
          calls.list.push(params);
          if (failWith) throw failWith;
          const page = params.page || 1;
          return { data: comments.slice((page - 1) * pageSize, page * pageSize) };
        },
        updateComment: async (params) => {
          calls.update.push(params);
          return { data: { id: params.comment_id, html_url: `https://github.com/o/r/pull/7#issuecomment-${params.comment_id}` } };
        },
        createComment: async (params) => {
          calls.create.push(params);
          const id = nextId++;
          return { data: { id, html_url: `https://github.com/o/r/pull/7#issuecomment-${id}` } };
        }
      }
    },
    paginate: async (fn, params) => {
      const all = [];
      for (let page = 1; ; page++) {
        const { data } = await fn({ ...params, page });
        all.push(...data);
        if (data.length < pageSize) return all;
      }
    }
  };
  return { github, calls };
}
const comment = (id, user, body, created = `2026-11-0${Math.min(9, id % 10 || 1)}T00:00:00Z`) => ({ id, user, body, created_at: created, html_url: `https://github.com/o/r/pull/7#issuecomment-${id}` });
const upsert = (github, extra = {}) => upsertStickyComment(github, { owner: 'o', repo: 'r', issue_number: 7, body: `${MARKER}\nnew`, marker: MARKER, createIfMissing: true, ...extra });

describe('upsertStickyComment', () => {
  it('creates a comment when there is none', async () => {
    const { github, calls } = fakeGithub([comment(1, { login: 'alice', type: 'User' }, 'LGTM')]);
    const r = await upsert(github);
    expect(r).toEqual({ action: 'created', id: 5000, url: 'https://github.com/o/r/pull/7#issuecomment-5000' });
    expect(calls.create).toEqual([{ owner: 'o', repo: 'r', issue_number: 7, body: `${MARKER}\nnew` }]);
    expect(calls.list[0]).toMatchObject({ owner: 'o', repo: 'r', issue_number: 7, per_page: 100 });
  });

  it("updates the bot's comment with the marker", async () => {
    const { github, calls } = fakeGithub([comment(1, { login: 'alice', type: 'User' }, 'hi'), comment(2, BOT, `${MARKER}\nold`)]);
    const r = await upsert(github);
    expect(r).toEqual({ action: 'updated', id: 2, url: 'https://github.com/o/r/pull/7#issuecomment-2' });
    expect(calls.update).toEqual([{ owner: 'o', repo: 'r', comment_id: 2, body: `${MARKER}\nnew` }]);
    expect(calls.create).toEqual([]);
  });

  it('updates the oldest of several bot comments with the marker', async () => {
    const { github, calls } = fakeGithub([
      comment(9, BOT, `${MARKER}\nb`, '2026-11-03T00:00:00Z'),
      comment(4, BOT, `${MARKER}\na`, '2026-11-02T00:00:00Z')
    ]);
    expect((await upsert(github)).id).toBe(4);
    expect(calls.update.map((c) => c.comment_id)).toEqual([4]);
  });

  it("never edits a human's comment that contains the marker (it creates its own)", async () => {
    const { github, calls } = fakeGithub([
      comment(1, { login: 'mallory', type: 'User' }, `${MARKER}\nplease overwrite me`),
      comment(2, { login: 'github-actions[bot]', type: 'User' }, `${MARKER}\nan account named like the bot`)
    ]);
    const r = await upsert(github);
    expect(r.action).toBe('created');
    expect(calls.update).toEqual([]);
  });

  it('ignores a comment with the marker from another bot', async () => {
    const { github, calls } = fakeGithub([comment(1, { login: 'dependabot[bot]', type: 'Bot' }, `${MARKER}\nx`)]);
    expect((await upsert(github)).action).toBe('created');
    expect(calls.update).toEqual([]);
  });

  it('honours a custom bot login (a GitHub App token)', async () => {
    const { github, calls } = fakeGithub([comment(3, { login: 'my-app[bot]', type: 'Bot' }, `${MARKER}\nx`)]);
    expect((await upsert(github, { botLogin: 'my-app[bot]' })).action).toBe('updated');
    expect(calls.update.map((c) => c.comment_id)).toEqual([3]);
  });

  it('only matches the marker on the first line, and only for its own comment id', async () => {
    const { github, calls } = fakeGithub([
      comment(1, BOT, `${stickyMarker('firefox')}\nother matrix leg`),
      comment(2, BOT, `### report\nroute \`${MARKER}\``), // a route quoting the marker, inside another comment
      comment(3, BOT, `${MARKER}-extra\nx`)
    ]);
    expect((await upsert(github)).action).toBe('created');
    expect(calls.update).toEqual([]);
    expect(hasMarker(`${MARKER}\r\nbody edited on the web`, MARKER)).toBe(true);
    expect(hasMarker(null, MARKER)).toBe(false);
  });

  it('finds the comment on a later page', async () => {
    const humans = Array.from({ length: 7 }, (_, i) => comment(100 + i, { login: 'alice', type: 'User' }, `c${i}`));
    const { github, calls } = fakeGithub([...humans, comment(200, BOT, `${MARKER}\nold`)], { pageSize: 3 });
    const r = await upsert(github);
    expect(r).toMatchObject({ action: 'updated', id: 200 });
    expect(calls.list.map((p) => p.page)).toEqual([1, 2, 3]);
  });

  it('a pass with no earlier comment is skipped: nothing is created', async () => {
    const { github, calls } = fakeGithub([]);
    expect(await upsert(github, { createIfMissing: shouldCreateComment('passed') })).toEqual({ action: 'skipped', id: null, url: '' });
    expect(calls.create).toEqual([]);
    expect(calls.update).toEqual([]);
  });

  it('a pass with an earlier comment updates it', async () => {
    const { github, calls } = fakeGithub([comment(2, BOT, `${MARKER}\nfailed before`)]);
    expect((await upsert(github, { createIfMissing: shouldCreateComment('passed') })).action).toBe('updated');
    expect(calls.update).toHaveLength(1);
  });

  it('failed and error runs create a comment', () => {
    expect(shouldCreateComment('failed')).toBe(true);
    expect(shouldCreateComment('error')).toBe(true);
    expect(shouldCreateComment('passed')).toBe(false);
  });

  it('passes API errors on to the caller', async () => {
    const err = Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    const { github } = fakeGithub([], { failWith: err });
    await expect(upsert(github)).rejects.toBe(err);
  });
});

// ─── loadReportForComment and run() ──────────────────────────────────────────

describe('loadReportForComment', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-prcomment-'));

  it('returns the result when it agrees with the action status, else null', () => {
    const dir = tmp();
    try {
      const file = path.join(dir, 'r.json');
      fs.writeFileSync(file, JSON.stringify(report({ status: 'failed', exit_code: 1 })));
      expect(loadReportForComment({ reportPath: file, status: 'failed' })).toMatchObject({ status: 'failed' });
      expect(loadReportForComment({ reportPath: file, status: 'error' })).toBeNull(); // the action said error
      expect(loadReportForComment({ reportPath: '', status: 'failed' })).toBeNull();
      expect(loadReportForComment({ reportPath: path.join(dir, 'nope.json'), status: 'failed' })).toBeNull();
      fs.writeFileSync(file, '{not json');
      expect(loadReportForComment({ reportPath: file, status: 'failed' })).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('run(): the comment step', () => {
  function fakeCore() {
    const outputs = {};
    const annotations = [];
    return {
      outputs,
      annotations,
      setOutput: (k, v) => { outputs[k] = v; },
      warning: (m) => annotations.push(['warning', m]),
      notice: (m) => annotations.push(['notice', m]),
      error: (m) => annotations.push(['error', m]),
      info: () => {}
    };
  }
  const context = (pr = {}) => ({
    eventName: 'pull_request',
    serverUrl: 'https://github.com',
    runId: 4242,
    repo: { owner: 'o', repo: 'r' },
    payload: { pull_request: { number: 7, head: { sha: 'abcdef0123456789abcdef0123456789abcdef01', repo: { full_name: 'o/r' } }, ...pr } }
  });
  const env = { VISUAL_CI_COMMENT_ID: 'default', VISUAL_CI_STATUS: 'error', VISUAL_CI_REPORT_PATH: '' };

  it('sets exactly the designed outputs', async () => {
    const core = fakeCore();
    await run({ core, github: fakeGithub([]).github, context: context() }, env);
    expect(Object.keys(core.outputs).sort()).toEqual([...COMMENT_OUTPUT_NAMES].sort());
    expect(core.outputs).toEqual({ 'comment-action': 'created', 'comment-url': 'https://github.com/o/r/pull/7#issuecomment-5000' });
  });

  it('comments with the PR head SHA (not the merge commit) and the run link', async () => {
    const core = fakeCore();
    const { github, calls } = fakeGithub([]);
    await run({ core, github, context: context() }, env);
    expect(calls.create[0].body).toContain('commit `abcdef0`');
    expect(calls.create[0].body).toContain('(https://github.com/o/r/actions/runs/4242)');
    expect(calls.create[0].issue_number).toBe(7);
  });

  it('skips a fork with a notice, without calling the API', async () => {
    const core = fakeCore();
    const { github, calls } = fakeGithub([]);
    await run({ core, github, context: context({ head: { sha: 'abc1234', repo: { full_name: 'someone/r' } } }) }, env);
    expect(core.outputs).toEqual({ 'comment-action': 'skipped', 'comment-url': '' });
    expect(core.annotations).toEqual([['notice', expect.stringContaining('from a fork')]]);
    expect(calls.list).toEqual([]);
  });

  it('treats a deleted head repository as a fork', async () => {
    const core = fakeCore();
    await run({ core, github: fakeGithub([]).github, context: context({ head: { sha: 'abc1234', repo: null } }) }, env);
    expect(core.outputs['comment-action']).toBe('skipped');
  });

  it('skips outside a pull request', async () => {
    const core = fakeCore();
    await run({ core, github: fakeGithub([]).github, context: { ...context(), payload: {} } }, env);
    expect(core.outputs['comment-action']).toBe('skipped');
    expect(core.annotations[0][0]).toBe('notice');
  });

  it('skips with a warning for an invalid comment-id', async () => {
    const core = fakeCore();
    await run({ core, github: fakeGithub([]).github, context: context() }, { ...env, VISUAL_CI_COMMENT_ID: '-->' });
    expect(core.outputs['comment-action']).toBe('skipped');
    expect(core.annotations).toEqual([['warning', expect.stringContaining('comment-id')]]);
  });

  it('a 403 (no pull-requests: write) is a warning that says how to fix it, never a throw', async () => {
    const core = fakeCore();
    const err = Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    await expect(run({ core, github: fakeGithub([], { failWith: err }).github, context: context() }, env)).resolves.toEqual({ action: 'failed', url: '' });
    expect(core.outputs).toEqual({ 'comment-action': 'failed', 'comment-url': '' });
    expect(core.annotations).toEqual([['warning', expect.stringContaining('pull-requests: write')]]);
    expect(core.annotations[0][1]).toContain('HTTP 403');
  });

  it('any other error is a warning too, with a sanitised message', async () => {
    const core = fakeCore();
    const err = new Error('boom\u001b[2J');
    await run({ core, github: fakeGithub([], { failWith: err }).github, context: context() }, env);
    expect(core.outputs['comment-action']).toBe('failed');
    expect(core.annotations[0]).toEqual(['warning', expect.stringContaining('boom\\u{1B}[2J')]);
  });

  it('a pass without an earlier comment creates nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-prcomment-'));
    try {
      const file = path.join(dir, 'r.json');
      fs.writeFileSync(file, JSON.stringify(report()));
      const core = fakeCore();
      const { github, calls } = fakeGithub([]);
      await run({ core, github, context: context() }, { ...env, VISUAL_CI_STATUS: 'passed', VISUAL_CI_REPORT_PATH: file });
      expect(core.outputs).toEqual({ 'comment-action': 'skipped', 'comment-url': '' });
      expect(calls.create).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('COMMENT_ID_PATTERN is the documented rule', () => {
    expect(COMMENT_ID_PATTERN.test('default')).toBe(true);
    expect(COMMENT_ID_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(COMMENT_ID_PATTERN.test('a'.repeat(65))).toBe(false);
  });
});

describe('github-script can load it from the action checkout (no npm ci there)', () => {
  it('prComment.js and everything it imports use only node: builtins and relative modules under src/', () => {
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
      for (const [, spec] of text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm)) {
        if (spec.startsWith('node:')) continue;
        expect(spec, `${file} imports ${spec}`).toMatch(/^\.\.?\//);
        const target = path.resolve(path.dirname(file), spec);
        expect(path.relative(path.resolve('src'), target).startsWith('..'), `${file} -> ${spec}`).toBe(false);
        visit(target);
      }
    };
    visit(path.resolve('src/ci/prComment.js'));
    expect([...seen].map((f) => path.relative(path.resolve('.'), f)).sort()).toEqual(['src/ci/actionReport.js', 'src/ci/prComment.js', 'src/shared/text.js']);
  });
});
