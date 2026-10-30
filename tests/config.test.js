import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { validateConfig, loadConfig } from '../src/cli/config.js';

describe('Configuration Validator (validateConfig)', () => {
  const validBaseConfig = {
    baseUrl: 'https://example.com',
    routes: ['/'],
    viewports: [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 375, height: 812 }
    ],
    maskSelectors: ['.timestamp'],
    threshold: 0.01
  };

  it('validates and normalizes a fully populated valid configuration', () => {
    const result = validateConfig(validBaseConfig);
    expect(result.baseUrl).toBe('https://example.com');
    expect(result.routes).toEqual(['/']);
    expect(result.viewports).toHaveLength(2);
    expect(result.maskSelectors).toEqual(['.timestamp']);
    expect(result.threshold).toBe(0.01);
    expect(result.storageDir).toBe('storage');
  });

  it('strips trailing slashes from baseUrl for clean concatenation', () => {
    const result = validateConfig({ ...validBaseConfig, baseUrl: 'https://example.com///' });
    expect(result.baseUrl).toBe('https://example.com');
  });

  it('automatically adds leading slash to routes if omitted', () => {
    const result = validateConfig({ ...validBaseConfig, routes: ['about', 'pricing/plans'] });
    expect(result.routes).toEqual(['/about', '/pricing/plans']);
  });

  it('applies default values for optional maskSelectors and threshold', () => {
    const result = validateConfig({
      baseUrl: 'http://localhost:3000',
      routes: ['/'],
      viewports: [{ name: 'desktop', width: 1280, height: 720 }]
    });
    expect(result.maskSelectors).toEqual([]);
    expect(result.threshold).toBe(0.01);
  });

  it('rejects non-object configurations', () => {
    expect(() => validateConfig(null)).toThrow('Configuration must be a valid JSON object.');
    expect(() => validateConfig('string')).toThrow('Configuration must be a valid JSON object.');
    expect(() => validateConfig([])).toThrow('Configuration must be a valid JSON object.');
  });

  it('rejects missing or invalid baseUrl', () => {
    expect(() => validateConfig({ ...validBaseConfig, baseUrl: '' })).toThrow('"baseUrl" is required');
    expect(() => validateConfig({ ...validBaseConfig, baseUrl: 123 })).toThrow('"baseUrl" is required');
    expect(() => validateConfig({ ...validBaseConfig, baseUrl: 'not-a-url' })).toThrow('must be a valid URL');
    expect(() => validateConfig({ ...validBaseConfig, baseUrl: 'ftp://example.com' })).toThrow('protocol must be http: or https:');
  });

  it('rejects empty or invalid routes', () => {
    expect(() => validateConfig({ ...validBaseConfig, routes: [] })).toThrow('"routes" must be a non-empty array');
    expect(() => validateConfig({ ...validBaseConfig, routes: 'not-an-array' })).toThrow('"routes" must be a non-empty array');
    expect(() => validateConfig({ ...validBaseConfig, routes: ['/ok', '  '] })).toThrow('must be a non-empty string');
    expect(() => validateConfig({ ...validBaseConfig, routes: [123] })).toThrow('must be a non-empty string');
  });

  it('rejects empty or invalid viewports', () => {
    expect(() => validateConfig({ ...validBaseConfig, viewports: [] })).toThrow('"viewports" must be a non-empty array');
    expect(() => validateConfig({ ...validBaseConfig, viewports: [{ name: '', width: 100, height: 100 }] })).toThrow('non-empty "name"');
    expect(() => validateConfig({ ...validBaseConfig, viewports: [{ name: 'v1', width: 0, height: 100 }] })).toThrow('positive integer');
    expect(() => validateConfig({ ...validBaseConfig, viewports: [{ name: 'v1', width: -10, height: 100 }] })).toThrow('positive integer');
    expect(() => validateConfig({ ...validBaseConfig, viewports: [{ name: 'v1', width: 100.5, height: 100 }] })).toThrow('positive integer');
    expect(() => validateConfig({ ...validBaseConfig, viewports: [{ name: 'v1', width: 100, height: 0 }] })).toThrow('positive integer');
  });

  it('rejects duplicate or invalid viewport names', () => {
    expect(() => validateConfig({
      ...validBaseConfig,
      viewports: [
        { name: 'desktop', width: 1440, height: 900 },
        { name: 'desktop', width: 1920, height: 1080 }
      ]
    })).toThrow('Duplicate viewport name "desktop" found.');

    expect(() => validateConfig({
      ...validBaseConfig,
      viewports: [{ name: 'desktop/wide', width: 1440, height: 900 }]
    })).toThrow('may only contain alphanumeric characters, hyphens, and underscores');
  });

  it('rejects invalid maskSelectors', () => {
    expect(() => validateConfig({ ...validBaseConfig, maskSelectors: 'not-an-array' })).toThrow('must be an array of CSS selector strings');
    expect(() => validateConfig({ ...validBaseConfig, maskSelectors: [''] })).toThrow('must be a non-empty string');
    expect(() => validateConfig({ ...validBaseConfig, maskSelectors: [123] })).toThrow('must be a non-empty string');
    expect(() => validateConfig({ ...validBaseConfig, maskSelectors: ['body { color: red; }'] })).toThrow('contains invalid characters');
  });

  it('rejects out-of-range or invalid threshold values', () => {
    expect(() => validateConfig({ ...validBaseConfig, threshold: -0.01 })).toThrow('"threshold" must be a number between 0 and 1');
    expect(() => validateConfig({ ...validBaseConfig, threshold: 1.05 })).toThrow('"threshold" must be a number between 0 and 1');
    expect(() => validateConfig({ ...validBaseConfig, threshold: '0.05' })).toThrow('"threshold" must be a number between 0 and 1');
    expect(() => validateConfig({ ...validBaseConfig, threshold: NaN })).toThrow('"threshold" must be a number between 0 and 1');
  });
});

describe('Configuration Loader (loadConfig)', () => {
  it('loads and validates the root visual.config.json file successfully', () => {
    const config = loadConfig();
    expect(config.baseUrl).toBe('https://example.com');
    expect(config.routes).toEqual(['/']);
    expect(config.viewports).toHaveLength(2);
    expect(config.threshold).toBe(0.01);
  });

  it('throws an error if configuration file is missing', () => {
    expect(() => loadConfig('non-existent-config.json')).toThrow('Configuration file not found at:');
  });

  it('applies CLI overrides on top of file configuration', () => {
    const config = loadConfig(undefined, {
      baseUrl: 'http://localhost:8080',
      threshold: 0.05
    });
    expect(config.baseUrl).toBe('http://localhost:8080');
    expect(config.threshold).toBe(0.05);
  });
});
