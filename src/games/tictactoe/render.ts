/**
 * Tic-Tac-Toe ASCII render: rows 3..1 top to bottom, column letters along the
 * bottom edge. Perfect information — every viewer sees the same board.
 */

import { playerId } from '../../kernel/types.ts';
import { tttTerminal, type TttState } from './rules.ts';

export function renderTtt(state: TttState): string {
  const lines: string[] = [];
  for (let row = 2; row >= 0; row--) {
    const cells: string[] = [];
    for (let col = 0; col < 3; col++) cells.push(state.board[row * 3 + col]!);
    lines.push(` ${row + 1}  ${cells.join(' ')}`);
  }
  lines.push('    a b c');
  lines.push('X = p0, O = p1, . = empty');
  lines.push(`Last move: ${state.lastMove ?? '(none)'}`);
  const result = tttTerminal(state);
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
