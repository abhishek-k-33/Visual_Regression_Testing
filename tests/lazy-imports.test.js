import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { getToolVersion } from '../src/cli/manifest.js';

// better-sqlite3 is a native module: its build can fail, or be for another Node.js.
// The CLI loads it (and yauzl) only in the commands that need the run database, so
// everything else keeps working. The loader hook makes every import of it throw.
const CLI = path.resolve('src/cli/index.js');
const BREAK_SQLITE = path.resolve('tests/fixtures/broken-better-sqlite3/register.mjs');

function cleanEnv() {
  const env = { ...process.env };
  for (const key of ['CI', 'GITHUB_STEP_SUMMARY', 'VISUAL_STORAGE_DIR', 'PORT', 'HOST']) delete env[key];
  return env;
}

function runBroken(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', BREAK_SQLITE, CLI, ...args], { cwd, env: cleanEnv(), timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, out: stdout + stderr });
    });
  });
}

const CLEAR_ERROR = 'Could not load better-sqlite3, the SQLite driver this command needs for the run database';

describe('commands that do not need the database work when better-sqlite3 cannot load', () => {
  let work;
  let site;
  let baseUrl;

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-lazy-imports-'));
    site = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><body style="background:#fff"><h1>Lazy</h1></body>');
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${site.address().port}`;
    fs.writeFileSync(path.join(work, 'visual.config.json'), JSON.stringify({
      baseUrl,
      routes: ['/'],
      viewports: [{ name: 'desktop', width: 320, height: 240 }]
    }));
    fs.mkdirSync(path.join(work, 'run-folder'));
  });

  afterAll(async () => {
    await new Promise((resolve) => site.close(resolve));
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('the loader hook really breaks better-sqlite3', async () => {
    const out = await new Promise((resolve) => {
      execFile(process.execPath, ['--import', BREAK_SQLITE, '-e', "import('better-sqlite3').then(() => console.log('loaded'), (e) => console.log(e.code))"],
        (err, stdout) => resolve(stdout));
    });
    expect(out.trim()).toBe('ERR_MODULE_NOT_FOUND');
  });

  it('--version and --help', async () => {
    const version = await runBroken(['--version'], work);
    expect(version.code, version.out).toBe(0);
    expect(version.stdout.trim()).toBe(getToolVersion());

    const help = await runBroken(['--help'], work);
    expect(help.code, help.out).toBe(0);
    expect(help.out).toContain('serve [options]');
  });

  it('--help of every command', async () => {
    for (const command of ['capture', 'test', 'import', 'serve', 'install-browsers']) {
      const { code, out } = await runBroken([command, '--help'], work);
      expect(code, `${command}: ${out}`).toBe(0);
      expect(out).toContain(`Usage: visual-ci ${command}`);
    }
  }, 30000);

  it('capture takes its screenshots', async () => {
    const { code, out } = await runBroken(['capture', '-r', 'lazy_capture'], work);
    expect(code, out).toBe(0);
    expect(fs.existsSync(path.join(work, 'storage', 'runs', 'lazy_capture', 'index-desktop.png'))).toBe(true);
  }, 60000);

  it('install-browsers runs the installer (--dry-run)', async () => {
    const { code, out } = await runBroken(['install-browsers', '--dry-run'], work);
    expect(code, out).toBe(0);
    expect(out).toContain('Install location:');
  }, 30000);

  it('test needs the database: a clear error and exit 2 before any screenshot, also in the --json result', async () => {
    const { code, out } = await runBroken(['test', '-r', 'lazy_test', '--json', 'result.json'], work);
    expect(code, out).toBe(2);
    expect(out).toContain(CLEAR_ERROR);
    expect(out).toContain('npm rebuild better-sqlite3');
    expect(fs.existsSync(path.join(work, 'storage', 'runs', 'lazy_test'))).toBe(false); // failed fast

    const result = JSON.parse(fs.readFileSync(path.join(work, 'result.json'), 'utf8'));
    expect(result).toMatchObject({ status: 'error', exit_code: 2, error: { code: 'INTERNAL' } });
    expect(result.error.message).toContain(CLEAR_ERROR);
  }, 30000);

  it('import and serve need the database: a clear error and exit 2', async () => {
    const imported = await runBroken(['import', 'run-folder'], work);
    expect(imported.code, imported.out).toBe(2);
    expect(imported.out).toContain(CLEAR_ERROR);

    const served = await runBroken(['serve', '-p', '0'], work);
    expect(served.code, served.out).toBe(2);
    expect(served.out).toContain(CLEAR_ERROR);
  }, 30000);
});
