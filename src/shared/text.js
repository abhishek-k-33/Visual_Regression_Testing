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

/**
 * Untrusted text as a Markdown code span, safe to put into a GitHub comment, a step
 * summary or a table cell. Inside a code span GitHub renders nothing: no @mentions,
 * links, images, HTML, emphasis or emoji shortcodes.
 *
 * - Control, bidi and other invisible characters (newlines included) are escaped
 *   first (sanitizeForDisplay), so the span stays on one line and shows what is there.
 * - The backtick fence is one longer than the longest backtick run in the text, and the
 *   text is padded with a space when it starts or ends with a backtick (or with spaces
 *   on both sides, which CommonMark would otherwise strip), so no text can close it.
 * - With `table` (the default) every `|` becomes `\|`: GitHub splits table cells
 *   before it parses code spans, and shows an escaped pipe as `|` even inside one.
 *   Pass { table: false } outside tables, where `\|` would show the backslash.
 *
 * @param {unknown} text
 * @param {{ table?: boolean }} [options]
 * @returns {string}
 */
export function mdCode(text, { table = true } = {}) {
  let s = sanitizeForDisplay(text ?? '');
  const longest = (s.match(/`+/g) || []).reduce((n, run) => Math.max(n, run.length), 0);
  const fence = '`'.repeat(longest + 1);
  const pad = s === '' || s.startsWith('`') || s.endsWith('`') || (s.startsWith(' ') && s.endsWith(' ') && s.trim() !== '');
  if (pad) s = ` ${s} `;
  if (table) s = s.replace(/\|/g, '\\|');
  return `${fence}${s}${fence}`;
}

/** At most `max` code points of `text` (never splitting a surrogate pair), with … when cut. */
export function truncate(text, max) {
  const chars = Array.from(String(text ?? ''));
  return chars.length <= max ? chars.join('') : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}
