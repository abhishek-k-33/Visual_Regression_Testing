import fs from 'node:fs';
import path from 'node:path';

/**
 * Turns the `visual-ci test --json` result that the GitHub Action's container wrote into
 * the action's outputs (action.yml, step "parse", run through actions/github-script).
 *
 * The container sees the runner's workspace at /github/workspace and $RUNNER_TEMP at
 * /runner-temp, and runs in /github/workspace/<working-directory>. The CLI records
 * paths relative to that working directory (or absolute when they lie outside it), so a
 * path is mapped back to the runner by joining it onto $GITHUB_WORKSPACE/<working-directory>,
 * or by swapping the container mount prefix for the host one.
 *
 * Only node: builtins, so it runs inside github-script without `npm ci` in the action
 * folder. Nothing here throws for a bad report: the action reports status "error" and
 * fails at its last step instead, after the artifact upload had its chance.
 */

export const CONTAINER_WORKSPACE = '/github/workspace';
export const CONTAINER_TEMP = '/runner-temp';
export const RESULT_SCHEMA = 'visual-ci-result';
export const RESULT_VERSION = 1;
export const UPLOAD_MODES = Object.freeze(['on-failure', 'always', 'never']);

/** Same rule as the CLI (capture.js) plus the length cap of `visual-ci import`. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Every output the parse step sets (action.yml maps its outputs onto these). */
export const OUTPUT_NAMES = Object.freeze([
  'status',
  'exit-code',
  'total',
  'changed',
  'new-baselines',
  'run-id',
  'report-path',
  'summary-path',
  'run-dir',
  'artifact-name',
  'upload',
  'upload-path'
]);

/** Name of the JSON result the action asks the CLI for, in $RUNNER_TEMP. */
export function reportFileName(runId) {
  return `visual-ci-${runId}.json`;
}

const isInsideOrSame = (child, parent) => {
  const rel = path.posix.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !path.posix.isAbsolute(rel));
};

/** <storage>/runs/<runId>, strictly inside the workspace: the only folder the action uploads. */
function isRunFolderPath(p, runId, workspace) {
  const root = path.posix.resolve(workspace);
  return path.posix.basename(p) === runId &&
    path.posix.basename(path.posix.dirname(p)) === 'runs' &&
    p !== root && isInsideOrSame(p, root);
}

/** A relative working-directory input as a clean POSIX path ("." for the workspace root). */
export function normalizeWorkingDirectory(dir) {
  const normalized = path.posix.normalize(String(dir ?? '.').trim() || '.').replace(/\/+$/, '');
  return normalized === '' ? '.' : normalized;
}

/**
 * A path from the result (container view) as a path on the runner, or null when it
 * does not lie in a mounted folder (then it only ever existed inside the container).
 *
 * @param {unknown} p - As recorded in the result: relative to the working directory, or absolute
 * @param {{ workspace: string, workingDirectory?: string, runnerTemp?: string }} hosts
 * @returns {string|null}
 */
export function toHostPath(p, { workspace, workingDirectory = '.', runnerTemp } = {}) {
  if (typeof p !== 'string' || p === '' || p.includes('\0') || !workspace) return null;
  const hostWorkspace = path.posix.resolve(workspace);
  const mounts = [[CONTAINER_WORKSPACE, hostWorkspace]];
  if (runnerTemp) mounts.push([CONTAINER_TEMP, path.posix.resolve(runnerTemp)]);

  if (!path.posix.isAbsolute(p)) {
    const containerCwd = path.posix.join(CONTAINER_WORKSPACE, normalizeWorkingDirectory(workingDirectory));
    return toHostPath(path.posix.resolve(containerCwd, p), { workspace, runnerTemp });
  }
  const resolved = path.posix.resolve(p);
  for (const [inContainer, onHost] of mounts) {
    if (isInsideOrSame(resolved, inContainer)) {
      return path.posix.join(onHost, path.posix.relative(inContainer, resolved));
    }
  }
  return null;
}

/**
 * Whether the run folder should be uploaded as an artifact.
 *
 * @param {string} mode - on-failure | always | never
 * @param {number} exitCode - The action's exit code (0 pass, 1 diffs, 2 error)
 * @param {boolean} runDirExists
 * @returns {boolean}
 */
export function shouldUpload(mode, exitCode, runDirExists) {
  if (!runDirExists) return false;
  if (mode === 'always') return true;
  if (mode === 'on-failure') return exitCode !== 0;
  return false; // never (or an unknown mode, which the validate step already refuses)
}

