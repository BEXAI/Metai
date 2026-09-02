import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, hashJson, sha256Hex } from '../canonical.ts';

describe('canonicalJson', () => {
  it('sorts object keys and strips whitespace', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { y: [1, 2], x: null }, a: 'hi' })).toBe('{"a":"hi","z":{"x":null,"y":[1,2]}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('sorts keys by UTF-16 code units', () => {
    expect(canonicalJson({ é: 1, z: 2, A: 3 })).toBe('{"A":3,"z":2,"é":1}');
  });

  it('is insensitive to key insertion order', () => {
    const a: Record<string, number> = {};
    a.x = 1;
    a.y = 2;
    const b: Record<string, number> = {};
    b.y = 2;
    b.x = 1;
    expect(hashJson(a)).toBe(hashJson(b));
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalJson(Number.NaN)).toThrow();
  });

  it('serializes numbers exactly like JSON.stringify', () => {
    for (const n of [0, -0, 7.5, 1e21, 1e-7, 123456789.123]) {
      expect(canonicalJson(n)).toBe(JSON.stringify(n));
    }
  });

  it('sha256Hex agrees with node:crypto', () => {
    for (const input of ['', 'ludus', '{"a":2,"b":1}', 'unicode: é☃']) {
      const expected = createHash('sha256').update(input, 'utf8').digest('hex');
      expect(sha256Hex(input)).toBe(expected);
    }
  });

  it('hashJson is stable', () => {
    const h = hashJson({ game: 'chess', turn: 3, board: ['r', 'n', null] });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashJson({ turn: 3, board: ['r', 'n', null], game: 'chess' })).toBe(h);
  });
});
