/**
 * Random-legal walker shared by the two werewolf registry gates
 * (test/playouts.test.ts and test/determinism.test.ts). NOT a test file: the
 * vitest include globs are `test/**\/*.test.ts`, so this is never collected —
 * same arrangement as test/verify-replay.ts.
 *
 * It exists because kernel/playout.ts deliberately reduces a playout to
 * aggregate counters and throws the final state away, while both werewolf
 * gates need the state itself: one to prove the day counter never runs past
 * DAY_LIMIT, the other to prove the seed was touched exactly seven times and
 * that the deal is a function of the seed alone.
 *
 * The move loop is a faithful copy of runPlayouts (src/kernel/playout.ts:73-105)
 * INCLUDING the mid-list terminal break at :104, so a divergence between this
 * walker and the gate harness surfaces as a move-count mismatch rather than
 * hiding. Every failure mode runPlayouts throws on is thrown here too — a
 * non-terminal state with no movers, a mover with no legal moves, a RuleError
 * on a move that legalMoves() itself produced, and overrunning the cap — which
 * is what makes "werewolf never hangs" an assertion per game rather than a
 * sampled one.
 */

import werewolf from '../src/games/werewolf/index.ts';
import type { WwState } from '../src/games/werewolf/rules.ts';
import { createSeedStream } from '../src/kernel/seed.ts';
import { isRuleError, playerId, type GameResult, type PlayerId, type SeedDraw } from '../src/kernel/types.ts';

/**
 * Well under the harness default of 20,000. A full cycle is 33 applied moves
 * and DAY_LIMIT is 6, so the rule-level ceiling is ~200; 400 is a tripwire that
 * fires long before a hang would look like a slow test.
 */
export const WW_MOVE_CAP = 400;

export const WW_SEATS: PlayerId[] = Array.from({ length: 8 }, (_, i) => playerId(i));

export interface WwWalk {
  /** Final state. Always terminal, so `phase` is 'over'. */
  state: WwState;
  result: GameResult;
  moves: number;
  /** The game's ENTIRE randomness surface. Expected to be seven int() draws. */
  seedDraws: readonly SeedDraw[];
  /** The deal, read off the terminal state (roles are immutable setup). */
  roles: Record<string, string>;
}

export function playWerewolf(seedHex: string, pickerSeedHex: string): WwWalk {
  const seed = createSeedStream(seedHex);
  const picker = createSeedStream(pickerSeedHex);
  let state = werewolf.initialState(seed, WW_SEATS, {}) as WwState;
  let moves = 0;

  const ctx = (msg: string): string =>
    `werewolf walk (seed ${seedHex.slice(0, 12)}…) after ${moves} moves in ` +
    `day ${state.day} ${state.phase}: ${msg}`;

  for (;;) {
    const result = werewolf.isTerminal(state);
    if (result) return { state, result, moves, seedDraws: seed.draws(), roles: { ...state.roles } };
    if (moves >= WW_MOVE_CAP) throw new Error(ctx(`did not terminate within ${WW_MOVE_CAP} moves`));

    const toMove = werewolf.playersToMove(state);
    if (toMove.length === 0) throw new Error(ctx('non-terminal state has no players to move'));

    for (const p of toMove) {
      const legal = werewolf.legalMoves(state, p);
      if (legal.length === 0) throw new Error(ctx(`${p} is to move but has no legal moves`));
      const move = legal[picker.int('pick', legal.length)]!;
      const applied = werewolf.apply(state, p, move, seed);
      if (isRuleError(applied)) {
        throw new Error(ctx(`apply() rejected a move from legalMoves(): ${applied.code}: ${applied.message}`));
      }
      state = applied.state;
      moves++;
      if (werewolf.isTerminal(state)) break; // remaining simultaneous movers no longer act
    }
  }
}

/** Seats dealt 'werewolf', ascending. Two of eight, by ROLE_MULTISET. */
export function wolvesOf(walk: WwWalk): string[] {
  return WW_SEATS.filter((p) => walk.roles[p] === 'werewolf');
}
