import http from 'node:http';

// The demo site used by `npm run demo`, as the visual CI target (`npm run demo:serve`)
// and by the GitHub Pages build (`npm run demo:pages`). Deliberately static so
// screenshots are deterministic.

export const DEMO_PORT = Number(process.env.DEMO_PORT) || 4567;

/**
 * 'original': the page the committed CI baselines were captured from (keep byte-identical).
 * 'regressed': unintended changes (red heading, purple off-center button).
 * 'redesign': an intentional change (pill-shaped, wider button with more space above it),
 * used by the GitHub Pages demo as the change that gets approved. 'regressed' shares that
 * spacing and button shape, so comparing it to the approved redesign shows only the bugs.
 */
export const DEMO_VARIANTS = ['original', 'regressed', 'redesign'];

/**
 * @param {boolean|string} [variant] - A DEMO_VARIANTS name; booleans are the older API
 *   (true = 'regressed', false = 'original').
 * @returns {'original'|'regressed'|'redesign'}
 */
export function normalizeDemoVariant(variant) {
  if (variant === true) return 'regressed';
  if (variant === false || variant === undefined || variant === null) return 'original';
  if (DEMO_VARIANTS.includes(variant)) return variant;
  throw new Error(`Unknown demo variant "${variant}" (expected one of ${DEMO_VARIANTS.join(', ')})`);
}

/**
 * @param {boolean|'original'|'regressed'|'redesign'} [variant='original']
 */
export function renderDemoHtml(variant = 'original') {
  const name = normalizeDemoVariant(variant);
  if (name === 'redesign') return REDESIGN_HTML;
  if (name === 'original') {
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

// Intentional redesign: pill-shaped, wider button with more space above it.
const REDESIGN_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Visual CI Demo</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0B1020; color: #F8FAFC; margin: 0; padding: 60px 40px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; }
    .card { background: #151F33; border: 1px solid #26344D; border-radius: 16px; padding: 48px; max-width: 600px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
    h1 { font-size: 32px; margin-top: 0; color: #38BDF8; font-weight: 700; }
    p { font-size: 16px; color: #94A3B8; line-height: 1.6; margin-bottom: 48px; }
    .btn { display: inline-block; background: #2997FF; color: white; padding: 14px 44px; border-radius: 20px; text-decoration: none; font-weight: 600; font-size: 15px; }
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

/**
 * @param {() => (boolean|string)} [getVariant] - Called per request; returns a DEMO_VARIANTS
 *   name, or a boolean (true serves the regressed variant) as in earlier versions.
 */
export function createDemoServer(getVariant = () => 'original') {
  return http.createServer((req, res) => {
    let html;
    try {
      html = renderDemoHtml(getVariant());
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err.message);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
}
