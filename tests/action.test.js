import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import YAML from 'yaml';
import { chromium } from 'playwright';
import { OUTPUT_NAMES } from '../src/ci/actionReport.js';
import { COMMENT_OUTPUT_NAMES, stickyMarker } from '../src/ci/prComment.js';
import { importRuns } from '../src/server/importRuns.js';
import { getDb, closeDb } from '../src/server/db.js';
import { writeZip, folderEntries } from './helpers/zip.js';
import { evaluateExpression, shouldRunStep, interpolate } from './helpers/gha-expr.js';

/**
 * The GitHub Action (action.yml), this repository's workflow that uses it, and the
 * action self-test workflow. GitHub Actions can't run here, so this checks the files
 * statically and runs the composite step by step the way the runner does: each step's
 * `if:` is evaluated (tests/helpers/gha-expr.js), bash steps run with the env action.yml
 * gives them against a fake `docker` (which can also run the real CLI on the host,
 * translating the container mounts), the github-script step runs as github-script runs
 * it, and the upload step is faked (its `with:` is recorded).
 */

const REPO = path.resolve('.');
const readYaml = (file) => YAML.parse(fs.readFileSync(file, 'utf8'));
const action = readYaml('action.yml');
const workflow = readYaml('.github/workflows/visual-ci.yml');
const selftest = readYaml('.github/workflows/action-selftest.yml');
const readme = fs.readFileSync('README.md', 'utf8');
const steps = action.runs.steps;
const stepById = (id) => steps.find((s) => s.id === id);
const stepByName = (name) => steps.find((s) => s.name === name);
const allWorkflows = () => fs.readdirSync('.github/workflows').map((f) => [f, readYaml(path.join('.github/workflows', f))]);

const EXPRESSION = /\$\{\{\s*([^}]*?)\s*\}\}/g;
const allExpressions = (value) => [...JSON.stringify(value).matchAll(EXPRESSION)].map((m) => m[1]);
const scriptsOf = (stepList) => stepList.flatMap((s) => [
  ...(s.run ? [[s.name, s.run]] : []),
  ...(s.with?.script ? [[s.name, s.with.script]] : [])
]);

const EXPECTED_INPUTS = {
  'base-url': { required: true, default: undefined },
  config: { required: false, default: 'visual.config.json' },
  'working-directory': { required: false, default: '.' },
  strict: { required: false, default: 'true' },
  'update-baselines': { required: false, default: 'false' },
  'run-id': { required: false, default: '' },
  'wait-on': { required: false, default: '' },
  'wait-timeout': { required: false, default: '60' },
  'artifact-name': { required: false, default: 'visual-regression-diffs' },
  'upload-artifact': { required: false, default: 'on-failure' },
  'retention-days': { required: false, default: '' },
  image: { required: false, default: '' },
  comment: { required: false, default: 'true' },
  'comment-id': { required: false, default: 'default' },
  'github-token': { required: false, default: '${{ github.token }}' }
};
const EXPECTED_OUTPUTS = [
  'status', 'exit-code', 'total', 'changed', 'new-baselines', 'run-id', 'report-path',
  'summary-path', 'run-dir', 'artifact-name', 'artifact-id', 'artifact-url', 'comment-url', 'comment-action'
];
const UPLOAD_ARTIFACT_OUTPUTS = ['artifact-id', 'artifact-url'];
/** What a github-script step of the action sets: the parse step's outputs or the comment step's. */
const githubScriptOutputs = (step) => (step.id === 'comment' ? COMMENT_OUTPUT_NAMES : OUTPUT_NAMES);
const PINNED = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@(v\d+|[0-9a-f]{40})$/;

describe('expression evaluator (test helper)', () => {
  const ctx = {
    inputs: { 'wait-on': '', strict: 'true', comment: 'true' },
    steps: { validate: { outcome: 'success', outputs: { 'run-id': 'r1' } }, parse: { outcome: 'skipped', outputs: {} } },
    runner: { os: 'Linux' },
    github: {}
  };

  it('evaluates the operators GitHub supports', () => {
    expect(evaluateExpression("inputs.wait-on != ''", ctx)).toBe(false);
    expect(evaluateExpression("steps.validate.outcome == 'SUCCESS'", ctx)).toBe(true); // case-insensitive
    expect(evaluateExpression("steps.parse.outputs.upload == ''", ctx)).toBe(true); // a missing value is null, == '' (both 0)
    expect(evaluateExpression("steps.parse.outputs.upload == 'true'", ctx)).toBe(false);
    expect(evaluateExpression("!(runner.os == 'Linux') || inputs.strict", ctx)).toBe('true');
    expect(evaluateExpression("steps.nope.outputs.x", ctx)).toBeNull();
  });

  it('applies the status functions and the implicit success()', () => {
    expect(shouldRunStep(undefined, ctx, { failed: true })).toBe(false);
    expect(shouldRunStep("${{ runner.os == 'Linux' }}", ctx, { failed: true })).toBe(false); // success() && (...)
    expect(shouldRunStep('${{ !cancelled() }}', ctx, { failed: true })).toBe(true);
    expect(shouldRunStep('${{ failure() }}', ctx, { failed: false })).toBe(false);
    expect(shouldRunStep('${{ always() }}', ctx, { cancelled: true })).toBe(true);
    expect(shouldRunStep('${{ !cancelled() }}', ctx, { cancelled: true })).toBe(false);
  });

  it('refuses what it does not understand (so a typo in action.yml fails a test)', () => {
    expect(() => evaluateExpression('inputs.wiat-on', ctx)).toThrow(/unknown input "wiat-on"/);
    expect(() => evaluateExpression('secrets.x', ctx)).toThrow(/unknown context/);
    expect(() => evaluateExpression('contains(a, b)', ctx)).toThrow();
  });

  it('interpolates values and evaluates every if: in action.yml without error', () => {
    expect(interpolate('x-${{ steps.validate.outputs.run-id }}-${{ steps.parse.outputs.y }}', ctx)).toBe('x-r1-');
    for (const step of steps) expect(() => shouldRunStep(step.if, ctx), step.name).not.toThrow();
  });
});

