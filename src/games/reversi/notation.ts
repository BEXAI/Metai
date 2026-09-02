/**
 * Reversi notation: cells 'a1'..'h8' plus 'pass'. Column a..h left to right,
 * row 1..8 from the TOP (standard Othello orientation).
 */

import type { ParseError } from '../../kernel/types.ts';
import { SIZE } from './rules.ts';

export function cellToIndex(cell: string): number {
  const col = cell.charCodeAt(0) - 97; // 'a'
  const row = cell.charCodeAt(1) - 49; // '1'
  return row * SIZE + col;
}

export function indexToCell(index: number): string {
  const col = index % SIZE;
  const row = Math.floor(index / SIZE);
  return `${String.fromCharCode(97 + col)}${row + 1}`;
}

export function parseReversiMove(input: string): string | ParseError {
  const t = input.trim().toLowerCase();
  if (t === 'pass') return 'pass';
  if (!/^[a-h][1-8]$/.test(t)) {
    return { parseError: true, message: `unrecognized move '${input}' (want a cell a1..h8 or 'pass')` };
  }
  return t;
}
