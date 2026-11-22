/**
 * Shared helpers for the dashboard's ES modules.
 * The server renders <html data-base="..." data-mode="...">; reading them here lets
 * every module build URLs that work when the dashboard is served under a sub-path.
 */

const { dataset } = document.documentElement;

/** Base path the dashboard is served under ('' at the site root), without a trailing slash. */
export const base = (() => {
  const b = (dataset.base || '').trim().replace(/\/+$/, '');
  return b && !b.startsWith('/') ? `/${b}` : b;
})();

/** 'live' (Express server with a writable API) or 'static' (read-only build). */
export const mode = dataset.mode || 'live';

/** URL of an API endpoint, e.g. api('/snapshots/3/approve'). */
export function api(path) {
  return `${base}/api${path}`;
}

/** Reads a message out to screen readers via the page's polite live region. */
export function announce(message) {
  const region = document.getElementById('live-region');
  if (!region) return;
  // Clear first so repeating the same message is announced again.
  region.textContent = '';
  setTimeout(() => {
    region.textContent = message;
  }, 50);
}
