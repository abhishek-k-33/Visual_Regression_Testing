import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// Each Playwright release only runs the browser builds bundled in its own
// mcr.microsoft.com/playwright image. If the npm package and the image tag
// drift apart, the container fails at launch with "Executable doesn't exist".
describe('Docker image matches the installed Playwright version', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));

  const imageVersion = dockerfile.match(/^FROM mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-\w+\s*$/m)?.[1];
  const lockedVersion = lock.packages['node_modules/playwright']?.version;
  const lockedCoreVersion = lock.packages['node_modules/playwright-core']?.version;

  it('package.json pins playwright to an exact version (no ^ or ~)', () => {
    expect(pkg.dependencies.playwright).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('lockfile resolves the pinned version', () => {
    expect(lockedVersion).toBe(pkg.dependencies.playwright);
    expect(lockedCoreVersion).toBe(pkg.dependencies.playwright);
  });

  it('Dockerfile base image tag equals the locked playwright version', () => {
    expect(imageVersion, 'FROM mcr.microsoft.com/playwright:v<version>-<distro> not found').toBeDefined();
    expect(imageVersion).toBe(lockedVersion);
  });
});
