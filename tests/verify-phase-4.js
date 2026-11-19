import fs from 'node:fs';
import path from 'node:path';

console.log('======================================================');
console.log('  [PHASE 4 VERIFICATION] Docker & Cross-OS Environment');
console.log('======================================================\n');

let failed = false;

function check(title, condition, detail) {
  if (condition) {
    console.log(`✓ ${title}`);
  } else {
    console.error(`✗ ${title} - ${detail}`);
    failed = true;
  }
}

// 1. Verify Dockerfile
const dockerfilePath = path.resolve(process.cwd(), 'Dockerfile');
const dockerfileExists = fs.existsSync(dockerfilePath);
check('Dockerfile exists', dockerfileExists, 'Dockerfile was not found in project root.');

if (dockerfileExists) {
  const content = fs.readFileSync(dockerfilePath, 'utf8');
  check('Dockerfile uses official Playwright base image', content.includes('FROM mcr.microsoft.com/playwright:v1.50.1-noble'), 'Expected base image mcr.microsoft.com/playwright:v1.50.1-noble');
  check('Dockerfile installs Linux typography packages', content.includes('fonts-noto-color-emoji') && content.includes('fonts-liberation'), 'Missing font packages in Dockerfile');
  check('Dockerfile sets working directory /app', content.includes('WORKDIR /app'), 'Missing WORKDIR /app');
  check('Dockerfile executes npm ci for clean build', content.includes('npm ci'), 'Missing npm ci instruction');
  check('Dockerfile copies application source and config', content.includes('COPY src/ ./src/') && content.includes('COPY visual.config.json ./'), 'Missing COPY instructions');
  check('Dockerfile exposes port 4000', content.includes('EXPOSE 4000'), 'Missing EXPOSE 4000');
  check('Dockerfile configures dashboard start command', content.includes('CMD ["node", "src/server/app.js"]'), 'Missing default start command');
}

// 2. Verify docker-compose.yml
const composePath = path.resolve(process.cwd(), 'docker-compose.yml');
const composeExists = fs.existsSync(composePath);
check('docker-compose.yml exists', composeExists, 'docker-compose.yml was not found in project root.');

if (composeExists) {
  const content = fs.readFileSync(composePath, 'utf8');
  check('docker-compose defines "dashboard" service', content.includes('dashboard:'), 'Missing dashboard service');
  check('docker-compose defines "runner" service', content.includes('runner:'), 'Missing runner service');
  check('docker-compose binds port 4000:4000', content.includes('"4000:4000"'), 'Missing port mapping 4000:4000');
  check('docker-compose mounts ./storage volume', content.includes('./storage:/app/storage'), 'Missing ./storage volume mount');
  check('docker-compose mounts visual.config.json for runner', content.includes('./visual.config.json:/app/visual.config.json'), 'Missing visual.config.json volume mount');
  check('docker-compose configures network_mode host for runner', content.includes('network_mode: "host"'), 'Missing network_mode: host for runner');
}

// 3. Verify .dockerignore
const dockerignorePath = path.resolve(process.cwd(), '.dockerignore');
const dockerignoreExists = fs.existsSync(dockerignorePath);
check('.dockerignore exists', dockerignoreExists, '.dockerignore was not found in project root.');

if (dockerignoreExists) {
  const content = fs.readFileSync(dockerignorePath, 'utf8');
  check('.dockerignore excludes node_modules', content.includes('node_modules'), 'Missing node_modules in .dockerignore');
  check('.dockerignore excludes .git', content.includes('.git'), 'Missing .git in .dockerignore');
  check('.dockerignore excludes SQLite database files', content.includes('*.sqlite*'), 'Missing *.sqlite* in .dockerignore');
  check('.dockerignore excludes transient runs', content.includes('storage/runs/*'), 'Missing storage/runs/* in .dockerignore');
}

// 4. Verify package.json helper scripts
const pkgPath = path.resolve(process.cwd(), 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
check('package.json has docker:build script', Boolean(pkg.scripts['docker:build']), 'Missing docker:build in package.json');
check('package.json has docker:dashboard script', Boolean(pkg.scripts['docker:dashboard']), 'Missing docker:dashboard in package.json');
check('package.json has docker:test script', Boolean(pkg.scripts['docker:test']), 'Missing docker:test in package.json');

console.log('\n======================================================');
if (failed) {
  console.error('  [FAIL] PHASE 4 VERIFICATION FAILED');
  console.log('======================================================\n');
  process.exit(1);
} else {
  console.log('  [PASS] ALL PHASE 4 DELIVERABLES VERIFIED SUCCESSFULLY');
  console.log('======================================================\n');
  process.exit(0);
}
