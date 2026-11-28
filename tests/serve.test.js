import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { startServer, dashboardUrl } from '../src/server/app.js';
import { initDb, closeDb, createTestRun } from '../src/server/db.js';
import { parsePort, resolveServeOptions } from '../src/cli/serve.js';

const CLI = path.resolve('src/cli/index.js');

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of ['CI', 'GITHUB_STEP_SUMMARY', 'VISUAL_STORAGE_DIR', 'PORT', 'HOST']) delete env[key];
  return { ...env, ...extra };
}

function runCli(args, { cwd, env = {} }) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: cleanEnv(env), timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: stdout + stderr });
    });
  });
}

/**
 * Starts `visual-ci serve <args>` and resolves once it prints its URL.
 * stop(signal) sends the signal and resolves with the exit code and all output.
 */
function startServe(args, { cwd, env = {} }) {
  const child = spawn(process.execPath, [CLI, 'serve', ...args], { cwd, env: cleanEnv(env) });
  let out = '';
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      out += chunk;
      const match = out.match(/\(listening on (.+):(\d+)\)/);
      if (match) resolve({ host: match[1], port: Number(match[2]) });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    exited.then(({ code }) => reject(new Error(`serve exited (${code}) before listening:\n${out}`)));
  });
  const stop = async (signal = 'SIGINT') => {
    child.kill(signal);
    const { code } = await exited;
    return { code, out };
  };
  return { child, ready, stop, output: () => out };
}

function seedRun(storageRoot, id) {
  const db = initDb(path.join(storageRoot, 'data.sqlite'));
  try {
    createTestRun({ id, commit_hash: 'abc1234', branch: 'main', status: 'PASSED' }, db);
  } finally {
    closeDb();
  }
}

