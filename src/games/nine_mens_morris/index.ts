/**
 * Nine Men's Morris — the Game module (spec games.M1_perfect_information.nine_mens_morris).
 * Pure, deterministic, zero seed draws. See rules.ts for the ruleset notes
 * (phases, mill/removal preference, draw rules).
 */

import type { Game, GameResult, Json, PlayerId, SeedStream, VariantConfig } from '../../kernel/types.ts';
import { seatIndex } from '../../kernel/types.ts';
import {
  applyNmm,
  decodeNmm,
  encodeNmm,
  enumerateNmm,
  initialNmmState,
  nmmResult,
  onBoardCount,
  type NmmMove,
  type NmmState,
} from './rules.ts';
import { nmmMoveSummary, parseNmmMove } from './notation.ts';
import { renderNmm } from './render.ts';

function publicViewOf(state: NmmState): Json {
  return {
    board: state.board,
    to_move: `p${state.toMove}`,
    phase: state.phase,
    in_hand: { p0: state.inHand[0]!, p1: state.inHand[1]! },
    on_board: { p0: onBoardCount(state.board, 0), p1: onBoardCount(state.board, 1) },
    quiet_plies: state.quiet,
    move_count: state.moveCount,
    last_move: state.lastMove,
  };
}

const nineMensMorris: Game<NmmState, NmmMove> = {
  meta: {
    id: 'nine_mens_morris',
    name: "Nine Men's Morris",
    players: { min: 2, max: 2 },
    information: 'perfect',
    randomness: 'none',
    variants: {},
    notation:
      "point labels a1..g7 (d4 is not a point): place 'd1', slide 'd1-d2', removal suffix on a mill 'd1-d2xd6' (placement removal 'd1xd6')",
    boardText: 'three concentric squares with connector lines, columns a-g and rows 1-7 on the edges',
    listed: true,
  },

  initialState(_seed: SeedStream, players: PlayerId[], _variant: VariantConfig): NmmState {
    return initialNmmState(players);
  },

  playersToMove(state: NmmState): PlayerId[] {
    if (nmmResult(state) !== null) return [];
    return [`p${state.toMove}`];
  },

  legalMoves(state: NmmState, player: PlayerId): NmmMove[] {
    if (nmmResult(state) !== null) return [];
    if (seatIndex(player) !== state.toMove) return [];
    return enumerateNmm(state, state.toMove);
  },

  apply(state: NmmState, player: PlayerId, move: NmmMove, _seed: SeedStream) {
    return applyNmm(state, seatIndex(player), move);
  },

  isTerminal(state: NmmState): GameResult | null {
    return nmmResult(state);
  },

  publicView(state: NmmState): Json {
    return publicViewOf(state);
  },

  privateView(state: NmmState, _player: PlayerId): Json {
    return publicViewOf(state); // perfect information: nothing hidden
  },

  renderText(state: NmmState, _viewer: PlayerId | null): string {
    return renderNmm(state);
  },

  encodeState: encodeNmm,
  decodeState: decodeNmm,

  parseMove(input: string, state: NmmState, _player: PlayerId) {
    return parseNmmMove(input, state);
  },

  moveToNotation(move: NmmMove, _state: NmmState): string {
    return move;
  },

  moveSummary(move: NmmMove, state: NmmState): string {
    return nmmMoveSummary(move, state);
  },
};

export default nineMensMorris;
