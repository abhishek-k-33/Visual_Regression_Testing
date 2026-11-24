import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { themeTokens, makeResolver, parseColor, contrastRatio } from './helpers/css-tokens.js';

const css = fs.readFileSync(path.resolve('src/server/public/css/styles.css'), 'utf8');
const { dark, light, lightOverrides } = themeTokens(css);

const AA_TEXT = 4.5; // normal text
const AA_UI = 3; // large text, UI component boundaries, graphical objects

// Backgrounds text can sit on: page, cards, table, navbar/table header/snapshot header.
const SURFACES = ['--bg-main', '--bg-card', '--bg-surface', '--bg-table', '--bg-secondary'];
// Status pills appear in the runs table, the run header, snapshot headers and history.
const PILL_SURFACES = ['--bg-table', '--bg-surface', '--bg-secondary'];

/** [description, foreground, background layers (top first, opaque last), minimum ratio] */
const PAIRS = [
  ...['--text-primary', '--text-secondary', '--text-muted'].flatMap((fg) =>
    SURFACES.map((bg) => [`${fg} on ${bg}`, fg, [bg], AA_TEXT])),
  ...['--primary-blue', '--bright-cyan'].flatMap((fg) =>
    SURFACES.map((bg) => [`link ${fg} on ${bg}`, fg, [bg], AA_TEXT])),
  ...['--success-green', '--error-red', '--status-new-text', '--status-approved-text'].flatMap((fg) =>
    ['--bg-table', '--bg-surface', '--bg-secondary'].map((bg) => [`count/label ${fg} on ${bg}`, fg, [bg], AA_TEXT])),
  ...[
    ['passed', '--status-passed-text', '--status-passed-bg'],
    ['approved', '--status-approved-text', '--status-approved-bg'],
    ['failed', '--status-failed-text', '--status-failed-bg'],
    ['rejected', '--status-failed-text', '--status-rejected-bg'],
    ['new', '--status-new-text', '--status-new-bg']
  ].flatMap(([name, fg, tint]) =>
    PILL_SURFACES.map((bg) => [`${name} pill on ${tint} over ${bg}`, fg, [tint, bg], AA_TEXT])),
  // Tinted buttons and links: Inspect, Approve, Reject, History
  ['Inspect button', '--primary-on-tint', ['--primary-tint-bg', '--bg-table'], AA_TEXT],
  ['Inspect-style button on a card (history "View current baseline")', '--primary-on-tint', ['--primary-tint-bg', '--bg-surface'], AA_TEXT],
  ['History link (hover)', '--primary-blue', ['--primary-tint-bg', '--bg-secondary'], AA_TEXT],
  ['Approve button', '--success-green', ['--success-tint-bg', '--bg-secondary'], AA_TEXT],
  ['Approve all button', '--success-green', ['--success-tint-bg', '--bg-surface'], AA_TEXT],
  ['Reject button', '--error-red', ['--danger-tint-bg', '--bg-secondary'], AA_TEXT],
  // Imported runs (M2): "Imported" badge in the runs table and run header; stale-baseline notice
  ['Imported badge in the runs table', '--primary-on-tint', ['--primary-tint-bg', '--bg-table'], AA_TEXT],
  ['Imported badge in the run header', '--primary-on-tint', ['--primary-tint-bg', '--bg-surface'], AA_TEXT],
  ['stale-baseline notice', '--text-primary', ['--status-new-bg', '--bg-surface'], AA_TEXT],
  // Hover states: text on a solid accent fill
  ['hovered Inspect', '--on-accent', ['--primary-blue'], AA_TEXT],
  ['hovered Approve', '--on-accent', ['--success-green'], AA_TEXT],
  ['hovered Reject', '--on-accent', ['--error-red'], AA_TEXT],
  ['slider handle glyph', '--on-accent', ['--primary-blue'], AA_UI],
  // Static demo banner (tinted strip over the page)
  ['demo banner text', '--text-secondary', ['--status-new-bg', '--bg-main'], AA_TEXT],
  ['demo banner tag', '--status-new-text', ['--status-new-bg', '--bg-main'], AA_TEXT],
  ['demo banner link', '--bright-cyan', ['--status-new-bg', '--bg-main'], AA_TEXT],
  // KPI cards: labels (15px) and values (36px bold = large) on both gradient ends
  ...['blue', 'green', 'red'].flatMap((c) => ['start', 'end'].flatMap((end) => [
    [`KPI label on ${c} ${end}`, '--kpi-label', [`--kpi-${c}-${end}`], AA_TEXT],
    [`KPI value on ${c} ${end}`, c === 'blue' ? '--kpi-value' : `--kpi-value-${c}`, [`--kpi-${c}-${end}`], AA_UI]
  ])),
  ['active filter tab', '--text-primary', ['--tab-active-bg'], AA_TEXT],
  // UI components
  ['search box / toggle border on page', '--control-border', ['--bg-main'], AA_UI],
  ['search box / toggle border on navbar', '--control-border', ['--bg-secondary'], AA_UI],
  ['active tab underline', '--primary-blue', ['--bg-table'], AA_UI]
];

