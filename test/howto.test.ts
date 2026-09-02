/**
 * The per-game agent instructions (src/games/howto.ts) must stay true to the
 * engines. These tests fail if a game is added without instructions, if the
 * worked example stops generating, or if a documented notation example is not
 * actually parseable by that game's own parser.
 */

import { describe, expect, it } from 'vitest';
import { GAMES } from '../src/games/index.ts';
import { STATIC_HOWTO, buildHowto, liveExample } from '../src/games/howto.ts';
import { createSeedStream } from '../src/kernel/seed.ts';
import { sha256Hex } from '../src/crypto/canonical.ts';
import { isParseError, playerId, type PlayerId } from '../src/kernel/types.ts';

const LISTED = Object.values(GAMES).filter((g) => g.meta.listed);

describe('per-game agent instructions', () => {
  it('every registered game has hand-authored instructions', () => {
    const missing = Object.keys(GAMES).filter((id) => !STATIC_HOWTO[id]);
    expect(missing, `games without STATIC_HOWTO entries: ${missing.join(', ')}`).toEqual([]);
  });

  it('no instructions exist for a game that is not registered', () => {
    const orphans = Object.keys(STATIC_HOWTO).filter((id) => !GAMES[id]);
    expect(orphans).toEqual([]);
  });

  for (const game of Object.values(GAMES)) {
    describe(game.meta.id, () => {
      it('builds a complete howto with a live worked example', () => {
        const h = buildHowto(game);
        expect(h.game).toBe(game.meta.id);
        expect(h.turn.length).toBeGreaterThan(20);
        expect(h.notation.length).toBeGreaterThan(0);
        expect(h.ending.length).toBeGreaterThan(10);
        expect(h.how_to_move.length).toBeGreaterThanOrEqual(3);
        // The example comes from the real engine, so it must be non-empty.
        expect(h.example?.opening_legal_move_count ?? 0).toBeGreaterThan(0);
        expect(h.example?.legal_moves_sample.length ?? 0).toBeGreaterThan(0);
        expect(h.example?.board_text_sample.length ?? 0).toBeGreaterThan(0);
        for (const entry of h.example?.legal_moves_sample ?? []) {
          expect(typeof entry.notation).toBe('string');
          expect(entry.notation.length).toBeGreaterThan(0);
        }
      });

      it('the sampled notation round-trips through the game\'s own parser', () => {
        // Rebuild the exact state liveExample used, then confirm every notation
        // string it advertises actually parses back into a legal move.
        const players: PlayerId[] = Array.from({ length: game.meta.players.min }, (_, i) => playerId(i));
        const seed = createSeedStream(sha256Hex(`howto:${game.meta.id}`));
        const state = game.initialState(seed, players, {});
        const mover = game.playersToMove(state)[0] ?? players[0]!;
        const sample = liveExample(game).legal_moves_sample;
        for (const entry of sample) {
          const parsed = game.parseMove(entry.notation, state, mover);
          expect(isParseError(parsed), `'${entry.notation}' did not parse for ${game.meta.id}`).toBe(false);
        }
      });
    });
  }

  it('traps are documented for every game with hidden information or dice', () => {
    for (const game of LISTED) {
      const h = STATIC_HOWTO[game.meta.id]!;
      if (game.meta.information === 'hidden' || game.meta.randomness !== 'none') {
        expect(h.traps.length, `${game.meta.id} needs traps documented`).toBeGreaterThan(0);
      }
    }
  });

  it('the trading games document their phase machine', () => {
    for (const id of ['landlord', 'islanders']) {
      expect(STATIC_HOWTO[id]?.phases?.length, `${id} must document phases`).toBeGreaterThan(0);
    }
  });
});
