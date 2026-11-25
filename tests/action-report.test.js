import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildActionOutputs,
  run,
  toHostPath,
  shouldUpload,
  normalizeWorkingDirectory,
  reportFileName,
  hostTempDir,
  inspectRunFolder,
  artifactNameTaken,
  OUTPUT_NAMES,
  UPLOAD_MODES
} from '../src/ci/actionReport.js';

// The report the CLI writes inside the container, as seen from /github/workspace/<wd>.
function report(overrides = {}) {
  return {
    schema: 'visual-ci-result',
    version: 1,
    tool: { name: 'visual-ci', version: '1.0.0' },
    command: 'test',
    status: 'failed',
    exit_code: 1,
    error: null,
    run: {
      id: 'gh-7-1',
      mode: 'compare',
      strict: true,
      run_dir: 'storage/runs/gh-7-1',
      manifest: 'storage/runs/gh-7-1/run.json',
      summary: 'storage/runs/gh-7-1/summary.md'
    },
    counts: { total: 4, passed: 2, changed: 1, missing_baseline: 1, new_baseline: 0 },
    snapshots: [],
    ...overrides
  };
}

describe('toHostPath: container paths back to the runner', () => {
  const hosts = { workspace: '/home/runner/work/repo/repo', workingDirectory: 'app', tempDir: '/home/runner/work/_temp/visual-ci' };

  it('joins a relative path onto the workspace + working-directory', () => {
    expect(toHostPath('storage/runs/r1', hosts)).toBe('/home/runner/work/repo/repo/app/storage/runs/r1');
    expect(toHostPath('storage/runs/r1', { ...hosts, workingDirectory: '.' })).toBe('/home/runner/work/repo/repo/storage/runs/r1');
    expect(toHostPath('storage/runs/r1', { ...hosts, workingDirectory: './app/' })).toBe('/home/runner/work/repo/repo/app/storage/runs/r1');
  });

  it('swaps the mount prefix of an absolute container path', () => {
    expect(toHostPath('/github/workspace/other/x.md', hosts)).toBe('/home/runner/work/repo/repo/other/x.md');
    expect(toHostPath('/visual-ci-temp/visual-ci-r1.json', hosts)).toBe('/home/runner/work/_temp/visual-ci/visual-ci-r1.json');
    expect(hostTempDir('/home/runner/work/_temp')).toBe('/home/runner/work/_temp/visual-ci');
  });

  it('returns null for paths that only exist inside the container', () => {
    expect(toHostPath('/tmp/vrt/runs/r1', hosts)).toBeNull();
    expect(toHostPath('/github/workspace-evil/x', hosts)).toBeNull(); // segment check, not a prefix check
    expect(toHostPath('../../../etc', hosts)).toBeNull(); // climbs out of /github/workspace
    expect(toHostPath('/visual-ci-temp/x', { ...hosts, tempDir: undefined })).toBeNull();
    expect(toHostPath('/runner-temp/x', hosts)).toBeNull(); // RUNNER_TEMP itself is not mounted any more
  });

  it('a relative path that climbs out of the working directory but stays in the workspace still maps', () => {
    expect(toHostPath('../shared/x', hosts)).toBe('/home/runner/work/repo/repo/shared/x');
  });

  it('returns null for missing or odd values', () => {
    for (const value of [null, undefined, '', 42, 'a\0b']) expect(toHostPath(value, hosts)).toBeNull();
    expect(toHostPath('x', { workspace: '' })).toBeNull();
  });

  it('normalizeWorkingDirectory cleans the input', () => {
    expect(normalizeWorkingDirectory('.')).toBe('.');
    expect(normalizeWorkingDirectory('')).toBe('.');
    expect(normalizeWorkingDirectory(undefined)).toBe('.');
    expect(normalizeWorkingDirectory('./app/')).toBe('app');
    expect(normalizeWorkingDirectory('a//b/')).toBe('a/b');
  });
});

