/**
 * Gate A1 (local half): 200+ random playouts terminate legally with the codec
 * checked every 50 moves. Gate A2 (local half): identical seeds produce
 * identical final hashes on two independent runs.
 */

import { describe, expect, it } from 'vitest';
import { finalHashOfPlayout, runPlayouts } from '../../../kernel/playout.ts';
import { sha256Hex } from '../../../crypto/canonical.ts';
import backgammon from '../index.ts';

describe('backgammon playouts', () => {
  it('200 random playouts terminate without illegal states', { timeout: 600_000 }, () => {
    const stats = runPlayouts(backgammon, {
      games: 200,
      seedPrefix: 'bg-t5a',
    });
    expect(stats.games).toBe(200);
    // Both seats should win games under random play.
    expect(stats.winsBySeat['p0'] ?? 0).toBeGreaterThan(0);
    expect(stats.winsBySeat['p1'] ?? 0).toBeGreaterThan(0);
    // Real terminations, not the safety turn limit.
    expect(stats.draws).toBe(0);
    const reasons = Object.keys(stats.reasons);
    expect(reasons.every((r) => ['bearoff', 'gammon', 'backgammon'].includes(r))).toBe(true);
  });

  it('determinism: identical seeds give identical final hashes', { timeout: 120_000 }, () => {
    const seedHex = sha256Hex('bg-determinism-seed');
    const pickHex = sha256Hex('bg-determinism-picker');
    const a = finalHashOfPlayout(backgammon, seedHex, pickHex, 2);
    const b = finalHashOfPlayout(backgammon, seedHex, pickHex, 2);
    expect(a.hash).toBe(b.hash);
    expect(a.moves).toBe(b.moves);
  });
});
