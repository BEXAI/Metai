/**
 * Reversi pure rules: 8x8 flipping game. A move must flank at least one
 * opponent disc; a player with no flanking move must pass (explicit 'pass'
 * move, only legal when no flanking move exists); two consecutive passes or a
 * full board end the game; most discs wins, equal is a draw.
 *
 * State layout: board is a 64-char string over '.BW'. Cell index
 * i = (row - 1) * 8 + col with col 0..7 = a..h and row 1..8 counted from the
 * TOP (standard Othello orientation: a1 is the top-left corner, so the
 * classic first moves for Black are d3 / c4 / f5 / e6).
 * B (black) = p0 and moves first; W (white) = p1. No seed draws are made.
 */

import { playerId, type GameResult, type PlayerId, type RuleError } from '../../kernel/types.ts';

export const SIZE = 8;
export const REVERSI_CHARS = ['B', 'W'] as const;

export type ReversiState = {
  /** 64 chars over '.BW'; index (row-1)*8 + col, row 1 at the top. */
  board: string;
  /** Seat to move: 0 (Black) or 1 (White). */
  toMove: number;
  /** Consecutive passes just played (0, 1, or 2). */
  passes: number;
  moveCount: number;
  lastMove: string | null;
};

/** A move is a cell notation 'a1'..'h8' or 'pass'. */
export type ReversiMove = string;

export function initialReversiState(): ReversiState {
  const cells = Array.from({ length: 64 }, () => '.');
  // Standard setup: White on d4 and e5, Black on e4 and d5 (row 1 at the top).
  cells[3 * 8 + 3] = 'W'; // d4
  cells[4 * 8 + 4] = 'W'; // e5
  cells[3 * 8 + 4] = 'B'; // e4
  cells[4 * 8 + 3] = 'B'; // d5
  return { board: cells.join(''), toMove: 0, passes: 0, moveCount: 0, lastMove: null };
}

const DIRS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

/** All opponent disc indexes flipped by playing `ch` at `idx` ([] = not a flanking move). */
export function flipsFor(board: string, idx: number, ch: 'B' | 'W'): number[] {
  if (board[idx] !== '.') return [];
  const other = ch === 'B' ? 'W' : 'B';
  const r0 = Math.floor(idx / SIZE);
  const c0 = idx % SIZE;
  const flips: number[] = [];
  for (const [dr, dc] of DIRS) {
    const line: number[] = [];
    let r = r0 + dr;
    let c = c0 + dc;
    while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r * SIZE + c] === other) {
      line.push(r * SIZE + c);
      r += dr;
      c += dc;
    }
    if (line.length > 0 && r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r * SIZE + c] === ch) {
      flips.push(...line);
    }
  }
  return flips;
}

/** All flanking-move cell indexes for the seat, in board order. */
export function flankingMoves(board: string, seat: number): number[] {
  const ch = REVERSI_CHARS[seat]!;
  const out: number[] = [];
  for (let i = 0; i < 64; i++) if (flipsFor(board, i, ch).length > 0) out.push(i);
  return out;
}

export function discCounts(board: string): { B: number; W: number } {
  let b = 0;
  let w = 0;
  for (const ch of board) {
    if (ch === 'B') b++;
    else if (ch === 'W') w++;
  }
  return { B: b, W: w };
}

export function reversiTerminal(state: ReversiState): GameResult | null {
  const full = !state.board.includes('.');
  if (!full && state.passes < 2) return null;
  const { B, W } = discCounts(state.board);
  const scores = { [playerId(0)]: B, [playerId(1)]: W };
  if (B === W) return { winners: [], draw: true, scores, reason: 'most_discs' };
  return { winners: [playerId(B > W ? 0 : 1)], draw: false, scores, reason: 'most_discs' };
}

export function reversiError(code: string, message: string): RuleError {
  return { error: true, code, message };
}

export function reversiMover(state: ReversiState): PlayerId {
  return playerId(state.toMove);
}
