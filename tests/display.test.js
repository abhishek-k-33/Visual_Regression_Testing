import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { redactUrl, redactUrlsInText, redactLocalPaths, toDisplayPath } from '../src/cli/display.js';
import { sanitizeMessage, buildResult } from '../src/cli/result.js';

describe('redactUrl', () => {
  it('strips the username and password', () => {
    expect(redactUrl('http://user:s3cret@example.test:8080/app')).toBe('http://example.test:8080/app');
    expect(redactUrl('http://user:s3cret@example.test')).toBe('http://example.test');
    expect(redactUrl('https://only-user@example.test/')).toBe('https://example.test/');
  });

  it('redacts token-like query values, whatever their case, and keeps the rest', () => {
    for (const name of ['token', 'access_token', 'auth', 'key', 'apikey', 'api_key', 'password', 'secret', 'sig', 'signature', 'TOKEN', 'Api_Key']) {
      const out = redactUrl(`https://example.test/p?${name}=abc123&page=2`);
      expect(out, name).toBe(`https://example.test/p?${name}=***&page=2`);
    }
    expect(redactUrl('http://example.test/?tokens=keep&monkey=keep')).toBe('http://example.test/?tokens=keep&monkey=keep');
  });

  it('leaves URLs without secrets, and non-URLs, exactly as they were', () => {
    expect(redactUrl('http://127.0.0.1:4567')).toBe('http://127.0.0.1:4567');
    expect(redactUrl('http://example.test/a?b=c%20d')).toBe('http://example.test/a?b=c%20d');
    expect(redactUrl('not a url')).toBe('not a url');
    expect(redactUrl(undefined)).toBe('');
  });

  it('finds URLs inside text (error messages)', () => {
    const text = 'page.goto: net::ERR_EMPTY_RESPONSE at http://user:s3cret@127.0.0.1:9/?token=abc/.\nCall log: navigating to "http://user:s3cret@127.0.0.1:9/?token=abc/"';
    const out = redactUrlsInText(text);
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('abc');
    expect(out).toContain('at http://127.0.0.1:9/?token=***.');
    expect(sanitizeMessage(text)).not.toMatch(/s3cret|abc/);
  });

  it('keeps credentials out of base_url in the JSON result', () => {
    const result = buildResult({ run: { id: 'r', baseUrl: 'http://user:s3cret@example.test?key=abc' } });
    expect(result.run.base_url).toBe('http://example.test/?key=***');
  });
});

describe('redactLocalPaths', () => {
  const cwd = path.resolve('/work/app');
  const home = path.resolve('/home/me');
  it('replaces the working directory with "." and the home directory with "~"', () => {
    expect(redactLocalPaths(`not found at ${cwd}${path.sep}visual.config.json`, { cwd, home })).toBe(`not found at .${path.sep}visual.config.json`);
    expect(redactLocalPaths(`doesn't exist at ${home}${path.sep}.cache${path.sep}ms-playwright`, { cwd, home })).toBe(`doesn't exist at ~${path.sep}.cache${path.sep}ms-playwright`);
    expect(redactLocalPaths(`in ${cwd}.`, { cwd, home })).toBe('in ..');
  });

  it('only replaces whole path prefixes, and never a bare root', () => {
    expect(redactLocalPaths(`${cwd}le/x`, { cwd, home })).toBe(`${cwd}le/x`);
    expect(redactLocalPaths('/etc/passwd', { cwd: path.parse(process.cwd()).root, home: path.parse(os.homedir()).root })).toBe('/etc/passwd');
  });
});

describe('toDisplayPath', () => {
  it('is cwd-relative POSIX inside cwd, absolute outside', () => {
    const cwd = path.resolve('/work/app');
    expect(toDisplayPath(path.join(cwd, 'cfg', 'visual.config.json'), cwd)).toBe('cfg/visual.config.json');
    expect(toDisplayPath(path.resolve('/other/x.json'), cwd)).toBe(path.resolve('/other/x.json').split(path.sep).join('/'));
  });
});
