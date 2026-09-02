/**
 * Go playout gates: A1/A4 (1,000 random 9x9 playouts terminate legally, codec
 * checked every 50 moves by the harness), 13x13/19x19 smoke playouts proving
 * full legal-move lists ship fine, and the local half of gate A2
 * (determinism: identical seeds -> identical final state hash).
 */

import { describe, expect, it } from 'vitest';
import { finalHashOfPlayout, runPlayouts } from '../../../kernel/playout.ts';
import { createSeedStream } from '../../../kernel/seed.ts';
import go from '../index.ts';

describe('go playouts', () => {
  it('1,000 random 9x9 playouts terminate without error', { timeout: 600_000 }, () => {
    const stats = runPlayouts(go, { games: 1000, seedPrefix: 'go-9x9' });
    expect(stats.games).toBe(1000);
    expect(stats.minMoves).toBeGreaterThanOrEqual(2); // at least the two ending passes
    expect(stats.reasons['two_passes']).toBe(1000); // only ending: two passes
  });

  it('13x13 smoke playouts', { timeout: 600_000 }, () => {
    const stats = runPlayouts(go, {
      games: 10,
      seedPrefix: 'go-13',
      variant: { board_size: 13 },
      maxMoves: 40_000,
    });
    expect(stats.games).toBe(10);
  });

  it('19x19 smoke playouts ship all ~361 legal moves per turn', { timeout: 600_000 }, () => {
    const s = go.initialState(createSeedStream('ab'.repeat(32)), ['p0', 'p1'], { board_size: 19 });
    expect(go.legalMoves(s, 'p0')).toHaveLength(362); // 361 plays + pass
    const stats = runPlayouts(go, {
      games: 10,
      seedPrefix: 'go-19',
      variant: { board_size: 19 },
      maxMoves: 40_000,
    });
    expect(stats.games).toBe(10);
  });

  it('same seeds give the same final hash (gate A2, local half)', { timeout: 600_000 }, () => {
    const gameSeed = '12ab'.repeat(16);
    const pickSeed = '34cd'.repeat(16);
    const a = finalHashOfPlayout(go, gameSeed, pickSeed, 2);
    const b = finalHashOfPlayout(go, gameSeed, pickSeed, 2);
    expect(a.hash).toBe(b.hash);
    expect(a.moves).toBe(b.moves);
    const v = { board_size: 13 as const };
    const c = finalHashOfPlayout(go, gameSeed, pickSeed, 2, v);
    const d = finalHashOfPlayout(go, gameSeed, pickSeed, 2, v);
    expect(c.hash).toBe(d.hash);
  });
});
