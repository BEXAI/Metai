/**
 * ASCII render for Hex: the classic staircase parallelogram. Each row is
 * indented one extra character so the six hex neighbours of a cell are the
 * two horizontal neighbours, the two vertical ones, and the two short
 * diagonals the offset creates.
 */

import { cellIndex, hexWinner, type HexState } from './rules.ts';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

export function renderHex(state: HexState): string {
  const { size, board } = state;
  const lines: string[] = [];

  const header = Array.from({ length: size }, (_, c) => LETTERS[c]!).join(' ');
  lines.push(`    ${header}   (X: top-bottom)`);

  for (let r = 0; r < size; r++) {
    const cells: string[] = [];
    for (let c = 0; c < size; c++) cells.push(board[cellIndex(c, r, size)]!);
    const rowNum = String(r + 1).padStart(2, ' ');
    lines.push(`${' '.repeat(r)}${rowNum}  ${cells.join(' ')}  ${r + 1}`);
  }
  lines.push(`${' '.repeat(size - 1)}    ${header}   (O: left-right)`);
  lines.push('');
  lines.push('legend: X = p0 (connects row 1 to row ' + size + '), O = p1 (connects column a to column ' + LETTERS[size - 1]! + '), . = empty');
  lines.push(`last move: ${state.lastMove ?? '(none)'}`);

  const winner = hexWinner(state);
  if (winner !== null) {
    lines.push(`status: p${winner} (${winner === 0 ? 'X' : 'O'}) has connected their sides and wins after ${state.moveCount} moves`);
  } else {
    const swapNote = state.moveCount === 1 && state.toMove === 1 ? " ('swap' available)" : '';
    lines.push(`status: p${state.toMove} (${state.toMove === 0 ? 'X' : 'O'}) to move — move ${state.moveCount + 1}${swapNote}`);
  }
  return lines.join('\n');
}
