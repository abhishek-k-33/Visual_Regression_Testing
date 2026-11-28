import express from 'express';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import apiRouter from './routes/api.js';
import viewRouter from './routes/views.js';
import { getDb } from './db.js';
import { getStorageRoot, resolvePngInside } from './paths.js';
import { hostAllowlist, requireSameOriginForWrites } from './security.js';
import { makeUrl } from './urls.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Reject requests whose Host header isn't localhost, an IP, or in ALLOWED_HOSTS (DNS rebinding)
app.use(hostAllowlist);

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Every local link in the views goes through url() (see urls.js). The live server
// renders at the site root. To render under a sub-path (the static Pages build),
// pass pageLocals({ base, mode }) as render options rather than changing app.locals,
// so base, mode and url() always agree and live requests are unaffected.
app.locals.base = '';
app.locals.mode = 'live';
app.locals.url = (p) => makeUrl(app.locals.base)(p);

// Static assets
app.use(express.static(path.join(__dirname, 'public')));

// Serve screenshots at /storage. Allowlist: only .png files under runs/ or baselines/.
// Everything else in storage (SQLite DB, summaries, stray files) is refused.
const SERVABLE_STORAGE_PATH = /^\/(runs|baselines)\/[A-Za-z0-9_\-./]+\.png$/i;

app.use('/storage', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  let relPath;
  try {
    relPath = decodeURIComponent(req.path);
  } catch {
    return res.status(400).type('text/plain').send('Bad request');
  }

  // No dot-segments at all: blocks '..' and hidden folders such as an import's
  // temporary runs/.import-* copy or a baseline's .x.png.<id>.bak backup.
  if (!SERVABLE_STORAGE_PATH.test(relPath) || relPath.split('/').some((seg) => seg.startsWith('.'))) {
    return res.status(403).type('text/plain').send('Access denied');
  }

  const storageRoot = getStorageRoot();
  const subDir = relPath.split('/')[1];
  let realFile;
  try {
    realFile = resolvePngInside(path.join(storageRoot, relPath), path.join(storageRoot, subDir));
  } catch (err) {
    return err.message.startsWith('Access denied')
      ? res.status(403).type('text/plain').send('Access denied')
      : res.status(404).type('text/plain').send('Not found');
  }

  const realRoot = fs.realpathSync(storageRoot);
  res.sendFile(path.relative(realRoot, realFile), { root: realRoot }, (err) => {
    if (err && !res.headersSent) res.status(404).type('text/plain').send('Not found');
  });
});

// Route mounting
app.use('/api', requireSameOriginForWrites, apiRouter);
app.use('/', viewRouter);

const LOOPBACK_OR_ANY = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::']);

/** The address to open in a browser for a server listening on host:port. */
export function dashboardUrl(host, port) {
  if (LOOPBACK_OR_ANY.has(host)) return `http://localhost:${port}`;
  return `http://${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
}

/**
 * Opens the database and starts the dashboard. Defaults: PORT env or 4000, and
 * HOST env or 127.0.0.1 (loopback only; HOST=0.0.0.0 exposes it on the network,
 * which Docker does). Prints the URL once it is listening; listen errors (port in
 * use...) are emitted as the returned server's 'error' event.
 *
 * @param {object} [options]
 * @param {number|string} [options.port]
 * @param {string} [options.host]
 * @param {(line: string) => void} [options.log=console.log]
 * @returns {import('node:http').Server}
 */
export function startServer({ port = process.env.PORT || 4000, host = process.env.HOST || '127.0.0.1', log = console.log } = {}) {
  getDb();
  const server = app.listen(port, host, () => {
    const actualPort = server.address().port; // the real one when port 0 was asked for
    log('──────────────────────────────────────────────────────');
    log('  Visual Regression Dashboard running at:');
    log(`  ${dashboardUrl(host, actualPort)}`);
    log(`  (listening on ${host}:${actualPort})`);
    log('──────────────────────────────────────────────────────');
  });
  return server;
}

// Start the server when this file is run directly (node src/server/app.js, npm start;
// also `node src/server/app`, which Node resolves to app.js), not when it is imported.
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fs.realpathSync(__filename);
  return [entry, `${entry}.js`].some((candidate) => {
    try {
      return fs.realpathSync(path.resolve(candidate)) === self;
    } catch {
      return false;
    }
  });
}

if (isMainModule()) startServer();

export default app;
