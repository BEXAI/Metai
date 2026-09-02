/**
 * ASCII render for Nine Men's Morris: the three concentric squares with
 * connector lines, rows 7 (top) to 1 (bottom), columns a..g left to right.
 */

import { nmmResult, onBoardCount, pointIndex, POINTS, SYMBOLS, type NmmState } from './rules.ts';

const COLS = 'abcdefg';
const X = (col: number): number => col * 4;
const Y = (row: number): number => (7 - row) * 2; // row 7 -> line 0 ... row 1 -> line 12

/** Adjacent pairs re-declared as label pairs for line drawing (same data as rules.ADJ). */
const LINES: [string, string][] = [
  ['a1', 'd1'], ['d1', 'g1'], ['b2', 'd2'], ['d2', 'f2'], ['c3', 'd3'], ['d3', 'e3'],
  ['a4', 'b4'], ['b4', 'c4'], ['e4', 'f4'], ['f4', 'g4'], ['c5', 'd5'], ['d5', 'e5'],
  ['b6', 'd6'], ['d6', 'f6'], ['a7', 'd7'], ['d7', 'g7'],
  ['a1', 'a4'], ['a4', 'a7'], ['b2', 'b4'], ['b4', 'b6'], ['c3', 'c4'], ['c4', 'c5'],
  ['d1', 'd2'], ['d2', 'd3'], ['d5', 'd6'], ['d6', 'd7'], ['e3', 'e4'], ['e4', 'e5'],
  ['f2', 'f4'], ['f4', 'f6'], ['g1', 'g4'], ['g4', 'g7'],
];

function coordOf(label: string): [number, number] {
  const col = COLS.indexOf(label[0]!);
  const row = Number(label[1]!);
  return [X(col), Y(row)];
}

export function renderNmm(state: NmmState): string {
  const grid: string[][] = Array.from({ length: 13 }, () => Array.from({ length: 25 }, () => ' '));

  for (const [a, b] of LINES) {
    const [xa, ya] = coordOf(a);
    const [xb, yb] = coordOf(b);
    if (ya === yb) {
      for (let x = Math.min(xa, xb) + 1; x < Math.max(xa, xb); x++) grid[ya]![x] = '-';
    } else {
      for (let y = Math.min(ya, yb) + 1; y < Math.max(ya, yb); y++) grid[y]![xa] = '|';
    }
  }
  for (const label of POINTS) {
    const [x, y] = coordOf(label);
    grid[y]![x] = state.board[pointIndex(label)!]!;
  }

  const lines: string[] = [];
  for (let y = 0; y < 13; y++) {
    const rowNum = y % 2 === 0 ? String(7 - y / 2) : ' ';
    lines.push(`${rowNum}  ${grid[y]!.join('')}`.replace(/\s+$/, ''));
  }
  lines.push('   a   b   c   d   e   f   g');
  lines.push('');
  const flying = (seat: number): string =>
    state.phase === 'moving' && onBoardCount(state.board, seat) === 3 ? ', flying' : '';
  lines.push(
    `legend: X = p0 (${onBoardCount(state.board, 0)} on board, ${state.inHand[0]!} in hand${flying(0)}), ` +
      `O = p1 (${onBoardCount(state.board, 1)} on board, ${state.inHand[1]!} in hand${flying(1)}), . = empty point`,
  );
  lines.push(`last move: ${state.lastMove ?? '(none)'}`);

  const result = nmmResult(state);
  if (result) {
    lines.push(
      result.draw
        ? `status: draw by ${result.reason} after ${state.moveCount} moves`
        : `status: ${result.winners[0]!} wins by ${result.reason} after ${state.moveCount} moves`,
    );
  } else {
    lines.push(
      `status: p${state.toMove} (${SYMBOLS[state.toMove]!}) to move — ${state.phase} phase, move ${state.moveCount + 1}, ${50 - state.quiet} quiet plies until draw`,
    );
  }
  return lines.join('\n');
}
