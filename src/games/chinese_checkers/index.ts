/**
 * Chinese Checkers — the Game module (spec games.M2_large_boards_and_multiplayer.chinese_checkers).
 * Pure, deterministic, zero seed draws. See rules.ts for the full ruleset
 * notes (doubled coordinates, seat->triangle table, jump BFS, anti-stall).
 */

import type { Game, GameResult, Json, PlayerId, SeedStream, VariantConfig } from '../../kernel/types.ts';
import { seatIndex } from '../../kernel/types.ts';
import {
  applyCc,
  ccResult,
  decodeCc,
  encodeCc,
  enumerateCc,
  goalTriangle,
  initialCcState,
  pegsInGoal,
  startTriangle,
  type CcMove,
  type CcState,
} from './rules.ts';
import { ccMoveSummary, parseCcMove } from './notation.ts';
import { renderCc } from './render.ts';

function publicViewOf(state: CcState): Json {
  const players: Json[] = [];
  for (let s = 0; s < state.n; s++) {
    players.push({
      player: `p${s}`,
      home: startTriangle(state, s),
      goal: goalTriangle(state, s),
      pegs_in_goal: pegsInGoal(state, s),
      moves_made: state.movesBy[s]!,
      forfeited: state.forfeited[s]!,
    });
  }
  return {
    board: state.board,
    to_move: `p${state.toMove}`,
    round: state.round,
    round_limit: 200,
    players,
    last_move: state.lastMove,
    move_count: state.moveCount,
  };
}

const chineseCheckers: Game<CcState, CcMove> = {
  meta: {
    id: 'chinese_checkers',
    name: 'Chinese Checkers',
    players: { min: 2, max: 6 },
    information: 'perfect',
    randomness: 'none',
    variants: {},
    notation:
      "hole labels are column letter + row number (columns a..y, rows 1..17, 'm1' is the top apex): step 'm3-l4', jump chain 'd5-f7-h9' (any physically valid chain is accepted and canonicalized); 'pass' only when blocked",
    boardText:
      'the 121-hole star with row numbers on the sides and split column-letter headers; seats render as digits 0-5',
    listed: true,
  },

  initialState(_seed: SeedStream, players: PlayerId[], _variant: VariantConfig): CcState {
    return initialCcState(players);
  },

  playersToMove(state: CcState): PlayerId[] {
    if (ccResult(state) !== null) return [];
    return [`p${state.toMove}`];
  },

  legalMoves(state: CcState, player: PlayerId): CcMove[] {
    if (ccResult(state) !== null) return [];
    if (seatIndex(player) !== state.toMove) return [];
    return enumerateCc(state, state.toMove);
  },

  apply(state: CcState, player: PlayerId, move: CcMove, _seed: SeedStream) {
    return applyCc(state, seatIndex(player), move);
  },

  isTerminal(state: CcState): GameResult | null {
    const r = ccResult(state);
    if (!r) return null;
    return { winners: r.winners, draw: r.draw, scores: r.scores, reason: r.reason };
  },

  publicView(state: CcState): Json {
    return publicViewOf(state);
  },

  privateView(state: CcState, _player: PlayerId): Json {
    return publicViewOf(state); // perfect information: nothing hidden
  },

  renderText(state: CcState, _viewer: PlayerId | null): string {
    return renderCc(state);
  },

  encodeState: encodeCc,
  decodeState: decodeCc,

  parseMove(input: string, state: CcState, player: PlayerId) {
    return parseCcMove(input, state, player);
  },

  moveToNotation(move: CcMove, _state: CcState): string {
    return move;
  },

  moveSummary(move: CcMove, state: CcState): string {
    return ccMoveSummary(move, state);
  },
};

export default chineseCheckers;
