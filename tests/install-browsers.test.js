import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { installArgs, installBrowsers, playwrightCliPath } from '../src/cli/installBrowsers.js';

const CLI = path.resolve('src/cli/index.js');
const OUR_PLAYWRIGHT = path.resolve('node_modules/playwright');

/** A spawn() stand-in: records its call and ends the "process" the way the test says. */
function fakeSpawn(end) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    setImmediate(() => end(child));
    return child;
  };
  return { spawn, calls };
}

describe('visual-ci install-browsers', () => {
  it('runs the CLI of the Playwright visual-ci depends on (its bin), not whatever `npx playwright` finds', () => {
    const cli = playwrightCliPath();
    const pkg = JSON.parse(fs.readFileSync(path.join(OUR_PLAYWRIGHT, 'package.json'), 'utf8'));
    expect(cli).toBe(path.join(OUR_PLAYWRIGHT, pkg.bin.playwright));
    expect(fs.existsSync(cli)).toBe(true);
    // The pinned version, the one whose Chromium build capture.js launches.
    const ourPkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    expect(pkg.version).toBe(ourPkg.dependencies.playwright);
  });

  it('finds the bin through package.json, wherever the package is installed', () => {
    const resolve = (id) => {
      expect(id).toBe('playwright/package.json');
      return path.join(OUR_PLAYWRIGHT, 'package.json');
    };
    expect(playwrightCliPath(resolve)).toBe(path.join(OUR_PLAYWRIGHT, 'cli.js'));
  });

  it('builds `install [--with-deps] [--dry-run] chromium`', () => {
    expect(installArgs()).toEqual(['install', 'chromium']);
    expect(installArgs({ withDeps: true })).toEqual(['install', '--with-deps', 'chromium']);
    expect(installArgs({ dryRun: true })).toEqual(['install', '--dry-run', 'chromium']);
    expect(installArgs({ withDeps: true, dryRun: true })).toEqual(['install', '--with-deps', '--dry-run', 'chromium']);
  });

  it('spawns this Node.js with our Playwright CLI, inheriting stdio, and exits 0 when it succeeds', async () => {
    const { spawn, calls } = fakeSpawn((child) => child.emit('exit', 0, null));
    const result = await installBrowsers({ spawn });
    expect(result).toMatchObject({ exitCode: 0, code: 0 });
    expect(calls).toEqual([{
      command: process.execPath,
      args: [playwrightCliPath(), 'install', 'chromium'],
      options: { stdio: 'inherit' }
    }]);
  });

  it('passes --with-deps on', async () => {
    const { spawn, calls } = fakeSpawn((child) => child.emit('exit', 0, null));
    await installBrowsers({ withDeps: true, spawn });
    expect(calls[0].args).toEqual([playwrightCliPath(), 'install', '--with-deps', 'chromium']);
  });

  it('any failure is exit 2: a non-zero exit, a signal, or a process that could not start', async () => {
    const failed = await installBrowsers({ spawn: fakeSpawn((child) => child.emit('exit', 1, null)).spawn });
    expect(failed).toMatchObject({ exitCode: 2, code: 1 });

    const killed = await installBrowsers({ spawn: fakeSpawn((child) => child.emit('exit', null, 'SIGTERM')).spawn });
    expect(killed).toMatchObject({ exitCode: 2, signal: 'SIGTERM' });

    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const notStarted = await installBrowsers({ spawn: fakeSpawn((child) => child.emit('error', enoent)).spawn });
    expect(notStarted).toMatchObject({ exitCode: 2, error: enoent });

    const throws = await installBrowsers({ spawn: () => { throw new Error('EAGAIN'); } });
    expect(throws.exitCode).toBe(2);
    expect(throws.error.message).toBe('EAGAIN');
  });

  // The real command, end to end, without downloading anything: --dry-run makes
  // Playwright print what it would install. The Chromium revision it names is the one
  // in our Playwright's browsers.json, so it really ran our Playwright.
  it('the command runs our Playwright (--dry-run prints our Chromium build and downloads nothing)', async () => {
    const browsers = JSON.parse(fs.readFileSync(path.resolve('node_modules/playwright-core/browsers.json'), 'utf8'));
    const revision = browsers.browsers.find((b) => b.name === 'chromium').revision;
    const { code, out } = await new Promise((resolve) => {
      execFile(process.execPath, [CLI, 'install-browsers', '--dry-run'], (err, stdout, stderr) => {
        resolve({ code: err ? err.code : 0, out: stdout + stderr });
      });
    });
    expect(code, out).toBe(0);
    expect(out).toContain(`(playwright chromium v${revision})`);
    expect(out).toContain('Install location:');
  }, 30000);

  it('an unknown option is a usage error (exit 2)', async () => {
    const code = await new Promise((resolve) => {
      execFile(process.execPath, [CLI, 'install-browsers', '--firefox'], (err) => resolve(err ? err.code : 0));
    });
    expect(code).toBe(2);
  });
});
