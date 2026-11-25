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
  const hosts = { workspace: '/home/runner/work/repo/repo', workingDirectory: 'app', runnerTemp: '/home/runner/work/_temp' };

  it('joins a relative path onto the workspace + working-directory', () => {
    expect(toHostPath('storage/runs/r1', hosts)).toBe('/home/runner/work/repo/repo/app/storage/runs/r1');
    expect(toHostPath('storage/runs/r1', { ...hosts, workingDirectory: '.' })).toBe('/home/runner/work/repo/repo/storage/runs/r1');
    expect(toHostPath('storage/runs/r1', { ...hosts, workingDirectory: './app/' })).toBe('/home/runner/work/repo/repo/app/storage/runs/r1');
  });

  it('swaps the mount prefix of an absolute container path', () => {
    expect(toHostPath('/github/workspace/other/x.md', hosts)).toBe('/home/runner/work/repo/repo/other/x.md');
    expect(toHostPath('/runner-temp/visual-ci-r1.json', hosts)).toBe('/home/runner/work/_temp/visual-ci-r1.json');
  });

  it('returns null for paths that only exist inside the container', () => {
    expect(toHostPath('/tmp/vrt/runs/r1', hosts)).toBeNull();
    expect(toHostPath('/github/workspace-evil/x', hosts)).toBeNull(); // segment check, not a prefix check
    expect(toHostPath('../../../etc', hosts)).toBeNull(); // climbs out of /github/workspace
    expect(toHostPath('/runner-temp/x', { ...hosts, runnerTemp: undefined })).toBeNull();
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

  const writeReport = (data, runId = 'gh-7-1') => {
    fs.writeFileSync(path.join(runnerTemp, reportFileName(runId)), typeof data === 'string' ? data : JSON.stringify(data));
  };
  const outputsFor = (extra = {}) => buildActionOutputs({
    exitCode: '1', runId: 'gh-7-1', workspace, workingDirectory: 'app', runnerTemp, uploadMode: 'on-failure', artifactName: 'diffs', ...extra
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-action-report-'));
    workspace = path.join(root, 'work');
    runnerTemp = path.join(root, 'temp');
    runDir = path.join(workspace, 'app', 'storage', 'runs', 'gh-7-1');
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(runnerTemp);
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
      'report-path': path.join(runnerTemp, 'visual-ci-gh-7-1.json'),
      'summary-path': path.join(runDir, 'summary.md'),
      'run-dir': runDir,
      'artifact-name': 'diffs',
      upload: 'true',
      'upload-path': runDir
    });
    expect(Object.keys(outputs).sort()).toEqual([...OUTPUT_NAMES].sort());
  });

  it('a passed run is not uploaded in on-failure mode, but is in always mode', () => {
    writeReport(report({ status: 'passed', exit_code: 0, counts: { total: 2, passed: 2, changed: 0, missing_baseline: 0, new_baseline: 0 } }));
    expect(outputsFor({ exitCode: '0' }).outputs).toMatchObject({ status: 'passed', 'exit-code': '0', upload: 'false', 'upload-path': '', 'artifact-name': '', 'run-dir': runDir });
    expect(outputsFor({ exitCode: '0', uploadMode: 'always' }).outputs).toMatchObject({ upload: 'true', 'upload-path': runDir, 'artifact-name': 'diffs' });
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
    expect(outputs['report-path']).toBe(path.join(runnerTemp, 'visual-ci-gh-7-1.json'));
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
    ['in RUNNER_TEMP', '/runner-temp/gh-7-1', /not a run folder inside the workspace/],
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

  it('run(): reads the env, sets every output and annotates problems, without throwing', () => {
    writeReport(report({ status: 'error', exit_code: 2, error: { code: 'INTERNAL', message: 'boom' } }));
    const calls = { outputs: {}, error: [], warning: [], info: [] };
    const core = {
      setOutput: (name, value) => { calls.outputs[name] = value; },
      error: (m) => calls.error.push(m),
      warning: (m) => calls.warning.push(m),
      info: (m) => calls.info.push(m)
    };
    run({ core }, {
      VISUAL_CI_EXIT_CODE: '2',
      VISUAL_CI_RUN_ID: 'gh-7-1',
      GITHUB_WORKSPACE: workspace,
      VISUAL_CI_WORKING_DIRECTORY: 'app',
      RUNNER_TEMP: runnerTemp,
      VISUAL_CI_UPLOAD_ARTIFACT: 'on-failure',
      VISUAL_CI_ARTIFACT_NAME: 'diffs'
    });
    expect(Object.keys(calls.outputs).sort()).toEqual([...OUTPUT_NAMES].sort());
    expect(calls.outputs).toMatchObject({ status: 'error', 'exit-code': '2', upload: 'true', 'upload-path': runDir, 'artifact-name': 'diffs' });
    expect(calls.error).toEqual(['visual-ci failed: INTERNAL: boom']);
    expect(calls.info[0]).toMatch(/status=error, exit code 2/);
  });
});
