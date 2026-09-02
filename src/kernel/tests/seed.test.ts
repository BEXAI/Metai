import { describe, expect, it } from 'vitest';
import { createSeedStream } from '../seed.ts';

const ZERO = '0'.repeat(64);

describe('SeedStream', () => {
  it('matches golden vectors (algorithm is frozen forever)', () => {
    const s = createSeedStream(ZERO);
    expect(s.int('dice:turn:1', 6)).toBe(4);
    expect(s.int('dice:turn:1', 6)).toBe(0);
    expect(s.int('big', 1000)).toBe(671);
    expect(s.die('roll', 6)).toBe(3);
    expect(s.shuffle('deck', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([1, 3, 0, 7, 6, 5, 8, 9, 2, 4]);
    expect(Buffer.from(s.bytes('b', 40)).toString('hex')).toBe(
      '95610f9e7a45e52c770383f993f9d89e8056d4e9e01e05815b64fab64519541bc02c402c07731662',
    );
    expect(s.draws().length).toBe(14); // 4 ints + 9 shuffle ints + 1 bytes
    expect(createSeedStream('ab'.repeat(32)).int('dice:turn:1', 6)).toBe(2);
  });

  it('is deterministic: two streams, same seed, same draws', () => {
    const a = createSeedStream('12ab'.repeat(16));
    const b = createSeedStream('12ab'.repeat(16));
    for (let i = 0; i < 50; i++) {
      expect(a.int('p', 1_000_000)).toBe(b.int('p', 1_000_000));
    }
    expect(a.shuffle('s', [...Array(52).keys()])).toEqual(b.shuffle('s', [...Array(52).keys()]));
    expect(a.draws()).toEqual(b.draws());
  });

  it('different purposes give independent sequences', () => {
    const s = createSeedStream('cd'.repeat(32));
    const seqA = Array.from({ length: 20 }, () => s.int('alpha', 1000));
    const seqB = Array.from({ length: 20 }, () => s.int('beta', 1000));
    expect(seqA).not.toEqual(seqB);
  });

  it('int() stays in range and int(1) is always 0', () => {
    const s = createSeedStream('ef'.repeat(32));
    for (let i = 0; i < 200; i++) {
      const v = s.int('r', 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      expect(s.int('one', 1)).toBe(0);
    }
  });

  it('die() is 1..sides', () => {
    const s = createSeedStream('01'.repeat(32));
    for (let i = 0; i < 100; i++) {
      const v = s.die('d6', 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
  });

  it('shuffle returns a permutation and leaves input untouched', () => {
    const s = createSeedStream('23'.repeat(32));
    const input = [...Array(100).keys()];
    const frozen = input.slice();
    const out = s.shuffle('deck', input);
    expect(input).toEqual(frozen);
    expect(out.slice().sort((x, y) => x - y)).toEqual(frozen);
  });

  it('rejects malformed seeds and bad arguments', () => {
    expect(() => createSeedStream('xyz')).toThrow();
    expect(() => createSeedStream('A'.repeat(64))).toThrow(); // uppercase hex rejected
    const s = createSeedStream('45'.repeat(32));
    expect(() => s.int('p', 0)).toThrow();
    expect(() => s.int('p', 1.5)).toThrow();
    expect(() => s.bytes('p', 0)).toThrow();
  });

  it('logs every draw with purpose and counter', () => {
    const s = createSeedStream('67'.repeat(32));
    s.int('a', 10);
    s.int('a', 10);
    s.int('b', 10);
    const log = s.draws();
    expect(log.map((d) => [d.purpose, d.counter])).toEqual([
      ['a', 0],
      ['a', 1],
      ['b', 0],
    ]);
  });
});