describe('action.yml: structure', () => {
  it('is a composite action with a name, description and branding', () => {
    expect(action.runs.using).toBe('composite');
    expect(action.name).toBe('Visual CI Regression Check');
    expect(action.description).toEqual(expect.any(String));
    expect(action.description.length).toBeLessThanOrEqual(125); // Marketplace limit
    expect(action.branding).toEqual({ icon: expect.any(String), color: expect.any(String) });
  });

  it('declares exactly the designed inputs, with their defaults', () => {
    expect(Object.keys(action.inputs).sort()).toEqual(Object.keys(EXPECTED_INPUTS).sort());
    for (const [name, { required, default: def }] of Object.entries(EXPECTED_INPUTS)) {
      expect(action.inputs[name].required, name).toBe(required);
      expect(action.inputs[name].default, name).toBe(def);
      expect(action.inputs[name].description, name).toEqual(expect.any(String));
    }
  });

  it('says in the input descriptions that artifact names must be unique and credentialed URLs belong in secrets', () => {
    expect(action.inputs['artifact-name'].description).toMatch(/unique within the workflow run/);
    expect(action.inputs['base-url'].description).toMatch(/secret/);
  });

  it('the comment step: github-script with the github-token input, on pull requests only, never failing the action', () => {
    const step = stepById('comment');
    expect(step.uses).toBe('actions/github-script@v8');
    expect(step.if).toBe("${{ !cancelled() && inputs.comment == 'true' && (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') }}");
    expect(step['continue-on-error']).toBe(true);
    expect(step.with['github-token']).toBe('${{ inputs.github-token }}');
    expect(step.env).toEqual({
      VISUAL_CI_ACTION_PATH: '${{ github.action_path }}',
      VISUAL_CI_COMMENT_ID: '${{ inputs.comment-id }}',
      VISUAL_CI_STATUS: '${{ steps.outcome.outputs.status }}',
      VISUAL_CI_REPORT_PATH: '${{ steps.parse.outputs.report-path }}',
      VISUAL_CI_ARTIFACT_NAME: '${{ steps.outcome.outputs.artifact-name }}',
      VISUAL_CI_ARTIFACT_URL: '${{ steps.upload.outputs.artifact-url }}'
    });
    expect(step.with.script).toContain("path.join(process.env.VISUAL_CI_ACTION_PATH, 'src', 'ci', 'prComment.js')");
    expect(step.with.script).toContain('await run({ core, github, context });');
    expect(step.with.script).toMatch(/^try \{[\s\S]*\} catch \(err\) \{\n\s+core\.warning\(/);
    expect(action.outputs['comment-url'].value).toBe('${{ steps.comment.outputs.comment-url }}');
    expect(action.outputs['comment-action'].value).toBe('${{ steps.comment.outputs.comment-action }}');
    // The token goes to github-script only: never to a shell step or the container.
    for (const other of steps.filter((st) => st !== step)) expect(JSON.stringify(other), other.name).not.toContain('github-token');
  });

  it('describes the comment inputs: permissions, separate comments per comment-id, the bot author', () => {
    expect(action.inputs.comment.description).toMatch(/pull-requests: write/);
    expect(action.inputs['comment-id'].description).toMatch(/matrix/);
    expect(action.inputs['github-token'].description).toMatch(/github-actions\[bot\]/);
  });

  it('declares exactly the designed outputs', () => {
    expect(Object.keys(action.outputs).sort()).toEqual([...EXPECTED_OUTPUTS].sort());
    for (const [name, output] of Object.entries(action.outputs)) {
      expect(output.description, name).toEqual(expect.any(String));
    }
  });

  it('maps every output onto a step output that exists', () => {
    for (const [name, output] of Object.entries(action.outputs)) {
      const match = output.value.match(/^\$\{\{ steps\.([\w-]+)\.outputs\.([\w-]+) \}\}$/);
      expect(match, `${name}: ${output.value}`).not.toBeNull();
      const [, stepId, stepOutput] = match;
      const step = stepById(stepId);
      expect(step, `${name}: no step with id ${stepId}`).toBeDefined();
      if (step.uses?.startsWith('actions/github-script@')) expect(githubScriptOutputs(step)).toContain(stepOutput);
      else if (step.uses?.startsWith('actions/upload-artifact@')) expect(UPLOAD_ARTIFACT_OUTPUTS).toContain(stepOutput);
      else expect(step.run).toContain(`${stepOutput}=`);
    }
  });

  it('status, exit-code and artifact-name come from the always-run outcome step; the artifact ones from the upload', () => {
    expect(action.outputs.status.value).toBe('${{ steps.outcome.outputs.status }}');
    expect(action.outputs['exit-code'].value).toBe('${{ steps.outcome.outputs.exit-code }}');
    expect(action.outputs['artifact-name'].value).toBe('${{ steps.outcome.outputs.artifact-name }}');
    expect(stepById('outcome').env.ARTIFACT_ID).toBe('${{ steps.upload.outputs.artifact-id }}');
    expect(OUTPUT_NAMES).not.toContain('artifact-name'); // never claimed before the upload happened
  });

  it('every steps.<id>.outputs.<name> reference resolves, and every inputs.<name> exists', () => {
    for (const expr of allExpressions(steps)) {
      for (const [, id, out] of expr.matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/g)) {
        const step = stepById(id);
        expect(step, `${expr}: no step ${id}`).toBeDefined();
        const produced = step.uses?.startsWith('actions/github-script@') ? githubScriptOutputs(step)
          : step.uses?.startsWith('actions/upload-artifact@') ? UPLOAD_ARTIFACT_OUTPUTS
            : [...step.run.matchAll(/^\s*echo "([\w-]+)=/gm)].map((m) => m[1]);
        expect(produced, expr).toContain(out);
      }
      for (const [, id] of expr.matchAll(/steps\.([\w-]+)\.outcome/g)) expect(stepById(id), expr).toBeDefined();
      for (const [, name] of expr.matchAll(/inputs\.([\w-]+)/g)) {
        expect(action.inputs[name], expr).toBeDefined();
      }
    }
    // ...and every input is used somewhere.
    const used = new Set(allExpressions(steps).flatMap((e) => [...e.matchAll(/inputs\.([\w-]+)/g)].map((m) => m[1])));
    expect([...used].sort()).toEqual(Object.keys(action.inputs).sort());
  });

  it('never puts an expression inside a script: inputs and github.* reach scripts only through env', () => {
    const scripts = scriptsOf(steps);
    expect(scripts.length).toBeGreaterThanOrEqual(7);
    for (const [name, script] of scripts) {
      expect(script, name).not.toMatch(/\$\{\{/);
    }
    // The workflows that use the action too.
    for (const wf of [workflow, selftest]) {
      for (const job of Object.values(wf.jobs)) {
        for (const [name, script] of scriptsOf(job.steps)) expect(script, name).not.toMatch(/\$\{\{/);
      }
    }
  });

  it('expressions only appear in env:, with:, if: and output values', () => {
    for (const step of steps) {
      const rest = Object.fromEntries(Object.entries(step).filter(([key]) => !['env', 'with', 'if'].includes(key)));
      expect(allExpressions(rest), step.name).toEqual([]);
    }
  });

  it('pins every action it uses to a major version (or a full SHA), on Node 24 versions', () => {
    const uses = [
      ...steps.filter((s) => s.uses).map((s) => s.uses),
      ...allWorkflows().flatMap(([, wf]) => Object.values(wf.jobs).flatMap((j) => (j.steps || []).filter((s) => s.uses && s.uses !== './').map((s) => s.uses)))
    ];
    expect(uses).toContain('actions/github-script@v8');
    expect(uses).toContain('actions/upload-artifact@v6');
    expect(uses).toContain('actions/download-artifact@v7');
    for (const ref of uses) expect(ref).toMatch(PINNED);
  });

  it('every run step uses bash', () => {
    for (const step of steps.filter((s) => s.run)) expect(step.shell, step.name).toBe('bash');
  });

  it('builds the image before waiting for the app, and comments after the upload and the outcome (before the result)', () => {
    expect(steps.map((s) => s.id || s.name)).toEqual([
      'runner', 'validate', 'image', 'wait', 'run', 'parse', 'upload', 'outcome', 'comment', 'Set the result'
    ]);
  });

  it('uploads only the run folder the result names, with the chosen name', () => {
    expect(stepById('upload').with).toEqual({
      name: '${{ inputs.artifact-name }}',
      path: '${{ steps.parse.outputs.upload-path }}',
      'retention-days': '${{ inputs.retention-days }}',
      'if-no-files-found': 'error'
    });
  });

  it('the parse step loads the module from the action folder via github.action_path, and gives it github and context', () => {
    const parse = stepById('parse');
    expect(parse.env.VISUAL_CI_ACTION_PATH).toBe('${{ github.action_path }}');
    expect(parse.with.script).toContain("path.join(process.env.VISUAL_CI_ACTION_PATH, 'src', 'ci', 'actionReport.js')");
    expect(parse.with.script).toContain('await run({ core, github, context });');
    expect(fs.existsSync(path.join(REPO, 'src/ci/actionReport.js'))).toBe(true);
  });

  it('never mounts RUNNER_TEMP itself into the container, only its visual-ci folder and the step summary', () => {
    const script = stepById('run').run;
    const mounts = [...script.matchAll(/-v "([^"]+)"/g)].map((m) => m[1]);
    expect(mounts).toEqual([
      '$GITHUB_STEP_SUMMARY:/github/step-summary.md',
      '$GITHUB_WORKSPACE:/github/workspace',
      '$out:/visual-ci-temp'
    ]);
    expect(script).toContain('out="$RUNNER_TEMP/visual-ci"');
    expect(script).not.toMatch(/"\$RUNNER_TEMP:/);
  });
});

describe('the Docker build context is the action folder', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  const ignored = fs.readFileSync('.dockerignore', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  it('everything the Dockerfile copies exists in the repository and is not excluded by .dockerignore', () => {
    const sources = [...dockerfile.matchAll(/^COPY\s+(.+)\s+\S+\s*$/gm)].flatMap((m) => m[1].split(/\s+/));
    expect(sources).toEqual(expect.arrayContaining(['package.json', 'package-lock.json', 'src/', 'visual.config.json']));
    for (const source of sources) {
      expect(fs.existsSync(source), source).toBe(true);
      const clean = source.replace(/\/$/, '');
      for (const pattern of ignored) {
        if (pattern.startsWith('!')) continue;
        const p = pattern.replace(/\/$/, '').replace(/\/\*$/, '');
        expect(clean === p || clean.startsWith(`${p}/`), `${source} is excluded by "${pattern}"`).toBe(false);
      }
    }
  });

  it('the image runs the CLI from /app, so the action can call node /app/src/cli/index.js from any working directory', () => {
    expect(dockerfile).toMatch(/^WORKDIR \/app$/m);
    expect(dockerfile).toMatch(/^COPY src\/ \.\/src\/$/m);
    expect(dockerfile).not.toMatch(/^USER /m); // the action picks the user (--user), so files are not root-owned
    expect(dockerfile).not.toMatch(/^ENTRYPOINT/m); // the action's command runs as given
  });
});

describe('visual-ci.yml dogfoods the action', () => {
  const job = workflow.jobs['visual-tests'];

  it('keeps the triggers, concurrency and minimal permissions', () => {
    expect(workflow.on).toEqual({
      push: { branches: ['main'] },
      pull_request: { branches: ['main'] },
      workflow_dispatch: null
    });
    expect(workflow.concurrency).toEqual({ group: '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs['unit-tests'].permissions).toBeUndefined();
  });

  it('grants pull-requests: write to the visual job only (job permissions replace the workflow ones, so contents: read stays)', () => {
    expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
    const check = job.steps.find((s) => s.uses === './');
    expect(String(check.with.comment ?? action.inputs.comment.default)).toBe('true');
    expect(check.with['github-token']).toBeUndefined(); // the job token, as github-actions[bot]
  });

  it('keeps the unit test job unchanged', () => {
    expect(workflow.jobs['unit-tests']).toEqual({
      name: 'Unit & Integration Tests',
      'runs-on': 'ubuntu-latest',
      steps: [
        { name: 'Checkout Repository', uses: 'actions/checkout@v4' },
        { name: 'Setup Node.js 22', uses: 'actions/setup-node@v4', with: { 'node-version': 22, cache: 'npm' } },
        { name: 'Install Node Dependencies', run: 'npm ci' },
        { name: 'Install Playwright Chromium', run: 'npx playwright install --with-deps chromium' },
        { name: 'Run Test Suite', run: 'npm test' }
      ]
    });
  });

  it('checks out without persisted credentials, starts the demo site, then uses ./ with base-url and wait-on', () => {
    const names = job.steps.map((s) => s.uses || s.name);
    expect(names.indexOf('actions/checkout@v4')).toBeLessThan(names.indexOf('Start Demo Site'));
    expect(names.indexOf('Start Demo Site')).toBeLessThan(names.indexOf('./'));
    expect(job.steps.find((s) => s.uses === 'actions/checkout@v4').with).toEqual({ 'persist-credentials': false });
    const start = job.steps.find((s) => s.name === 'Start Demo Site');
    expect(start.run.trim()).toMatch(/^node scripts\/serve-demo\.js .*&$/); // in the background
    const check = job.steps.find((s) => s.uses === './');
    expect(check.with).toMatchObject({
      'base-url': 'http://127.0.0.1:4567',
      'wait-on': 'http://127.0.0.1:4567/',
      'artifact-name': 'visual-regression-diffs',
      'upload-artifact': 'on-failure',
      'retention-days': 7
    });
    expect(check.with.strict ?? action.inputs.strict.default).toBe('true');
  });

  it('no longer builds, runs or uploads by hand', () => {
    const text = JSON.stringify(job);
    expect(text).not.toMatch(/docker (build|run)/);
    expect(text).not.toContain('actions/upload-artifact');
  });
});

/** Runs a workflow step's bash script with its env: evaluated against `context`. */
async function runWorkflowScript(step, context, { cwd = os.tmpdir(), env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-wf-step-'));
  try {
    const script = path.join(dir, 'step.sh');
    fs.writeFileSync(script, step.run);
    const stepEnv = { PATH: process.env.PATH, HOME: dir, RUNNER_TEMP: dir, ...env };
    for (const [key, value] of Object.entries(step.env || {})) stepEnv[key] = interpolate(value, context);
    return await exec('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], { cwd, env: stepEnv });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('action-selftest.yml proves the failure paths on a real runner', () => {
  const { diff, error } = selftest.jobs;
  const actionStep = (job) => job.steps.find((s) => s.uses === './');
  const named = (job, re) => job.steps.find((s) => re.test(s.name));

  it('runs on demand and on pull requests that touch the action, with a read-only token', () => {
    expect(selftest.on).toEqual({
      workflow_dispatch: null,
      pull_request: {
        paths: ['action.yml', 'src/ci/**', 'src/cli/**', 'src/shared/**', 'Dockerfile', '.dockerignore', '.github/workflows/action-selftest.yml']
      }
    });
    expect(selftest.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(selftest.jobs).sort()).toEqual(['diff', 'error']);
    for (const job of Object.values(selftest.jobs)) {
      expect(job.permissions).toBeUndefined();
      expect(job['runs-on']).toBe('ubuntu-latest');
    }
  });

  it('never comments on the pull request: comment is false, and the token is read-only anyway', () => {
    for (const [name, job] of Object.entries(selftest.jobs)) {
      expect(String(actionStep(job).with.comment), name).toBe('false');
      expect(named(job, /^Assert the Outputs/).env.COMMENT_ACTION, name).toBe('${{ steps.visual.outputs.comment-action }}');
    }
    expect(selftest.permissions).toEqual({ contents: 'read' });
  });

  it('can never change committed baselines: strict compare, no credentials, and a check at the end', () => {
    for (const [name, job] of Object.entries(selftest.jobs)) {
      const checkout = job.steps.find((s) => s.uses === 'actions/checkout@v4');
      expect(checkout.with, name).toEqual({ 'persist-credentials': false });
      const use = actionStep(job);
      expect(use.with.strict ?? 'true', name).toBe('true');
      expect(use.with['update-baselines'] ?? 'false', name).toBe('false');
      const guard = job.steps.at(name === 'diff' ? -2 : -1);
      expect(guard.name, name).toBe('Committed Baselines Are Untouched');
      expect(guard.if, name).toBe('always()');
    }
  });

  it('the diff job serves a page that differs from the baselines and uploads always, under its own artifact name', () => {
    expect(named(diff, /^Start Demo Site/).run.trim()).toMatch(/^DEMO_VARIANT=regressed node scripts\/serve-demo\.js .*&$/);
    const use = actionStep(diff);
    expect(use).toMatchObject({ id: 'visual', 'continue-on-error': true });
    expect(use.with).toMatchObject({
      'base-url': 'http://127.0.0.1:4567',
      'wait-on': 'http://127.0.0.1:4567/',
      'upload-artifact': 'always',
      'artifact-name': 'selftest-diff-${{ github.run_attempt }}'
    });
  });

  it('the diff job downloads the artifact by its (asserted) name and imports it into a throwaway storage folder', () => {
    const download = diff.steps.find((s) => s.uses?.startsWith('actions/download-artifact@'));
    // By name, not by id: download-artifact found no artifact by id within the same run.
    expect(download.with).toEqual({ name: '${{ steps.visual.outputs.artifact-name }}', path: '${{ runner.temp }}/selftest-artifact' });
    const importStep = named(diff, /^Import the Artifact/);
    expect(importStep.run).toContain('[ ! -f "$ARTIFACT_DIR/run.json" ]');
    expect(importStep.run).toContain('export VISUAL_STORAGE_DIR="$RUNNER_TEMP/selftest-import-storage"');
    expect(importStep.run).toContain('node src/cli/index.js import "$ARTIFACT_DIR"');
    const order = diff.steps.map((s) => s.name);
    expect(order.indexOf('Assert the Outputs of a Diff Run')).toBeLessThan(order.indexOf('Download the Artifact'));
  });

  it('the error job points at a port nothing listens on, uploads always, and has its own artifact name', () => {
    const use = actionStep(error);
    expect(use).toMatchObject({ id: 'visual', 'continue-on-error': true });
    expect(use.with).toMatchObject({ 'base-url': 'http://127.0.0.1:9/', 'upload-artifact': 'always', 'artifact-name': 'selftest-error-${{ github.run_attempt }}' });
    expect(use.with['wait-on']).toBeUndefined();
  });

  describe('the assertions fail the job when an output is wrong', () => {
    const diffOutputs = {
      status: 'failed', 'exit-code': '1', changed: '2', 'artifact-name': 'selftest-diff-1',
      'artifact-id': '4711', 'artifact-url': 'https://github.com/o/r/actions/runs/1/artifacts/4711', 'comment-action': ''
    };
    const errorOutputs = { status: 'error', 'exit-code': '2', 'artifact-name': '', 'artifact-id': '', 'artifact-url': '', 'comment-action': '' };
    const ctx = (outputs, outcome = 'failure') => ({ steps: { visual: { outcome, outputs } }, github: { run_attempt: '1' }, runner: { temp: os.tmpdir() } });
    const assertDiff = named(diff, /^Assert the Outputs/);
    const assertError = named(error, /^Assert the Outputs/);

    it('pass for the expected outputs', async () => {
      const d = await runWorkflowScript(assertDiff, ctx(diffOutputs));
      expect(d.code, d.stdout).toBe(0);
      const e = await runWorkflowScript(assertError, ctx(errorOutputs));
      expect(e.code, e.stdout).toBe(0);
    });

    it.each([
      ['the action passed', {}, 'success'],
      ['status passed', { status: 'passed' }],
      ['exit code 2', { 'exit-code': '2' }],
      ['nothing changed', { changed: '0' }],
      ['changed empty', { changed: '' }],
      ['no artifact id', { 'artifact-id': '' }],
      ['no artifact url', { 'artifact-url': '' }],
      ['no artifact name', { 'artifact-name': '' }],
      ['the comment step ran', { 'comment-action': 'skipped' }]
    ])('diff job: fails when %s', async (_label, change, outcome) => {
      const r = await runWorkflowScript(assertDiff, ctx({ ...diffOutputs, ...change }, outcome));
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('::error title=self-test::');
    });

    it.each([
      ['the action passed', {}, 'success'],
      ['status failed', { status: 'failed' }],
      ['exit code 1', { 'exit-code': '1' }],
      ['an artifact id', { 'artifact-id': '12' }],
      ['an artifact url', { 'artifact-url': 'https://x' }],
      ['an artifact name', { 'artifact-name': 'selftest-error-1' }],
      ['a comment was posted', { 'comment-action': 'created' }]
    ])('error job: fails when %s', async (_label, change, outcome) => {
      const r = await runWorkflowScript(assertError, ctx({ ...errorOutputs, ...change }, outcome));
      expect(r.code).toBe(1);
    });
  });

  it('the baseline guard fails when storage/baselines changed', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-guard-'));
    const git = (...args) => exec('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo });
    try {
      fs.mkdirSync(path.join(repo, 'storage', 'baselines'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'storage', 'baselines', 'a.png'), 'a');
      await git('init', '-q');
      await git('add', '.');
      await git('commit', '-q', '-m', 'init');
      const guard = named(error, /^Committed Baselines/);
      expect((await runWorkflowScript(guard, {}, { cwd: repo })).code).toBe(0);
      fs.writeFileSync(path.join(repo, 'storage', 'baselines', 'b.png'), 'b');
      const added = await runWorkflowScript(guard, {}, { cwd: repo });
      expect(added.code).toBe(1);
      expect(added.stdout).toContain('storage/baselines changed');
      fs.rmSync(path.join(repo, 'storage', 'baselines', 'b.png'));
      fs.writeFileSync(path.join(repo, 'storage', 'baselines', 'a.png'), 'changed');
      expect((await runWorkflowScript(guard, {}, { cwd: repo })).code).toBe(1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('README documents the action', () => {
  const section = (() => {
    const at = readme.search(/^## .*Use it in your repo \(GitHub Action\)/m);
    if (at === -1) return '';
    const next = readme.slice(at + 3).search(/^## /m);
    return next === -1 ? readme.slice(at) : readme.slice(at, at + 3 + next);
  })();

  it('has a "Use it in your repo (GitHub Action)" section with a usage snippet', () => {
    expect(section).not.toBe('');
    expect(section).toContain('uses: abhishek-k-33/Visual_Regression_Testing@v1');
    expect(section).toMatch(/base-url:/);
    expect(section).toMatch(/wait-on:/);
    expect(section).toMatch(/@main/);
  });

  it('installs and starts the app in separate steps (npm ci must not race wait-on)', () => {
    expect(section).not.toMatch(/npm ci && npm start &/);
    expect(section).toMatch(/- run: npm ci\n\s+- run: npm start &/);
  });

  it.each(Object.keys(EXPECTED_INPUTS))('documents the input %s', (name) => {
    expect(section).toMatch(new RegExp(`^\\| \`${name}\` \\|`, 'm'));
  });

  it.each(EXPECTED_OUTPUTS)('documents the output %s', (name) => {
    expect(section).toMatch(new RegExp(`^\\| \`${name}\` \\|`, 'm'));
  });

  it('documents the pull request comment: sample, permissions, forks, matrix comment-id, the bot author, safety', () => {
    expect(section).toMatch(/^### Pull request comment$/m);
    expect(section).toContain('> ### ❌ Visual CI found visual changes'); // the sample
    expect(section).toMatch(/permissions:\n\s+contents: read\n\s+pull-requests: write/);
    expect(section).toMatch(/pull-requests: write\s+# the pull request comment/); // in the complete workflow
    expect(section).toMatch(/\*\*Pull requests from forks:\*\* no comment/);
    expect(section).toMatch(/workflow_run/); // the documented follow-up
    expect(section).toMatch(/comment-id: \$\{\{ matrix\.\w+ \}\}/);
    expect(section).toContain('github-actions[bot]');
    expect(section).toContain('<!-- visual-ci:sticky id=<comment-id> -->');
    expect(section).toContain('comment: false');
    expect(section).not.toMatch(/Pull request comments are not part of the action yet/);
  });

  it('documents baselines, limitations, error-run artifacts, unique names and secrets', () => {
    expect(section).toMatch(/update-baselines: true/);
    expect(section).toMatch(/Linux/);
    expect(section).toMatch(/fork/i);
    expect(section).toMatch(/not importable/);
    expect(section).toMatch(/unique/);
    expect(section).toMatch(/secrets\./);
    expect(section).toMatch(/action-selftest\.yml/);
  });
});

// ─── Running the steps ───────────────────────────────────────────────────────

const FAKE_DOCKER = String.raw`#!/usr/bin/env node
// Fake docker for tests: logs each call; "run" either writes a canned report (FAKE_DOCKER_REPORT)
// or, with FAKE_DOCKER_CLI=1, runs the real CLI on the host with the container mounts translated.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const entry = { args };
let status = Number(process.env.FAKE_DOCKER_EXIT || 0);
if (args[0] === 'run' && process.env.FAKE_DOCKER_RUN_EXIT) status = Number(process.env.FAKE_DOCKER_RUN_EXIT);
if (args[0] === 'run') {
  const mounts = [];
  const envs = [];
  const flags = [];
  let workdir = null;
  let i = 1;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--rm') { flags.push(a); continue; }
    if (['--network', '--user', '-e', '-v', '-w'].includes(a)) {
      const v = args[++i];
      if (a === '-v') mounts.push(v); else if (a === '-e') envs.push(v); else if (a === '-w') workdir = v; else flags.push(a + ' ' + v);
      continue;
    }
    if (a.startsWith('-')) { console.error('fake docker: unexpected flag ' + a); process.exit(125); }
    break;
  }
  const table = mounts.map((m) => {
    const parts = m.split(':');
    // Like docker, a ':' in the host path would make the spec ambiguous: refuse it loudly.
    if (parts.length !== 2 || !parts[0].startsWith('/') || !parts[1].startsWith('/')) { console.error('fake docker: cannot parse -v ' + m); process.exit(125); }
    return [parts[1], parts[0]];
  });
  table.push(['/app', process.env.FAKE_DOCKER_APP]);
  table.sort((a, b) => b[0].length - a[0].length);
  const toHost = (p) => {
    for (const [inside, host] of table) {
      if (p === inside) return host;
      if (p.startsWith(inside + '/')) return path.join(host, p.slice(inside.length + 1));
    }
    return p;
  };
  const mapArg = (a) => { const eq = a.indexOf('='); return a.startsWith('/') ? toHost(a) : (eq > 0 && a[eq + 1] === '/' ? a.slice(0, eq + 1) + toHost(a.slice(eq + 1)) : a); };
  const image = args[i];
  const command = args.slice(i + 1);
  const jsonArg = command.find((a) => a.startsWith('--json='));
  const jsonHost = jsonArg ? toHost(jsonArg.slice('--json='.length)) : null;
  Object.assign(entry, { mounts, envs, flags, workdir, image, command, reportExisted: jsonHost ? fs.existsSync(jsonHost) : null });
  if (process.env.FAKE_DOCKER_CLI === '1') {
    const env = { PATH: process.env.PATH, PLAYWRIGHT_BROWSERS_PATH: process.env.FAKE_DOCKER_BROWSERS };
    for (const e of envs) {
      const eq = e.indexOf('=');
      const name = eq === -1 ? e : e.slice(0, eq);
      if (name === 'HOME') env.HOME = process.env.FAKE_DOCKER_HOME; // the container's /tmp: a per-test folder here
      else if (eq === -1) { if (process.env[e] !== undefined) env[e] = process.env[e]; } else env[name] = mapArg(e.slice(eq + 1));
    }
    const [bin, ...rest] = command;
    const r = spawnSync(bin === 'node' ? process.execPath : bin, rest.map(mapArg), { cwd: toHost(workdir), env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    entry.stdout = r.stdout; entry.stderr = r.stderr;
    status = r.status === null ? 137 : r.status;
  } else if (process.env.FAKE_DOCKER_REPORT && jsonHost) {
    fs.writeFileSync(jsonHost, process.env.FAKE_DOCKER_REPORT);
  }
}
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(entry) + '\n');
process.exit(status);
`;

/**
 * Where Playwright keeps its browsers (the CLI runs with a different HOME, as in the
 * action, so it must be told). Resolved by Playwright itself, so it works on macOS too;
 * null when Chromium is not installed (the real-browser tests are then skipped).
 */
function playwrightBrowsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') return process.env.PLAYWRIGHT_BROWSERS_PATH;
  let exe;
  try {
    exe = chromium.executablePath();
  } catch {
    return null;
  }
  if (!exe || !fs.existsSync(exe)) return null;
  for (let dir = path.dirname(exe); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (/^chromium(_headless_shell)?-\d+$/.test(path.basename(dir))) return path.dirname(dir);
  }
  return null;
}
const HOST_BROWSERS = playwrightBrowsersPath();
if (!HOST_BROWSERS) console.warn('[action.test.js] Playwright Chromium not found: skipping the real-browser action tests (run `npx playwright install chromium`).');

function exec(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

const readOutputs = (file) => Object.fromEntries(
  (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split('\n').filter(Boolean).map((line) => {
    const eq = line.indexOf('=');
    return [line.slice(0, eq), line.slice(eq + 1)];
  })
);

/** A throwaway runner: workspace, RUNNER_TEMP (with the runner's command files), fake docker on PATH. Never the repository's storage/. */
function createRunner() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-action-'));
  // The fake docker parses "-v host:container" like docker: a ':' in a path would break it.
  expect(root, 'temp paths must not contain ":"').not.toContain(':');
  const commands = path.join(root, 'runner-temp', '_runner_file_commands');
  const runner = {
    root,
    workspace: path.join(root, 'workspace'),
    temp: path.join(root, 'runner-temp'),
    bin: path.join(root, 'bin'),
    home: path.join(root, 'container-home'),
    dockerLog: path.join(root, 'docker.log'),
    stepSummary: path.join(commands, 'step_summary_1'),
    githubEnv: path.join(commands, 'set_env_1'),
    steps: {},
    uploads: [],
    dockerCalls: () => (fs.existsSync(runner.dockerLog) ? fs.readFileSync(runner.dockerLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
  for (const dir of [runner.workspace, commands, runner.bin, runner.home]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(runner.bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(runner.stepSummary, '');
  fs.writeFileSync(runner.githubEnv, '');
  return runner;
}

function contextFor(runner, inputs) {
  const withDefaults = {};
  for (const [name, def] of Object.entries(action.inputs)) withDefaults[name] = inputs[name] ?? def.default ?? '';
  const stepsCtx = {};
  for (const [id, { __outcome, ...outputs }] of Object.entries(runner.steps)) stepsCtx[id] = { outputs, outcome: __outcome, conclusion: __outcome };
  // __event: the triggering event (github.event_name); push unless a test says otherwise.
  return { inputs: withDefaults, steps: stepsCtx, runner: { os: inputs.__os || 'Linux', temp: runner.temp }, github: { action_path: REPO, event_name: inputs.__event || 'push' } };
}

/** Base environment of a step on the runner (what GitHub sets), plus the step's own env: from action.yml. */
function stepEnv(runner, step, inputs, extra = {}) {
  const env = {
    PATH: `${runner.bin}${path.delimiter}${process.env.PATH}`,
    HOME: process.env.HOME,
    GITHUB_WORKSPACE: runner.workspace,
    RUNNER_TEMP: runner.temp,
    GITHUB_ACTION_PATH: REPO,
    GITHUB_ACTIONS: 'true',
    GITHUB_RUN_ID: '4242',
    GITHUB_RUN_ATTEMPT: '3',
    GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
    GITHUB_REF_NAME: '17/merge',
    GITHUB_HEAD_REF: 'feat/branch',
    GITHUB_STEP_SUMMARY: runner.stepSummary,
    GITHUB_ENV: runner.githubEnv,
    FAKE_DOCKER_LOG: runner.dockerLog,
    FAKE_DOCKER_APP: REPO,
    FAKE_DOCKER_HOME: runner.home,
    FAKE_DOCKER_BROWSERS: HOST_BROWSERS || '',
    ...extra
  };
  const ctx = contextFor(runner, inputs);
  for (const [key, value] of Object.entries(step.env || {})) env[key] = interpolate(value, ctx);
  return env;
}

/** Runs one bash step like GitHub does (bash --noprofile --norc -eo pipefail) and records its outputs. */
async function runBashStep(runner, step, inputs = {}, extra = {}) {
  const script = path.join(runner.root, `step-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(script, step.run);
  const output = path.join(runner.root, `output-${Math.random().toString(36).slice(2)}`);
  const env = { ...stepEnv(runner, step, inputs, extra), GITHUB_OUTPUT: output };
  const result = await exec('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], { cwd: runner.workspace, env });
  const outputs = readOutputs(output);
  if (step.id) runner.steps[step.id] = { ...outputs, __outcome: result.code === 0 ? 'success' : 'failure' };
  return { ...result, outputs };
}

/**
 * Runs the github-script step's script the way actions/github-script does: as the
 * body of an AsyncFunction(require, core, github, context, ...), in a separate Node
 * process, with the step's env. GITHUB_ACTION_PATH points at github-script's own
 * folder there, as on GitHub. `artifacts` is what listing the run's artifacts returns
 * (null: the token lacks actions: read, as with permissions: contents: read).
 */
async function runParseStep(runner, inputs = {}, { artifacts = null } = {}) {
  const step = stepById('parse');
  const harness = path.join(runner.root, 'github-script-harness.cjs');
  const body = path.join(runner.root, 'github-script-body.js');
  fs.writeFileSync(body, step.with.script);
  fs.writeFileSync(harness, `
    const fs = require('fs');
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const outputs = {}; const annotations = []; const listed = [];
    const core = {
      setOutput: (k, v) => { outputs[k] = String(v); },
      error: (m) => annotations.push(['error', String(m)]),
      warning: (m) => annotations.push(['warning', String(m)]),
      info: () => {}
    };
    const artifacts = process.env.HARNESS_ARTIFACTS ? JSON.parse(process.env.HARNESS_ARTIFACTS) : null;
    const github = { rest: { actions: { listWorkflowRunArtifacts: async (params) => {
      listed.push(params);
      if (!artifacts) { const e = new Error('Resource not accessible by integration'); e.status = 403; throw e; }
      return { data: { total_count: artifacts.length, artifacts } };
    } } } };
    const context = { runId: Number(process.env.GITHUB_RUN_ID), repo: { owner: 'o', repo: 'r' } };
    new AsyncFunction('require', 'core', 'github', 'context', fs.readFileSync(process.argv[2], 'utf8'))(require, core, github, context)
      .then(() => process.stdout.write(JSON.stringify({ outputs, annotations, listed })), (e) => { console.error(e); process.exit(1); });
  `);
  const env = stepEnv(runner, step, inputs, {
    GITHUB_ACTION_PATH: path.join(runner.root, 'not-this-action'),
    ...(artifacts ? { HARNESS_ARTIFACTS: JSON.stringify(artifacts) } : {})
  });
  const result = await exec(process.execPath, [harness, body], { cwd: runner.workspace, env });
  if (result.code !== 0) throw new Error(`github-script step failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  runner.steps.parse = { ...parsed.outputs, __outcome: 'success' };
  return { code: 0, ...parsed };
}

/**
 * Runs the comment step's script the way github-script does (like runParseStep), with
 * a fake Octokit (issues.listComments / createComment / updateComment, paginate) and a
 * pull_request context. `comments`: what listing returns; `commentError`: { status,
 * message } thrown by every issues call (403: the token lacks pull-requests: write);
 * `headRepo`: the PR head's repository (o/r is this one; anything else is a fork);
 * `crash`: the github-script process itself fails (continue-on-error must absorb it).
 */
async function runCommentStep(runner, inputs = {}, { comments = [], commentError = null, headRepo = 'o/r', crash = false } = {}) {
  const step = stepById('comment');
  const harness = path.join(runner.root, 'github-script-comment-harness.cjs');
  const body = path.join(runner.root, 'github-script-comment-body.js');
  fs.writeFileSync(body, step.with.script);
  fs.writeFileSync(harness, `
    const fs = require('fs');
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const opts = JSON.parse(process.env.HARNESS_COMMENT);
    if (opts.crash) process.exit(1);
    const outputs = {}; const annotations = []; const calls = { list: [], create: [], update: [] };
    const core = {
      setOutput: (k, v) => { outputs[k] = String(v); },
      error: (m) => annotations.push(['error', String(m)]),
      warning: (m) => annotations.push(['warning', String(m)]),
      notice: (m) => annotations.push(['notice', String(m)]),
      info: () => {}
    };
    const fail = () => { if (opts.commentError) { const e = new Error(opts.commentError.message); e.status = opts.commentError.status; throw e; } };
    const github = {
      paginate: async (fn, params) => (await fn(params)).data,
      rest: { issues: {
        listComments: async (p) => { calls.list.push(p); fail(); return { data: opts.comments }; },
        createComment: async (p) => { calls.create.push(p); fail(); return { data: { id: 777, html_url: 'https://github.com/o/r/pull/17#issuecomment-777' } }; },
        updateComment: async (p) => { calls.update.push(p); fail(); return { data: { id: p.comment_id, html_url: 'https://github.com/o/r/pull/17#issuecomment-' + p.comment_id } }; }
      } }
    };
    const pr = { number: 17, head: { sha: 'feedfacefeedfacefeedfacefeedfacefeedface', repo: { full_name: opts.headRepo } } };
    const context = {
      eventName: process.env.HARNESS_EVENT, serverUrl: 'https://github.com', runId: Number(process.env.GITHUB_RUN_ID),
      repo: { owner: 'o', repo: 'r' }, payload: process.env.HARNESS_EVENT.startsWith('pull_request') ? { pull_request: pr } : {}
    };
    new AsyncFunction('require', 'core', 'github', 'context', fs.readFileSync(process.argv[2], 'utf8'))(require, core, github, context)
      .then(() => process.stdout.write(JSON.stringify({ outputs, annotations, calls })), (e) => { console.error(e); process.exit(1); });
  `);
  const ctx = contextFor(runner, inputs);
  const env = stepEnv(runner, step, inputs, {
    GITHUB_ACTION_PATH: path.join(runner.root, 'not-this-action'),
    HARNESS_EVENT: ctx.github.event_name,
    HARNESS_COMMENT: JSON.stringify({ comments, commentError, headRepo, crash })
  });
  const result = await exec(process.execPath, [harness, body], { cwd: runner.workspace, env });
  if (result.code !== 0) {
    runner.steps.comment = { __outcome: 'failure' };
    return { code: result.code, outputs: {}, annotations: [], calls: null, stderr: result.stderr };
  }
  const parsed = JSON.parse(result.stdout);
  runner.steps.comment = { ...parsed.outputs, __outcome: 'success' };
  return { code: 0, ...parsed, token: interpolate(step.with['github-token'], ctx) };
}

/**
 * The upload step, faked: records its evaluated `with:` and, like upload-artifact with
 * if-no-files-found: error, fails when the path holds no file. `mode: 'fail'` makes it
 * fail like a name collision (409 Conflict) does.
 */
function runUploadStep(runner, inputs, { mode = 'success' } = {}) {
  const step = stepById('upload');
  const ctx = contextFor(runner, inputs);
  const withValues = Object.fromEntries(Object.entries(step.with).map(([k, v]) => [k, interpolate(v, ctx)]));
  runner.uploads.push(withValues);
  const hasFiles = fs.existsSync(withValues.path) && fs.readdirSync(withValues.path, { recursive: true }).length > 0;
  if (mode === 'fail' || !hasFiles) {
    runner.steps.upload = { __outcome: 'failure' };
    return { code: 1, outputs: {} };
  }
  const outputs = { 'artifact-id': '9001', 'artifact-url': 'https://github.com/o/r/actions/runs/4242/artifacts/9001' };
  runner.steps.upload = { ...outputs, __outcome: 'success' };
  return { code: 0, outputs };
}

/**
 * Runs the composite action as the runner does: every step in order, each one only if
 * its real `if:` says so (a failed step fails the action, and later steps then need a
 * status function such as !cancelled()), then evaluates the action's outputs.
 */
async function runAction(runner, inputs, { env = {}, upload = {}, artifacts = null, comment = {} } = {}) {
  runner.steps = {};
  const status = { failed: false };
  const ran = [];
  const results = {};
  for (const step of steps) {
    const key = step.id || step.name;
    if (!shouldRunStep(step.if, contextFor(runner, inputs), status)) {
      if (step.id) runner.steps[step.id] = { __outcome: 'skipped' };
      continue;
    }
    ran.push(key);
    let result;
    if (step.run) result = await runBashStep(runner, step, inputs, env);
    else if (step.id === 'comment') result = await runCommentStep(runner, inputs, comment);
    else if (step.uses.startsWith('actions/github-script@')) result = await runParseStep(runner, inputs, { artifacts });
    else if (step.uses.startsWith('actions/upload-artifact@')) result = runUploadStep(runner, inputs, upload);
    else throw new Error(`unexpected step ${step.uses}`);
    if (result.code !== 0 && step['continue-on-error'] !== true) status.failed = true;
    results[key] = result;
  }
  const ctx = contextFor(runner, inputs);
  const outputs = Object.fromEntries(Object.entries(action.outputs).map(([name, o]) => [name, interpolate(o.value, ctx)]));
  return { ran, results, outputs, failed: status.failed };
}

const cannedReport = (overrides = {}) => JSON.stringify({
  schema: 'visual-ci-result',
  version: 1,
  status: 'passed',
  exit_code: 0,
  error: null,
  run: { id: 'gh-4242-3', run_dir: 'storage/runs/gh-4242-3', manifest: null, summary: null },
  counts: { total: 1, passed: 1, changed: 0, missing_baseline: 0, new_baseline: 0 },
  snapshots: [],
  ...overrides
});

describe('action steps (bash, with a fake docker)', { timeout: 60000 }, () => {
  let runner;
  beforeEach(() => { runner = createRunner(); });
  afterEach(() => runner.cleanup());

  describe('runner check', () => {
    it('passes on Linux and fails elsewhere with a clear error', async () => {
      const step = stepById('runner');
      expect((await runBashStep(runner, step, { __os: 'Linux' })).code).toBe(0);
      const mac = await runBashStep(runner, step, { __os: 'macOS' });
      expect(mac.code).toBe(1);
      expect(mac.stdout).toContain('::error title=visual-ci::This action needs a Linux runner');
    });
  });

  describe('input validation', () => {
    const validate = (inputs, extra) => runBashStep(runner, stepById('validate'), { 'base-url': 'http://127.0.0.1:3000', ...inputs }, extra);

    it('accepts the defaults and derives the run id from the run id and attempt', async () => {
      const r = await validate({});
      expect(r.code, r.stdout).toBe(0);
      expect(r.outputs).toEqual({ 'run-id': 'gh-4242-3', 'working-directory': '.' });
    });

    it('accepts every valid value', async () => {
      fs.mkdirSync(path.join(runner.workspace, 'apps', 'web site'), { recursive: true });
      const r = await validate({
        'base-url': 'https://user:pass@preview.example.com/app?token=x',
        config: 'config/visual.json',
        'working-directory': 'apps/web site',
        strict: 'false',
        'update-baselines': 'true',
        'run-id': 'nightly_2026-11-25',
        'wait-on': 'http://localhost:3000/health',
        'wait-timeout': '120',
        'artifact-name': 'visual diffs web',
        'upload-artifact': 'always',
        'retention-days': '90',
        image: 'ghcr.io/owner/visual-ci:1.0.0',
        comment: 'false',
        'comment-id': 'chrome_1.2-' + 'x'.repeat(53)
      });
      expect(r.code, r.stdout).toBe(0);
      expect(r.outputs).toEqual({ 'run-id': 'nightly_2026-11-25', 'working-directory': 'apps/web site' });
    });

    it.each([
      ['base-url missing', { 'base-url': '' }, 'base-url is required.'],
      ['base-url not http', { 'base-url': 'file:///etc/passwd' }, 'base-url must be an http:// or https:// URL'],
      ['base-url with a space', { 'base-url': 'http://a b' }, 'base-url must be an http:// or https:// URL'],
      ['base-url with a newline', { 'base-url': 'http://a\n::set-output name=x::y' }, 'base-url must be an http:// or https:// URL'],
      ['config empty', { config: '' }, "config must be a path inside working-directory (relative, no '..')."],
      ['config absolute', { config: '/etc/visual.json' }, 'config must be a path inside working-directory'],
      ['config climbing out with ..', { config: '../other/visual.config.json' }, 'config must be a path inside working-directory'],
      ['config with .. in the middle', { config: 'a/../../b.json' }, 'config must be a path inside working-directory'],
      ['working-directory absolute', { 'working-directory': '/home/runner' }, 'working-directory must be a folder inside the repository'],
      ['working-directory with ..', { 'working-directory': 'a/../../b' }, 'working-directory must be a folder inside the repository'],
      ['working-directory ..', { 'working-directory': '..' }, 'working-directory must be a folder inside the repository'],
      ['working-directory with $()', { 'working-directory': '$(id)' }, 'working-directory must be a folder inside the repository'],
      ['working-directory missing', { 'working-directory': 'nope' }, 'working-directory does not exist'],
      ['strict not a boolean', { strict: 'yes' }, 'strict must be true or false.'],
      ['strict capitalised', { strict: 'True' }, 'strict must be true or false.'],
      ['update-baselines not a boolean', { 'update-baselines': '1' }, 'update-baselines must be true or false.'],
      ['upload-artifact unknown', { 'upload-artifact': 'failure' }, 'upload-artifact must be on-failure, always or never.'],
      ['run-id with a slash', { 'run-id': '../x' }, "run-id may only contain letters, digits, '-' and '_'"],
      ['run-id with a command', { 'run-id': 'x$(touch pwned)' }, 'run-id may only contain'],
      ['run-id too long', { 'run-id': 'a'.repeat(129) }, 'run-id may only contain'],
      ['wait-on not http', { 'wait-on': 'localhost:3000' }, 'wait-on must be an http:// or https:// URL'],
      ['wait-timeout not a number', { 'wait-timeout': '1m' }, 'wait-timeout must be a whole number'],
      ['wait-timeout zero', { 'wait-timeout': '0' }, 'wait-timeout must be a whole number'],
      ['wait-timeout negative', { 'wait-timeout': '-5' }, 'wait-timeout must be a whole number'],
      ['wait-timeout decimal', { 'wait-timeout': '1.5' }, 'wait-timeout must be a whole number'],
      ['artifact-name empty', { 'artifact-name': '' }, 'artifact-name may only contain'],
      ['artifact-name with a slash', { 'artifact-name': 'a/b' }, 'artifact-name may only contain'],
      ['retention-days too high', { 'retention-days': '91' }, 'retention-days must be a whole number from 1 to 90'],
      ['retention-days zero', { 'retention-days': '0' }, 'retention-days must be a whole number from 1 to 90'],
      ['image starting with a dash', { image: '--help' }, 'image must be an image reference'],
      ['image with a space', { image: 'a b' }, 'image must be an image reference'],
      ['comment not a boolean', { comment: 'yes' }, 'comment must be true or false.'],
      ['comment-id empty', { 'comment-id': '' }, "comment-id may only contain letters, digits, '.', '_' and '-' (at most 64)."],
      ['comment-id with a space', { 'comment-id': 'a b' }, 'comment-id may only contain'],
      ['comment-id closing the HTML comment', { 'comment-id': 'x-->' }, 'comment-id may only contain'],
      ['comment-id too long', { 'comment-id': 'a'.repeat(65) }, 'comment-id may only contain']
    ])('refuses %s', async (_label, inputs, message) => {
      const r = await validate(inputs);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`::error title=visual-ci::${message}`);
      expect(r.outputs).toEqual({}); // nothing half-validated reaches later steps
    });

    it('accepts a config path with dots that is not ..', async () => {
      const r = await validate({ config: 'config/..visual.json' });
      expect(r.code, r.stdout).toBe(0);
    });

    it('reports every problem at once', async () => {
      const r = await validate({ strict: 'x', 'upload-artifact': 'x', 'wait-timeout': 'x' });
      expect(r.code).toBe(1);
      expect(r.stdout.match(/::error/g)).toHaveLength(3);
    });

    it('its error messages never repeat an input value', async () => {
      const r = await validate({ 'base-url': 'https://user:s3cret@host/ x', 'run-id': '::stop-commands::tok' });
      expect(r.code).toBe(1);
      expect(r.stdout + r.stderr).not.toContain('s3cret');
      expect(r.stdout + r.stderr).not.toContain('stop-commands');
    });

    it('treats input values as data: shell syntax is never executed', async () => {
      const marker = path.join(runner.root, 'pwned');
      const r = await validate({ 'base-url': `http://h/$(touch${'${IFS}'}${marker})`, config: `$(touch ${marker}).json`, 'run-id': '' });
      expect(r.code, r.stdout).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  describe('wait-on', () => {
    let server;
    let url;
    beforeAll(async () => {
      server = http.createServer((req, res) => { res.writeHead(req.url === '/missing' ? 404 : 200); res.end('ok'); });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(() => new Promise((resolve) => server.close(resolve)));
    const wait = (inputs) => runBashStep(runner, stepById('wait'), inputs);

    it('returns as soon as the app answers', async () => {
      const r = await wait({ 'wait-on': `${url}/`, 'wait-timeout': '10' });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain('wait-on: the app is answering.');
    });

    it('fails with a clear error when the app never answers successfully', async () => {
      const started = Date.now();
      const r = await wait({ 'wait-on': `${url}/missing`, 'wait-timeout': '2' });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('::error title=visual-ci::wait-on: the app did not answer within 2s.');
      expect(Date.now() - started).toBeLessThan(15000);
    });

    it('keeps polling until an app that starts late is up', async () => {
      const probe = net.createServer();
      await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const port = probe.address().port;
      await new Promise((resolve) => probe.close(resolve));
      const late = http.createServer((req, res) => res.end('ok'));
      const timer = setTimeout(() => late.listen(port, '127.0.0.1'), 1500);
      try {
        const r = await wait({ 'wait-on': `http://127.0.0.1:${port}/`, 'wait-timeout': '20' });
        expect(r.code, r.stdout).toBe(0);
      } finally {
        clearTimeout(timer);
        await new Promise((resolve) => (late.listening ? late.close(resolve) : resolve()));
      }
    });
  });

  describe('image', () => {
    it('builds the Dockerfile in the action folder when no image is given', async () => {
      const r = await runBashStep(runner, stepById('image'), {});
      expect(r.code).toBe(0);
      expect(r.outputs).toEqual({ ref: 'visual-ci-action:local' });
      expect(runner.dockerCalls().map((c) => c.args)).toEqual([['build', '-t', 'visual-ci-action:local', REPO]]);
    });

    it('pulls a prebuilt image instead', async () => {
      const r = await runBashStep(runner, stepById('image'), { image: 'ghcr.io/owner/visual-ci:1.2.3' });
      expect(r.code).toBe(0);
      expect(r.outputs).toEqual({ ref: 'ghcr.io/owner/visual-ci:1.2.3' });
      expect(runner.dockerCalls().map((c) => c.args)).toEqual([['pull', 'ghcr.io/owner/visual-ci:1.2.3']]);
    });

    it('fails the step when the build fails', async () => {
      const r = await runBashStep(runner, stepById('image'), {}, { FAKE_DOCKER_EXIT: '1' });
      expect(r.code).toBe(1);
      expect(r.outputs).toEqual({});
    });
  });

  describe('docker run', () => {
    const inputs = { 'base-url': 'http://127.0.0.1:3000/?token=abc' };
    async function runStep(extraInputs = {}, extraEnv = {}) {
      fs.mkdirSync(path.join(runner.workspace, 'site'), { recursive: true });
      runner.steps.image = { ref: 'visual-ci-action:local', __outcome: 'success' };
      const all = { ...inputs, 'working-directory': 'site', ...extraInputs };
      const v = await runBashStep(runner, stepById('validate'), all);
      expect(v.code, v.stdout).toBe(0);
      return runBashStep(runner, stepById('run'), all, extraEnv);
    }

    it('runs the CLI in the image with the designed flags, mounts and env', async () => {
      const r = await runStep();
      expect(r.code, r.stderr).toBe(0);
      const [call] = runner.dockerCalls();
      expect(call.flags).toEqual(['--rm', '--network host', `--user ${process.getuid()}:${process.getgid()}`]);
      expect(call.envs).toEqual([
        'HOME=/tmp', 'CI=true', 'GITHUB_ACTIONS', 'GITHUB_SHA', 'GITHUB_REF_NAME', 'GITHUB_HEAD_REF',
        'GITHUB_STEP_SUMMARY=/github/step-summary.md'
      ]);
      expect(call.mounts).toEqual([
        `${runner.stepSummary}:/github/step-summary.md`,
        `${runner.workspace}:/github/workspace`,
        `${path.join(runner.temp, 'visual-ci')}:/visual-ci-temp`
      ]);
      expect(call.workdir).toBe('/github/workspace/site');
      expect(call.image).toBe('visual-ci-action:local');
      expect(call.command).toEqual([
        'node', '/app/src/cli/index.js', 'test',
        '--json=/visual-ci-temp/visual-ci-gh-4242-3.json',
        '--config=visual.config.json',
        '--base-url=http://127.0.0.1:3000/?token=abc',
        '--run-id=gh-4242-3',
        '--strict'
      ]);
    });

    it("mounts nothing of RUNNER_TEMP but its own folder and the step summary (never GITHUB_ENV or the runner's command files)", async () => {
      await runStep();
      const [call] = runner.dockerCalls();
      const hostPaths = call.mounts.map((m) => m.split(':')[0]);
      for (const host of hostPaths) {
        const rel = path.relative(runner.temp, host);
        if (rel.startsWith('..')) continue; // outside RUNNER_TEMP (the workspace)
        expect([path.join('visual-ci'), path.join('_runner_file_commands', 'step_summary_1')]).toContain(rel);
      }
      expect(hostPaths).not.toContain(runner.temp);
      expect(hostPaths).not.toContain(path.dirname(runner.githubEnv));
      expect(fs.statSync(path.join(runner.temp, 'visual-ci')).isDirectory()).toBe(true); // created for the mount
    });

    it('passes --no-strict and --update-baselines when asked', async () => {
      await runStep({ strict: 'false', 'update-baselines': 'true', 'run-id': 'r1', config: 'cfg/v.json' });
      const [call] = runner.dockerCalls();
      expect(call.command.slice(3)).toEqual([
        '--json=/visual-ci-temp/visual-ci-r1.json', '--config=cfg/v.json', '--base-url=http://127.0.0.1:3000/?token=abc',
        '--run-id=r1', '--no-strict', '--update-baselines'
      ]);
    });

    it('does not mount a step summary that does not exist', async () => {
      await runStep({}, { GITHUB_STEP_SUMMARY: '' });
      const [call] = runner.dockerCalls();
      expect(call.envs).not.toContain('GITHUB_STEP_SUMMARY=/github/step-summary.md');
      expect(call.mounts.some((m) => m.endsWith(':/github/step-summary.md'))).toBe(false);
    });

    it('removes a stale report before the run, so an old result is never read', async () => {
      fs.mkdirSync(path.join(runner.temp, 'visual-ci'));
      fs.writeFileSync(path.join(runner.temp, 'visual-ci', 'visual-ci-gh-4242-3.json'), '{"stale":true}');
      await runStep();
      expect(runner.dockerCalls()[0].reportExisted).toBe(false);
    });

    it.each([0, 1, 2, 125, 137])('records exit code %i and never fails the step itself', async (code) => {
      const r = await runStep({}, { FAKE_DOCKER_EXIT: String(code) });
      expect(r.code).toBe(0);
      expect(r.outputs).toEqual({ 'exit-code': String(code) });
    });

    it('passes shell syntax in inputs to the container as plain text', async () => {
      const marker = path.join(runner.root, 'pwned');
      await runStep({ 'base-url': `http://h/$(touch${'${IFS}'}${marker})`, config: `a;touch ${marker}` });
      expect(fs.existsSync(marker)).toBe(false);
      const [call] = runner.dockerCalls();
      expect(call.command).toContain(`--base-url=http://h/$(touch${'${IFS}'}${marker})`);
      expect(call.command).toContain(`--config=a;touch ${marker}`);
    });
  });

  describe('outcome (always runs)', () => {
    const outcome = async ({ status, code, artifactId }) => {
      runner.steps.parse = { status, 'exit-code': code, __outcome: 'success' };
      runner.steps.upload = artifactId === undefined ? { __outcome: 'skipped' } : { 'artifact-id': artifactId, __outcome: 'success' };
      return runBashStep(runner, stepById('outcome'), { 'artifact-name': 'diffs' });
    };

    it.each([
      ['passed', '0'], ['failed', '1'], ['error', '2']
    ])('passes a consistent result on (%s, %s)', async (status, code) => {
      const r = await outcome({ status, code });
      expect(r.code).toBe(0);
      expect(r.outputs).toEqual({ status, 'exit-code': code, 'artifact-name': '' });
    });

    it.each([
      ['nothing (visual-ci never ran)', undefined, undefined],
      ['an inconsistent pair', 'passed', '1'],
      ['an unknown status', 'great', '0']
    ])('turns %s into error / 2', async (_label, status, code) => {
      const r = await outcome({ status, code });
      expect(r.outputs).toEqual({ status: 'error', 'exit-code': '2', 'artifact-name': '' });
    });

    it('names the artifact only when the upload produced one', async () => {
      expect((await outcome({ status: 'failed', code: '1', artifactId: '9001' })).outputs['artifact-name']).toBe('diffs');
      expect((await outcome({ status: 'failed', code: '1', artifactId: '' })).outputs['artifact-name']).toBe('');
      expect((await outcome({ status: 'failed', code: '1' })).outputs['artifact-name']).toBe('');
    });
  });

  describe('result (last step)', () => {
    // parsed: null means the parse step was skipped (visual-ci never ran).
    const finish = (exitCode, { changed = '0', parsed = exitCode, upload = 'skipped' } = {}) => {
      runner.steps.outcome = { 'exit-code': exitCode, __outcome: 'success' };
      runner.steps.parse = parsed === null ? { __outcome: 'skipped' } : { 'exit-code': parsed, changed, __outcome: 'success' };
      runner.steps.upload = { __outcome: upload };
      return runBashStep(runner, stepByName('Set the result'), {});
    };

    it('passes on 0', async () => {
      const r = await finish('0');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('visual-ci: passed.');
    });

    it('fails with 1 on visual differences', async () => {
      const r = await finish('1', { changed: '3' });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('::error title=visual-ci::Visual differences found (3 changed snapshot(s)');
    });

    it('fails with 2 on an error', async () => {
      const r = await finish('2');
      expect(r.code).toBe(2);
      expect(r.stdout).toContain('visual-ci failed with an error (exit code 2)');
    });

    it('fails with 2 when visual-ci never ran (runner check or validation failed)', async () => {
      const r = await finish('2', { parsed: null });
      expect(r.code).toBe(2);
      expect(r.stdout).toContain('::error title=visual-ci::visual-ci did not run');
    });

    it('a failed upload fails even a passing run, with a message about unique artifact names', async () => {
      const r = await finish('0', { upload: 'failure' });
      expect(r.code).toBe(2);
      expect(r.stdout).toContain('Artifact names must be unique within a workflow run');
    });
  });

  describe('parse step (as github-script runs it)', () => {
    it('imports the module from github.action_path and sets every output', async () => {
      runner.steps.validate = { 'run-id': 'gh-4242-3', 'working-directory': '.', __outcome: 'success' };
      runner.steps.run = { 'exit-code': '2', __outcome: 'success' };
      const { outputs, annotations } = await runParseStep(runner, {});
      expect(Object.keys(outputs).sort()).toEqual([...OUTPUT_NAMES].sort());
      expect(outputs).toMatchObject({ status: 'error', 'exit-code': '2', upload: 'false', 'run-id': 'gh-4242-3' });
      expect(annotations[0][0]).toBe('error');
      expect(annotations[0][1]).toContain('wrote no JSON result');
    });

    it('reports an error when visual-ci never ran (e.g. the image build failed)', async () => {
      runner.steps.validate = { 'run-id': 'gh-4242-3', 'working-directory': '.', __outcome: 'success' };
      const { outputs, annotations } = await runParseStep(runner, {});
      expect(outputs).toMatchObject({ status: 'error', 'exit-code': '2' });
      expect(annotations).toEqual([['error', 'visual-ci did not run (no exit code was recorded; see the earlier steps).']]);
    });
  });
});

describe('the whole action, step by step by its if: conditions (canned results)', { timeout: 60000 }, () => {
  let runner;
  beforeEach(() => { runner = createRunner(); });
  afterEach(() => runner.cleanup());

  const runDir = () => path.join(runner.workspace, 'storage', 'runs', 'gh-4242-3');
  const withRunFolder = (files = ['index-desktop.png', 'run.json']) => {
    fs.mkdirSync(runDir(), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(runDir(), f), 'x');
  };
  const go = (inputs = {}, options = {}) => runAction(runner, { 'base-url': 'http://127.0.0.1:3000', ...inputs }, options);
  const ALWAYS = ['outcome', 'Set the result'];

  it('a pass: every step runs except the upload; outputs from the result', async () => {
    withRunFolder();
    const r = await go({}, { env: { FAKE_DOCKER_REPORT: cannedReport() } });
    expect(r.ran).toEqual(['runner', 'validate', 'image', 'run', 'parse', ...ALWAYS]); // no wait-on, no upload
    expect(r.failed).toBe(false);
    expect(r.outputs).toMatchObject({ status: 'passed', 'exit-code': '0', 'artifact-name': '', 'artifact-id': '', 'artifact-url': '' });
  });

  it('a diff: uploads this run folder; the artifact outputs come from the upload', async () => {
    withRunFolder();
    const report = cannedReport({ status: 'failed', exit_code: 1, counts: { total: 1, passed: 0, changed: 1, missing_baseline: 0, new_baseline: 0 } });
    const r = await go({ 'artifact-name': 'diffs-a' }, { env: { FAKE_DOCKER_REPORT: report, FAKE_DOCKER_RUN_EXIT: '1' } });
    expect(r.ran).toContain('upload');
    expect(runner.uploads).toEqual([{ name: 'diffs-a', path: runDir(), 'retention-days': '', 'if-no-files-found': 'error' }]);
    expect(r.outputs).toMatchObject({
      status: 'failed', 'exit-code': '1', changed: '1', 'artifact-name': 'diffs-a', 'artifact-id': '9001',
      'artifact-url': 'https://github.com/o/r/actions/runs/4242/artifacts/9001'
    });
    expect(r.failed).toBe(true);
    expect(r.results['Set the result'].code).toBe(1);
  });

  it('an error with an empty run folder (Scenario A): nothing is uploaded and no artifact is claimed, even with always', async () => {
    fs.mkdirSync(runDir(), { recursive: true });
    const report = cannedReport({ status: 'error', exit_code: 2, error: { code: 'NAVIGATION_FAILED', message: 'no page' }, counts: { total: 0, passed: 0, changed: 0, missing_baseline: 0, new_baseline: 0 } });
    const r = await go({ 'upload-artifact': 'always' }, { env: { FAKE_DOCKER_REPORT: report, FAKE_DOCKER_RUN_EXIT: '2' } });
    expect(r.ran).not.toContain('upload');
    expect(runner.uploads).toEqual([]);
    expect(r.outputs).toMatchObject({ status: 'error', 'exit-code': '2', 'artifact-name': '', 'artifact-id': '', 'artifact-url': '' });
    expect(r.results.parse.annotations).toContainEqual(['warning', 'The run folder is empty (visual-ci stopped before the first screenshot), so there is nothing to upload.']);
  });

  it('an artifact-name collision fails the upload (and the action) clearly, even on a pass', async () => {
    withRunFolder();
    const r = await go({ 'upload-artifact': 'always' }, {
      env: { FAKE_DOCKER_REPORT: cannedReport() },
      upload: { mode: 'fail' },
      artifacts: [{ name: 'visual-regression-diffs', expired: false }]
    });
    expect(r.results.parse.annotations.some(([kind, m]) => kind === 'warning' && m.includes('already exists in this workflow run'))).toBe(true);
    expect(r.results.parse.listed).toEqual([{ owner: 'o', repo: 'r', run_id: 4242, name: 'visual-regression-diffs', per_page: 100 }]);
    expect(r.ran).toContain('upload');
    expect(r.failed).toBe(true);
    expect(r.outputs).toMatchObject({ status: 'passed', 'exit-code': '0', 'artifact-name': '', 'artifact-id': '' });
    expect(r.results['Set the result'].code).toBe(2);
    expect(r.results['Set the result'].stdout).toContain('Artifact names must be unique within a workflow run');
  });

  it.each([
    ['input validation fails', { strict: 'maybe' }, ['runner', 'validate']],
    ['the runner is not Linux', { __os: 'Windows' }, ['runner']]
  ])('when %s, status and exit-code are still set (error, 2) and the action fails', async (_label, inputs, before) => {
    const r = await go(inputs);
    expect(r.ran).toEqual([...before, ...ALWAYS]);
    expect(r.failed).toBe(true);
    expect(r.outputs.status).toBe('error');
    expect(r.outputs['exit-code']).toBe('2');
    expect(r.outputs['artifact-name']).toBe('');
    expect(r.results['Set the result'].code).toBe(2);
    expect(runner.dockerCalls()).toEqual([]);
  });

  it('when the image build fails, visual-ci never runs; the result step still reports error / 2', async () => {
    const r = await go({}, { env: { FAKE_DOCKER_EXIT: '1' } });
    expect(r.ran).toEqual(['runner', 'validate', 'image', 'parse', ...ALWAYS]);
    expect(r.outputs).toMatchObject({ status: 'error', 'exit-code': '2' });
    expect(r.failed).toBe(true);
  });

  it('the image is prepared before wait-on; a wait-on timeout stops the action before docker run', async () => {
    const r = await go({ 'wait-on': 'http://127.0.0.1:9/', 'wait-timeout': '1' });
    expect(r.ran).toEqual(['runner', 'validate', 'image', 'wait', 'parse', ...ALWAYS]);
    expect(runner.dockerCalls().map((c) => c.args[0])).toEqual(['build']);
    expect(r.outputs).toMatchObject({ status: 'error', 'exit-code': '2' });
    expect(r.failed).toBe(true);
  });
});

describe('the pull request comment, step by step (canned results)', { timeout: 60000 }, () => {
  let runner;
  beforeEach(() => { runner = createRunner(); });
  afterEach(() => runner.cleanup());

  const runDir = () => path.join(runner.workspace, 'storage', 'runs', 'gh-4242-3');
  const withRunFolder = () => {
    fs.mkdirSync(runDir(), { recursive: true });
    for (const f of ['index-desktop.png', 'run.json']) fs.writeFileSync(path.join(runDir(), f), 'x');
  };
  const diffReport = () => cannedReport({
    status: 'failed',
    exit_code: 1,
    counts: { total: 2, passed: 1, changed: 1, missing_baseline: 0, new_baseline: 0 },
    snapshots: [
      { route: '/', viewport: 'desktop', status: 'MATCH', mismatch_percentage: 0 },
      { route: '/pri`ci|ng', viewport: 'mobile', status: 'DIFF', mismatch_percentage: 4.4444 }
    ]
  });
  const DIFF_ENV = () => ({ FAKE_DOCKER_REPORT: diffReport(), FAKE_DOCKER_RUN_EXIT: '1' });
  const go = (inputs = {}, options = {}) => runAction(runner, { 'base-url': 'http://127.0.0.1:3000', __event: 'pull_request', ...inputs }, options);
  const BOT = { login: 'github-actions[bot]', type: 'Bot' };

  it('a diff on a pull request: creates the comment with the table, the artifact, the import snippet and the PR head SHA', async () => {
    withRunFolder();
    const r = await go({}, { env: DIFF_ENV() });
    expect(r.ran).toEqual(['runner', 'validate', 'image', 'run', 'parse', 'upload', 'outcome', 'comment', 'Set the result']);
    const { calls, annotations } = r.results.comment;
    expect(annotations).toEqual([]);
    expect(calls.list).toEqual([{ owner: 'o', repo: 'r', issue_number: 17, per_page: 100 }]);
    expect(calls.create).toHaveLength(1);
    const body = calls.create[0].body;
    expect(body.split('\n')[0]).toBe(stickyMarker('default'));
    expect(body).toContain('### ❌ Visual CI found visual changes');
    expect(body).toContain('| 🔴 Changed | ``/pri`ci\\|ng`` | `mobile` | 4.44% |');
    expect(body).toContain('[Artifact `visual-regression-diffs`](https://github.com/o/r/actions/runs/4242/artifacts/9001)');
    expect(body).toContain("gh run download 4242 -R o/r -n 'visual-regression-diffs' -D vrt-4242 && npx visual-ci import vrt-4242");
    expect(body).toContain('commit `feedfac`'); // the PR head, not GITHUB_SHA (0123456...)
    expect(body).not.toContain('0123456');
    expect(r.outputs).toMatchObject({ 'comment-url': 'https://github.com/o/r/pull/17#issuecomment-777', 'comment-action': 'created', status: 'failed', 'exit-code': '1' });
    expect(r.results['Set the result'].code).toBe(1);
  });

  it('passes the github-token input to github-script', async () => {
    const r = await go({ 'github-token': 'ghs_custom' }, { env: DIFF_ENV() });
    expect(r.results.comment.token).toBe('ghs_custom');
  });

  it('pull_request_target from the same repository comments too', async () => {
    const r = await go({ __event: 'pull_request_target' }, { env: DIFF_ENV() });
    expect(r.ran).toContain('comment');
    expect(r.outputs['comment-action']).toBe('created');
  });

  it('updates the earlier comment of the bot, never the one a person wrote with the marker', async () => {
    const marker = stickyMarker('default');
    const r = await go({}, {
      env: DIFF_ENV(),
      comment: { comments: [
        { id: 5, user: { login: 'mallory', type: 'User' }, body: `${marker}\nmine`, created_at: '2026-11-01T00:00:00Z' },
        { id: 8, user: BOT, body: `${marker}\nold`, created_at: '2026-11-02T00:00:00Z' }
      ] }
    });
    expect(r.results.comment.calls.update.map((c) => c.comment_id)).toEqual([8]);
    expect(r.results.comment.calls.create).toEqual([]);
    expect(r.outputs).toMatchObject({ 'comment-action': 'updated', 'comment-url': 'https://github.com/o/r/pull/17#issuecomment-8' });
  });

  it('a pass with no earlier comment creates none; with one, it is updated to say everything matches', async () => {
    const first = await go({}, { env: { FAKE_DOCKER_REPORT: cannedReport() } });
    expect(first.ran).toContain('comment');
    expect(first.results.comment.calls.create).toEqual([]);
    expect(first.outputs).toMatchObject({ status: 'passed', 'comment-action': 'skipped', 'comment-url': '' });
    expect(first.failed).toBe(false);

    const second = await go({}, { env: { FAKE_DOCKER_REPORT: cannedReport() }, comment: { comments: [{ id: 9, user: BOT, body: `${stickyMarker('default')}\nfailed`, created_at: '2026-11-01T00:00:00Z' }] } });
    expect(second.results.comment.calls.update).toHaveLength(1);
    expect(second.results.comment.calls.update[0].body).toContain('All 1 snapshot match the baselines.');
    expect(second.outputs['comment-action']).toBe('updated');
  });

  it('a comment-id keeps a separate comment (matrix): another id\'s comment is left alone', async () => {
    const r = await go({ 'comment-id': 'firefox' }, {
      env: DIFF_ENV(),
      comment: { comments: [{ id: 3, user: BOT, body: `${stickyMarker('default')}\nchrome`, created_at: '2026-11-01T00:00:00Z' }] }
    });
    expect(r.results.comment.calls.update).toEqual([]);
    expect(r.results.comment.calls.create[0].body.split('\n')[0]).toBe('<!-- visual-ci:sticky id=firefox -->');
    expect(r.results.comment.calls.create[0].body).toContain('(`firefox`)');
  });

  it('a pull request from a fork: a notice, no API call, the result unchanged', async () => {
    const r = await go({}, { env: DIFF_ENV(), comment: { headRepo: 'someone/r' } });
    expect(r.ran).toContain('comment');
    expect(r.results.comment.annotations).toEqual([['notice', expect.stringContaining('from a fork')]]);
    expect(r.results.comment.calls.list).toEqual([]);
    expect(r.outputs).toMatchObject({ 'comment-action': 'skipped', 'comment-url': '', status: 'failed', 'exit-code': '1' });
    expect(r.results['Set the result'].code).toBe(1);
  });

  it.each(['push', 'workflow_dispatch', 'schedule'])('a %s event: the comment step does not run', async (event) => {
    const r = await go({ __event: event }, { env: DIFF_ENV() });
    expect(r.ran).not.toContain('comment');
    expect(r.outputs).toMatchObject({ 'comment-url': '', 'comment-action': '' });
  });

  it('comment: false: the comment step does not run, even on a pull request', async () => {
    const r = await go({ comment: 'false' }, { env: DIFF_ENV() });
    expect(r.ran).not.toContain('comment');
    expect(r.outputs).toMatchObject({ 'comment-url': '', 'comment-action': '', status: 'failed' });
  });

  it.each([
    ['a pass', () => ({ FAKE_DOCKER_REPORT: cannedReport() }), 0, [{ id: 9, user: { login: 'github-actions[bot]', type: 'Bot' }, body: '<!-- visual-ci:sticky id=default -->\nx' }]],
    ['a diff', DIFF_ENV, 1, []]
  ])('403 without pull-requests: write on %s: a warning saying how to fix it; the job result is unchanged', async (_label, env, code, comments) => {
    const r = await go({}, { env: env(), comment: { comments, commentError: { status: 403, message: 'Resource not accessible by integration' } } });
    expect(r.results.comment.annotations).toEqual([['warning', expect.stringContaining('permissions: pull-requests: write')]]);
    expect(r.outputs).toMatchObject({ 'comment-action': 'failed', 'comment-url': '', 'exit-code': String(code) });
    expect(r.failed).toBe(code !== 0);
    expect(r.results['Set the result'].code).toBe(code);
  });

  it('a crashing comment step (github-script itself fails) does not fail a passing action: continue-on-error', async () => {
    const r = await go({}, { env: { FAKE_DOCKER_REPORT: cannedReport() }, comment: { crash: true } });
    expect(r.results.comment.code).toBe(1);
    expect(r.failed).toBe(false);
    expect(r.results['Set the result'].code).toBe(0);
    expect(r.outputs).toMatchObject({ status: 'passed', 'exit-code': '0', 'comment-action': '' });
  });

  it('when visual-ci never ran (invalid input), the comment reports the error', async () => {
    const r = await go({ strict: 'maybe' });
    expect(r.ran).toEqual(['runner', 'validate', 'outcome', 'comment', 'Set the result']);
    const body = r.results.comment.calls.create[0].body;
    expect(body).toContain('### ⚠️ Visual CI failed with an error');
    expect(body).toContain('`NO_RESULT`');
    expect(r.results['Set the result'].code).toBe(2);
  });

  it('an invalid comment-id fails validation, and the comment step only warns', async () => {
    const r = await go({ 'comment-id': 'bad id' });
    expect(r.results.validate.stdout).toContain('comment-id may only contain');
    expect(r.results.comment.annotations).toEqual([['warning', expect.stringContaining('comment-id')]]);
    expect(r.outputs['comment-action']).toBe('skipped');
  });

  it('an error run with a debugging artifact says it cannot be imported', async () => {
    withRunFolder();
    const report = cannedReport({ status: 'error', exit_code: 2, error: { code: 'NAVIGATION_FAILED', message: 'net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3000/b' } });
    const r = await go({}, { env: { FAKE_DOCKER_REPORT: report, FAKE_DOCKER_RUN_EXIT: '2' } });
    const body = r.results.comment.calls.create[0].body;
    expect(body).toContain('`NAVIGATION_FAILED`: `net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3000/b`');
    expect(body).toContain('cannot be imported');
    expect(body).not.toContain('gh run download');
  });
});

// Real Chromium runs: far above vitest's 5 s default on a busy machine.
describe.skipIf(!HOST_BROWSERS)('the whole action against a real page (fake docker runs the real CLI)', { timeout: 120000 }, () => {
  const CONFIG = JSON.stringify({
    baseUrl: 'http://example.invalid', // the base-url input overrides it
    routes: ['/'],
    viewports: [{ name: 'desktop', width: 400, height: 300 }],
    threshold: 0.01
  });
  let site;
  let baseUrl;
  let color = 'white';
  let seedDir;
  let seedBaseline; // the white page's baseline, captured once; each test copies it
  let runner;

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><body style="margin:0;background:${color}"><h1>Action</h1></body>`);
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${site.address().port}`;

    seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-action-seed-'));
    fs.writeFileSync(path.join(seedDir, 'visual.config.json'), CONFIG);
    const env = { PATH: process.env.PATH, HOME: seedDir, PLAYWRIGHT_BROWSERS_PATH: HOST_BROWSERS };
    const seeded = await exec(process.execPath, [path.join(REPO, 'src/cli/index.js'), 'test', '--update-baselines', '-u', baseUrl, '-r', 'seed'], { cwd: seedDir, env });
    expect(seeded.code, seeded.stdout + seeded.stderr).toBe(0);
    seedBaseline = path.join(seedDir, 'storage', 'baselines', 'index-desktop.png');
  });

  afterAll(async () => {
    site.closeAllConnections();
    await new Promise((resolve) => site.close(resolve));
    fs.rmSync(seedDir, { recursive: true, force: true });
  });

  // Every test gets its own runner, workspace, container HOME and committed baseline.
  beforeEach(() => {
    runner = createRunner();
    const app = path.join(runner.workspace, 'app');
    fs.mkdirSync(path.join(app, 'storage', 'baselines'), { recursive: true });
    fs.writeFileSync(path.join(app, 'visual.config.json'), CONFIG);
    fs.copyFileSync(seedBaseline, path.join(app, 'storage', 'baselines', 'index-desktop.png'));
    color = 'white';
  });
  afterEach(() => runner.cleanup());

  const go = (inputs, options = {}) => runAction(runner, { 'base-url': baseUrl, 'wait-on': `${baseUrl}/`, 'working-directory': 'app', ...inputs }, { ...options, env: { FAKE_DOCKER_CLI: '1', ...options.env } });
  const runDir = (id) => path.join(runner.workspace, 'app', 'storage', 'runs', id);

  it('without baselines and strict: false, creates them and passes; nothing is uploaded on success', async () => {
    fs.rmSync(path.join(runner.workspace, 'app', 'storage'), { recursive: true });
    const r = await go({ strict: 'false', 'run-id': 'first' });
    expect(r.results.run.outputs, JSON.stringify(runner.dockerCalls().at(-1))).toEqual({ 'exit-code': '0' });
    expect(r.results.parse.outputs).toEqual({
      status: 'passed',
      'exit-code': '0',
      total: '1',
      changed: '0',
      'new-baselines': '1',
      'run-id': 'first',
      'report-path': path.join(runner.temp, 'visual-ci', 'visual-ci-first.json'),
      'summary-path': path.join(runDir('first'), 'summary.md'),
      'run-dir': runDir('first'),
      upload: 'false',
      'upload-path': ''
    });
    expect(r.failed).toBe(false);
    expect(r.outputs).toMatchObject({ status: 'passed', 'exit-code': '0', 'artifact-name': '', 'artifact-id': '' });
    expect(fs.existsSync(path.join(runner.workspace, 'app', 'storage', 'baselines', 'index-desktop.png'))).toBe(true);
    expect(fs.readFileSync(runner.stepSummary, 'utf8')).toContain('first'); // the step summary reached the runner's file
    expect(fs.readFileSync(runner.githubEnv, 'utf8')).toBe(''); // never touched
  });

  it('an unchanged page passes in strict mode, with the git context from the env', async () => {
    const r = await go({ 'run-id': 'same' });
    expect(r.outputs).toMatchObject({ status: 'passed', 'exit-code': '0', 'new-baselines': '0', 'artifact-id': '' });
    expect(r.failed).toBe(false);
    const result = JSON.parse(fs.readFileSync(r.outputs['report-path'], 'utf8'));
    expect(result.run).toMatchObject({ branch: 'feat/branch', commit_sha: '0123456789abcdef0123456789abcdef01234567', strict: true, run_dir: 'storage/runs/same' });
  });

  it('a changed page fails with 1 and uploads only its own run folder, which imports as a zip', async () => {
    color = 'black';
    const r = await go({ 'run-id': 'changed' });
    expect(r.outputs).toMatchObject({ status: 'failed', 'exit-code': '1', changed: '1', 'artifact-name': 'visual-regression-diffs', 'artifact-id': '9001' });
    expect(runner.uploads.map((u) => u.path)).toEqual([runDir('changed')]);
    expect(r.failed).toBe(true);

    // upload-artifact with a single folder puts its contents at the zip root.
    const zip = path.join(runner.root, 'visual-regression-diffs.zip');
    writeZip(zip, folderEntries(runner.uploads[0].path));
    const storageRoot = path.join(runner.root, 'reviewer-storage');
    fs.mkdirSync(storageRoot);
    try {
      const db = getDb(path.join(storageRoot, 'data.sqlite'));
      const { runs } = await importRuns({ kind: 'zip', file: zip }, { storageRoot, db });
      expect(runs).toEqual([expect.objectContaining({ id: 'changed', status: 'FAILED', snapshots: 1 })]);
    } finally {
      closeDb();
    }
  });

  it('a changed page on a pull request gets a comment built from the real result', async () => {
    color = 'black';
    const r = await go({ 'run-id': 'pr', __event: 'pull_request' });
    expect(r.outputs).toMatchObject({ status: 'failed', 'exit-code': '1', 'comment-action': 'created' });
    const body = r.results.comment.calls.create[0].body;
    expect(body).toContain('1 snapshot: 1 changed, 0 passed.');
    expect(body).toMatch(/^\| 🔴 Changed \| `\/` \| `desktop` \| \d+\.\d\d% \|$/m);
    expect(body).toContain("-n 'visual-regression-diffs' -D vrt-4242 && npx visual-ci import vrt-4242");
    expect(r.results['Set the result'].code).toBe(1);
  });

  it('upload-artifact: always uploads a passing run', async () => {
    const r = await go({ 'run-id': 'always', 'upload-artifact': 'always' });
    expect(r.outputs).toMatchObject({ status: 'passed', 'artifact-name': 'visual-regression-diffs', 'artifact-id': '9001' });
    expect(runner.uploads.map((u) => u.path)).toEqual([runDir('always')]);
    expect(r.failed).toBe(false);
  });

  it('upload-artifact: never uploads nothing, even on failure', async () => {
    color = 'black';
    const r = await go({ 'run-id': 'never', 'upload-artifact': 'never' });
    expect(r.outputs).toMatchObject({ status: 'failed', 'exit-code': '1', 'run-dir': runDir('never'), 'artifact-name': '', 'artifact-id': '' });
    expect(runner.uploads).toEqual([]);
    expect(r.failed).toBe(true);
  });

  it('a missing config is an error: exit 2, status error, nothing to upload', async () => {
    const r = await go({ 'run-id': 'noconfig', config: 'missing.json', 'wait-on': '' });
    expect(r.results.run.outputs).toEqual({ 'exit-code': '2' });
    expect(r.outputs).toMatchObject({ status: 'error', 'exit-code': '2', 'run-dir': '', 'artifact-name': '' });
    expect(r.results.parse.annotations[0][1]).toMatch(/^visual-ci failed: CONFIG_NOT_FOUND: /);
    expect(r.results['Set the result'].code).toBe(2);
  });

  it('a page that cannot load leaves an empty run folder: exit 2, no upload, no artifact outputs', async () => {
    const r = await go({ 'run-id': 'unreachable', 'base-url': 'http://127.0.0.1:9/', 'wait-on': '', 'upload-artifact': 'always' });
    expect(fs.readdirSync(runDir('unreachable'))).toEqual([]); // capture created it before the browser failed
    expect(r.outputs).toMatchObject({ status: 'error', 'exit-code': '2', 'run-dir': runDir('unreachable'), 'artifact-name': '', 'artifact-id': '', 'artifact-url': '' });
    expect(runner.uploads).toEqual([]);
    expect(r.results.parse.annotations[0][1]).toMatch(/^visual-ci failed: NAVIGATION_FAILED: /);
    expect(r.results['Set the result'].code).toBe(2);
  });
});
