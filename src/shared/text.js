/**
 * Text helpers shared by the CLI, the dashboard server and the GitHub Action scripts.
 *
 * Only plain JavaScript, no imports at all: src/ci/*.js load this module inside
 * actions/github-script straight from the action's checkout (no `npm ci` there), and
 * the CLI's result writer uses it without pulling in the server's dependencies.
 */

// C0/DEL/C1 controls, format characters (bidi overrides U+202A-E, isolates U+2066-9,
// marks U+200E/F, zero-width chars, BOM...), lone surrogates and line/paragraph
// separators: refused in every manifest string and archive entry name, and escaped
// whenever untrusted text is shown (they can rewrite a terminal or disguise text).
export const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_CHARS_GLOBAL = new RegExp(UNSAFE_CHARS.source, 'gu');

/**
 * Makes untrusted text safe to print to a terminal or log: every control, format,
 * surrogate or separator character becomes a visible \u{...} escape.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizeForDisplay(text) {
  return String(text).replace(UNSAFE_CHARS_GLOBAL, (ch) => `\\u{${ch.codePointAt(0).toString(16).toUpperCase()}}`);
}
