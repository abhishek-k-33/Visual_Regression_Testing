import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import YAML from 'yaml';
import { OUTPUT_NAMES } from '../src/ci/actionReport.js';
import { importRuns } from '../src/server/importRuns.js';
import { getDb, closeDb } from '../src/server/db.js';
import { writeZip, folderEntries } from './helpers/zip.js';

/**
 * The GitHub Action (action.yml) and this repository's workflow that uses it.
 * GitHub Actions can't run here, so this checks the files statically and runs each
 * step's bash script with the env action.yml gives it, against a fake `docker` (which
 * can also run the real CLI on the host, translating the container mounts).
 */

const REPO = path.resolve('.');
const action = YAML.parse(fs.readFileSync('action.yml', 'utf8'));
const workflow = YAML.parse(fs.readFileSync('.github/workflows/visual-ci.yml', 'utf8'));
const readme = fs.readFileSync('README.md', 'utf8');
const steps = action.runs.steps;
const stepById = (id) => steps.find((s) => s.id === id);
const stepByName = (name) => steps.find((s) => s.name === name);

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
  image: { required: false, default: '' }
};
const EXPECTED_OUTPUTS = [
  'status', 'exit-code', 'total', 'changed', 'new-baselines', 'run-id', 'report-path',
  'summary-path', 'run-dir', 'artifact-name', 'artifact-id', 'artifact-url'
];
const UPLOAD_ARTIFACT_OUTPUTS = ['artifact-id', 'artifact-url'];

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

  it('leaves the pull request comment inputs to A3', () => {
    for (const name of ['comment', 'comment-id', 'github-token']) expect(action.inputs[name]).toBeUndefined();
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
      if (step.uses?.startsWith('actions/github-script@')) expect(OUTPUT_NAMES).toContain(stepOutput);
      else if (step.uses?.startsWith('actions/upload-artifact@')) expect(UPLOAD_ARTIFACT_OUTPUTS).toContain(stepOutput);
      else expect(step.run).toContain(`${stepOutput}=`);
    }
  });

  it('every steps.<id>.outputs.<name> reference resolves, and every inputs.<name> exists', () => {
    for (const expr of allExpressions(steps)) {
      for (const [, id, out] of expr.matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/g)) {
        const step = stepById(id);
        expect(step, `${expr}: no step ${id}`).toBeDefined();
        const produced = step.uses?.startsWith('actions/github-script@') ? OUTPUT_NAMES
          : step.uses?.startsWith('actions/upload-artifact@') ? UPLOAD_ARTIFACT_OUTPUTS
            : [...step.run.matchAll(/^\s*echo "([\w-]+)=/gm)].map((m) => m[1]);
        expect(produced, expr).toContain(out);
      }
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
    expect(scripts.length).toBeGreaterThanOrEqual(6);
    for (const [name, script] of scripts) {
      expect(script, name).not.toMatch(/\$\{\{/);
    }
    // The workflow's own scripts too.
    for (const job of Object.values(workflow.jobs)) {
      for (const [name, script] of scriptsOf(job.steps)) expect(script, name).not.toMatch(/\$\{\{/);
    }
  });

  it('expressions only appear in env:, with:, if: and output values', () => {
    for (const step of steps) {
      const rest = Object.fromEntries(Object.entries(step).filter(([key]) => !['env', 'with', 'if'].includes(key)));
      expect(allExpressions(rest), step.name).toEqual([]);
    }
  });

  it('pins every action it uses to a major version (or a full SHA)', () => {
    const pinned = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@(v\d+|[0-9a-f]{40})$/;
    const uses = [
      ...steps.filter((s) => s.uses).map((s) => s.uses),
      ...fs.readdirSync('.github/workflows').flatMap((f) => {
        const wf = YAML.parse(fs.readFileSync(path.join('.github/workflows', f), 'utf8'));
        return Object.values(wf.jobs).flatMap((j) => (j.steps || []).filter((s) => s.uses && s.uses !== './').map((s) => s.uses));
      })
    ];
    expect(uses).toContain('actions/github-script@v7');
    expect(uses).toContain('actions/upload-artifact@v4');
    for (const ref of uses) expect(ref).toMatch(pinned);
  });

  it('every run step uses bash', () => {
    for (const step of steps.filter((s) => s.run)) expect(step.shell, step.name).toBe('bash');
  });

  it('runs the steps in the designed order, with the right conditions', () => {
    expect(steps.map((s) => s.id || s.name)).toEqual([
      'Check the runner', 'validate', 'Wait for the app', 'image', 'run', 'parse', 'upload', 'Set the result'
    ]);
    expect(stepByName('Wait for the app').if).toBe("${{ inputs.wait-on != '' }}");
    expect(stepById('parse').if).toBe("${{ !cancelled() && steps.validate.outcome == 'success' }}");
    expect(stepById('upload').if).toBe("${{ !cancelled() && steps.parse.outputs.upload == 'true' }}");
    expect(stepByName('Set the result').if).toBe("${{ !cancelled() && steps.validate.outcome == 'success' }}");
  });

  it('uploads only the run folder the result names, with the chosen name', () => {
    expect(stepById('upload').with).toEqual({
      name: '${{ inputs.artifact-name }}',
      path: '${{ steps.parse.outputs.upload-path }}',
      'retention-days': '${{ inputs.retention-days }}',
      'if-no-files-found': 'warn'
    });
  });

  it('the parse step loads the module from the action folder via github.action_path', () => {
    const parse = stepById('parse');
    expect(parse.env.VISUAL_CI_ACTION_PATH).toBe('${{ github.action_path }}');
    expect(parse.with.script).toContain("path.join(process.env.VISUAL_CI_ACTION_PATH, 'src', 'ci', 'actionReport.js')");
    expect(fs.existsSync(path.join(REPO, 'src/ci/actionReport.js'))).toBe(true);
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
    for (const j of Object.values(workflow.jobs)) expect(j.permissions).toBeUndefined();
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

  it('checks out, starts the demo site, then uses ./ with base-url and wait-on', () => {
    const names = job.steps.map((s) => s.uses || s.name);
    expect(names.indexOf('actions/checkout@v4')).toBeLessThan(names.indexOf('Start Demo Site'));
    expect(names.indexOf('Start Demo Site')).toBeLessThan(names.indexOf('./'));
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

  it.each(Object.keys(EXPECTED_INPUTS))('documents the input %s', (name) => {
    expect(section).toMatch(new RegExp(`^\\| \`${name}\` \\|`, 'm'));
  });

  it.each(EXPECTED_OUTPUTS)('documents the output %s', (name) => {
    expect(section).toMatch(new RegExp(`^\\| \`${name}\` \\|`, 'm'));
  });

  it('documents baselines and limitations', () => {
    expect(section).toMatch(/update-baselines: true/);
    expect(section).toMatch(/Linux/);
    expect(section).toMatch(/fork/i);
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
  const table = mounts.map((m) => { const [host, inside] = m.split(':'); return [inside, host]; });
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
      if (eq === -1) { if (process.env[e] !== undefined) env[e] = process.env[e]; } else env[e.slice(0, eq)] = mapArg(e.slice(eq + 1));
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

// Where Playwright keeps its browsers for this user (the CLI runs with HOME=/tmp, as in the action).
const HOST_BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');

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

/** A throwaway runner: workspace, RUNNER_TEMP, fake docker on PATH. Never touches the repository's storage/. */
function createRunner() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-action-'));
  const runner = {
    root,
    workspace: path.join(root, 'workspace'),
    temp: path.join(root, 'runner-temp'),
    bin: path.join(root, 'bin'),
    dockerLog: path.join(root, 'docker.log'),
    stepSummary: path.join(root, 'runner-temp', 'step_summary'),
    steps: {},
    dockerCalls: () => (fs.existsSync(runner.dockerLog) ? fs.readFileSync(runner.dockerLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
  for (const dir of [runner.workspace, runner.temp, runner.bin]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(runner.bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(runner.stepSummary, '');
  return runner;
}

/** Evaluates the simple `${{ a.b.c }}` values action.yml uses in env:, from a context. */
function evaluate(value, context) {
  if (typeof value !== 'string') return String(value);
  return value.replace(EXPRESSION, (_, expr) => {
    const parts = expr.split('.');
    let current = context;
    for (const part of parts) {
      if (current === undefined || current === null || !(part in current)) {
        if (parts[0] === 'steps') return ''; // a step that did not run has no outputs
        throw new Error(`unknown expression in test: ${expr}`);
      }
      current = current[part];
    }
    return current ?? '';
  });
}

function contextFor(runner, inputs) {
  const withDefaults = {};
  for (const [name, def] of Object.entries(action.inputs)) withDefaults[name] = inputs[name] ?? def.default ?? '';
  const stepsCtx = {};
  for (const [id, outputs] of Object.entries(runner.steps)) stepsCtx[id] = { outputs, outcome: outputs.__outcome };
  return { inputs: withDefaults, steps: stepsCtx, runner: { os: inputs.__os || 'Linux' }, github: { action_path: REPO } };
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
    FAKE_DOCKER_LOG: runner.dockerLog,
    FAKE_DOCKER_APP: REPO,
    FAKE_DOCKER_BROWSERS: HOST_BROWSERS,
    ...extra
  };
  const ctx = contextFor(runner, inputs);
  for (const [key, value] of Object.entries(step.env || {})) env[key] = evaluate(value, ctx);
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
 * body of an AsyncFunction(require, core, ...), in a separate Node process, with the
 * step's env. GITHUB_ACTION_PATH points at github-script's own folder there, as on GitHub.
 */
async function runParseStep(runner, inputs = {}) {
  const step = stepById('parse');
  const harness = path.join(runner.root, 'github-script-harness.cjs');
  const body = path.join(runner.root, 'github-script-body.js');
  fs.writeFileSync(body, step.with.script);
  fs.writeFileSync(harness, `
    const fs = require('fs');
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const outputs = {}; const annotations = [];
    const core = {
      setOutput: (k, v) => { outputs[k] = String(v); },
      error: (m) => annotations.push(['error', String(m)]),
      warning: (m) => annotations.push(['warning', String(m)]),
      info: () => {}
    };
    new AsyncFunction('require', 'core', fs.readFileSync(process.argv[2], 'utf8'))(require, core)
      .then(() => process.stdout.write(JSON.stringify({ outputs, annotations })), (e) => { console.error(e); process.exit(1); });
  `);
  const env = stepEnv(runner, step, inputs, { GITHUB_ACTION_PATH: path.join(runner.root, 'not-this-action') });
  const result = await exec(process.execPath, [harness, body], { cwd: runner.workspace, env });
  if (result.code !== 0) throw new Error(`github-script step failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  runner.steps.parse = { ...parsed.outputs, __outcome: 'success' };
  return parsed;
}

/** The composite action from validation to the last step (the runner check is tested on its own). */
async function runAction(runner, inputs, extra = {}) {
  const validate = await runBashStep(runner, stepById('validate'), inputs, extra);
  if (validate.code !== 0) return { validate };
  let wait = null;
  if ((inputs['wait-on'] ?? '') !== '') {
    wait = await runBashStep(runner, stepByName('Wait for the app'), inputs, extra);
  }
  let image = null;
  let run = null;
  if (!wait || wait.code === 0) {
    image = await runBashStep(runner, stepById('image'), inputs, extra);
    if (image.code === 0) run = await runBashStep(runner, stepById('run'), inputs, extra);
  }
  const parse = await runParseStep(runner, inputs);
  const final = await runBashStep(runner, stepByName('Set the result'), inputs, extra);
  return { validate, wait, image, run, parse, final };
}

describe('action steps (bash, with a fake docker)', { timeout: 60000 }, () => {
  let runner;
  beforeEach(() => { runner = createRunner(); });
  afterEach(() => runner.cleanup());

  describe('runner check', () => {
    it('passes on Linux and fails elsewhere with a clear error', async () => {
      const step = stepByName('Check the runner');
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
        image: 'ghcr.io/owner/visual-ci:1.0.0'
      });
      expect(r.code, r.stdout).toBe(0);
      expect(r.outputs).toEqual({ 'run-id': 'nightly_2026-11-25', 'working-directory': 'apps/web site' });
    });

    it.each([
      ['base-url missing', { 'base-url': '' }, 'base-url is required.'],
      ['base-url not http', { 'base-url': 'file:///etc/passwd' }, 'base-url must be an http:// or https:// URL'],
      ['base-url with a space', { 'base-url': 'http://a b' }, 'base-url must be an http:// or https:// URL'],
      ['base-url with a newline', { 'base-url': 'http://a\n::set-output name=x::y' }, 'base-url must be an http:// or https:// URL'],
      ['config empty', { config: '' }, 'config must be a path relative to working-directory.'],
      ['config absolute', { config: '/etc/visual.json' }, 'config must be a path relative'],
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
      ['run-id with a command', { 'run-id': 'x$(touch pwned)' }, "run-id may only contain"],
      ['run-id too long', { 'run-id': 'a'.repeat(129) }, "run-id may only contain"],
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
      ['image with a space', { image: 'a b' }, 'image must be an image reference']
    ])('refuses %s', async (_label, inputs, message) => {
      const r = await validate(inputs);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`::error title=visual-ci::${message}`);
      expect(r.outputs).toEqual({}); // nothing half-validated reaches later steps
    });

    it('reports every problem at once', async () => {
      const r = await validate({ strict: 'x', 'upload-artifact': 'x', 'wait-timeout': 'x' });
      expect(r.code).toBe(1);
      expect(r.stdout.match(/::error/g)).toHaveLength(3);
    });

    it('never echoes an input (it could hold credentials or a workflow command)', async () => {
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
    const wait = (inputs) => runBashStep(runner, stepByName('Wait for the app'), inputs);

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
        `${runner.temp}:/runner-temp`
      ]);
      expect(call.workdir).toBe('/github/workspace/site');
      expect(call.image).toBe('visual-ci-action:local');
      expect(call.command).toEqual([
        'node', '/app/src/cli/index.js', 'test',
        '--json=/runner-temp/visual-ci-gh-4242-3.json',
        '--config=visual.config.json',
        '--base-url=http://127.0.0.1:3000/?token=abc',
        '--run-id=gh-4242-3',
        '--strict'
      ]);
    });

    it('passes --no-strict and --update-baselines when asked', async () => {
      await runStep({ strict: 'false', 'update-baselines': 'true', 'run-id': 'r1', config: 'cfg/v.json' });
      const [call] = runner.dockerCalls();
      expect(call.command.slice(3)).toEqual([
        '--json=/runner-temp/visual-ci-r1.json', '--config=cfg/v.json', '--base-url=http://127.0.0.1:3000/?token=abc',
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
      fs.writeFileSync(path.join(runner.temp, 'visual-ci-gh-4242-3.json'), '{"stale":true}');
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

  describe('result (last step)', () => {
    const finish = (exitCode, changed = '0') => {
      runner.steps.validate = { __outcome: 'success' };
      runner.steps.parse = { 'exit-code': exitCode, changed, __outcome: 'success' };
      return runBashStep(runner, stepByName('Set the result'), {});
    };

    it('passes on 0', async () => {
      const r = await finish('0');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('visual-ci: passed.');
    });

    it('fails with 1 on visual differences', async () => {
      const r = await finish('1', '3');
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('::error title=visual-ci::Visual differences found (3 changed snapshot(s)');
    });

    it('fails with 2 on an error', async () => {
      const r = await finish('2');
      expect(r.code).toBe(2);
      expect(r.stdout).toContain('visual-ci failed with an error (exit code 2)');
    });

    it.each(['', 'x', '1; exit 0'])('fails when no exit code was recorded (%j)', async (code) => {
      const r = await finish(code);
      expect(r.code).toBe(2);
      expect(r.stdout).toContain('::error title=visual-ci::No result was recorded');
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

// Real Chromium runs (one or two per test): far above vitest's 5 s default on a busy machine.
describe('the whole action against a real page (fake docker runs the real CLI)', { timeout: 120000 }, () => {
  let site;
  let baseUrl;
  let color = 'white';
  let runner;

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><body style="margin:0;background:${color}"><h1>Action</h1></body>`);
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${site.address().port}`;
    runner = createRunner();
    const app = path.join(runner.workspace, 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'visual.config.json'), JSON.stringify({
      baseUrl: 'http://example.invalid', // the base-url input overrides it
      routes: ['/'],
      viewports: [{ name: 'desktop', width: 400, height: 300 }],
      threshold: 0.01
    }));
  });

  afterAll(async () => {
    site.closeAllConnections();
    await new Promise((resolve) => site.close(resolve));
    runner.cleanup();
  });

  const go = (inputs) => {
    runner.steps = {};
    return runAction(runner, { 'base-url': baseUrl, 'wait-on': `${baseUrl}/`, 'working-directory': 'app', ...inputs }, { FAKE_DOCKER_CLI: '1' });
  };
  const runDir = (id) => path.join(runner.workspace, 'app', 'storage', 'runs', id);

  it('first run without strict creates the baselines and passes; nothing is uploaded on success', async () => {
    const r = await go({ strict: 'false', 'run-id': 'first' });
    expect(r.run.outputs, JSON.stringify(runner.dockerCalls().at(-1))).toEqual({ 'exit-code': '0' });
    expect(r.parse.outputs).toEqual({
      status: 'passed',
      'exit-code': '0',
      total: '1',
      changed: '0',
      'new-baselines': '1',
      'run-id': 'first',
      'report-path': path.join(runner.temp, 'visual-ci-first.json'),
      'summary-path': path.join(runDir('first'), 'summary.md'),
      'run-dir': runDir('first'),
      'artifact-name': '',
      upload: 'false',
      'upload-path': ''
    });
    expect(r.final.code).toBe(0);
    expect(fs.existsSync(path.join(runner.workspace, 'app', 'storage', 'baselines', 'index-desktop.png'))).toBe(true);
    expect(fs.readFileSync(runner.stepSummary, 'utf8')).toContain('first'); // the step summary reached the runner's file
  });

  it('an unchanged page passes in strict mode', async () => {
    const r = await go({ 'run-id': 'same' });
    expect(r.parse.outputs).toMatchObject({ status: 'passed', 'exit-code': '0', 'new-baselines': '0', upload: 'false' });
    expect(r.final.code).toBe(0);
    // The git context came from the env the action passes in.
    const result = JSON.parse(fs.readFileSync(r.parse.outputs['report-path'], 'utf8'));
    expect(result.run).toMatchObject({ branch: 'feat/branch', commit_sha: '0123456789abcdef0123456789abcdef01234567', strict: true, run_dir: 'storage/runs/same' });
  });

  it('a changed page fails with 1 and uploads only its own run folder, which imports as a zip', async () => {
    color = 'black';
    try {
      const r = await go({ 'run-id': 'changed' });
      expect(r.parse.outputs).toMatchObject({ status: 'failed', 'exit-code': '1', changed: '1', upload: 'true', 'upload-path': runDir('changed'), 'artifact-name': 'visual-regression-diffs' });
      expect(r.final.code).toBe(1);

      // upload-artifact with a single folder puts its contents at the zip root.
      const zip = path.join(runner.root, 'visual-regression-diffs.zip');
      writeZip(zip, folderEntries(r.parse.outputs['upload-path']));
      const storageRoot = path.join(runner.root, 'reviewer-storage');
      fs.mkdirSync(storageRoot);
      try {
        const db = getDb(path.join(storageRoot, 'data.sqlite'));
        const { runs } = await importRuns({ kind: 'zip', file: zip }, { storageRoot, db });
        expect(runs).toEqual([expect.objectContaining({ id: 'changed', status: 'FAILED', snapshots: 1 })]);
      } finally {
        closeDb();
      }
    } finally {
      color = 'white';
    }
  });

  it('upload-artifact: always uploads a passing run; never uploads nothing even on failure', async () => {
    const always = await go({ 'run-id': 'always', 'upload-artifact': 'always' });
    expect(always.parse.outputs).toMatchObject({ status: 'passed', upload: 'true', 'upload-path': runDir('always') });
    color = 'black';
    try {
      const never = await go({ 'run-id': 'never', 'upload-artifact': 'never' });
      expect(never.parse.outputs).toMatchObject({ status: 'failed', upload: 'false', 'upload-path': '', 'run-dir': runDir('never') });
      expect(never.final.code).toBe(1);
    } finally {
      color = 'white';
    }
  });

  it('a missing config is an error: exit 2, status error, nothing to upload', async () => {
    const r = await go({ 'run-id': 'noconfig', config: 'missing.json', 'wait-on': '' });
    expect(r.run.outputs).toEqual({ 'exit-code': '2' });
    expect(r.parse.outputs).toMatchObject({ status: 'error', 'exit-code': '2', 'run-dir': '', upload: 'false' });
    expect(r.parse.annotations[0][1]).toMatch(/^visual-ci failed: CONFIG_NOT_FOUND: /);
    expect(r.final.code).toBe(2);
  });

  it('a page that cannot load is an error: exit 2, and the partial run folder is uploaded for debugging', async () => {
    const r = await go({ 'run-id': 'unreachable', 'base-url': 'http://127.0.0.1:1/', 'wait-on': '' });
    expect(r.parse.outputs).toMatchObject({ status: 'error', 'exit-code': '2', upload: 'true', 'upload-path': runDir('unreachable') });
    expect(r.parse.annotations[0][1]).toMatch(/^visual-ci failed: NAVIGATION_FAILED: /);
    expect(r.final.code).toBe(2);
  });

  it('wait-on that times out stops the action before docker runs; the result is an error', async () => {
    const calls = runner.dockerCalls().length;
    const r = await go({ 'run-id': 'nowait', 'wait-on': 'http://127.0.0.1:1/', 'wait-timeout': '1' });
    expect(r.wait.code).toBe(1);
    expect(r.run).toBeNull();
    expect(runner.dockerCalls().length).toBe(calls);
    expect(r.parse.outputs).toMatchObject({ status: 'error', 'exit-code': '2' });
    expect(r.final.code).toBe(2);
  });
});