describe('shouldUpload: the upload-artifact modes', () => {
  it.each([
    // mode, exit code, run folder exists, upload?
    ['on-failure', 0, true, false],
    ['on-failure', 1, true, true],
    ['on-failure', 2, true, true],
    ['on-failure', 1, false, false],
    ['always', 0, true, true],
    ['always', 1, true, true],
    ['always', 2, true, true],
    ['always', 0, false, false],
    ['never', 0, true, false],
    ['never', 1, true, false],
    ['never', 2, true, false],
    ['bogus', 1, true, false]
  ])('%s, exit %i, folder %s -> %s', (mode, code, exists, expected) => {
    expect(shouldUpload(mode, code, exists)).toBe(expected);
  });

  it('knows exactly the three documented modes', () => {
    expect(UPLOAD_MODES).toEqual(['on-failure', 'always', 'never']);
  });
});

describe('buildActionOutputs', () => {
  let root;
  let workspace;
  let runnerTemp;
  let runDir;
  let reportDir;

  const writeReport = (data, runId = 'gh-7-1') => {
    fs.writeFileSync(path.join(reportDir, reportFileName(runId)), typeof data === 'string' ? data : JSON.stringify(data));
  };
  const outputsFor = (extra = {}) => buildActionOutputs({
    exitCode: '1', runId: 'gh-7-1', workspace, workingDirectory: 'app', runnerTemp, uploadMode: 'on-failure', ...extra
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-action-report-'));
    workspace = path.join(root, 'work');
    runnerTemp = path.join(root, 'temp');
    runDir = path.join(workspace, 'app', 'storage', 'runs', 'gh-7-1');
    fs.mkdirSync(runDir, { recursive: true });
    reportDir = path.join(runnerTemp, 'visual-ci');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'summary.md'), '# summary\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('maps a failed run: counts, host paths, upload of only this run folder', () => {
    writeReport(report());
    const { outputs, errors, warnings } = outputsFor();
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(outputs).toEqual({
      status: 'failed',
      'exit-code': '1',
      total: '4',
      changed: '1',
      'new-baselines': '0',
      'run-id': 'gh-7-1',
      'report-path': path.join(runnerTemp, 'visual-ci', 'visual-ci-gh-7-1.json'),
      'summary-path': path.join(runDir, 'summary.md'),
      'run-dir': runDir,
      upload: 'true',
      'upload-path': runDir
    });
    expect(Object.keys(outputs).sort()).toEqual([...OUTPUT_NAMES].sort());
  });

  it('a passed run is not uploaded in on-failure mode, but is in always mode', () => {
    writeReport(report({ status: 'passed', exit_code: 0, counts: { total: 2, passed: 2, changed: 0, missing_baseline: 0, new_baseline: 0 } }));
    expect(outputsFor({ exitCode: '0' }).outputs).toMatchObject({ status: 'passed', 'exit-code': '0', upload: 'false', 'upload-path': '', 'run-dir': runDir });
    expect(outputsFor({ exitCode: '0', uploadMode: 'always' }).outputs).toMatchObject({ upload: 'true', 'upload-path': runDir });
  });

  it('never mode never uploads, even a failure', () => {
    writeReport(report());
    expect(outputsFor({ uploadMode: 'never' }).outputs).toMatchObject({ status: 'failed', upload: 'false', 'upload-path': '' });
  });

  it('reports new baselines', () => {
    writeReport(report({ status: 'passed', exit_code: 0, run: { ...report().run, mode: 'update-baselines' }, counts: { total: 2, passed: 0, changed: 0, missing_baseline: 0, new_baseline: 2 } }));
    expect(outputsFor({ exitCode: '0' }).outputs).toMatchObject({ status: 'passed', 'new-baselines': '2', total: '2' });
  });

  it('an error result passes its code and message on and is uploaded on failure', () => {
    writeReport(report({ status: 'error', exit_code: 2, error: { code: 'NAVIGATION_FAILED', message: 'Could not load http://127.0.0.1:1/' } }));
    const { outputs, errors } = outputsFor({ exitCode: '2' });
    expect(outputs).toMatchObject({ status: 'error', 'exit-code': '2', upload: 'true' });
    expect(errors).toEqual(['visual-ci failed: NAVIGATION_FAILED: Could not load http://127.0.0.1:1/']);
  });

  it('an error before the run started (run: null) has no paths and nothing to upload', () => {
    writeReport(report({ status: 'error', exit_code: 2, error: { code: 'CONFIG_NOT_FOUND', message: 'no config' }, run: null, counts: { total: 0, passed: 0, changed: 0, missing_baseline: 0, new_baseline: 0 } }));
    const { outputs } = outputsFor({ exitCode: '2' });
    expect(outputs).toMatchObject({ status: 'error', 'exit-code': '2', 'run-dir': '', 'summary-path': '', upload: 'false', 'run-id': 'gh-7-1' });
    expect(outputs['report-path']).toBe(path.join(runnerTemp, 'visual-ci', 'visual-ci-gh-7-1.json'));
  });

  it('reads the result only from RUNNER_TEMP/visual-ci, the folder the container can write', () => {
    fs.writeFileSync(path.join(runnerTemp, reportFileName('gh-7-1')), JSON.stringify(report()));
    const { outputs, errors } = outputsFor();
    expect(outputs).toMatchObject({ status: 'error', 'exit-code': '2' });
    expect(errors[0]).toContain(path.join(runnerTemp, 'visual-ci', 'visual-ci-gh-7-1.json'));
  });

  describe('only a folder with something in it is uploaded', () => {
    const errorReport = () => report({ status: 'error', exit_code: 2, error: { code: 'NAVIGATION_FAILED', message: 'no page' }, counts: { total: 0, passed: 0, changed: 0, missing_baseline: 0, new_baseline: 0 } });

    it.each(['on-failure', 'always'])('an empty run folder (error before the first screenshot) is never uploaded (%s)', (uploadMode) => {
      fs.rmSync(path.join(runDir, 'summary.md'));
      writeReport(errorReport());
      const { outputs, warnings } = outputsFor({ exitCode: '2', uploadMode });
      expect(outputs).toMatchObject({ status: 'error', 'run-dir': runDir, upload: 'false', 'upload-path': '' });
      expect(warnings).toEqual(['The run folder is empty (visual-ci stopped before the first screenshot), so there is nothing to upload.']);
    });

    it('a folder holding only empty sub-folders counts as empty', () => {
      fs.rmSync(path.join(runDir, 'summary.md'));
      fs.mkdirSync(path.join(runDir, 'baselines'));
      writeReport(errorReport());
      expect(outputsFor({ exitCode: '2' }).outputs.upload).toBe('false');
    });

    it('a folder with some screenshots but no run.json (error mid-run) is uploaded for debugging', () => {
      fs.rmSync(path.join(runDir, 'summary.md'));
      fs.writeFileSync(path.join(runDir, 'index-desktop.png'), 'png');
      writeReport(errorReport());
      expect(outputsFor({ exitCode: '2' }).outputs).toMatchObject({ upload: 'true', 'upload-path': runDir });
    });
  });

  describe('symlinks never widen what is uploaded', () => {
    it('a symlinked folder on the way (storage -> elsewhere) is refused', () => {
      const elsewhere = path.join(root, 'elsewhere');
      fs.mkdirSync(path.join(elsewhere, 'runs', 'gh-7-1'), { recursive: true });
      fs.writeFileSync(path.join(elsewhere, 'runs', 'gh-7-1', 'secret.txt'), 'x');
      fs.rmSync(path.join(workspace, 'app', 'storage'), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(workspace, 'app', 'storage'));
      writeReport(report());
      const { outputs, warnings } = outputsFor();
      expect(outputs).toMatchObject({ 'run-dir': '', upload: 'false', 'upload-path': '' });
      expect(warnings[0]).toMatch(/resolves outside the workspace \(through a symlink\)/);
    });

    it('a symlink inside the workspace that stays inside it is fine', () => {
      const realStorage = path.join(workspace, 'real-storage');
      fs.renameSync(path.join(workspace, 'app', 'storage'), realStorage);
      fs.symlinkSync(realStorage, path.join(workspace, 'app', 'storage'));
      writeReport(report());
      expect(outputsFor().outputs).toMatchObject({ upload: 'true', 'upload-path': runDir });
    });

    it.each([
      ['a file symlink', (dir) => fs.symlinkSync('/etc/hostname', path.join(dir, 'evil.png')), 'evil.png'],
      ['a folder symlink', (dir) => fs.symlinkSync('/etc', path.join(dir, 'baselines')), 'baselines'],
      ['a nested symlink', (dir) => { fs.mkdirSync(path.join(dir, 'baselines')); fs.symlinkSync('/etc/hostname', path.join(dir, 'baselines', 'x.png')); }, 'baselines/x.png']
    ])('a run folder containing %s is not uploaded (upload-artifact follows symlinks)', (_label, plant, name) => {
      plant(runDir);
      writeReport(report());
      const { outputs, warnings } = outputsFor();
      expect(outputs).toMatchObject({ upload: 'false', 'upload-path': '' });
      expect(warnings[0]).toContain(`(e.g. ${name})`);
    });

    it('inspectRunFolder counts files recursively and lists unsafe entries', () => {
      fs.mkdirSync(path.join(runDir, 'baselines'));
      fs.writeFileSync(path.join(runDir, 'baselines', 'a.png'), 'x');
      fs.symlinkSync('/etc', path.join(runDir, 'link'));
      expect(inspectRunFolder(runDir)).toEqual({ files: 2, unsafe: ['link'] });
    });
  });

  it.each([
    ['missing', null, /exited with code 2, but visual-ci wrote no JSON result/],
    ['not JSON', '{oops', /is not valid JSON/],
    ['not an object', '[1]', /is not an object/],
    ['another schema', JSON.stringify({ schema: 'other', version: 1 }), /is not schema visual-ci-result v1/],
    ['a newer version', JSON.stringify(report({ version: 2 })), /is not schema visual-ci-result v1/],
    ['an invalid status', JSON.stringify(report({ status: 'great' })), /invalid status or exit_code/]
  ])('a %s report means status error, exit 2, with a clear error', (_label, content, message) => {
    if (content !== null) writeReport(content);
    const { outputs, errors } = outputsFor({ exitCode: '2' });
    expect(outputs).toMatchObject({ status: 'error', 'exit-code': '2', total: '0', changed: '0', 'run-dir': '', upload: 'false' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(message);
  });

  it('a missing report is an error even when the container exited 0 (a pass is never assumed)', () => {
    const { outputs, errors } = outputsFor({ exitCode: '0' });
    expect(outputs).toMatchObject({ status: 'error', 'exit-code': '2', 'report-path': '' });
    expect(errors[0]).toMatch(/exited with code 0, but visual-ci wrote no JSON result/);
  });

  it('a container exit code that disagrees with the report is an error (e.g. killed after writing)', () => {
    writeReport(report({ status: 'passed', exit_code: 0 }));
    const { outputs, errors } = outputsFor({ exitCode: '137' });
    expect(outputs).toMatchObject({ status: 'error', 'exit-code': '2' });
    expect(errors[0]).toMatch(/exited with code 137, but its JSON result says 0/);
  });

  it.each(['', undefined, 'abc', '-1'])('no recorded exit code (%j) means visual-ci did not run', (exitCode) => {
    writeReport(report());
    const { outputs, errors } = outputsFor({ exitCode });
    expect(outputs).toMatchObject({ status: 'error', 'exit-code': '2', upload: 'false', total: '0' });
    expect(errors).toEqual(['visual-ci did not run (no exit code was recorded; see the earlier steps).']);
  });

  it('a report for another run id never points the upload at its folder', () => {
    fs.mkdirSync(path.join(workspace, 'app', 'storage', 'runs', 'other'), { recursive: true });
    writeReport(report({ run: { ...report().run, id: 'other', run_dir: 'storage/runs/other' } }));
    const { outputs, warnings } = outputsFor();
    expect(outputs).toMatchObject({ status: 'failed', 'run-dir': '', upload: 'false', 'run-id': 'gh-7-1' });
    expect(warnings[0]).toMatch(/is for run "other", not "gh-7-1"/);
  });

  it.each([
    ['outside the workspace (container only)', '/tmp/vrt/runs/gh-7-1', /outside the workspace/],
    ['the workspace itself', '../', /not a run folder/],
    ['a folder not named after the run', 'storage', /not a run folder/],
    ['in the mounted temp folder', '/visual-ci-temp/gh-7-1', /not a run folder inside the workspace/],
    ['in RUNNER_TEMP (not mounted)', '/runner-temp/gh-7-1', /outside the workspace/],
    ['named after the run but not in a runs/ folder', 'storage/gh-7-1', /not a run folder/]
  ])('a run_dir %s is never uploaded', (_label, runDirValue, message) => {
    fs.mkdirSync(path.join(runnerTemp, 'gh-7-1'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'app', 'storage', 'gh-7-1'), { recursive: true });
    writeReport(report({ run: { ...report().run, run_dir: runDirValue } }));
    const { outputs, warnings } = outputsFor();
    expect(outputs).toMatchObject({ 'run-dir': '', upload: 'false', 'upload-path': '' });
    expect(warnings[0]).toMatch(message);
  });

  it('a run folder that is a symlink is not uploaded', () => {
    const real = path.join(root, 'elsewhere');
    fs.mkdirSync(real);
    fs.rmSync(runDir, { recursive: true });
    fs.symlinkSync(real, runDir);
    writeReport(report());
    expect(outputsFor().outputs).toMatchObject({ 'run-dir': '', upload: 'false' });
  });

  it('a run folder that was never created is not uploaded, and its paths are empty', () => {
    fs.rmSync(runDir, { recursive: true });
    writeReport(report());
    expect(outputsFor().outputs).toMatchObject({ status: 'failed', 'run-dir': '', 'summary-path': '', upload: 'false' });
  });

  it('bad counts become 0', () => {
    writeReport(report({ counts: { total: -1, changed: 'x', new_baseline: 1.5 } }));
    expect(outputsFor().outputs).toMatchObject({ total: '0', changed: '0', 'new-baselines': '0' });
  });

  it('run(): reads the env, sets every output and annotates problems, without throwing', async () => {
    writeReport(report({ status: 'error', exit_code: 2, error: { code: 'INTERNAL', message: 'boom' } }));
    const calls = { outputs: {}, error: [], warning: [], info: [] };
    const core = {
      setOutput: (name, value) => { calls.outputs[name] = value; },
      error: (m) => calls.error.push(m),
      warning: (m) => calls.warning.push(m),
      info: (m) => calls.info.push(m)
    };
    await run({ core }, {
      VISUAL_CI_EXIT_CODE: '2',
      VISUAL_CI_RUN_ID: 'gh-7-1',
      GITHUB_WORKSPACE: workspace,
      VISUAL_CI_WORKING_DIRECTORY: 'app',
      RUNNER_TEMP: runnerTemp,
      VISUAL_CI_UPLOAD_ARTIFACT: 'on-failure',
      VISUAL_CI_ARTIFACT_NAME: 'diffs'
    });
    expect(Object.keys(calls.outputs).sort()).toEqual([...OUTPUT_NAMES].sort());
    expect(calls.outputs).toMatchObject({ status: 'error', 'exit-code': '2', upload: 'true', 'upload-path': runDir });
    expect(calls.outputs['artifact-name']).toBeUndefined(); // set after the upload, from its result
    expect(calls.error).toEqual(['visual-ci failed: INTERNAL: boom']);
    expect(calls.info[0]).toMatch(/status=error, exit code 2/);
  });
});

describe('artifact name collisions (best effort, needs actions: read)', () => {
  const context = { repo: { owner: 'o', repo: 'r' }, runId: 4242 };
  const githubWith = (impl) => ({ rest: { actions: { listWorkflowRunArtifacts: impl } } });

  it('finds an artifact of the same name in this run', async () => {
    const calls = [];
    const github = githubWith(async (params) => { calls.push(params); return { data: { artifacts: [{ name: 'diffs', expired: false }] } }; });
    expect(await artifactNameTaken({ github, context, name: 'diffs' })).toBe(true);
    expect(calls).toEqual([{ owner: 'o', repo: 'r', run_id: 4242, name: 'diffs', per_page: 100 }]);
  });

  it('is false when no artifact (or only an expired one) has the name', async () => {
    expect(await artifactNameTaken({ github: githubWith(async () => ({ data: { artifacts: [] } })), context, name: 'diffs' })).toBe(false);
    expect(await artifactNameTaken({ github: githubWith(async () => ({ data: { artifacts: [{ name: 'diffs', expired: true }, { name: 'other' }] } })), context, name: 'diffs' })).toBe(false);
  });

  it('is unknown (null) without permission or without a client', async () => {
    const forbidden = githubWith(async () => { const e = new Error('Resource not accessible by integration'); e.status = 403; throw e; });
    expect(await artifactNameTaken({ github: forbidden, context, name: 'diffs' })).toBeNull();
    expect(await artifactNameTaken({ github: undefined, context, name: 'diffs' })).toBeNull();
    expect(await artifactNameTaken({ github: githubWith(async () => ({})), context: {}, name: 'diffs' })).toBeNull();
  });

  describe('run() warns before an upload that would collide', () => {
    let root;
    let env;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-action-collide-'));
      const runDir = path.join(root, 'work', 'storage', 'runs', 'gh-7-1');
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'a.png'), 'x');
      fs.mkdirSync(path.join(root, 'temp', 'visual-ci'), { recursive: true });
      fs.writeFileSync(path.join(root, 'temp', 'visual-ci', 'visual-ci-gh-7-1.json'), JSON.stringify(report()));
      env = {
        VISUAL_CI_EXIT_CODE: '1', VISUAL_CI_RUN_ID: 'gh-7-1', GITHUB_WORKSPACE: path.join(root, 'work'), VISUAL_CI_WORKING_DIRECTORY: '.',
        RUNNER_TEMP: path.join(root, 'temp'), VISUAL_CI_UPLOAD_ARTIFACT: 'on-failure', VISUAL_CI_ARTIFACT_NAME: 'diffs'
      };
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
    const core = (warnings) => ({ setOutput() {}, error() {}, warning: (m) => warnings.push(m), info() {} });

    it('with a clear message about unique names', async () => {
      const warnings = [];
      const github = githubWith(async () => ({ data: { artifacts: [{ name: 'diffs' }] } }));
      const { outputs } = await run({ core: core(warnings), github, context }, env);
      expect(outputs.upload).toBe('true'); // the upload still runs and fails; the last step explains it
      expect(warnings).toEqual(['An artifact named "diffs" already exists in this workflow run, so the upload will fail. ' +
        'In a matrix, or when this action runs more than once in a job, give each use its own artifact-name (and run-id).']);
    });

    it('silently when the check is not possible', async () => {
      const warnings = [];
      await run({ core: core(warnings), github: githubWith(async () => { throw new Error('403'); }), context }, env);
      expect(warnings).toEqual([]);
    });

    it('not at all when nothing will be uploaded', async () => {
      const warnings = [];
      let listed = false;
      const github = githubWith(async () => { listed = true; return { data: { artifacts: [{ name: 'diffs' }] } }; });
      await run({ core: core(warnings), github, context }, { ...env, VISUAL_CI_UPLOAD_ARTIFACT: 'never' });
      expect(listed).toBe(false);
      expect(warnings).toEqual([]);
    });
  });
});
