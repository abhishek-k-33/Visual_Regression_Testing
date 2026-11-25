import { createDemoServer, normalizeDemoVariant, DEMO_PORT, DEMO_VARIANTS } from './demo-app.js';

// Serves the demo site for visual tests: `npm run demo:serve`. The original page by
// default (the one the committed baselines show); DEMO_VARIANT=regressed or redesign
// serves a changed page, e.g. for the action self-test (.github/workflows/action-selftest.yml).
let variant;
try {
  variant = normalizeDemoVariant(process.env.DEMO_VARIANT || undefined);
} catch {
  console.error(`DEMO_VARIANT must be one of ${DEMO_VARIANTS.join(', ')}`);
  process.exit(2);
}

const server = createDemoServer(() => variant);
server.listen(DEMO_PORT, '127.0.0.1', () => {
  console.log(`Demo site (${variant}) listening on http://127.0.0.1:${DEMO_PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
