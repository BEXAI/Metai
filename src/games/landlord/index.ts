/**
 * Landlord — an original 2-4 player property-trading game (id 'landlord') set
 * in the invented city of Meridian Bay. Hidden information: the two event-deck
 * orders only (hidden from players AND spectators until the game ends). All
 * cash and holdings are public.
 */

import type { Game, GameResult, Json, ParseError, PlayerId } from '../../kernel/types.ts';
import { isParseError } from '../../kernel/types.ts';
import { landlordMoveSummary, landlordMoveToNotation, parseLandlordMove } from './notation.ts';
import { renderLandlord } from './render.ts';
import {
  applyMove,
  legalMovesFor,
  makeInitialState,
  terminalResult,
  toMove,
  writsOf,
  type LandlordMove,
  type LandlordState,
} from './rules.ts';

function publicViewOf(st: LandlordState): Json {
  return {
    players: st.players,
    cash: st.cash,
    pos: st.pos,
    detained: st.detained,
    detention_tries: st.detTries,
    writs_held: st.writs, // holdings are public; only DECK ORDER is hidden
    bankrupt: st.bankrupt,
    props: st.props,
    house_pool: st.housePool,
    hotel_pool: st.hotelPool,
    deck_a_count: st.deckA.length,
    deck_b_count: st.deckB.length,
    phase: st.phase,
    current: st.current,
    round: st.round,
    turn_limit: st.turnLimit,
    doubles: st.doubles,
    last_dice: st.lastDice,
    pending_prop: st.pendingProp,
    auction: st.auction,
    offer: st.offer,
    debt: st.phase === 'debt' ? (st.payments[0] ?? null) : null,
    offers_made_this_turn: st.offersMade,
  } as unknown as Json;
}

const landlord: Game<LandlordState, LandlordMove> = {
  meta: {
    id: 'landlord',
    name: 'Landlord',
    players: { min: 2, max: 4 },
    information: 'hidden',
    randomness: 'both',
    variants: {
      starting_cash: {
        description: 'Cash each player starts with',
        values: [1000, 1500, 2500],
        default: 1500,
      },
      turn_limit: {
        description: 'Rounds before the game ends on net worth',
        values: [75, 150],
        default: 150,
      },
    },
    notation:
      "Phase-tagged actions: roll, buy, decline, auction_bid(N), build(prop,n), sell_buildings(prop,n), mortgage(prop), unmortgage(prop), offer({\"get\":{cash,props,writs},\"give\":{...},\"note\":text|null,\"to\":\"pX\"}), accept(id), reject(id), counter(id,{...}), pay_detention, use_card, pay_debt, declare_bankruptcy, end_turn. Bids are multiples of 10; offer cash may be any non-negative integer.",
    boardText:
      'Schematic 40-space track in two columns with group/owner/building markers and player tokens, cash and net-worth table, pending auction/offer/debt, and recent actions.',
    listed: true,
  },

  initialState(seed, players, variant) {
    return makeInitialState(seed, players, variant);
  },

  playersToMove(state) {
    return toMove(state);
  },

  legalMoves(state, player) {
    return legalMovesFor(state, player);
  },

  // Auction bid lists run to the bidder's cash in steps of 10 and can grow
  // past the 5,000-entry view cap in cash-rich endgames; provide paging.
  legalMovesPaged(state, player, page) {
    const pageSize = 1_000;
    const all = legalMovesFor(state, player);
    return { moves: all.slice(page * pageSize, (page + 1) * pageSize), total: all.length, pageSize };
  },

  apply(state, player, move, seed) {
    return applyMove(state, player, move, seed);
  },

  isTerminal(state): GameResult | null {
    const r = terminalResult(state);
    if (!r) return null;
    return { winners: r.winners, draw: r.draw, scores: r.scores, reason: r.reason };
  },

  publicView(state) {
    return publicViewOf(state);
  },

  privateView(state, player) {
    // The only hidden information (deck order) is hidden from everyone, so a
    // player's private view adds nothing beyond the public view.
    const pub = publicViewOf(state) as { [k: string]: Json };
    return { ...pub, you: player, your_writs: writsOf(state, player) };
  },

  renderText(state, viewer) {
    return renderLandlord(state, viewer);
  },

  encodeState(state) {
    return JSON.stringify(state);
  },

  decodeState(encoded) {
    return JSON.parse(encoded) as LandlordState;
  },

  parseMove(input, _state, _player): LandlordMove | ParseError {
    const parsed = parseLandlordMove(input);
    if (isParseError(parsed)) return parsed;
    return parsed;
  },

  moveToNotation(move) {
    return landlordMoveToNotation(move);
  },

  moveSummary(move, state) {
    return landlordMoveSummary(move, state);
  },

  defaultMove(state, _player, legal) {
    for (const t of ['end_turn', 'decline', 'reject', 'pay_debt'] as const) {
      const found = legal.find((m) => m.t === t);
      if (found) return found;
    }
    return legal[0]!;
  },
};

/**
 * Gate A10 probes: distinctive substrings that would only appear in a view if
 * the hidden deck order leaked. Same-deck id sequences can never legitimately
 * appear in any view (held writs are at most one per deck), so 2+-id JSON
 * fragments of either deck are safe, precise probes. Attributed to every
 * player so the harness checks every other player's view AND the public view.
 */
export function secretProbes(state: Json, _player: PlayerId): string[] {
  const st = state as LandlordState;
  const probes: string[] = [];
  for (const deck of [st.deckA, st.deckB]) {
    if (deck.length >= 2) {
      probes.push(deck.map((id) => JSON.stringify(id)).join(','));
    }
    if (deck.length >= 3) {
      probes.push(
        deck
          .slice(0, 3)
          .map((id) => JSON.stringify(id))
          .join(','),
      );
    }
  }
  return probes;
}

export default landlord;
