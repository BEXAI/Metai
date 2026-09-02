/**
 * Gate A10 harness: over many random states of a hidden-information game, no
 * player's private view (nor the public view / spectator render) may contain
 * another player's hidden data. Games supply `secretProbes(state, player)`:
 * distinctive strings that would only appear if that player's hidden
 * information leaked (card names in hand, deck order fragments, ...).
 */

import { canonicalJson, sha256Hex } from '../crypto/canonical.ts';
import { createSeedStream } from './seed.ts';
import { buildView } from './view.ts';
import { isRuleError, playerId, type AnyGame, type Json, type PlayerId, type VariantConfig } from './types.ts';

export interface LeakageOptions {
  states: number;
  seedPrefix: string;
  players?: number;
  variant?: VariantConfig;
  movesPerState?: number;
}

export function runLeakageCheck(
  game: AnyGame,
  secretProbes: (state: Json, player: PlayerId) => string[],
  opts: LeakageOptions,
): { statesChecked: number } {
  const nPlayers = opts.players ?? game.meta.players.min;
  const players: PlayerId[] = Array.from({ length: nPlayers }, (_, i) => playerId(i));
  let checked = 0;

  for (let g = 0; checked < opts.states; g++) {
    const seed = createSeedStream(sha256Hex(`leak:${game.meta.id}:${opts.seedPrefix}:${g}`));
    const picker = createSeedStream(sha256Hex(`leakpick:${game.meta.id}:${opts.seedPrefix}:${g}`));
    let state = game.initialState(seed, players, opts.variant ?? {});
    let moves = 0;
    const cap = opts.movesPerState ?? 400;

    while (!game.isTerminal(state) && moves < cap && checked < opts.states) {
      inspect(game, state, players, secretProbes);
      checked++;
      const toMove = game.playersToMove(state);
      for (const p of toMove) {
        const legal = game.legalMoves(state, p);
        if (legal.length === 0) throw new Error(`${game.meta.id} leakage: ${p} to move with no legal moves`);
        const applied = game.apply(state, p, legal[picker.int('pick', legal.length)]!, seed);
        if (isRuleError(applied)) throw new Error(`${game.meta.id} leakage: apply rejected legal move: ${applied.message}`);
        state = applied.state;
        moves++;
        if (game.isTerminal(state)) break;
      }
    }
  }
  return { statesChecked: checked };
}

function inspect(
  game: AnyGame,
  state: Json,
  players: PlayerId[],
  secretProbes: (state: Json, player: PlayerId) => string[],
): void {
  const publicStr = canonicalJson(game.publicView(state)) + ' ' + game.renderText(state, null);
  for (const owner of players) {
    const probes = secretProbes(state, owner).filter((p) => p.length >= 3);
    for (const probe of probes) {
      if (publicStr.includes(probe)) {
        throw new Error(`${game.meta.id}: public view/render leaks ${owner}'s secret ${JSON.stringify(probe)}`);
      }
      for (const other of players) {
        if (other === owner) continue;
        const view = canonicalJson(game.privateView(state, other)) + ' ' + game.renderText(state, other);
        if (view.includes(probe)) {
          throw new Error(`${game.meta.id}: ${other}'s private view leaks ${owner}'s secret ${JSON.stringify(probe)}`);
        }
        // The FULL assembled view an agent actually receives on the wire —
        // including state_string, which shipped raw encodeState until
        // red-team finding F1. Scan every string an opponent gets.
        const full = buildView(game, state, other, {
          gameId: 'leakage-check',
          turnIndex: 0,
          phase: 'leakage',
          deadlineUtc: '1970-01-01T00:00:00Z',
          history: [],
          rulesCard: '',
        });
        const wire = canonicalJson(full as unknown as Json);
        if (wire.includes(probe)) {
          throw new Error(
            `${game.meta.id}: the assembled ViewObject served to ${other} leaks ${owner}'s secret ${JSON.stringify(probe)} (check viewStateString/encodeState handling)`,
          );
        }
      }
    }
  }
}
