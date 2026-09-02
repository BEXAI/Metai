/**
 * Tic-Tac-Toe pure rules (kernel smoke-test game; not listed in lobbies).
 *
 * State layout: board is a 9-char string over '.XO'. Cell index
 * i = (row - 1) * 3 + col with col 0..2 = a..c and row 1..3 counted from the
 * BOTTOM (chess-like), so index 0 = a1, index 8 = c3.
 * X = p0 and moves first; O = p1. No seed draws are made.
 */

import { playerId, type GameResult, type PlayerId, type RuleError } from '../../kernel/types.ts';

export type TttState = {
  /** 9 chars over '.XO'; index (row-1)*3 + col. */
  board: string;
  /** Seat to move: 0 or 1. */
  toMove: number;
  moveCount: number;
  lastMove: string | null;
};

/** A move is the cell in game notation, e.g. 'b2'. */
export type TttMove = string;

export const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8], // rows
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8], // columns
  [0, 4, 8],
  [2, 4, 6], // diagonals
];

export const CHARS = ['X', 'O'] as const;

export function initialTttState(): TttState {
  return { board: '.'.repeat(9), toMove: 0, moveCount: 0, lastMove: null };
}

export function winnerChar(board: string): 'X' | 'O' | null {
  for (const [a, b, c] of LINES) {
    const ch = board[a];
    if (ch !== '.' && ch === board[b] && ch === board[c]) return ch as 'X' | 'O';
  }
  return null;
}

export function tttTerminal(state: TttState): GameResult | null {
  const w = winnerChar(state.board);
  if (w !== null) {
    return { winners: [playerId(CHARS.indexOf(w))], draw: false, reason: 'three_in_a_row' };
  }
  if (state.moveCount >= 9) return { winners: [], draw: true, reason: 'board_full' };
  return null;
}

export function tttError(code: string, message: string): RuleError {
  return { error: true, code, message };
}

export function tttMover(state: TttState): PlayerId {
  return playerId(state.toMove);
}
