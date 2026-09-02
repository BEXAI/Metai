/**
 * Reversi — 8x8 flanking/flipping game.
 * Moves are cell notations 'a1'..'h8' plus 'pass' (legal only when no
 * flanking move exists). No randomness; no seed draws.
 */

import type { AnyGame, Game, Json } from '../../kernel/types.ts';
import { cellToIndex, indexToCell, parseReversiMove } from './notation.ts';
import { renderReversi } from './render.ts';
import {
  discCounts,
  flankingMoves,
  flipsFor,
  initialReversiState,
  REVERSI_CHARS,
  reversiError,
  reversiMover,
  reversiTerminal,
  type ReversiMove,
  type ReversiState,
} from './rules.ts';

function publicViewOf(state: ReversiState): Json {
  const { B, W } = discCounts(state.board);
  return {
    board: state.board,
    toMove: reversiMover(state),
    passes: state.passes,
    moveCount: state.moveCount,
    lastMove: state.lastMove,
    discs: { B, W },
  };
}

const game: Game<ReversiState, ReversiMove> = {
  meta: {
    id: 'reversi',
    name: 'Reversi',
    players: { min: 2, max: 2 },
    information: 'perfect',
    randomness: 'none',
    variants: {},
    notation:
      "cell 'a1'..'h8' (column a-h, row 1-8 from the top), or 'pass' — legal only when you have no flanking move",
    boardText:
      '8x8 grid, row 1 at the top (Othello orientation), column letters on the top edge; B = p0, W = p1',
    listed: true,
  },

  initialState(_seed, players, _variant): ReversiState {
    if (players.length !== 2) throw new Error(`reversi needs exactly 2 players, got ${players.length}`);
    return initialReversiState();
  },

  playersToMove(state) {
    return reversiTerminal(state) ? [] : [reversiMover(state)];
  },

  legalMoves(state, player) {
    if (reversiTerminal(state) || player !== reversiMover(state)) return [];
    const cells = flankingMoves(state.board, state.toMove);
    if (cells.length === 0) return ['pass'];
    return cells.map(indexToCell);
  },

  apply(state, player, move, _seed) {
    if (reversiTerminal(state)) return reversiError('game_over', 'the game is already over');
    if (player !== reversiMover(state)) return reversiError('not_your_turn', `${player} is not to move`);
    if (typeof move !== 'string' || (move !== 'pass' && !/^[a-h][1-8]$/.test(move))) {
      return reversiError('bad_move', `'${String(move)}' is not a cell a1..h8 or 'pass'`);
    }
    const ch = REVERSI_CHARS[state.toMove]!;

    if (move === 'pass') {
      if (flankingMoves(state.board, state.toMove).length > 0) {
        return reversiError('pass_illegal', 'you have a flanking move, so you may not pass');
      }
      const next: ReversiState = {
        board: state.board,
        toMove: 1 - state.toMove,
        passes: state.passes + 1,
        moveCount: state.moveCount + 1,
        lastMove: 'pass',
      };
      return {
        state: next,
        events: [{ type: 'pass', data: { player }, visibility: 'public' as const }],
      };
    }

    const idx = cellToIndex(move);
    if (state.board[idx] !== '.') return reversiError('occupied', `cell ${move} is already occupied`);
    const flips = flipsFor(state.board, idx, ch);
    if (flips.length === 0) {
      return reversiError('no_flank', `playing on ${move} would not flank any opponent disc`);
    }
    const cells = state.board.split('');
    cells[idx] = ch;
    for (const f of flips) cells[f] = ch;
    const next: ReversiState = {
      board: cells.join(''),
      toMove: 1 - state.toMove,
      passes: 0,
      moveCount: state.moveCount + 1,
      lastMove: move,
    };
    return {
      state: next,
      events: [
        {
          type: 'place',
          data: { player, cell: move, flipped: flips.length },
          visibility: 'public' as const,
        },
      ],
    };
  },

  isTerminal(state) {
    return reversiTerminal(state);
  },

  publicView(state) {
    return publicViewOf(state);
  },

  privateView(state, _player) {
    return publicViewOf(state);
  },

  renderText(state, _viewer) {
    return renderReversi(state);
  },

  encodeState(state) {
    return `${state.board} ${state.toMove} ${state.passes} ${state.moveCount} ${state.lastMove ?? '-'}`;
  },

  decodeState(encoded) {
    const parts = encoded.split(' ');
    if (parts.length !== 5 || !/^[.BW]{64}$/.test(parts[0]!)) {
      throw new Error(`reversi: malformed state string '${encoded}'`);
    }
    return {
      board: parts[0]!,
      toMove: Number(parts[1]),
      passes: Number(parts[2]),
      moveCount: Number(parts[3]),
      lastMove: parts[4] === '-' ? null : parts[4]!,
    };
  },

  parseMove(input, _state, _player) {
    return parseReversiMove(input);
  },

  moveToNotation(move, _state) {
    return move;
  },

  moveSummary(move, state) {
    if (move === 'pass') return 'passes (no flanking move available)';
    const ch = REVERSI_CHARS[state.toMove]!;
    const flips = flipsFor(state.board, cellToIndex(move), ch);
    return `places ${ch} on ${move}, flipping ${flips.length} disc${flips.length === 1 ? '' : 's'}`;
  },
};

export default game as unknown as AnyGame;
export type { ReversiState, ReversiMove };
