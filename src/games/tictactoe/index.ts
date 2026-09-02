/**
 * Tic-Tac-Toe — kernel smoke-test game (meta.listed = false).
 * Moves are cell notations 'a1'..'c3'. No randomness; no seed draws.
 */

import type { AnyGame, Game, Json } from '../../kernel/types.ts';
import { cellToIndex, indexToCell, parseTttMove } from './notation.ts';
import { renderTtt } from './render.ts';
import {
  CHARS,
  initialTttState,
  tttError,
  tttMover,
  tttTerminal,
  type TttMove,
  type TttState,
} from './rules.ts';

function publicViewOf(state: TttState): Json {
  return {
    board: state.board,
    toMove: tttMover(state),
    moveCount: state.moveCount,
    lastMove: state.lastMove,
  };
}

const game: Game<TttState, TttMove> = {
  meta: {
    id: 'tictactoe',
    name: 'Tic-Tac-Toe',
    players: { min: 2, max: 2 },
    information: 'perfect',
    randomness: 'none',
    variants: {},
    notation: "cell 'a1'..'c3' (column a-c left to right, row 1-3 from the bottom)",
    boardText: '3x3 grid, rows 3..1 top to bottom, column letters on the bottom edge; X = p0, O = p1',
    listed: false,
  },

  initialState(_seed, players, _variant): TttState {
    if (players.length !== 2) throw new Error(`tictactoe needs exactly 2 players, got ${players.length}`);
    return initialTttState();
  },

  playersToMove(state) {
    return tttTerminal(state) ? [] : [tttMover(state)];
  },

  legalMoves(state, player) {
    if (tttTerminal(state) || player !== tttMover(state)) return [];
    const out: TttMove[] = [];
    for (let i = 0; i < 9; i++) if (state.board[i] === '.') out.push(indexToCell(i));
    return out;
  },

  apply(state, player, move, _seed) {
    if (tttTerminal(state)) return tttError('game_over', 'the game is already over');
    if (player !== tttMover(state)) return tttError('not_your_turn', `${player} is not to move`);
    if (typeof move !== 'string' || !/^[a-c][1-3]$/.test(move)) {
      return tttError('bad_move', `'${String(move)}' is not a cell a1..c3`);
    }
    const idx = cellToIndex(move);
    if (state.board[idx] !== '.') return tttError('occupied', `cell ${move} is already occupied`);
    const board = state.board.slice(0, idx) + CHARS[state.toMove]! + state.board.slice(idx + 1);
    const next: TttState = {
      board,
      toMove: 1 - state.toMove,
      moveCount: state.moveCount + 1,
      lastMove: move,
    };
    return { state: next, events: [] };
  },

  isTerminal(state) {
    return tttTerminal(state);
  },

  publicView(state) {
    return publicViewOf(state);
  },

  privateView(state, _player) {
    return publicViewOf(state);
  },

  renderText(state, _viewer) {
    return renderTtt(state);
  },

  encodeState(state) {
    return `${state.board} ${state.toMove} ${state.moveCount} ${state.lastMove ?? '-'}`;
  },

  decodeState(encoded) {
    const parts = encoded.split(' ');
    if (parts.length !== 4 || !/^[.XO]{9}$/.test(parts[0]!)) {
      throw new Error(`tictactoe: malformed state string '${encoded}'`);
    }
    return {
      board: parts[0]!,
      toMove: Number(parts[1]),
      moveCount: Number(parts[2]),
      lastMove: parts[3] === '-' ? null : parts[3]!,
    };
  },

  parseMove(input, _state, _player) {
    return parseTttMove(input);
  },

  moveToNotation(move, _state) {
    return move;
  },

  moveSummary(move, state) {
    return `plays ${CHARS[state.toMove]} on ${move}`;
  },
};

export default game as unknown as AnyGame;
export type { TttState, TttMove };
