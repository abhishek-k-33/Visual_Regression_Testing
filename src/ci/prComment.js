import { Buffer } from 'node:buffer';
import { mdCode, sanitizeForDisplay, truncate } from '../shared/text.js';
import { readReport } from './actionReport.js';

export { mdCode };

/**
 * The GitHub Action's pull request comment (action.yml, step "comment", run through
 * actions/github-script): one "sticky" comment per pull request (and comment-id) that
 * every run of the action updates in place, so the PR always shows the latest result.
 *
 * Pure helpers (renderComment, upsertStickyComment) plus the step's entry point run().
 * Only node: builtins and src/ modules without dependencies, so github-script can load
 * it from the action checkout without `npm ci`.
 *
 * Everything that comes from the run (routes, viewports, error messages) is untrusted:
 * a route is chosen by whoever edits the config, and an error message can quote the app
 * under test. It only ever reaches the comment through mdCode (a code span), so it can't
 * ping people, add links or images, or break out of the table.
 *
 * Which comment is updated: the oldest one that starts with this comment-id's hidden
 * marker AND was written by the bot (github-actions[bot], type Bot). Anyone can post a
 * comment containing the marker; matching the author too means the action never
 * overwrites a person's comment.
 */

export const COMMENT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
/**
 * GitHub refuses comment bodies over 65,536 characters; stay well below. Checked in
 * UTF-8 bytes (never fewer than characters), so it holds whichever GitHub counts.
 */
export const MAX_COMMENT_LENGTH = 60000;
export const MAX_TABLE_ROWS = 50;
/** A route or viewport longer than this (in code points) is shortened in the table. */
export const MAX_CELL_LENGTH = 2000;
/**
 * Where the import command in the comment gets visual-ci from. The npm name "visual-ci"
 * is not ours (and our package is not published yet), so a bare `npx visual-ci` would
 * run whatever is published under that name: this fetches this repository instead.
 * Switch it to "visual-ci@<version>" once the package is on npm.
 */
export const IMPORT_PACKAGE_SPEC = 'github:abhishek-k-33/Visual_Regression_Testing';
export const MAX_ERROR_MESSAGE_LENGTH = 500;
export const DEFAULT_BOT_LOGIN = 'github-actions[bot]';
/** Every output the comment step sets (action.yml maps its outputs onto these). */
export const COMMENT_OUTPUT_NAMES = Object.freeze(['comment-url', 'comment-action']);

const STATUSES = ['passed', 'failed', 'error'];
const EXIT_CODES = { passed: 0, failed: 1, error: 2 };
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ARTIFACT_NAME = /^[A-Za-z0-9._-][A-Za-z0-9._ -]{0,99}$/; // the action's own input rule
const SHA = /^[0-9a-f]{7,64}$/i;

/** The hidden first line that identifies the sticky comment of one comment-id. */
export function stickyMarker(commentId) {
  if (typeof commentId !== 'string' || !COMMENT_ID_PATTERN.test(commentId)) {
    throw new TypeError('comment-id may only contain letters, digits, ".", "_" and "-" (at most 64).');
  }
  return `<!-- visual-ci:sticky id=${commentId} -->`;
}

/** Whether a comment body is a sticky comment for `marker`: the marker is its first line. */
export function hasMarker(body, marker) {
  return typeof body === 'string' && body.split(/\r?\n/, 1)[0].trim() === marker;
}

/** The hidden first line of a sticky comment that was replaced by a newer one (never matched again). */
export function supersededMarker(commentId) {
  return stickyMarker(commentId).replace('visual-ci:sticky', 'visual-ci:superseded');
}

/**
 * Create or update? Decided by the action's status (the job's truth), not by the
 * report. A run that did not pass (anything but exactly "passed", or a pass whose
 * artifact upload failed, which fails the job) always gets a comment. A passing run
 * only updates an existing one (to say everything matches again), never starts a new
 * one: a PR that was green from the start stays free of bot comments.
 */
export function shouldCreateComment(status, { uploadFailed = false } = {}) {
  return status !== 'passed' || uploadFailed === true;
}

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const byteLength = (text) => Buffer.byteLength(text, 'utf8');

/** The report reduced to what the comment shows; anything unusable becomes an error. */
function normalize(report) {
  if (!report || typeof report !== 'object' || !STATUSES.includes(report.status)) {
    return {
      status: 'error',
      error: { code: 'NO_RESULT', message: 'visual-ci produced no usable result. See the job log.' },
      counts: { total: 0, passed: 0, changed: 0, missing_baseline: 0, new_baseline: 0 },
      snapshots: []
    };
  }
  const snapshots = Array.isArray(report.snapshots) ? report.snapshots.filter((s) => s && typeof s === 'object') : [];
  const c = report.counts && typeof report.counts === 'object' ? report.counts : {};
  return {
    status: report.status,
    error: report.status === 'error' ? (report.error && typeof report.error === 'object' ? report.error : { code: 'INTERNAL', message: '' }) : null,
    counts: {
      total: count(c.total),
      passed: count(c.passed),
      changed: count(c.changed),
      missing_baseline: count(c.missing_baseline),
      new_baseline: count(c.new_baseline)
    },
    snapshots
  };
}

function formatPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value > 0 && value < 0.01) return '<0.01%';
  return `${value.toFixed(2)}%`;
}

/** An https URL as a Markdown link destination, or null. */
function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return url.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

function utcStamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function headline(r, commentId, uploadFailed) {
  const label = commentId && commentId !== 'default' ? ` (${mdCode(commentId, { table: false })})` : '';
  const { total, passed, changed, missing_baseline: missing, new_baseline: created } = r.counts;
  const newBaselines = created > 0 ? `, ${plural(created, 'new baseline')} created` : '';
  const uploadLine = ['', '⚠️ **Uploading the artifact failed**, so the job fails. Artifact names must be unique within a workflow run: in a matrix, give each use its own `artifact-name`.'];
  if (r.status === 'passed') {
    const all = total === 0 ? 'No snapshots were checked' : `All ${plural(total, 'snapshot')} match the baselines`;
    if (uploadFailed) return [`### ⚠️ Visual CI: the snapshots match, but the job failed${label}`, '', `${all}${newBaselines}.`, ...uploadLine];
    return [`### ✅ Visual CI passed${label}`, '', `${all}${newBaselines}.`];
  }
  const extra = uploadFailed ? uploadLine : [];
  if (r.status === 'failed') {
    const parts = [`${changed} changed`];
    if (missing > 0) parts.push(plural(missing, 'missing baseline'));
    parts.push(`${passed} passed`);
    return [`### ❌ Visual CI found visual changes${label}`, '', `${plural(total, 'snapshot')}: ${parts.join(', ')}${newBaselines}.`, ...extra];
  }
  const code = typeof r.error?.code === 'string' && ERROR_CODE.test(r.error.code) ? r.error.code : 'INTERNAL';
  const message = truncate(r.error?.message ?? '', MAX_ERROR_MESSAGE_LENGTH).trim();
  return [
    `### ⚠️ Visual CI failed with an error${label}`,
    '',
    `${mdCode(code, { table: false })}${message ? `: ${mdCode(message, { table: false })}` : ''}`,
    ...extra
  ];
}

/** A table cell for a route or viewport: a code span, or — when empty. */
function cell(value) {
  const text = truncate(value ?? '', MAX_CELL_LENGTH);
  return text === '' ? '—' : mdCode(text);
}

function tableRow(s) {
  const status = s.status === 'DIFF' ? '🔴 Changed' : '🟠 Missing baseline';
  const mismatch = s.status === 'DIFF' ? formatPercent(s.mismatch_percentage) : '—';
  return `| ${status} | ${cell(s.route)} | ${cell(s.viewport)} | ${mismatch} |`;
}

/** The shell command that downloads the artifact and imports it (only fixed, validated parts). */
export function importCommand({ runId, repo, artifactName }) {
  const dir = `vrt-${runId}`;
  return `gh run download ${runId} -R ${repo} -n ${shQuote(artifactName)} -D ${dir} && ` +
    `npx -y -p ${IMPORT_PACKAGE_SPEC} visual-ci import ${dir}`;
}

/**
 * The comment's Markdown.
 *
 * @param {object|null} report - The `visual-ci test --json` result (schema visual-ci-result v1); null when there is none
 * @param {object} options
 * @param {string} options.commentId - Validated against COMMENT_ID_PATTERN (throws otherwise)
 * @param {string} [options.artifactUrl] - The uploaded artifact (empty: none)
 * @param {string} [options.artifactName]
 * @param {string} [options.runUrl] - The workflow run
 * @param {string} [options.repo] - owner/repo, for the import snippet
 * @param {string|number} [options.runId] - The workflow run id, for the import snippet
 * @param {string} [options.headSha] - The pull request's head commit
 * @param {boolean} [options.uploadFailed] - The artifact upload failed (the job then fails)
 * @param {Date} [options.now]
 * @returns {string} At most MAX_COMMENT_LENGTH UTF-8 bytes, the marker always on the first line
 */
