/**
 * Go — the Game module (spec games.M2_large_boards_and_multiplayer.go,
 * acceptance A4). Tromp-Taylor rules: positional superko, suicide illegal by
 * default (variant allows multi-stone suicide), komi 7.5, two passes end the
 * game, area scoring with no dead-stone agreement. Pure and deterministic:
 * zero seed draws (Black is always seat p0, White p1).
 */

import type { Game, GameResult, Json, ParseError, PlayerId, SeedStream, VariantConfig } from '../../kernel/types.ts';
import { seatIndex } from '../../kernel/types.ts';
import { goMoveToNotation, parseGoMove, pointToNotation } from './notation.ts';
import {
  applyGo,
  checkPlay,
  decodeGo,
  encodeGo,
  enumerateLegal,
  goResult,
  initialGoState,
  type GoColor,
  type GoMove,
  type GoState,
} from './rules.ts';
import { renderGo } from './render.ts';

function colorOfPlayer(player: PlayerId): GoColor | null {
  const seat = seatIndex(player);
  return seat === 0 ? 'B' : seat === 1 ? 'W' : null;
}

function publicViewOf(state: GoState): Json {
  return {
    size: state.size,
    komi: state.komi,
    allow_suicide: state.allowSuicide,
    /** row-major from the bottom row; index = row*size + col; '.'=empty, 'X'=Black, 'O'=White */
    board: state.board,
    to_move: state.toMove,
    black_player: 'p0',
    white_player: 'p1',
    captures: { black: state.capB, white: state.capW },
    consecutive_passes: state.passes,
    move_number: state.moves.length,
    last: state.last,
    ended: state.ended,
  };
}

const go: Game<GoState, GoMove> = {
  meta: {
    id: 'go',
    name: 'Go',
    players: { min: 2, max: 2 },
    information: 'perfect',
    randomness: 'none',
    variants: {
      board_size: { description: 'board side length', values: [9, 13, 19], default: 9 },
      komi: { description: "points added to White's area score", values: [7.5, 6.5, 5.5, 0.5, 7, 0], default: 7.5 },
      allow_suicide: {
        description:
          'permit multi-stone suicide (single-stone suicide always stays illegal via positional superko)',
        values: [false, true],
        default: false,
      },
    },
    notation:
      "a point like 'E5' — column letter (skipping 'I') + row number, A1 = bottom-left; lowercase accepted; or 'pass'",
    boardText:
      'grid with column letters on top AND bottom edges and row numbers on both sides; X=Black, O=White, +=star point, ()=last move; capture counts and status below',
    listed: true,
  },

  initialState(_seed: SeedStream, players: PlayerId[], variant: VariantConfig): GoState {
    // No seed draws: go has no setup randomness (Black is seat p0 by rule).
    return initialGoState(players, variant);
  },

  playersToMove(state: GoState): PlayerId[] {
    if (state.ended) return [];
    return [state.toMove === 'B' ? 'p0' : 'p1'];
  },

  legalMoves(state: GoState, player: PlayerId): GoMove[] {
    if (state.ended) return [];
    if (colorOfPlayer(player) !== state.toMove) return [];
    return enumerateLegal(state);
  },

  apply(state: GoState, player: PlayerId, move: GoMove, _seed: SeedStream) {
    return applyGo(state, colorOfPlayer(player), move);
  },

  isTerminal(state: GoState): GameResult | null {
    return goResult(state);
  },

  publicView(state: GoState): Json {
    return publicViewOf(state);
  },

  privateView(state: GoState, _player: PlayerId): Json {
    return publicViewOf(state); // perfect information: nothing hidden
  },

  renderText(state: GoState, viewer: PlayerId | null): string {
    return renderGo(state, viewer);
  },

  encodeState(state: GoState): string {
    return encodeGo(state);
  },

  decodeState(encoded: string): GoState {
    return decodeGo(encoded);
  },

  parseMove(input: string, state: GoState, _player: PlayerId): GoMove | ParseError {
    return parseGoMove(input, state.size);
  },

  moveToNotation(move: GoMove, _state: GoState): string {
    return goMoveToNotation(move);
  },

  moveSummary(move: GoMove, state: GoState): string {
    const who = state.toMove === 'B' ? 'Black' : 'White';
    if (move.pass) {
      return state.passes === 1 ? `${who} passes, ending the game` : `${who} passes`;
    }
    const nt = pointToNotation(move.col, move.row);
    const c = checkPlay(state, state.toMove, move.col, move.row);
    if (!c.legal) return `${who} plays ${nt}`;
    if (c.captured > 0) return `${who} plays ${nt}, capturing ${c.captured} stone${c.captured === 1 ? '' : 's'}`;
    if (c.suicided > 0) return `${who} plays ${nt}, giving up ${c.suicided} stones (suicide)`;
    return `${who} plays ${nt}`;
  },

  defaultMove(_state: GoState, _player: PlayerId, _legal: GoMove[]): GoMove {
    return { pass: true }; // pass is always legal while the game runs
  },
};

export default go;
