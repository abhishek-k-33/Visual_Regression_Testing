/**
 * Base-path handling for the dashboard's templates.
 *
 * Every local URL in the views goes through url(), so the same templates render at
 * the site root (live server) or under a sub-path (static GitHub Pages build).
 */

/** '' for the site root, otherwise '/segment' with a leading slash and no trailing one. */
export function normalizeBase(base) {
  let normalized = String(base || '').trim().replace(/\/+$/, '');
  if (normalized && !normalized.startsWith('/')) normalized = `/${normalized}`;
  return normalized;
}

/** url() for a given base: prefixes local paths; a missing path stays '' (e.g. no screenshot). */
export function makeUrl(base) {
  const prefix = normalizeBase(base);
  return (p) => (p ? `${prefix}${p}` : '');
}

/**
 * Render locals for a base path and mode, always supplied together so `url()`,
 * `data-base` and `data-mode` can never disagree. Pass these as render options
 * instead of mutating app.locals (which live requests share).
 *
 * @param {{ base?: string, mode?: 'live' | 'static' }} [options]
 */
export function pageLocals({ base = '', mode = 'live' } = {}) {
  if (mode !== 'live' && mode !== 'static') throw new Error(`Unknown page mode "${mode}"`);
  return { base: normalizeBase(base), mode, url: makeUrl(base) };
}
