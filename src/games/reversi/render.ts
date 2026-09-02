/**
 * Reversi ASCII render: column letters a..h across the top, row numbers 1..8
 * down the left side (row 1 at the top — standard Othello orientation).
 * Perfect information — every viewer sees the same board.
 */

import { playerId } from '../../kernel/types.ts';
import { discCounts, reversiTerminal, SIZE, type ReversiState } from './rules.ts';

export function renderReversi(state: ReversiState): string {
  const lines: string[] = [];
  lines.push('    a b c d e f g h');
  for (let row = 0; row < SIZE; row++) {
    const cells: string[] = [];
    for (let col = 0; col < SIZE; col++) cells.push(state.board[row * SIZE + col]!);
    lines.push(` ${row + 1}  ${cells.join(' ')}`);
  }
  const { B, W } = discCounts(state.board);
  lines.push('B = p0 (black), W = p1 (white), . = empty');
  lines.push(`Discs: B ${B} — W ${W}`);
  lines.push(`Last move: ${state.lastMove ?? '(none)'}`);
  const result = reversiTerminal(state);
  if (result) {
    lines.push(
      result.draw
        ? `Game over: draw ${B}-${W}`
        : `Game over: ${result.winners.join(', ')} wins ${Math.max(B, W)}-${Math.min(B, W)}`,
    );
  } else {
    const ch = state.toMove === 0 ? 'B' : 'W';
    lines.push(`${ch} (${playerId(state.toMove)}) to move — move ${state.moveCount + 1}`);
  }
  return lines.join('\n');
}
