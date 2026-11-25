import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jsonTargetConflict, jsonTargetShapeProblem, realpathLoose } from '../src/cli/jsonTarget.js';

describe('--json target checks', () => {
  let dir;
  let runsDir;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-json-target-')));
    runsDir = path.join(dir, 'realstore', 'runs', 'r1');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const conflict = (target, extra = {}) => jsonTargetConflict(target, { runsDir, cwd: dir, ...extra });

  it('accepts stdout, no target, and ordinary files', () => {
    expect(conflict(undefined)).toBeNull();
    expect(conflict('-')).toBeNull();
    expect(conflict('result.json')).toBeNull();
    expect(conflict('realstore/runs/r1/result.json')).toBeNull();
    expect(jsonTargetConflict('realstore/runs/r1/run.json', { runsDir: null, cwd: dir })).toBeNull();
  });

  it("refuses the run's run.json and summary by path", () => {
    expect(conflict('realstore/runs/r1/run.json')).toContain("run's run.json");
    expect(conflict(path.join(runsDir, 'summary.md'))).toContain('markdown summary');
    expect(conflict('realstore/runs/r1/report.md', { summaryFile: 'report.md' })).toContain('markdown summary');
    expect(conflict('realstore/runs/r1/summary.md', { summaryFile: 'report.md' })).toBeNull();
  });

  it('refuses them through a symlinked folder, even before the run folder exists', () => {
    fs.mkdirSync(path.join(dir, 'realstore'));
    fs.symlinkSync(path.join(dir, 'realstore'), path.join(dir, 'store'));
    expect(conflict('store/runs/r1/run.json')).toContain("run's run.json");
    // and the other way round: the run folder is reached through the link
    expect(jsonTargetConflict('realstore/runs/r1/run.json', { runsDir: path.join(dir, 'store', 'runs', 'r1'), cwd: dir })).toContain("run's run.json");
  });

  it('refuses a link (symbolic or hard) to the existing run.json', () => {
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, 'run.json'), '{}');
    fs.symlinkSync(path.join(runsDir, 'run.json'), path.join(dir, 'soft.json'));
    fs.linkSync(path.join(runsDir, 'run.json'), path.join(dir, 'hard.json'));
    expect(conflict('soft.json')).toContain("run's run.json");
    expect(conflict('hard.json')).toContain("run's run.json");
  });

  it('folds case on macOS and Windows only', () => {
    expect(conflict('REALSTORE/runs/R1/RUN.JSON', { platform: 'darwin' })).toContain("run's run.json");
    expect(conflict('realstore/runs/r1/Summary.MD', { platform: 'win32' })).toContain('markdown summary');
    expect(conflict('REALSTORE/runs/R1/RUN.JSON', { platform: 'linux' })).toBeNull();
  });

  it('realpathLoose resolves the existing part of a path that does not exist yet', () => {
    fs.mkdirSync(path.join(dir, 'realstore'));
    fs.symlinkSync(path.join(dir, 'realstore'), path.join(dir, 'store'));
    expect(realpathLoose(path.join(dir, 'store', 'runs', 'x', 'run.json'))).toBe(path.join(dir, 'realstore', 'runs', 'x', 'run.json'));
  });

  it('refuses an empty name, an existing directory and a trailing separator', () => {
    fs.mkdirSync(path.join(dir, 'out'));
    expect(jsonTargetShapeProblem('', { cwd: dir })).toContain('needs a file name');
    expect(jsonTargetShapeProblem('.', { cwd: dir })).toContain('is a directory');
    expect(jsonTargetShapeProblem('out', { cwd: dir })).toContain('is a directory');
    expect(jsonTargetShapeProblem('new/', { cwd: dir })).toContain('is a directory');
    expect(jsonTargetShapeProblem('out/result.json', { cwd: dir })).toBeNull();
    expect(jsonTargetShapeProblem('-', { cwd: dir })).toBeNull();
    expect(jsonTargetShapeProblem(undefined, { cwd: dir })).toBeNull();
  });
});