function readReport(file, fsImpl) {
  let text;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch (err) {
    return { problem: err.code === 'ENOENT' ? 'visual-ci wrote no JSON result' : `the JSON result could not be read (${err.code || err.message})` };
  }
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    return { problem: 'the JSON result is not valid JSON' };
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { problem: 'the JSON result is not an object' };
  if (report.schema !== RESULT_SCHEMA || report.version !== RESULT_VERSION) {
    return { problem: `the JSON result is not schema ${RESULT_SCHEMA} v${RESULT_VERSION}` };
  }
  if (!['passed', 'failed', 'error'].includes(report.status) || ![0, 1, 2].includes(report.exit_code)) {
    return { problem: 'the JSON result has an invalid status or exit_code' };
  }
  return { report };
}

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
const isDirectory = (p, fsImpl) => {
  try {
    return fsImpl.lstatSync(p).isDirectory(); // lstat: a symlink is never uploaded
  } catch {
    return false;
  }
};
const isFile = (p, fsImpl) => {
  try {
    return fsImpl.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Computes the action outputs.
 *
 * @param {object} options
 * @param {string} options.exitCode - The container's exit code, as the run step recorded it ('' if it never ran)
 * @param {string} options.runId - The validated run id
 * @param {string} options.workspace - $GITHUB_WORKSPACE
 * @param {string} options.workingDirectory - The validated working-directory input
 * @param {string} options.runnerTemp - $RUNNER_TEMP
 * @param {string} options.uploadMode - on-failure | always | never
 * @param {string} [options.artifactName] - The artifact-name input (an output only when the folder is uploaded)
 * @param {typeof fs} [options.fs]
 * @returns {{ outputs: Record<string, string>, errors: string[], warnings: string[] }}
 */
export function buildActionOutputs({ exitCode, runId, workspace, workingDirectory = '.', runnerTemp, uploadMode, artifactName = '', fs: fsImpl = fs }) {
  const errors = [];
  const warnings = [];
  const hosts = { workspace, workingDirectory, runnerTemp };
  const reportFile = runnerTemp ? path.posix.join(path.posix.resolve(runnerTemp), reportFileName(runId)) : '';

  const rawCode = String(exitCode ?? '').trim();
  const containerCode = /^\d{1,3}$/.test(rawCode) ? Number(rawCode) : null;

  let report = null;
  if (containerCode === null) {
    errors.push('visual-ci did not run (no exit code was recorded; see the earlier steps).');
  } else {
    const read = reportFile ? readReport(reportFile, fsImpl) : { problem: 'RUNNER_TEMP is not set' };
    if (read.problem) {
      errors.push(`visual-ci exited with code ${containerCode}, but ${read.problem} (${reportFile || 'no report path'}). See the log above.`);
    } else if (read.report.exit_code !== containerCode) {
      errors.push(`visual-ci exited with code ${containerCode}, but its JSON result says ${read.report.exit_code}: the run did not finish normally (killed or out of memory?).`);
    } else {
      report = read.report;
    }
  }

  const status = report ? report.status : 'error';
  const actionExitCode = report ? report.exit_code : 2;
  if (report?.status === 'error' && report.error) {
    errors.push(`visual-ci failed: ${report.error.code}: ${report.error.message}`);
  }

  // The run folder: only this run's own folder (named after the run id) is ever uploaded.
  let runDir = null;
  if (report?.run) {
    const id = report.run.id;
    const mapped = toHostPath(report.run.run_dir, hosts);
    if (id !== runId) {
      warnings.push(`The JSON result is for run "${String(id)}", not "${runId}"; its folder is not used.`);
    } else if (!mapped) {
      warnings.push(`The run folder (${String(report.run.run_dir)}) is outside the workspace, so it cannot be uploaded.`);
    } else if (!isRunFolderPath(mapped, runId, workspace)) {
      warnings.push(`The run folder (${String(report.run.run_dir)}) is not a run folder inside the workspace, so it is not uploaded.`);
    } else {
      runDir = mapped;
    }
  }
  const runDirExists = runDir !== null && isDirectory(runDir, fsImpl);
  const summaryPath = report?.run ? toHostPath(report.run.summary, hosts) : null;
  const upload = shouldUpload(uploadMode, actionExitCode, runDirExists);

  const outputs = {
    status,
    'exit-code': String(actionExitCode),
    total: String(count(report?.counts?.total)),
    changed: String(count(report?.counts?.changed)),
    'new-baselines': String(count(report?.counts?.new_baseline)),
    'run-id': runId || '',
    'report-path': reportFile && isFile(reportFile, fsImpl) ? reportFile : '',
    'summary-path': summaryPath && isFile(summaryPath, fsImpl) ? summaryPath : '',
    'run-dir': runDirExists ? runDir : '',
    'artifact-name': upload ? artifactName : '',
    upload: upload ? 'true' : 'false',
    'upload-path': upload ? runDir : ''
  };
  return { outputs, errors, warnings };
}

/**
 * Entry point for the action's github-script step: reads the step's env, sets the
 * outputs and reports problems as annotations. Never fails the step.
 *
 * @param {{ core: { setOutput: Function, error: Function, warning: Function, info: Function } }} ctx
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ReturnType<typeof buildActionOutputs>}
 */
export function run({ core }, env = process.env) {
  const result = buildActionOutputs({
    exitCode: env.VISUAL_CI_EXIT_CODE,
    runId: env.VISUAL_CI_RUN_ID,
    workspace: env.GITHUB_WORKSPACE,
    workingDirectory: env.VISUAL_CI_WORKING_DIRECTORY,
    runnerTemp: env.RUNNER_TEMP,
    uploadMode: env.VISUAL_CI_UPLOAD_ARTIFACT,
    artifactName: env.VISUAL_CI_ARTIFACT_NAME
  });
  for (const message of result.errors) core.error(message);
  for (const message of result.warnings) core.warning(message);
  for (const name of OUTPUT_NAMES) core.setOutput(name, result.outputs[name]);
  core.info(`visual-ci: status=${result.outputs.status}, exit code ${result.outputs['exit-code']}, ` +
    `${result.outputs.total} snapshot(s), ${result.outputs.changed} changed, ${result.outputs['new-baselines']} new baseline(s)`);
  return result;
}
