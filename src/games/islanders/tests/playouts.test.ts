import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../crypto/canonical.ts';
import { finalHashOfPlayout, runPlayouts } from '../../../kernel/playout.ts';
import type { AnyGame } from '../../../kernel/types.ts';
import islanders from '../index.ts';

const game = islanders as unknown as AnyGame;

describe('islanders playouts (gate A1 local)', () => {
  it('200 random playouts terminate legally at 3 players', { timeout: 600_000 }, () => {
    const stats = runPlayouts(game, { games: 200, seedPrefix: 'isl3', players: 3 });
    expect(stats.games).toBe(200);
    expect(stats.minMoves).toBeGreaterThan(12); // at least setup + some turns
    // every game ends by points or the 100-round limit
    const reasons = Object.keys(stats.reasons).sort();
    for (const r of reasons) expect(['points', 'turn_limit']).toContain(r);
  });

  it('200 random playouts terminate legally at 4 players', { timeout: 600_000 }, () => {
    const stats = runPlayouts(game, { games: 200, seedPrefix: 'isl4', players: 4 });
    expect(stats.games).toBe(200);
  });

  it('50 random playouts on the random layout variant', { timeout: 600_000 }, () => {
    const stats = runPlayouts(game, { games: 50, seedPrefix: 'islrand', players: 3, variant: { layout: 'random' } });
    expect(stats.games).toBe(50);
  });
});

describe('islanders determinism (gate A2 local half)', () => {
  it('identical seeds give identical final hashes', { timeout: 600_000 }, () => {
    const seedHex = sha256Hex('islanders-det-seed');
    const pickerHex = sha256Hex('islanders-det-picker');
    const a = finalHashOfPlayout(game, seedHex, pickerHex, 3);
    const b = finalHashOfPlayout(game, seedHex, pickerHex, 3);
    expect(a.hash).toBe(b.hash);
    expect(a.moves).toBe(b.moves);
    const c = finalHashOfPlayout(game, seedHex, pickerHex, 4);
    const d = finalHashOfPlayout(game, seedHex, pickerHex, 4);
    expect(c.hash).toBe(d.hash);
    expect(c.hash).not.toBe(a.hash);
  });
});
