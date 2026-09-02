/**
 * Gate A1: for every registered game, N random-legal-move playouts terminate
 * without error and every intermediate state passes the harness checks
 * (legalMoves consistency, codec round-trips, termination).
 *
 *   LUDUS_PLAYOUTS=1000 npx vitest run test/playouts.test.ts   (gate setting)
 *   LUDUS_PLAYOUTS=25   ...                                    (quick pre-integration)
 *
 * Stub games (tracks not yet landed) are skipped with a warning; the printed
 * PlayoutStats lines feed REPORT.md.
 */

import { describe, expect, it } from 'vitest';
import { GAMES } from '../src/games/index.ts';
import { runPlayouts } from '../src/kernel/playout.ts';
import { isStub } from '../src/kernel/stub.ts';

const N = Number(process.env.LUDUS_PLAYOUTS ?? 1000);

describe(`random playouts (${N} per game)`, () => {
  for (const [id, game] of Object.entries(GAMES)) {
    if (isStub(game)) {
      console.warn(`[playouts] skipping '${id}' — stub, its build track has not landed yet`);
      it.skip(`${id}: skipped (stub)`, () => {});
      continue;
    }

    it(`${id}: ${N} playouts at ${game.meta.players.min} players`, () => {
      const stats = runPlayouts(game, { games: N, seedPrefix: 'a1' });
      console.log(`[playouts] ${id} players=${game.meta.players.min} ${JSON.stringify(stats)}`);
      expect(stats.games).toBe(N);
      expect(stats.totalMoves).toBeGreaterThan(0);
      expect(stats.minMoves).toBeGreaterThan(0);
    });

    if (game.meta.players.max > game.meta.players.min) {
      it(`${id}: ${N} playouts at ${game.meta.players.max} players`, () => {
        const stats = runPlayouts(game, {
          games: N,
          seedPrefix: 'a1',
          players: game.meta.players.max,
        });
        console.log(`[playouts] ${id} players=${game.meta.players.max} ${JSON.stringify(stats)}`);
        expect(stats.games).toBe(N);
        expect(stats.totalMoves).toBeGreaterThan(0);
      });
    }
  }
});
