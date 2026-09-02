/**
 * Checkers ASCII render. Every dark square shows its square number prefixed by
 * its occupant ('.' = empty dark square), e.g. ' b12' or ' .16'; light squares
 * are blank. Row 0 (squares 1..4 or 1..5) is at the TOP. Perfect information —
 * every viewer sees the same board.
 */

import {
  boardSize,
  checkersTerminal,
  seatOfColor,
  toSq,
  type CheckersState,
} from './rules.ts';

export function renderCheckers(state: CheckersState): string {
  const size = boardSize(state.variant);
  const lines: string[] = [];
  lines.push(`Checkers (${state.variant}) — squares numbered 1..${(size * size) / 2}, top-left to bottom-right`);
  for (let row = 0; row < size; row++) {
    const cells: string[] = [];
    for (let col = 0; col < size; col++) {
      const sq = toSq(row, col, state.variant);
      if (sq === 0) {
        cells.push('    ');
      } else {
        cells.push(`${state.board[sq - 1]!}${sq}`.padStart(4, ' '));
      }
    }
    lines.push(cells.join(''));
  }
  lines.push("b/w = men, B/W = kings, '.' before a number = empty dark square");
  lines.push(
    `Black (b) = ${seatOfColor('b', state.variant)} moves down; White (w) = ${seatOfColor('w', state.variant)} moves up`,
  );
  lines.push(`Last move: ${state.lastMove ?? '(none)'}`);
  lines.push(`Plies since last capture/man move: ${state.quietClock}/80`);
  const result = checkersTerminal(state);
  if (result) {
    lines.push(
      result.draw
        ? `Game over: draw (${result.reason})`
        : `Game over: ${result.winners.join(', ')} wins (${result.reason})`,
    );
  } else {
    const color = state.toMove === 'b' ? 'Black' : 'White';
    lines.push(
      `${color} (${state.toMove}, ${seatOfColor(state.toMove, state.variant)}) to move — move ${state.moveCount + 1}`,
    );
  }
  return lines.join('\n');
}
