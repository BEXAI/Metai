/**
 * RED TEAM red-team-rules — attack family 3: trading-phase deadlocks.
 *
 * Hostile playouts for landlord and islanders with adversarial pickers
 * (always-offer, always-counter, always-bid-max, never-accept) instead of
 * uniform random. The liveness invariant the kernel demands (and the playout
 * harness enforces): every non-terminal state has playersToMove ≠ [] and
 * every player to move has ≥ 1 legal move; games terminate under the
 * rule-level turn limits.
 *
 * Seeded randomness only (createSeedStream).
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { isRuleError, playerId, type AnyGame, type Json, type PlayerId } from '../../src/kernel/types.ts';
import landlord from '../../src/games/landlord/index.ts';
import islanders from '../../src/games/islanders/index.ts';
import type { LandlordMove } from '../../src/games/landlord/rules.ts';
import type { IslMove } from '../../src/games/islanders/rules.ts';

type Picker = (legal: Json[], pick: (n: number) => number) => Json;

/**
 * Runs one full hostile game. Throws (fails the test) on: empty toMove in a
 * non-terminal state, a mover with no legal moves, apply() rejecting a move
 * from its own legal list, apply() throwing, or non-termination.
 */
function hostilePlayout(
  game: AnyGame,
  nPlayers: number,
  variant: Record<string, string | number | boolean>,
  picker: Picker,
  tag: string,
  maxMoves: number,
): { moves: number; reason: string } {
  const players: PlayerId[] = Array.from({ length: nPlayers }, (_, i) => playerId(i));
  const seed = createSeedStream(sha256Hex(`deadlock:${game.meta.id}:${tag}`));
  const pickerSeed = createSeedStream(sha256Hex(`deadlock-picker:${game.meta.id}:${tag}`));
  const pick = (n: number): number => pickerSeed.int('pick', n);
  let state = game.initialState(seed, players, variant);
  let moves = 0;

  for (;;) {
    const result = game.isTerminal(state);
    if (result) return { moves, reason: result.reason };
    if (moves >= maxMoves) throw new Error(`${game.meta.id}/${tag}: no termination after ${maxMoves} moves`);

    const toMove = game.playersToMove(state);
    if (toMove.length === 0) {
      throw new Error(`${game.meta.id}/${tag}: DEADLOCK — non-terminal state with nobody to move after ${moves} moves`);
    }
    for (const p of toMove) {
      const legal = game.legalMoves(state, p);
      if (legal.length === 0) {
        throw new Error(`${game.meta.id}/${tag}: DEADLOCK — ${p} to move with zero legal moves after ${moves} moves\nstate: ${game.encodeState(state).slice(0, 400)}`);
      }
      const move = picker(legal, pick);
      const applied = game.apply(state, p, move, seed);
      if (isRuleError(applied)) {
        throw new Error(`${game.meta.id}/${tag}: apply rejected its own legal move ${JSON.stringify(move).slice(0, 200)} -> ${applied.code}: ${applied.message}`);
      }
      state = applied.state;
      moves++;
      if (game.isTerminal(state)) break;
    }
  }
}

// ---------------------------------------------------------------------------
// Hostile pickers
// ---------------------------------------------------------------------------

/** landlord: always offer/counter when possible, bid the maximum, never accept. */
const landlordHostile: Picker = (legal, pick) => {
  const moves = legal as LandlordMove[];
  const offers = moves.filter((m) => m.t === 'offer');
  if (offers.length > 0) return offers[pick(offers.length)] as Json;
  const counters = moves.filter((m) => m.t === 'counter');
  if (counters.length > 0) return counters[pick(counters.length)] as Json;
  const bids = moves.filter((m) => m.t === 'auction_bid') as Extract<LandlordMove, { t: 'auction_bid' }>[];
  if (bids.length > 0) {
    let best = bids[0]!;
    for (const b of bids) if (b.amount > best.amount) best = b;
    return best as Json;
  }
  const noAccept = moves.filter((m) => m.t !== 'accept');
  const pool = noAccept.length > 0 ? noAccept : moves;
  return pool[pick(pool.length)] as Json;
};

/** landlord: greedy hoarder — never end the turn if anything else is possible. */
const landlordStaller: Picker = (legal, pick) => {
  const moves = legal as LandlordMove[];
  const notEnd = moves.filter((m) => m.t !== 'end_turn' && m.t !== 'accept');
  const pool = notEnd.length > 0 ? notEnd : moves;
  return pool[pick(pool.length)] as Json;
};

/** islanders: spam offers and counters, reject everything, never accept. */
const islandersHostile: Picker = (legal, pick) => {
  const moves = legal as IslMove[];
  const offers = moves.filter((m) => m.type === 'offer');
  if (offers.length > 0) return offers[pick(offers.length)] as Json;
  const counters = moves.filter((m) => m.type === 'counter');
  if (counters.length > 0) return counters[pick(counters.length)] as Json;
  const noAccept = moves.filter((m) => m.type !== 'accept');
  const pool = noAccept.length > 0 ? noAccept : moves;
  return pool[pick(pool.length)] as Json;
};

/** islanders: always accept every trade (resource churn + hand-size chaos). */
const islandersGullible: Picker = (legal, pick) => {
  const moves = legal as IslMove[];
  const accepts = moves.filter((m) => m.type === 'accept');
  if (accepts.length > 0) return accepts[0] as Json;
  const offers = moves.filter((m) => m.type === 'offer');
  if (offers.length > 0) return offers[pick(offers.length)] as Json;
  return moves[pick(moves.length)] as Json;
};

// ---------------------------------------------------------------------------
// Landlord
// ---------------------------------------------------------------------------

describe('landlord trading/auction deadlocks (hostile pickers)', () => {
  it('always-offer / always-counter / never-accept / max-bid: 6 games at 4p never stall', { timeout: 600_000 }, () => {
    for (let g = 0; g < 6; g++) {
      const { reason } = hostilePlayout(landlord, 4, { turn_limit: 75 }, landlordHostile, `hostile-${g}`, 120_000);
      expect(['turn_limit', 'last_standing']).toContain(reason);
    }
  });

  it('greedy staller at 2p: never ends the turn voluntarily, still terminates', { timeout: 600_000 }, () => {
    for (let g = 0; g < 4; g++) {
      const { reason } = hostilePlayout(landlord, 2, { turn_limit: 75 }, landlordStaller, `staller-${g}`, 120_000);
      expect(['turn_limit', 'last_standing']).toContain(reason);
    }
  });

  it('3p with max bidding: auctions always settle within 3 rounds', { timeout: 600_000 }, () => {
    const { reason } = hostilePlayout(landlord, 3, { turn_limit: 75 }, landlordHostile, 'bid3', 120_000);
    expect(['turn_limit', 'last_standing']).toContain(reason);
  });
});

// ---------------------------------------------------------------------------
// Islanders
// ---------------------------------------------------------------------------

describe('islanders trading deadlocks (hostile pickers)', () => {
  it('offer-spam / counter / never-accept: 4 games at 3p never stall', { timeout: 600_000 }, () => {
    for (let g = 0; g < 4; g++) {
      const { reason } = hostilePlayout(islanders, 3, {}, islandersHostile, `hostile-${g}`, 80_000);
      expect(['turn_limit', 'points']).toContain(reason);
    }
  });

  it('gullible accept-everything at 4p never stalls', { timeout: 600_000 }, () => {
    for (let g = 0; g < 2; g++) {
      const { reason } = hostilePlayout(islanders, 4, {}, islandersGullible, `gullible-${g}`, 80_000);
      expect(['turn_limit', 'points']).toContain(reason);
    }
  });
});
