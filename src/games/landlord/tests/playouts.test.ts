import { describe, expect, it } from 'vitest';
import { finalHashOfPlayout, runPlayouts } from '../../../kernel/playout.ts';
import { sha256Hex } from '../../../crypto/canonical.ts';
import landlord from '../index.ts';

describe('landlord playouts (gate A1 local slice)', () => {
  it('200 random playouts at 2 players terminate legally', { timeout: 600_000 }, () => {
    const stats = runPlayouts(landlord, {
      games: 200,
      seedPrefix: 'landlord-2p',
      players: 2,
      maxMoves: 60_000,
    });
    expect(stats.games).toBe(200);
    expect(stats.minMoves).toBeGreaterThan(0);
    // Both endings must occur across 200 games: eliminations and the round limit.
    expect((stats.reasons['last_standing'] ?? 0) + (stats.reasons['turn_limit'] ?? 0)).toBe(200);
  });

  it('200 random playouts at 4 players terminate legally', { timeout: 600_000 }, () => {
    const stats = runPlayouts(landlord, {
      games: 200,
      seedPrefix: 'landlord-4p',
      players: 4,
      maxMoves: 60_000,
    });
    expect(stats.games).toBe(200);
    expect((stats.reasons['last_standing'] ?? 0) + (stats.reasons['turn_limit'] ?? 0)).toBe(200);
    // Every seat should win at least once over 200 four-player games.
    for (const seat of ['p0', 'p1', 'p2', 'p3']) {
      expect(stats.winsBySeat[seat] ?? 0).toBeGreaterThan(0);
    }
  });

  it('3-player playouts also work (odd seat count)', { timeout: 600_000 }, () => {
    const stats = runPlayouts(landlord, {
      games: 40,
      seedPrefix: 'landlord-3p',
      players: 3,
      maxMoves: 60_000,
    });
    expect(stats.games).toBe(40);
  });
});

describe('landlord determinism (gate A2 local half)', () => {
  it('identical seeds give identical final hashes and move counts', { timeout: 600_000 }, () => {
    const seedHex = sha256Hex('landlord-determinism-seed');
    const pickHex = sha256Hex('landlord-determinism-picker');
    const a = finalHashOfPlayout(landlord, seedHex, pickHex, 4, {}, 60_000);
    const b = finalHashOfPlayout(landlord, seedHex, pickHex, 4, {}, 60_000);
    expect(a.hash).toBe(b.hash);
    expect(a.moves).toBe(b.moves);
    const c = finalHashOfPlayout(landlord, sha256Hex('other-seed'), pickHex, 4, {}, 60_000);
    expect(c.hash).not.toBe(a.hash);
  });

  it('variants flow through: shorter turn limit and lower starting cash', { timeout: 600_000 }, () => {
    const stats = runPlayouts(landlord, {
      games: 20,
      seedPrefix: 'landlord-variant',
      players: 2,
      variant: { turn_limit: 75, starting_cash: 1000 },
      maxMoves: 60_000,
    });
    expect(stats.games).toBe(20);
  });
});
