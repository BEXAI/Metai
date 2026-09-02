/**
 * Dropline (connect_drop) pure rules: 7 columns x 6 rows, drop a disc into a
 * column, four in a row in any direction wins, full board draws.
 *
 * State layout: cols is an array of 7 strings over 'XO', each string listing
 * the discs in that column from BOTTOM to TOP (index 0 = row 1).
 * X = p0 and moves first; O = p1. No seed draws are made.
 */

import { playerId, type GameResult, type PlayerId, type RuleError } from '../../kernel/types.ts';

export const COLS = 7;
export const ROWS = 6;
export const DROP_CHARS = ['X', 'O'] as const;

export type DropState = {
  /** 7 column strings over 'XO', bottom to top. */
  cols: string[];
  /** Seat to move: 0 or 1. */
  toMove: number;
  moveCount: number;
  lastMove: string | null;
};

/** A move is the column letter 'a'..'g'. */
export type DropMove = string;

export function initialDropState(): DropState {
  return { cols: Array.from({ length: COLS }, () => ''), toMove: 0, moveCount: 0, lastMove: null };
}

/** Disc at (col 0..6, row 0..5 from the bottom), or '.' when empty. */
export function discAt(state: DropState, col: number, row: number): string {
  const column = state.cols[col];
  if (column === undefined || row < 0 || row >= ROWS) return '.';
  return column[row] ?? '.';
}

const DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0], // horizontal
  [0, 1], // vertical
  [1, 1], // diagonal up-right
  [1, -1], // diagonal down-right
];

/** 'X' | 'O' if someone has four in a row, else null. */
export function dropWinner(state: DropState): 'X' | 'O' | null {
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const ch = discAt(state, c, r);
      if (ch === '.') continue;
      for (const [dc, dr] of DIRECTIONS) {
        let run = 1;
        while (run < 4 && discAt(state, c + dc * run, r + dr * run) === ch) run++;
        if (run === 4) return ch as 'X' | 'O';
      }
    }
  }
  return null;
}

export function dropTerminal(state: DropState): GameResult | null {
  const w = dropWinner(state);
  if (w !== null) {
    return { winners: [playerId(DROP_CHARS.indexOf(w))], draw: false, reason: 'four_in_a_row' };
  }
  if (state.moveCount >= COLS * ROWS) return { winners: [], draw: true, reason: 'board_full' };
  return null;
}

export function dropError(code: string, message: string): RuleError {
  return { error: true, code, message };
}

export function dropMover(state: DropState): PlayerId {
  return playerId(state.toMove);
}
