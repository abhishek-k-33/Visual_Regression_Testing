import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// What `npm publish` would ship. `npm pack --dry-run --json` lists the files without
// writing a tarball; it runs once for this file, with a throwaway npm cache.
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
let cache;
let packed; // { name, version, size, unpackedSize, entryCount, files: [{ path, size }] }
let files; // Set of packed paths

beforeAll(async () => {
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-npm-cache-'));
  const stdout = await new Promise((resolve, reject) => {
    execFile('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' },
      maxBuffer: 16 * 1024 * 1024
    }, (err, out, errOut) => (err ? reject(new Error(`npm pack failed: ${err.message}\n${errOut}`)) : resolve(out)));
  });
  [packed] = JSON.parse(stdout);
  files = new Set(packed.files.map((f) => f.path));
}, 60000);

afterAll(() => {
  if (cache) fs.rmSync(cache, { recursive: true, force: true });
});

describe('npm package contents (npm pack --dry-run)', () => {
  it('is visual-ci at the package.json version', () => {
    expect(packed.name).toBe('visual-ci');
    expect(packed.version).toBe(pkg.version);
  });

  it('includes the CLI, the server with its views and static assets, src/shared, src/ci, LICENSE and README.md', () => {
    for (const file of ['package.json', 'LICENSE', 'README.md', 'src/cli/index.js', 'src/server/app.js', 'src/shared/text.js']) {
      expect(files, file).toContain(file);
    }
    const listed = (dir, ext) => fs.readdirSync(dir, { recursive: true })
      .filter((f) => (ext ? f.endsWith(ext) : fs.statSync(path.join(dir, f)).isFile()))
      .map((f) => path.join(dir, f).split(path.sep).join('/'));
    const expected = [
      ...listed('src/server/views', '.ejs'),
      ...listed('src/server/public'),
      ...listed('src/ci', '.js')
    ];
    expect(expected.length).toBeGreaterThan(15);
    for (const file of expected) expect(files, file).toContain(file);
  });

  it('includes every file the CLI and the dashboard import (relative imports from src/)', () => {
    const missing = [];
    for (const file of [...files].filter((f) => f.startsWith('src/') && f.endsWith('.js'))) {
      const source = fs.readFileSync(file, 'utf8');
      const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of specifiers) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
        if (!files.has(target)) missing.push(`${file} -> ${spec}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('leaves out secrets, tests, storage, scripts, CI files, Docker files, dependencies and databases', () => {
    const forbidden = [
      [/^\.env/, '.env files'],
      [/(^|\/)\.env/, '.env files'],
      [/^tests\//, 'tests'],
      [/^storage\//, 'storage'],
      [/^scripts\//, 'scripts'],
      [/^docs\//, 'docs'],
      [/^\.github\//, '.github'],
      [/^\.antigravity\//, 'IDE settings'],
      [/(^|\/)Dockerfile$/, 'Dockerfile'],
      [/^docker-compose\.yml$/, 'docker-compose.yml'],
      [/^action\.yml$/, 'the GitHub Action'],
      [/(^|\/)node_modules\//, 'node_modules'],
      [/\.(sqlite|db)(-wal|-shm)?$/, 'databases'],
      [/^_site\//, 'the static demo build'],
      [/^visual\.config\.json$/, 'this repository\'s config'],
      [/\.md$/, 'markdown other than README.md']
    ];
    const offenders = [...files].filter((f) => f !== 'README.md' && forbidden.some(([re]) => re.test(f)));
    expect(offenders).toEqual([]);
    expect([...files].every((f) => f === 'package.json' || f === 'LICENSE' || f === 'README.md' || f.startsWith('src/'))).toBe(true);
  });

  it('stays small (no stray artefacts)', () => {
    expect(packed.unpackedSize).toBeLessThan(1024 * 1024);
    expect(packed.entryCount).toBeLessThan(100);
  });
});

describe('package.json for npm', () => {
  it('name, bin and the files whitelist', () => {
    expect(pkg.name).toBe('visual-ci');
    expect(pkg.bin).toEqual({ 'visual-ci': './src/cli/index.js' });
    expect(pkg.files).toEqual(['src/', 'README.md', 'LICENSE']);
    expect(fs.readFileSync(pkg.bin['visual-ci'], 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('has no "main" (that was the CLI, which parses argv when imported) and exports only package.json', () => {
    expect(pkg).not.toHaveProperty('main');
    expect(pkg.exports).toEqual({ './package.json': './package.json' });
  });

  it('requires Node.js 22 or newer (better-sqlite3 13 does)', () => {
    expect(pkg.engines).toEqual({ node: '>=22' });
  });

  it('links the GitHub repository (needed for npm provenance), homepage and issues', () => {
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/abhishek-k-33/Visual_Regression_Testing.git' });
    expect(pkg.homepage).toBe('https://github.com/abhishek-k-33/Visual_Regression_Testing#readme');
    expect(pkg.bugs).toEqual({ url: 'https://github.com/abhishek-k-33/Visual_Regression_Testing/issues' });
    expect(pkg.description).toMatch(/visual regression/i);
    expect(pkg.keywords).toEqual(expect.arrayContaining(['visual-regression', 'playwright']));
  });

  it('package-lock.json carries the same name and engines', () => {
    const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
    expect(lock.name).toBe('visual-ci');
    expect(lock.packages[''].name).toBe('visual-ci');
    expect(lock.packages[''].engines).toEqual(pkg.engines);
  });

  it('ships an MIT LICENSE', () => {
    expect(pkg.license).toBe('MIT');
    const license = fs.readFileSync('LICENSE', 'utf8');
    expect(license).toMatch(/^MIT License\n\nCopyright \(c\) 2026 \S/);
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
    expect(license).not.toMatch(/@/); // no email address
  });

  it('the old package name is gone from the docs, Docker files and workflows', () => {
    const checked = ['README.md', 'Dockerfile', 'docker-compose.yml', 'action.yml',
      ...fs.readdirSync('.github/workflows').map((f) => `.github/workflows/${f}`)];
    for (const file of checked) expect(fs.readFileSync(file, 'utf8'), file).not.toContain('visual-regression-tool');
  });
});
