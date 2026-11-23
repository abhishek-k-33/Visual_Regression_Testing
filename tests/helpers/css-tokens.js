/**
 * Pure-JS helpers for the theme contrast test: read colour custom properties out of
 * styles.css, resolve var() references per theme, and compute WCAG 2.x contrast.
 * No dependencies; only handles what styles.css uses (hex, rgb()/rgba(), var()).
 */

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations (`--name: value`) of the first top-level rule whose selector is exactly `selector`. */
export function readCustomProperties(css, selector) {
  const clean = stripComments(css);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(clean);
  if (!m) throw new Error(`No "${selector}" rule found`);
  const props = {};
  for (const decl of m[1].split(';')) {
    const d = /^\s*(--[A-Za-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
    if (d) props[d[1]] = d[2];
  }
  return props;
}

/**
 * Token maps for both themes: dark is `:root` (the no-JS default), light is `:root`
 * overridden by `:root[data-theme="light"]`.
 */
export function themeTokens(css) {
  const dark = readCustomProperties(css, ':root');
  const lightOverrides = readCustomProperties(css, ':root[data-theme="light"]');
  return { dark, light: { ...dark, ...lightOverrides }, lightOverrides };
}

/** Replaces var(--x[, fallback]) recursively. */
export function resolveValue(tokens, value, depth = 0) {
  if (depth > 20) throw new Error(`var() cycle while resolving "${value}"`);
  return value.replace(/var\(\s*(--[A-Za-z0-9-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name, fallback) => {
    if (name in tokens) return resolveValue(tokens, tokens[name], depth + 1);
    if (fallback !== undefined) return resolveValue(tokens, fallback, depth + 1);
    throw new Error(`Undefined custom property ${name}`);
  });
}

/** '#rgb' | '#rrggbb' | '#rrggbbaa' | 'rgb(...)' | 'rgba(...)' -> { r, g, b, a } (0-255, alpha 0-1). */
export function parseColor(input) {
  const value = input.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
    if (hex.length !== 6 && hex.length !== 8) throw new Error(`Bad hex colour ${value}`);
    const n = (i) => parseInt(hex.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(value);
  if (m) {
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[4] && m[4].endsWith('%')) a /= 100;
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  throw new Error(`Unsupported colour "${value}"`);
}

/** Paints `top` (possibly translucent) over an opaque `bottom`. */
export function composite(top, bottom) {
  const a = top.a;
  const mix = (t, b) => t * a + b * (1 - a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

export function relativeLuminance({ r, g, b }) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(fg, bg) {
  const [hi, lo] = [relativeLuminance(fg), relativeLuminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Resolves a colour expression in a theme. `layers` lists backgrounds from the top
 * down to an opaque base: ['--status-passed-bg', '--bg-table'] means the pill tint
 * painted over the table background.
 */
export function makeResolver(tokens) {
  const color = (expr) => parseColor(resolveValue(tokens, expr.startsWith('--') ? `var(${expr})` : expr));
  const flatten = (layers) => {
    const list = Array.isArray(layers) ? layers : [layers];
    let base = color(list[list.length - 1]);
    if (base.a !== 1) throw new Error(`Bottom layer ${list[list.length - 1]} is not opaque`);
    for (let i = list.length - 2; i >= 0; i--) base = composite(color(list[i]), base);
    return base;
  };
  return {
    color,
    flatten,
    ratio(fg, bgLayers) {
      const bg = flatten(bgLayers);
      const f = color(fg);
      return contrastRatio(f.a === 1 ? f : composite(f, bg), bg);
    }
  };
}
