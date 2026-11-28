import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { EXIT } from './result.js';

const require = createRequire(import.meta.url);

/**
 * The Playwright CLI of the Playwright this package depends on (its "bin" entry), so
 * the browser that gets installed is the build our pinned Playwright launches.
 * (`npx playwright` could run a different Playwright, e.g. one of the project's own.)
 *
 * @param {(id: string) => string} [resolve=require.resolve]
 * @returns {string} Absolute path of playwright's cli.js
 */
export function playwrightCliPath(resolve = require.resolve) {
  const pkgFile = resolve('playwright/package.json');
  const pkg = require(pkgFile);
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.playwright;
  if (!bin) throw new Error(`No "playwright" bin in ${pkgFile}`);
  return path.resolve(path.dirname(pkgFile), bin);
}

/**
 * Arguments for the Playwright CLI: `install [--with-deps] [--dry-run] chromium`.
 *
 * @param {{ withDeps?: boolean, dryRun?: boolean }} [options]
 * @returns {string[]}
 */
export function installArgs({ withDeps = false, dryRun = false } = {}) {
  return ['install', ...(withDeps ? ['--with-deps'] : []), ...(dryRun ? ['--dry-run'] : []), 'chromium'];
}

/**
 * Runs our Playwright's `install chromium` with this Node.js, its output going
 * straight to the terminal.
 *
 * @param {object} [options]
 * @param {boolean} [options.withDeps] - Also install the system libraries (Linux; uses sudo when not root)
 * @param {boolean} [options.dryRun] - Only print what would be installed
 * @param {typeof nodeSpawn} [options.spawn] - For tests
 * @param {string} [options.cliPath] - Defaults to playwrightCliPath()
 * @returns {Promise<{ exitCode: number, code?: number|null, signal?: string|null, error?: Error }>}
 *   exitCode is EXIT.PASS when Playwright succeeded, otherwise EXIT.ERROR
 */
export function installBrowsers({ withDeps = false, dryRun = false, spawn = nodeSpawn, cliPath } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const cli = cliPath ?? playwrightCliPath();
      child = spawn(process.execPath, [cli, ...installArgs({ withDeps, dryRun })], { stdio: 'inherit' });
    } catch (error) {
      resolve({ exitCode: EXIT.ERROR, error });
      return;
    }
    child.once('error', (error) => resolve({ exitCode: EXIT.ERROR, error }));
    child.once('exit', (code, signal) => resolve({ exitCode: code === 0 ? EXIT.PASS : EXIT.ERROR, code, signal }));
  });
}
