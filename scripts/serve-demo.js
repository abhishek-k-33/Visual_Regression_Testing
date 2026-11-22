import { createDemoServer, DEMO_PORT } from './demo-app.js';

// Serves the demo site (unmodified variant) for visual tests: `npm run demo:serve`.
const server = createDemoServer();
server.listen(DEMO_PORT, '127.0.0.1', () => {
  console.log(`Demo site listening on http://127.0.0.1:${DEMO_PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