export function renderComment(report, { artifactUrl, runUrl, repo, runId, headSha, commentId = 'default', artifactName, uploadFailed = false, now } = {}) {
  const marker = stickyMarker(commentId);
  const r = normalize(report);
  const head = [marker, ...headline(r, commentId, uploadFailed === true)];

  // Only the rows that can be shown are rendered; the count covers the rest.
  const changed = r.snapshots.filter((s) => s.status === 'DIFF' || s.status === 'MISSING_BASELINE');
  const rows = changed.slice(0, MAX_TABLE_ROWS).map(tableRow);
  const table = (shown) => {
    if (changed.length === 0) return [];
    const lines = ['', '| Status | Route | Viewport | Mismatch |', '| :--- | :--- | :--- | ---: |', ...rows.slice(0, shown)];
    const hidden = changed.length - shown;
    if (hidden > 0) {
      const capped = shown < rows.length ? ' (the comment size limit)' : '';
      lines.push('', `…and ${hidden} more${capped}: see the step summary${artifactUrl ? ' or the artifact' : ''}.`);
    }
    return lines;
  };

  const tail = [''];
  const artifact = safeUrl(artifactUrl);
  const run = safeUrl(runUrl);
  const links = [];
  if (run) links.push(`[Workflow run and step summary](${run})`);
  if (artifact) {
    const name = typeof artifactName === 'string' && artifactName ? ` ${mdCode(truncate(artifactName, 100), { table: false })}` : '';
    links.push(`[Artifact${name}](${artifact})`);
  }
  if (links.length > 0) tail.push(`**Details:** ${links.join(' · ')}`);

  if (artifact) {
    if (r.status === 'error') {
      tail.push('', 'The artifact holds the screenshots taken before the error, for debugging only: it has no `run.json` and cannot be imported.');
    } else if (typeof repo === 'string' && REPO.test(repo) && /^\d{1,20}$/.test(String(runId ?? '')) &&
               typeof artifactName === 'string' && ARTIFACT_NAME.test(artifactName)) {
      tail.push('', 'Review it in your local dashboard:', '', '```sh', importCommand({ runId, repo, artifactName }), '```');
    }
  }
  const sha = typeof headSha === 'string' && SHA.test(headSha) ? `commit ${mdCode(headSha.slice(0, 7), { table: false })} · ` : '';
  tail.push('', `<sub>visual-ci · ${sha}updated ${utcStamp(now)}</sub>`);

  for (let shown = rows.length; shown >= 0; shown--) {
    const body = [...head, ...table(shown), ...tail].join('\n');
    if (byteLength(body) <= MAX_COMMENT_LENGTH) return body;
  }
  // Unreachable with the limits above; still never more than the cap, marker and headline kept.
  let body = [...head, '', 'The details did not fit in a comment: see the workflow run.'].join('\n');
  while (byteLength(body) > MAX_COMMENT_LENGTH) body = Array.from(body).slice(0, -1000).join('');
  return body;
}

/**
 * Updates this action's sticky comment on a pull request, or creates it.
 *
 * The oldest comment that starts with `marker` and was written by `botLogin` (type Bot)
 * is the sticky one. Any newer matching bot comments (two overlapping runs that both
 * created one) are edited to a short "superseded" note pointing at it, under a
 * different marker, so a stale result never lingers and they are never matched again.
 *
 * @param {object} github - An Octokit client (github-script's `github`): paginate + rest.issues
 * @param {object} options
 * @param {string} options.owner
 * @param {string} options.repo
 * @param {number} options.issue_number
 * @param {string} options.body
 * @param {string} options.marker - stickyMarker(commentId)
 * @param {string} [options.supersededMarker] - First line of a replaced duplicate (default: derived from marker)
 * @param {string} [options.botLogin] - Only comments by this login, of type Bot, are ever updated
 * @param {boolean} options.createIfMissing
 * @returns {Promise<{ action: 'created'|'updated'|'skipped', id: number|null, url: string, superseded: number[], supersedeErrors: string[] }>}
 */
export async function upsertStickyComment(github, { owner, repo, issue_number, body, marker, supersededMarker: replaced, botLogin = DEFAULT_BOT_LOGIN, createIfMissing }) {
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number, per_page: 100 });
  const ours = (Array.isArray(comments) ? comments : [])
    .filter((c) => c && c.user?.login === botLogin && c.user?.type === 'Bot' && hasMarker(c.body, marker))
    .sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0) || a.id - b.id);
  if (ours.length === 0) {
    if (!createIfMissing) return { action: 'skipped', id: null, url: '', superseded: [], supersedeErrors: [] };
    const { data } = await github.rest.issues.createComment({ owner, repo, issue_number, body });
    return { action: 'created', id: data?.id ?? null, url: data?.html_url || '', superseded: [], supersedeErrors: [] };
  }
  const [kept, ...duplicates] = ours;
  const { data } = await github.rest.issues.updateComment({ owner, repo, comment_id: kept.id, body });
  const url = data?.html_url || kept.html_url || '';
  const superseded = [];
  const supersedeErrors = [];
  const link = safeUrl(url);
  const note = [replaced || marker.replace('visual-ci:sticky', 'visual-ci:superseded'), '',
    link ? `Superseded by [the current visual-ci comment](${link}).` : 'Superseded by a newer visual-ci comment.'].join('\n');
  for (const dup of duplicates) {
    try {
      await github.rest.issues.updateComment({ owner, repo, comment_id: dup.id, body: note });
      superseded.push(dup.id);
    } catch (err) {
      supersedeErrors.push(`${dup.id}: ${truncate(sanitizeForDisplay(err?.message ?? err), 200)}`);
    }
  }
  return { action: 'updated', id: kept.id, url, superseded, supersedeErrors };
}

