import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PORT = 4567;
let isMutated = false;

function renderHtml() {
  if (!isMutated) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Visual CI Demo</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0B1020; color: #F8FAFC; margin: 0; padding: 60px 40px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; }
    .card { background: #151F33; border: 1px solid #26344D; border-radius: 16px; padding: 48px; max-width: 600px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
    h1 { font-size: 32px; margin-top: 0; color: #38BDF8; font-weight: 700; }
    p { font-size: 16px; color: #94A3B8; line-height: 1.6; margin-bottom: 32px; }
    .btn { display: inline-block; background: #2997FF; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Visual CI Live Demonstration</h1>
    <p>This is the original, verified baseline master. The button is centered and the theme is tuned for modern developer tools.</p>
    <a href="#" class="btn">Deploy to Production</a>
  </div>
</body>
</html>`;
  }

  // Mutated version with unexpected visual layout shift & color regression
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Visual CI Demo</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0B1020; color: #F8FAFC; margin: 0; padding: 60px 40px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; }
    .card { background: #151F33; border: 1px solid #26344D; border-radius: 16px; padding: 48px; max-width: 600px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
    h1 { font-size: 32px; margin-top: 0; color: #F43F5E; font-weight: 700; } /* Regression: color turned red */
    p { font-size: 16px; color: #94A3B8; line-height: 1.6; margin-bottom: 48px; } /* Regression: spacing shifted */
    .btn { display: inline-block; background: #8B5CF6; color: white; padding: 14px 44px; margin-left: 60px; border-radius: 20px; text-decoration: none; font-weight: 600; font-size: 15px; } /* Regression: shifted right, purple, pill shape */
  </style>
</head>
<body>
  <div class="card">
    <h1>Visual CI Live Demonstration</h1>
    <p>This is the original, verified baseline master. The button is centered and the theme is tuned for modern developer tools.</p>
    <a href="#" class="btn">Deploy to Production</a>
  </div>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(renderHtml());
});

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
        '--base-url', `http://127.0.0.1:${PORT}`,
        '--run-id', demoRun2
      ]);
      console.log('  Test finished without errors.');
    } catch (testErr) {
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
