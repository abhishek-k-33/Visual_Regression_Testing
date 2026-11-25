import os from 'node:os';
import path from 'node:path';

/**
 * Turning values into text that is safe to print or publish (the JSON result can end
 * up in a PR comment, where GitHub does not mask secrets). No imports from the rest of
 * the project, so config.js and capture.js can use it without an import cycle.
 */

const SECRET_PARAMS = new Set([
  'token', 'access_token', 'auth', 'key', 'apikey', 'api_key', 'password', 'secret', 'sig', 'signature'
]);
export const REDACTED = '***';

/**
 * A URL without its username/password, and with the values of token-like query
 * parameters (token, access_token, auth, key, apikey, api_key, password, secret, sig,
 * signature; any case) replaced by ***. Text that is not a URL is returned unchanged.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function redactUrl(value) {
  const text = String(value ?? '');
  let url;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  let changed = false;
  if (url.username || url.password) {
    url.username = '';
    url.password = '';
    changed = true;
  }
  if (url.search) {
    const pairs = url.search.slice(1).split('&').map((pair) => {
      const eq = pair.indexOf('=');
      const rawName = eq === -1 ? pair : pair.slice(0, eq);
      let name;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, ' '));
      } catch {
        name = rawName;
      }
      if (eq === -1 || !SECRET_PARAMS.has(name.toLowerCase())) return pair;
      changed = true;
      return `${rawName}=${REDACTED}`;
    });
    if (changed) url.search = `?${pairs.join('&')}`;
  }
  if (!changed) return text;
  let out = url.href;
  // new URL() adds a "/" path to "http://host"; don't let redaction change that.
  if (url.pathname === '/' && !url.search && !url.hash && !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\//i.test(text)) {
    out = out.replace(/\/$/, '');
  }
  return out;
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

/**
 * Redacts every URL found in a piece of text (e.g. an error message that quotes one).
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactUrlsInText(text) {
  return String(text ?? '').replace(URL_IN_TEXT, (match) => {
    // Trailing punctuation is usually the sentence, not the URL.
    const [, url, tail] = match.match(/^(.*?)([.,;:)\]]*)$/);
    return redactUrl(url) + tail;
  });
}

/**
 * A path for display or the JSON result: relative to cwd with "/" separators, or
 * absolute (still with "/") when it lies outside cwd. null stays null.
 *
 * @param {string|null|undefined} file
 * @param {string} [cwd=process.cwd()]
 * @returns {string|null}
 */
export function toDisplayPath(file, cwd = process.cwd()) {
  if (!file) return null;
  const abs = path.resolve(cwd, file);
  const rel = path.relative(cwd, abs);
  if (rel === '') return '.';
  const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return (outside ? abs : rel).split(path.sep).join('/');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces the working directory with "." and the home directory with "~" in text,
 * so a message doesn't reveal (or depend on) where the workspace lives on this host
 * or in this container. Only whole path prefixes are replaced ("/work/app" in
 * "/work/apple" is left alone).
 *
 * @param {unknown} text
 * @param {{ cwd?: string, home?: string }} [options]
 * @returns {string}
 */
export function redactLocalPaths(text, { cwd = process.cwd(), home = os.homedir() } = {}) {
  let out = String(text ?? '');
  for (const [dir, replacement] of [[cwd, '.'], [home, '~']]) {
    if (!dir || path.parse(dir).root === dir) continue; // never replace a bare "/" or "C:\"
    const variants = new Set([dir, dir.split(path.sep).join('/')]);
    for (const variant of variants) {
      out = out.replace(new RegExp(`${escapeRegExp(variant)}(?=$|[\\\\/\\s"'):,;]|\\.(?:$|\\s))`, 'g'), replacement);
    }
  }
  return out;
}