describe('theme tokens (styles.css)', () => {
  it('the light theme overrides every colour token of the dark default', () => {
    const isColourToken = (value) => /#[0-9a-f]{3,8}\b|rgba?\(|var\(--/i.test(value) && !/^var\(--font|cubic-bezier/.test(value);
    const colourTokens = Object.keys(dark).filter((name) => isColourToken(dark[name]));
    // Aliases that only point at another token follow it automatically.
    const aliases = colourTokens.filter((name) => /^var\(--[A-Za-z0-9-]+\)$/.test(dark[name].trim()));
    const missing = colourTokens.filter((name) => !aliases.includes(name) && !(name in lightOverrides));
    expect(missing).toEqual([]);
    expect(colourTokens.length).toBeGreaterThan(60);
  });

  it('declares color-scheme for each theme', () => {
    expect(css).toMatch(/(^|\s):root\s*\{[^}]*color-scheme:\s*dark/);
    expect(css).toMatch(/:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/);
  });

  it('keeps raw colours out of the rules (they live in the token blocks)', () => {
    const rules = css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/:root(\[data-theme="light"\])?\s*\{[^}]*\}/g, '');
    expect(rules.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) || []).toEqual([]);
  });

  it('resolves every token in both themes', () => {
    for (const tokens of [dark, light]) {
      const { color } = makeResolver(tokens);
      for (const [, fg, layers] of PAIRS) {
        expect(() => color(fg)).not.toThrow();
        for (const layer of layers) expect(() => color(layer)).not.toThrow();
      }
    }
  });
});

describe('WCAG contrast math', () => {
  it('matches known reference ratios', () => {
    expect(contrastRatio(parseColor('#000'), parseColor('#fff'))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor('#777'), parseColor('#fff'))).toBeCloseTo(4.48, 2);
    expect(contrastRatio(parseColor('#fff'), parseColor('#fff'))).toBe(1);
  });

  it('parses hex and rgba colours', () => {
    expect(parseColor('#0B1020')).toEqual({ r: 11, g: 16, b: 32, a: 1 });
    expect(parseColor('rgba(16, 185, 129, 0.14)')).toEqual({ r: 16, g: 185, b: 129, a: 0.14 });
  });
});

/** Pairs below their minimum, as readable strings (empty when the theme passes). */
function contrastFailures(tokens) {
  const { ratio } = makeResolver(tokens);
  return PAIRS
    .map(([label, fg, layers, min]) => ({ label, min, value: ratio(fg, layers) }))
    .filter(({ value, min }) => value < min)
    .map(({ label, min, value }) => `${label}: ${value.toFixed(2)}:1 (needs ${min}:1)`);
}

describe('WCAG AA contrast of the key token pairs', () => {
  it.each([['dark', dark], ['light', light]])(`%s theme: all ${PAIRS.length} pairs pass`, (_name, tokens) => {
    expect(contrastFailures(tokens)).toEqual([]);
  });

  it('would have caught the pre-M6 dark palette', () => {
    const old = { ...dark, '--text-muted': '#64748B', '--error-red': '#F43F5E', '--status-approved-text': 'var(--approved-purple)', '--kpi-label': 'var(--text-secondary)' };
    const failures = contrastFailures(old).join('\n');
    expect(failures).toMatch(/--text-muted on --bg-main: 3\.98:1/);
    expect(failures).toMatch(/--text-muted on --bg-card: 3\.46:1/);
    expect(failures).toMatch(/approved pill/);
    expect(failures).toMatch(/failed pill/);
    expect(failures).toMatch(/KPI label on blue end/);
  });
});