/**
 * The report to show: the JSON result when it agrees with the action's status, else
 * null (rendered as an error). The action's status is the truth: it is what the job
 * reports, and it is "error" whenever the result was missing or inconsistent.
 */
export function loadReportForComment({ reportPath, status, fs: fsImpl } = {}) {
  if (!reportPath || !STATUSES.includes(status)) return null;
  const { report } = readReport(reportPath, fsImpl);
  if (!report || report.status !== status || report.exit_code !== EXIT_CODES[status]) return null;
  return report;
}

/**
 * Entry point for the action's comment step. Never throws and never fails the step: a
 * comment problem must not change the visual result. Sets comment-url and
 * comment-action (created, updated, skipped or failed).
 *
 * @param {{ core: object, github: object, context: object }} ctx - github-script's core, github and context
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ action: string, url: string }>}
 */
export async function run({ core, github, context }, env = process.env) {
  const finish = (action, url = '') => {
    core.setOutput('comment-url', url);
    core.setOutput('comment-action', action);
    return { action, url };
  };
  try {
    const commentId = env.VISUAL_CI_COMMENT_ID ?? '';
    if (!COMMENT_ID_PATTERN.test(commentId)) {
      core.warning('visual-ci: no pull request comment: comment-id may only contain letters, digits, ".", "_" and "-" (at most 64).');
      return finish('skipped');
    }
    const pr = context?.payload?.pull_request;
    // pull_request only: with pull_request_target the job usually tests the base
    // branch, and naming the PR's head commit in the comment would be wrong.
    if (context?.eventName !== 'pull_request' || !pr || !Number.isInteger(pr.number)) {
      core.notice('visual-ci: no pull request comment: comments are only written for pull_request events.');
      return finish('skipped');
    }
    const repo = `${context.repo.owner}/${context.repo.repo}`;
    if (pr.head?.repo?.full_name !== repo) {
      // The token of a pull_request run from a fork is read-only: posting would fail.
      core.notice('visual-ci: no pull request comment for a pull request from a fork (its token cannot write comments). ' +
        'The results are in the step summary and the artifact.');
      return finish('skipped');
    }

    const status = env.VISUAL_CI_STATUS;
    const uploadFailed = env.VISUAL_CI_UPLOAD_OUTCOME === 'failure';
    const report = loadReportForComment({ reportPath: env.VISUAL_CI_REPORT_PATH, status });
    const runUrl = context.serverUrl && context.runId ? `${context.serverUrl}/${repo}/actions/runs/${context.runId}` : '';
    const body = renderComment(report, {
      commentId,
      artifactUrl: env.VISUAL_CI_ARTIFACT_URL,
      artifactName: env.VISUAL_CI_ARTIFACT_NAME,
      runUrl,
      repo,
      runId: context.runId,
      headSha: pr.head?.sha, // the PR's commit, not GITHUB_SHA (the merge commit)
      uploadFailed
    });
    const result = await upsertStickyComment(github, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pr.number,
      body,
      marker: stickyMarker(commentId),
      supersededMarker: supersededMarker(commentId),
      createIfMissing: shouldCreateComment(status, { uploadFailed })
    });
    if (result.superseded.length > 0) {
      core.info(`visual-ci: marked ${result.superseded.length} older duplicate comment(s) as superseded.`);
    }
    for (const problem of result.supersedeErrors) core.warning(`visual-ci: could not mark a duplicate comment as superseded (${problem}).`);
    core.info(result.action === 'skipped'
      ? 'visual-ci: the run passed and there is no earlier comment to update: no pull request comment.'
      : `visual-ci: pull request comment ${result.action}: ${result.url}`);
    return finish(result.action, result.url);
  } catch (err) {
    const message = truncate(sanitizeForDisplay(err?.message ?? err), 300);
    if (err?.status === 403 || err?.status === 404) {
      core.warning(`visual-ci: could not write the pull request comment: HTTP ${err.status}: ${message}. ` +
        'Probably the token lacks permission to write pull request comments: give the job "permissions: pull-requests: write" ' +
        '(and keep "contents: read"), or set "comment: false". A locked conversation also answers 403. The visual result is not affected.');
    } else {
      core.warning(`visual-ci: could not write the pull request comment: ${message}. The visual result is not affected.`);
    }
    return finish('failed');
  }
}
