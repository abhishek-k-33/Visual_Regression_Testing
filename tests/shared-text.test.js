import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { sanitizeForDisplay, UNSAFE_CHARS } from '../src/shared/text.js';
import { sanitizeForDisplay as fromImportRuns } from '../src/server/importRuns.js';

const importsOf = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm)].map((m) => m[1]);

describe('src/shared/text.js', () => {
  it('sanitizeForDisplay escapes C0, DEL, C1, bidi, format and separator characters', () => {
    expect(sanitizeForDisplay('a\u001b[2J\u0007\u007f\u0085\u009b\u200f\u202e\u2066\ufeff\u2028b')).toBe(
      'a\\u{1B}[2J\\u{7}\\u{7F}\\u{85}\\u{9B}\\u{200F}\\u{202E}\\u{2066}\\u{FEFF}\\u{2028}b'
    );
    expect(sanitizeForDisplay('line\nnext\r')).toBe('line\\u{A}next\\u{D}');
    expect(sanitizeForDisplay('plain /route-é ✓ 📸')).toBe('plain /route-é ✓ 📸');
    expect(sanitizeForDisplay(42)).toBe('42');
    expect(UNSAFE_CHARS.test('\u202e')).toBe(true);
    expect(UNSAFE_CHARS.test('ok')).toBe(false);
  });

  it('is still exported from importRuns.js (the same function)', () => {
    expect(fromImportRuns).toBe(sanitizeForDisplay);
  });

  it('has no imports, so github-script can load it from the action checkout without npm ci', () => {
    expect(importsOf('src/shared/text.js')).toEqual([]);
    expect(fs.readFileSync('src/shared/text.js', 'utf8')).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });

  it('the CLI result writer, the CLI and the upload route take it from src/shared, not from the importer', () => {
    // result.js must not pull the dashboard server (and better-sqlite3, yauzl) into `test --json`.
    expect(importsOf('src/cli/result.js').filter((p) => p.includes('/server/'))).toEqual([]);
    expect(fs.readFileSync('src/cli/result.js', 'utf8')).not.toContain('TODO(A3)');
    for (const file of ['src/cli/result.js', 'src/cli/index.js', 'src/server/uploadImport.js']) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).toMatch(/import \{[^}]*\bsanitizeForDisplay\b[^}]*\} from '\.\.\/shared\/text\.js';/);
      expect(text, file).not.toMatch(/import \{[^}]*\bsanitizeForDisplay\b[^}]*\} from '[^']*importRuns\.js'/);
    }
  });
});
