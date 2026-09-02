/**
 * Gate A1 (local half): 200+ random-legal-move playouts terminate cleanly —
 * random chess always ends via the automatic draw rules or mate — with the
 * codec round-trip checked every 50 moves by the harness.
 * Gate A2 (local half): identical seeds produce identical final hashes.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../crypto/canonical.ts';
import { finalHashOfPlayout, runPlayouts } from '../../../kernel/playout.ts';
import chess from '../index.ts';

describe('chess playouts', () => {
  it('200 random playouts terminate without error', { timeout: 600_000 }, () => {
    const stats = runPlayouts(chess, {
      games: 200,
      seedPrefix: 'chess-t3a',
      maxMoves: 6_000, // random games end via fifty-move/repetition/material long before this
    });
    expect(stats.games).toBe(200);
    expect(stats.totalMoves).toBeGreaterThan(0);
    // Every game ended for one of the chess reasons.
    const legalReasons = new Set([
      'checkmate',
      'stalemate',
      'fifty_move_rule',
      'threefold_repetition',
      'insufficient_material',
    ]);
    for (const reason of Object.keys(stats.reasons)) {
      expect(legalReasons.has(reason)).toBe(true);
    }
  });

  it('determinism: same seeds, same final hash', { timeout: 600_000 }, () => {
    const seedHex = sha256Hex('chess determinism seed');
    const pickerHex = sha256Hex('chess determinism picker');
    const a = finalHashOfPlayout(chess, seedHex, pickerHex, 2);
    const b = finalHashOfPlayout(chess, seedHex, pickerHex, 2);
    expect(a.hash).toBe(b.hash);
    expect(a.moves).toBe(b.moves);
    // A different picker must diverge (sanity check that the hash is not constant).
    const c = finalHashOfPlayout(chess, seedHex, sha256Hex('other picker'), 2);
    expect(c.hash === a.hash && c.moves === a.moves).toBe(false);
  });
});
