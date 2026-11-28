import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMPORT_PACKAGE_SPEC } from '../ci/prComment.js';
import { toDisplayPath } from './display.js';

/** This package's CLI entry point (src/cli/index.js). */
export const CLI_FILE = fileURLToPath(new URL('./index.js', import.meta.url));

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

const shellQuote = (text) => (SHELL_SAFE.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`);

/**
 * The command a user should type to run visual-ci again, for hints such as
 * "Install it with: <command> install-browsers". It depends on where this copy runs
 * from, so the hint never sends npx to the npm registry for a package that is not ours:
 *
 * - installed in the current project (node_modules above or at cwd): `npx visual-ci`,
 *   which npx resolves to that local copy;
 * - from npx's cache (`npx -p <spec> visual-ci ...`): the same `npx -y -p <spec> visual-ci`;
 * - any other node_modules (a global install): `visual-ci`;
 * - a checkout of this repository: `node <path to src/cli/index.js>`.
 *
 * @param {object} [options]
 * @param {string} [options.file=CLI_FILE] - Absolute path of the running src/cli/index.js
 * @param {string} [options.cwd=process.cwd()]
 * @returns {string}
 */
export function cliCommand({ file = CLI_FILE, cwd = process.cwd() } = {}) {
  const parts = file.split(path.sep);
  const nodeModules = parts.indexOf('node_modules');
  if (nodeModules === -1) {
    const shown = toDisplayPath(file, cwd);
    return `node ${SHELL_SAFE.test(shown) ? shown : shellQuote(file)}`;
  }
  if (parts.includes('_npx')) return `npx -y -p ${IMPORT_PACKAGE_SPEC} visual-ci`;
  const projectRoot = parts.slice(0, nodeModules).join(path.sep) || path.sep;
  const rel = path.relative(projectRoot, cwd);
  const cwdInProject = rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  return cwdInProject ? 'npx visual-ci' : 'visual-ci';
}
