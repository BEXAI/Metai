/**
 * Dropline ASCII render: rows 6..1 top to bottom (discs fall to row 1),
 * column letters along the bottom edge. Perfect information — every viewer
 * sees the same board.
 */

import { playerId } from '../../kernel/types.ts';
import { COLS, discAt, dropTerminal, ROWS, type DropState } from './rules.ts';

export function renderDrop(state: DropState): string {
  const lines: string[] = [];
  for (let row = ROWS - 1; row >= 0; row--) {
    const cells: string[] = [];
    for (let col = 0; col < COLS; col++) cells.push(discAt(state, col, row));
    lines.push(` ${row + 1} | ${cells.join(' ')} |`);
  }
  lines.push('     a b c d e f g');
  lines.push('X = p0, O = p1, . = empty (discs fall to the lowest empty row)');
  lines.push(`Last move: ${state.lastMove ?? '(none)'}`);
  const result = dropTerminal(state);
  if (result) {
    lines.push(
      result.draw
        ? `Game over: draw (${result.reason})`
        : `Game over: ${result.winners.join(', ')} wins (${result.reason})`,
    );
  } else {
    const ch = state.toMove === 0 ? 'X' : 'O';
    lines.push(`${ch} (${playerId(state.toMove)}) to move — move ${state.moveCount + 1}`);
  }
  return lines.join('\n');
}
