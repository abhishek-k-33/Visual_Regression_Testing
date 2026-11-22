import { describe, it, expect } from 'vitest';
import { normalizeBase, makeUrl, pageLocals } from '../src/server/urls.js';

describe('base-path URL helpers', () => {
  it('normalizes the base: leading slash added, trailing slashes removed, empty stays empty', () => {
    expect(normalizeBase('')).toBe('');
    expect(normalizeBase(undefined)).toBe('');
    expect(normalizeBase('/')).toBe('');
    expect(normalizeBase('/x/')).toBe('/x');
    expect(normalizeBase('Visual_Regression_Testing')).toBe('/Visual_Regression_Testing');
    expect(normalizeBase(' /a/b// ')).toBe('/a/b');
  });

  it('makeUrl prefixes local paths and maps a missing path to an empty string', () => {
    expect(makeUrl('')('/css/styles.css')).toBe('/css/styles.css');
    expect(makeUrl('/x/')('/runs/a')).toBe('/x/runs/a');
    expect(makeUrl('x')('/')).toBe('/x/');
    expect(makeUrl('/x')(null)).toBe('');
    expect(makeUrl('/x')('')).toBe('');
  });

  it('pageLocals keeps base, mode and url() consistent and rejects unknown modes', () => {
    const locals = pageLocals({ base: 'demo/', mode: 'static' });
    expect(locals.base).toBe('/demo');
    expect(locals.mode).toBe('static');
    expect(locals.url('/js/common.js')).toBe('/demo/js/common.js');
    expect(pageLocals()).toMatchObject({ base: '', mode: 'live' });
    expect(() => pageLocals({ mode: 'preview' })).toThrow(/Unknown page mode/);
  });
});
