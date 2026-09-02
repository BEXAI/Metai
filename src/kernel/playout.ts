/**
 * Random-playout harness (gate A1) and determinism check (gate A2, in-runtime
 * half). Every game's test suite runs these. Throws with full context on the
 * first illegal state, RuleError from a random legal move, codec mismatch, or
 * non-terminating game.
 */

import { sha256Hex } from '../crypto/canonical.ts';
import { hashState } from './hash.ts';
import { createSeedStream } from './seed.ts';
import {
  isRuleError,
  playerId,
  type AnyGame,
  type Json,
  type PlayerId,
  type VariantConfig,
} from './types.ts';

export interface PlayoutOptions {
  games: number;
  /** Distinguishes suites; part of each game's seed. */
  seedPrefix: string;
  variant?: VariantConfig;
  /** Number of seats; defaults to game.meta.players.min. */
  players?: number;
  /** Safety cap on applied moves per game (games have rule-level turn limits). */
  maxMoves?: number;
  /** Check encode/decode round-trip every N applied moves (0 = never). */
  codecEvery?: number;
}

export interface PlayoutStats {
  games: number;
  totalMoves: number;
  minMoves: number;
  maxMoves: number;
  avgMoves: number;
  draws: number;
  winsBySeat: Record<string, number>;
  reasons: Record<string, number>;
}

export function runPlayouts(game: AnyGame, opts: PlayoutOptions): PlayoutStats {
  const nPlayers = opts.players ?? game.meta.players.min;
  const maxMoves = opts.maxMoves ?? 20_000;
  const codecEvery = opts.codecEvery ?? 50;
  const players: PlayerId[] = Array.from({ length: nPlayers }, (_, i) => playerId(i));
  const variant = opts.variant ?? {};

  const stats: PlayoutStats = {
    games: opts.games,
    totalMoves: 0,
    minMoves: Number.MAX_SAFE_INTEGER,
    maxMoves: 0,
    avgMoves: 0,
    draws: 0,
    winsBySeat: {},
    reasons: {},
  };

  for (let g = 0; g < opts.games; g++) {
    const seedHex = sha256Hex(`playout:${game.meta.id}:${opts.seedPrefix}:${g}`);
    const seed = createSeedStream(seedHex);
    const picker = createSeedStream(sha256Hex(`picker:${game.meta.id}:${opts.seedPrefix}:${g}`));
    let state = game.initialState(seed, players, variant);
    let moves = 0;

    const ctx = (msg: string): string =>
      `${game.meta.id} playout #${g} (seed ${seedHex.slice(0, 12)}…) after ${moves} moves: ${msg}\n` +
      `state: ${game.encodeState(state).slice(0, 400)}`;

    for (;;) {
      const result = game.isTerminal(state);
      if (result) {
        stats.reasons[result.reason] = (stats.reasons[result.reason] ?? 0) + 1;
        if (result.draw) stats.draws++;
        for (const w of result.winners) stats.winsBySeat[w] = (stats.winsBySeat[w] ?? 0) + 1;
        break;
      }
      if (moves >= maxMoves) throw new Error(ctx(`did not terminate within ${maxMoves} moves`));

      const toMove = game.playersToMove(state);
      if (toMove.length === 0) throw new Error(ctx('non-terminal state has no players to move'));

      for (const p of toMove) {
        const legal = game.legalMoves(state, p);
        if (legal.length === 0) {
          throw new Error(ctx(`player ${p} is to move but has no legal moves (games must model pass/forfeit explicitly)`));
        }
        const move = legal[picker.int('pick', legal.length)]!;
        const applied = game.apply(state, p, move, seed);
        if (isRuleError(applied)) {
          throw new Error(ctx(`apply() rejected a move from legalMoves(): ${game.moveToNotation(move, state)} -> ${applied.code}: ${applied.message}`));
        }
        state = applied.state;
        moves++;
        if (codecEvery > 0 && moves % codecEvery === 0) {
          const rt = game.decodeState(game.encodeState(state));
          if (hashState(rt) !== hashState(state)) {
            throw new Error(ctx('encode/decode round-trip changed the state hash'));
          }
        }
        if (game.isTerminal(state)) break; // remaining simultaneous movers no longer act
      }
    }

    stats.totalMoves += moves;
    stats.minMoves = Math.min(stats.minMoves, moves);
    stats.maxMoves = Math.max(stats.maxMoves, moves);
  }
  stats.avgMoves = stats.totalMoves / Math.max(1, stats.games);
  return stats;
}

/**
 * Gate A2 (single-runtime half): the same seed and the same pick sequence must
 * produce identical final hashes on two independent runs. Cross-runtime
 * comparison (Node vs workerd) happens in stage 4 using the same function.
 */
export function finalHashOfPlayout(
  game: AnyGame,
  seedHex: string,
  pickerSeedHex: string,
  nPlayers: number,
  variant: VariantConfig = {},
  maxMoves = 20_000,
): { hash: string; moves: number } {
  const players: PlayerId[] = Array.from({ length: nPlayers }, (_, i) => playerId(i));
  const seed = createSeedStream(seedHex);
  const picker = createSeedStream(pickerSeedHex);
  let state = game.initialState(seed, players, variant);
  let moves = 0;
  while (!game.isTerminal(state) && moves < maxMoves) {
    const toMove = game.playersToMove(state);
    for (const p of toMove) {
      const legal = game.legalMoves(state, p);
      if (legal.length === 0) throw new Error(`${game.meta.id}: no legal moves for ${p}`);
      const applied = game.apply(state, p, legal[picker.int('pick', legal.length)]!, seed);
      if (isRuleError(applied)) throw new Error(`${game.meta.id}: ${applied.code} ${applied.message}`);
      state = applied.state;
      moves++;
      if (game.isTerminal(state)) break;
    }
  }
  return { hash: hashState(state as Json), moves };
}
