/**
 * Checkers notation: square numbers (1-32 english, 1-50 international) joined
 * by '-' for quiet moves and 'x' for jumps, one 'x' per captured piece:
 * '11-15', '11x18x25'. A quiet move has exactly two squares.
 */

import type { ParseError } from '../../kernel/types.ts';
import {
  colorOf,
  otherColor,
  squareCount,
  toRC,
  type CheckersState,
  type CheckersVariant,
} from './rules.ts';

export function parseCheckersMove(input: string, variant: CheckersVariant): number[] | ParseError {
  const t = input.trim();
  const bad = (why: string): ParseError => ({
    parseError: true,
    message: `unrecognized move '${input}' — ${why} (want '11-15' or '11x18x25')`,
  });
  if (!/^\d+([x-]\d+)*$/.test(t)) return bad('square numbers joined by - or x');
  const isJump = t.includes('x');
  if (isJump && t.includes('-')) return bad("mix of '-' and 'x'");
  const parts = t.split(isJump ? 'x' : '-');
  if (parts.length < 2) return bad('a move needs at least two squares');
  if (!isJump && parts.length !== 2) return bad("a quiet move is exactly 'from-to'");
  const max = squareCount(variant);
  const path: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > max) return bad(`square ${p} is out of range 1..${max}`);
    path.push(n);
  }
  return path;
}

/**
 * Canonical notation for a path on the given board: 'x' when the first step
 * jumps over an enemy piece (or the path has more than two squares), '-'
 * otherwise.
 */
export function checkersNotation(path: number[], state: CheckersState): string {
  return path.join(pathIsJump(path, state) ? 'x' : '-');
}

export function pathIsJump(path: number[], state: CheckersState): boolean {
  if (path.length > 2) return true;
  if (path.length < 2) return false;
  const from = path[0]!;
  const to = path[1]!;
  const mover = colorOf(state.board[from - 1] ?? '.');
  const enemy = mover ? otherColor(mover) : null;
  const [r0, c0] = toRC(from, state.variant);
  const [r1, c1] = toRC(to, state.variant);
  const dr = Math.sign(r1 - r0);
  const dc = Math.sign(c1 - c0);
  if (Math.abs(r1 - r0) !== Math.abs(c1 - c0) || dr === 0 || dc === 0) return false;
  const size = Math.abs(r1 - r0);
  for (let i = 1; i < size; i++) {
    const cell = betweenChar(state, r0 + i * dr, c0 + i * dc);
    if (cell !== null && colorOf(cell) !== null && (enemy === null || colorOf(cell) === enemy)) {
      return true;
    }
  }
  return false;
}

function betweenChar(state: CheckersState, row: number, col: number): string | null {
  const size = state.variant === 'english' ? 8 : 10;
  if (row < 0 || row >= size || col < 0 || col >= size || (row + col) % 2 !== 1) return null;
  const sq = row * (size / 2) + Math.floor(col / 2) + 1;
  return state.board[sq - 1] ?? null;
}
