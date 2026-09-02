/**
 * Hex — the Game module (spec games.M1_perfect_information.hex).
 * Pure, deterministic, zero seed draws. See rules.ts for the ruleset notes
 * (steal-the-move pie rule, edge assignments, union-find win detection).
 */

import type { Game, GameResult, Json, PlayerId, SeedStream, VariantConfig } from '../../kernel/types.ts';
import { seatIndex } from '../../kernel/types.ts';
import {
  applyHex,
  decodeHex,
  encodeHex,
  enumerateHex,
  hexWinner,
  initialHexState,
  type HexMove,
  type HexState,
} from './rules.ts';
import { hexMoveSummary, parseHexMove } from './notation.ts';
import { renderHex } from './render.ts';

function publicViewOf(state: HexState): Json {
  return {
    size: state.size,
    board: state.board,
    to_move: `p${state.toMove}`,
    move_count: state.moveCount,
    swap_used: state.swapUsed,
    swap_available: state.moveCount === 1 && state.toMove === 1,
    last_move: state.lastMove,
  };
}

const hex: Game<HexState, HexMove> = {
  meta: {
    id: 'hex',
    name: 'Hex',
    players: { min: 2, max: 2 },
    information: 'perfect',
    randomness: 'none',
    variants: {
      size: { description: 'board side length', values: [7, 11, 13], default: 11 },
    },
    notation:
      "a cell like 'f6' (columns a.. left to right, rows 1.. top to bottom); 'swap' as the second player's first move steals the first stone in place (pie rule)",
    boardText:
      'staircase parallelogram with column letters and row numbers on the edges; X connects top-bottom, O connects left-right',
    listed: true,
  },

  initialState(_seed: SeedStream, players: PlayerId[], variant: VariantConfig): HexState {
    return initialHexState(players, variant['size']);
  },

  playersToMove(state: HexState): PlayerId[] {
    if (hexWinner(state) !== null) return [];
    return [`p${state.toMove}`];
  },

  legalMoves(state: HexState, player: PlayerId): HexMove[] {
    if (hexWinner(state) !== null) return [];
    if (seatIndex(player) !== state.toMove) return [];
    return enumerateHex(state);
  },

  apply(state: HexState, player: PlayerId, move: HexMove, _seed: SeedStream) {
    return applyHex(state, seatIndex(player), move);
  },

  isTerminal(state: HexState): GameResult | null {
    const winner = hexWinner(state);
    if (winner === null) return null;
    return { winners: [`p${winner}`], draw: false, reason: 'connection' };
  },

  publicView(state: HexState): Json {
    return publicViewOf(state);
  },

  privateView(state: HexState, _player: PlayerId): Json {
    return publicViewOf(state); // perfect information: nothing hidden
  },

  renderText(state: HexState, _viewer: PlayerId | null): string {
    return renderHex(state);
  },

  encodeState: encodeHex,
  decodeState: decodeHex,

  parseMove(input: string, state: HexState, _player: PlayerId) {
    return parseHexMove(input, state);
  },

  moveToNotation(move: HexMove, _state: HexState): string {
    return move;
  },

  moveSummary(move: HexMove, state: HexState): string {
    return hexMoveSummary(move, state);
  },
};

export default hex;
