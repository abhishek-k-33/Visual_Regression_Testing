import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { CLI_FILE, cliCommand } from '../src/cli/invocation.js';
import { IMPORT_PACKAGE_SPEC } from '../src/ci/prComment.js';

// cliCommand() is what hints tell users to type ("Install it with: <command>
// install-browsers"). It must never be a bare `npx visual-ci` unless npx will resolve
// it to a local install: before the package is published, npx would otherwise run
// whatever the npm registry has under that name.
describe('cliCommand', () => {
  const at = (...parts) => path.join(path.sep, ...parts);

  it('CLI_FILE is this package\'s src/cli/index.js', () => {
    expect(CLI_FILE).toBe(path.resolve('src/cli/index.js'));
  });

  it('a checkout: node and the path of src/cli/index.js (relative to the working directory)', () => {
    expect(cliCommand({ file: at('work', 'vrt', 'src', 'cli', 'index.js'), cwd: at('work', 'vrt') })).toBe('node src/cli/index.js');
    expect(cliCommand()).toBe('node src/cli/index.js'); // these tests run from the checkout
  });

  it('a checkout elsewhere: the absolute path, quoted for the shell when it needs it', () => {
    expect(cliCommand({ file: at('opt', 'vrt', 'src', 'cli', 'index.js'), cwd: at('home', 'me', 'app') })).toBe('node /opt/vrt/src/cli/index.js');
    expect(cliCommand({ file: at('opt', 'my tools', "it's", 'src', 'cli', 'index.js'), cwd: at('home', 'me') }))
      .toBe("node '/opt/my tools/it'\\''s/src/cli/index.js'");
  });

  it('installed in the current project (or a parent of the working directory): npx visual-ci, which resolves locally', () => {
    const file = at('home', 'me', 'app', 'node_modules', 'visual-ci', 'src', 'cli', 'index.js');
    expect(cliCommand({ file, cwd: at('home', 'me', 'app') })).toBe('npx visual-ci');
    expect(cliCommand({ file, cwd: at('home', 'me', 'app', 'packages', 'web') })).toBe('npx visual-ci');
  });

  it('run through npx from GitHub (npx cache): the same npx -p command, never a bare npx visual-ci', () => {
    const file = at('home', 'me', '.npm', '_npx', '0123abcd', 'node_modules', 'visual-ci', 'src', 'cli', 'index.js');
    expect(cliCommand({ file, cwd: at('home', 'me', 'app') })).toBe(`npx -y -p ${IMPORT_PACKAGE_SPEC} visual-ci`);
    expect(IMPORT_PACKAGE_SPEC).toBe('github:abhishek-k-33/Visual_Regression_Testing');
  });

  it('installed somewhere else (a global install): visual-ci, which is on the PATH', () => {
    const file = at('usr', 'lib', 'node_modules', 'visual-ci', 'src', 'cli', 'index.js');
    expect(cliCommand({ file, cwd: at('home', 'me', 'app') })).toBe('visual-ci');
    // A sibling folder whose name starts like the project's is not inside it.
    const sibling = at('home', 'me', 'app', 'node_modules', 'visual-ci', 'src', 'cli', 'index.js');
    expect(cliCommand({ file: sibling, cwd: at('home', 'me', 'app-2') })).toBe('visual-ci');
  });
});
