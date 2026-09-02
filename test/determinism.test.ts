/**
 * Gate A2 (single-runtime half): the same seed and pick sequence must produce
 * an identical final state hash and move count on two independent runs, for
 * every non-stub game, at min and (where different) max player counts.
 * The cross-runtime half (Node vs workerd) reuses finalHashOfPlayout in stage 4.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/crypto/canonical.ts';
import { GAMES } from '../src/games/index.ts';
import { finalHashOfPlayout } from '../src/kernel/playout.ts';
import { isStub } from '../src/kernel/stub.ts';

const SEEDS_PER_GAME = 3;

describe('determinism: identical seeds, identical final hashes', () => {
  for (const [id, game] of Object.entries(GAMES)) {
    if (isStub(game)) {
      console.warn(`[determinism] skipping '${id}' — stub, its build track has not landed yet`);
      it.skip(`${id}: skipped (stub)`, () => {});
      continue;
    }

    const playerCounts =
      game.meta.players.max > game.meta.players.min
        ? [game.meta.players.min, game.meta.players.max]
        : [game.meta.players.min];

    for (const players of playerCounts) {
      it(`${id} at ${players} players: two runs agree on hash and move count`, () => {
        for (let k = 0; k < SEEDS_PER_GAME; k++) {
          const seedHex = sha256Hex(`determinism:${id}:${players}:${k}`);
          const pickerHex = sha256Hex(`determinism-pick:${id}:${players}:${k}`);
          const a = finalHashOfPlayout(game, seedHex, pickerHex, players);
          const b = finalHashOfPlayout(game, seedHex, pickerHex, players);
          expect(b.hash).toBe(a.hash);
          expect(b.moves).toBe(a.moves);
          expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
        }
      });
    }
  }
});
