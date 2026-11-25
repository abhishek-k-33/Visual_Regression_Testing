import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDemoServer, DEMO_PORT } from './demo-app.js';

const execFileAsync = promisify(execFile);
const PORT = DEMO_PORT;
// Own config (route /__vrt_demo) so the demo's baselines never overwrite the committed
// CI baselines in storage/baselines (__vrt_demo-*.png are gitignored).
const DEMO_CONFIG = 'scripts/demo.config.json';
let isMutated = false;

const server = createDemoServer(() => isMutated);

server.listen(PORT, '127.0.0.1', async () => {
  console.log('──────────────────────────────────────────────────────');
  console.log('  Visual CI: Interactive Demonstration Runner');
  console.log('──────────────────────────────────────────────────────');
  console.log(`  Demo Fixture App running at http://127.0.0.1:${PORT}`);
  console.log('──────────────────────────────────────────────────────\n');

  try {
    const demoRun1 = `demo_baseline_${Date.now()}`;
    const demoRun2 = `demo_regression_${Date.now()}`;

    console.log('▶ Step 1: Establishing initial golden master baselines...');
    await execFileAsync('node', [
      'src/cli/index.js',
      'test',
      '--config', DEMO_CONFIG,
      '--base-url', `http://127.0.0.1:${PORT}`,
      '--run-id', demoRun1,
      '--update-baselines'
    ]);
    console.log('  ✓ Baseline captured and stored successfully.');

    console.log('\n▶ Step 2: Inducing intentional visual regressions (layout shift + color mutation)...');
    isMutated = true;

    console.log('\n▶ Step 3: Running Visual CI to detect regression...');
    try {
      await execFileAsync('node', [
        'src/cli/index.js',
        'test',
        '--config', DEMO_CONFIG,
        '--base-url', `http://127.0.0.1:${PORT}`,
        '--run-id', demoRun2
      ]);
      console.log('  Test finished without errors.');
    } catch (testErr) {
      // Exit 1 means visual differences; 2 means the run itself failed.
      if (testErr.code !== 1) throw testErr;
      console.log('  ✓ Visual CI detected visual regressions and flagged the run as FAILED!');
      if (testErr.stdout) {
        const lines = testErr.stdout.split('\n');
        const summaryStart = lines.findIndex(l => l.includes('Visual Regression Test Summary'));
        if (summaryStart !== -1) {
          console.log('\n' + lines.slice(summaryStart).join('\n'));
        }
      }
    }

    console.log('══════════════════════════════════════════════════════');
    console.log('  🎯 Interactive Demo Ready! See it live:');
    console.log('══════════════════════════════════════════════════════');
    console.log(`  📊 Main Dashboard : http://localhost:4000`);
    console.log(`  🔍 Inspect Run    : http://localhost:4000/runs/${demoRun2}`);
    console.log('══════════════════════════════════════════════════════');
    console.log('  Try these interactive features on the web page:');
    console.log('  1. Drag the Split Slider left & right to wipe before/after.');
    console.log('  2. Click "Diff Highlight" to see red pixels on the shift.');
    console.log('  3. Click "Approve & Update Baseline" to accept the change!');
    console.log('══════════════════════════════════════════════════════\n');

  } catch (err) {
    console.error('Demo error:', err);
  } finally {
    server.close();
  }
});