describe('parsePort / resolveServeOptions', () => {
  it('accepts whole numbers from 0 to 65535', () => {
    expect(parsePort('0', '--port')).toBe(0);
    expect(parsePort('4700', '--port')).toBe(4700);
    expect(parsePort(' 65535 ', '--port')).toBe(65535);
  });

  it('refuses anything else with INVALID_ARGUMENT, naming where it came from', () => {
    for (const bad of ['', 'abc', '-1', '65536', '80.5', '4e3', '0x50', undefined]) {
      expect(() => parsePort(bad, '--port')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
    expect(() => parsePort('x', 'the PORT environment variable')).toThrow('Invalid port "x" (from the PORT environment variable)');
  });

  it('flags win over PORT / HOST, which win over 4000 and 127.0.0.1', () => {
    expect(resolveServeOptions({}, {})).toEqual({ port: 4000, host: '127.0.0.1' });
    expect(resolveServeOptions({}, { PORT: '4100', HOST: '0.0.0.0' })).toEqual({ port: 4100, host: '0.0.0.0' });
    expect(resolveServeOptions({ port: '4200', host: '::1' }, { PORT: '4100', HOST: '0.0.0.0' })).toEqual({ port: 4200, host: '::1' });
    expect(resolveServeOptions({}, { PORT: '', HOST: '' })).toEqual({ port: 4000, host: '127.0.0.1' }); // empty = unset, as in app.js
    expect(() => resolveServeOptions({ host: ' ' }, {})).toThrow('--host cannot be empty');
  });
});

describe('startServer', () => {
  let storage;
  let previousStorage;
  beforeEach(() => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-start-server-'));
    previousStorage = process.env.VISUAL_STORAGE_DIR;
    process.env.VISUAL_STORAGE_DIR = storage;
  });
  afterEach(() => {
    closeDb();
    if (previousStorage === undefined) delete process.env.VISUAL_STORAGE_DIR;
    else process.env.VISUAL_STORAGE_DIR = previousStorage;
    fs.rmSync(storage, { recursive: true, force: true });
  });

  it('returns the http server, listening where asked, and prints the URL with the real port', async () => {
    const lines = [];
    const server = startServer({ port: 0, host: '127.0.0.1', log: (line) => lines.push(line) });
    try {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const { port } = server.address();
      expect(port).toBeGreaterThan(0);
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
      expect(lines).toContain(`  http://localhost:${port}`);
      expect(lines).toContain(`  (listening on 127.0.0.1:${port})`);
      expect(fs.existsSync(path.join(storage, 'data.sqlite'))).toBe(true); // it opened the database
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('dashboardUrl: localhost for loopback and all-interfaces hosts, the host itself otherwise', () => {
    expect(dashboardUrl('127.0.0.1', 4000)).toBe('http://localhost:4000');
    expect(dashboardUrl('0.0.0.0', 4000)).toBe('http://localhost:4000');
    expect(dashboardUrl('::', 80)).toBe('http://localhost:80');
    expect(dashboardUrl('192.168.1.20', 4000)).toBe('http://192.168.1.20:4000');
    expect(dashboardUrl('fd00::1', 4000)).toBe('http://[fd00::1]:4000');
  });

  it('importing app.js does not start a server (only running it directly does), even from a script named app.js', async () => {
    // A script named app.js used to count as "run directly" (the old argv check).
    const script = path.join(storage, 'app.js');
    fs.writeFileSync(script, `import ${JSON.stringify(path.resolve('src/server/app.js'))}; console.log('imported');\n`);
    const { code, out } = await new Promise((resolve) => {
      execFile(process.execPath, [script], { env: cleanEnv({ VISUAL_STORAGE_DIR: storage, PORT: '0' }), timeout: 15000 }, (err, stdout, stderr) => {
        resolve({ code: err ? (err.killed ? 'timeout' : err.code) : 0, out: stdout + stderr });
      });
    });
    expect(code, out).toBe(0); // exited on its own: nothing was listening
    expect(out).toContain('imported');
    expect(out).not.toContain('listening on');
  }, 20000);
});

describe('visual-ci serve', () => {
  let work;
  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-serve-'));
  });
  afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

  it('serves the dashboard on the port it prints (-p 0), and Ctrl+C (SIGINT) stops it cleanly with exit 0', async () => {
    const serve = startServe(['-p', '0'], { cwd: work });
    const { host, port } = await serve.ready;
    expect(host).toBe('127.0.0.1'); // loopback only by default
    expect(serve.output()).toContain(`http://localhost:${port}`);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Visual Regression Test Runs');
    // Default storage of the working directory, never the repository's.
    expect(fs.existsSync(path.join(work, 'storage', 'data.sqlite'))).toBe(true);

    const { code, out } = await serve.stop('SIGINT');
    expect(code).toBe(0);
    expect(out).toContain('SIGINT received: stopping the dashboard.');
  }, 30000);

  it('SIGTERM stops it cleanly too', async () => {
    const serve = startServe(['--port', '0', '--host', '127.0.0.1'], { cwd: work });
    await serve.ready;
    expect((await serve.stop('SIGTERM')).code).toBe(0);
  }, 30000);

  it('uses PORT from the environment when -p is not given', async () => {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const free = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    const serve = startServe([], { cwd: work, env: { PORT: String(free) } });
    expect((await serve.ready).port).toBe(free);
    await serve.stop();
  }, 30000);

  it('-c serves the storageDir of that config (the same root `test -c` and `import -c` use)', async () => {
    fs.mkdirSync(path.join(work, 'cfg'));
    fs.writeFileSync(path.join(work, 'cfg', 'review.json'), '{ "storageDir": "custom-store" } // only storageDir is read');
    seedRun(path.join(work, 'custom-store'), 'run_from_config');

    const withConfig = startServe(['-p', '0', '-c', 'cfg/review.json'], { cwd: work });
    const { port } = await withConfig.ready;
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('run_from_config');
    expect((await fetch(`http://127.0.0.1:${port}/runs/run_from_config`)).status).toBe(200);
    await withConfig.stop();

    // Without -c (no ./visual.config.json here) it is ./storage, which has no such run.
    const without = startServe(['-p', '0'], { cwd: work });
    const other = await without.ready;
    expect(await (await fetch(`http://127.0.0.1:${other.port}/`)).text()).not.toContain('run_from_config');
    await without.stop();
  }, 30000);

  it('VISUAL_STORAGE_DIR still wins over -c, as for the other commands', async () => {
    fs.writeFileSync(path.join(work, 'review.json'), '{ "storageDir": "custom-store" }');
    seedRun(path.join(work, 'env-store'), 'run_from_env');
    const serve = startServe(['-p', '0', '-c', 'review.json'], { cwd: work, env: { VISUAL_STORAGE_DIR: path.join(work, 'env-store') } });
    const { port } = await serve.ready;
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('run_from_env');
    await serve.stop();
  }, 30000);

  it('an invalid port is exit 2, from the flag or from PORT', async () => {
    for (const args of [['-p', 'abc'], ['-p', '70000'], ['--port', '-1']]) {
      const { code, out } = await runCli(['serve', ...args], { cwd: work });
      expect(code, out).toBe(2);
      expect(out).toMatch(/Invalid port|error: /);
    }
    const env = await runCli(['serve'], { cwd: work, env: { PORT: 'eighty' } });
    expect(env.code).toBe(2);
    expect(env.out).toContain('Invalid port "eighty" (from the PORT environment variable)');
    expect(fs.existsSync(path.join(work, 'storage'))).toBe(false); // refused before touching storage
  }, 30000);

  it('a port already in use is exit 2 with a clear message', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    try {
      const { code, out } = await runCli(['serve', '-p', String(blocker.address().port)], { cwd: work });
      expect(code).toBe(2);
      expect(out).toContain(`port ${blocker.address().port} on 127.0.0.1 is already in use`);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  }, 30000);

  it('a missing -c config is exit 2 (CONFIG_NOT_FOUND)', async () => {
    const { code, out } = await runCli(['serve', '-p', '0', '-c', 'nope.json'], { cwd: work });
    expect(code).toBe(2);
    expect(out).toContain('Configuration file not found');
  }, 30000);

  it('is listed in --help', async () => {
    const { code, out } = await runCli(['serve', '--help'], { cwd: work });
    expect(code).toBe(0);
    expect(out).toContain('-p, --port <n>');
    expect(out).toContain('--host <host>');
    expect(out).toContain('-c, --config <path>');
  });
});
