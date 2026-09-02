/**
 * Dropline — 7x6 drop-four game (public-domain rules, original name).
 * Moves are column letters 'a'..'g'. No randomness; no seed draws.
 */

import type { AnyGame, Game, Json } from '../../kernel/types.ts';
import { columnIndex, columnLetter, parseDropMove } from './notation.ts';
import { renderDrop } from './render.ts';
import {
  COLS,
  DROP_CHARS,
  dropError,
  dropMover,
  dropTerminal,
  initialDropState,
  ROWS,
  type DropMove,
  type DropState,
} from './rules.ts';

function publicViewOf(state: DropState): Json {
  return {
    cols: state.cols.slice(),
    toMove: dropMover(state),
    moveCount: state.moveCount,
    lastMove: state.lastMove,
  };
}

const game: Game<DropState, DropMove> = {
  meta: {
    id: 'connect_drop',
    name: 'Dropline',
    players: { min: 2, max: 2 },
    information: 'perfect',
    randomness: 'none',
    variants: {},
    notation: "column letter 'a'..'g' — the disc drops to the lowest empty row of that column",
    boardText:
      '7x6 grid, rows 6..1 top to bottom, column letters on the bottom edge; X = p0, O = p1',
    listed: true,
  },

  initialState(_seed, players, _variant): DropState {
    if (players.length !== 2) throw new Error(`connect_drop needs exactly 2 players, got ${players.length}`);
    return initialDropState();
  },

  playersToMove(state) {
    return dropTerminal(state) ? [] : [dropMover(state)];
  },

  legalMoves(state, player) {
    if (dropTerminal(state) || player !== dropMover(state)) return [];
    const out: DropMove[] = [];
    for (let c = 0; c < COLS; c++) if (state.cols[c]!.length < ROWS) out.push(columnLetter(c));
    return out;
  },

  apply(state, player, move, _seed) {
    if (dropTerminal(state)) return dropError('game_over', 'the game is already over');
    if (player !== dropMover(state)) return dropError('not_your_turn', `${player} is not to move`);
    if (typeof move !== 'string' || !/^[a-g]$/.test(move)) {
      return dropError('bad_move', `'${String(move)}' is not a column letter a..g`);
    }
    const c = columnIndex(move);
    const column = state.cols[c]!;
    if (column.length >= ROWS) return dropError('column_full', `column ${move} is full`);
    const cols = state.cols.slice();
    cols[c] = column + DROP_CHARS[state.toMove]!;
    const next: DropState = {
      cols,
      toMove: 1 - state.toMove,
      moveCount: state.moveCount + 1,
      lastMove: move,
    };
    const events = [
      {
        type: 'drop',
        data: { player, column: move, row: column.length + 1 },
        visibility: 'public' as const,
      },
    ];
    return { state: next, events };
  },

  isTerminal(state) {
    return dropTerminal(state);
  },

  publicView(state) {
    return publicViewOf(state);
  },

  privateView(state, _player) {
    return publicViewOf(state);
  },

  renderText(state, _viewer) {
    return renderDrop(state);
  },

  encodeState(state) {
    return `${state.cols.join('/')} ${state.toMove} ${state.moveCount} ${state.lastMove ?? '-'}`;
  },

  decodeState(encoded) {
    const parts = encoded.split(' ');
    if (parts.length !== 4) throw new Error(`connect_drop: malformed state string '${encoded}'`);
    const cols = parts[0]!.split('/');
    if (cols.length !== COLS || cols.some((col) => col.length > ROWS || !/^[XO]*$/.test(col))) {
      throw new Error(`connect_drop: malformed columns '${parts[0]!}'`);
    }
    return {
      cols,
      toMove: Number(parts[1]),
      moveCount: Number(parts[2]),
      lastMove: parts[3] === '-' ? null : parts[3]!,
    };
  },

  parseMove(input, _state, _player) {
    return parseDropMove(input);
  },

  moveToNotation(move, _state) {
    return move;
  },

  moveSummary(move, state) {
    const c = columnIndex(move);
    const row = (state.cols[c]?.length ?? 0) + 1;
    return `drops ${DROP_CHARS[state.toMove]} into column ${move} (lands on row ${row})`;
  },
};

export default game as unknown as AnyGame;
export type { DropState, DropMove };
