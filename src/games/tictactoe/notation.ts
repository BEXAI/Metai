/**
 * Tic-Tac-Toe notation: cells 'a1'..'c3'. Column a..c (left to right), row
 * 1..3 from the bottom. Cell index = (row-1)*3 + col.
 */

import type { ParseError } from '../../kernel/types.ts';

export function cellToIndex(cell: string): number {
  const col = cell.charCodeAt(0) - 97; // 'a'
  const row = cell.charCodeAt(1) - 49; // '1'
  return row * 3 + col;
}

export function indexToCell(index: number): string {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return `${String.fromCharCode(97 + col)}${row + 1}`;
}

export function parseTttMove(input: string): string | ParseError {
  const t = input.trim().toLowerCase();
  if (!/^[a-c][1-3]$/.test(t)) {
    return { parseError: true, message: `unrecognized move '${input}' (want a cell a1..c3)` };
  }
  return t;
}
