import net from 'node:net';

// Cross-site protections for a dashboard with no authentication.
//
// 1. Host allowlist (all requests): blocks DNS rebinding, where an attacker's
//    domain is re-pointed at 127.0.0.1 so their page becomes "same-origin" with
//    the dashboard and can read and write it freely.
// 2. Same-origin check on writes (non-GET /api requests): blocks classic CSRF,
//    where any website makes the user's browser POST to approve/reject.

export const CSRF_HEADER = 'X-Requested-With';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseHostHeader(hostHeader) {
  if (!hostHeader) return null;
  try {
    // URL lowercases the name and splits off the port; IPv6 keeps its brackets.
    return new URL(`http://${hostHeader}`).hostname.replace(/\.$/, '');
  } catch {
    return null;
  }
}

function extraAllowedHosts() {
  return (process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
}

/**
 * localhost and IP literals are always allowed (an IP cannot be rebound).
 * Any other hostname must be listed in ALLOWED_HOSTS (comma-separated).
 */
export function isAllowedHost(hostHeader) {
  const hostname = parseHostHeader(hostHeader);
  if (!hostname) return false;
  if (hostname === 'localhost') return true;
  if (net.isIP(hostname.replace(/^\[|\]$/g, ''))) return true;
  return extraAllowedHosts().includes(hostname);
}

export function hostAllowlist(req, res, next) {
  if (isAllowedHost(req.headers.host)) return next();
  res.status(403).type('text/plain').send('Host not allowed. Add it to ALLOWED_HOSTS to permit it.');
}

function sameOriginWriteFailure(req) {
  // A custom header cannot be set by an HTML form, and a cross-origin fetch that
  // sets it triggers a CORS preflight, which this server never approves.
  if (!req.get(CSRF_HEADER)) return `missing ${CSRF_HEADER} header`;

  // Modern browsers say outright whether the request is cross-site.
  const fetchSite = req.get('Sec-Fetch-Site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return `Sec-Fetch-Site is ${fetchSite}`;
  }

  // Browsers send Origin on POSTs; non-browser clients (curl, scripts) usually don't.
  const origin = req.get('Origin');
  if (origin !== undefined) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return 'unparseable Origin';
    }
    if (originHost !== req.headers.host) return 'Origin does not match Host';
  }
  return null;
}

export function requireSameOriginForWrites(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const failure = sameOriginWriteFailure(req);
  if (!failure) return next();
  res.status(403).json({ success: false, error: `Cross-site request blocked (${failure})` });
}
