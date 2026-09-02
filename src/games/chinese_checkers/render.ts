/**
 * ASCII render for Chinese Checkers: the 121-hole star, rows 1 (top) to 17
 * (bottom). Column letters a..y are split over two header/footer lines (odd
 * columns on one, even on the other) because adjacent rows interleave.
 */

import {
  ccResult,
  goalTriangle,
  HOLES,
  pegsInGoal,
  startTriangle,
  type CcState,
} from './rules.ts';

const LETTERS = 'abcdefghijklmnopqrstuvwxy';

export function renderCc(state: CcState): string {
  const lines: string[] = [];
  const oddHeader = Array.from({ length: 25 }, (_, i) => (i % 2 === 0 ? LETTERS[i]! : ' ')).join('');
  const evenHeader = Array.from({ length: 25 }, (_, i) => (i % 2 === 1 ? LETTERS[i]! : ' ')).join('');
  lines.push(`    ${oddHeader}`);
  lines.push(`    ${evenHeader}`);

  const rows: string[][] = Array.from({ length: 17 }, () => Array.from({ length: 25 }, () => ' '));
  HOLES.forEach((h, i) => {
    rows[h.r - 1]![h.c - 1] = state.board[i]!;
  });
  for (let r = 1; r <= 17; r++) {
    const num = String(r).padStart(2, ' ');
    lines.push(`${num}  ${rows[r - 1]!.join('')}  ${r}`);
  }
  lines.push(`    ${evenHeader}`);
  lines.push(`    ${oddHeader}`);
  lines.push('');

  const legendParts: string[] = [];
  for (let s = 0; s < state.n; s++) {
    const gone = state.forfeited[s] ? ', forfeited' : '';
    legendParts.push(
      `${s} = p${s} (home ${startTriangle(state, s)}, goal ${goalTriangle(state, s)}: ${pegsInGoal(state, s)}/10${gone})`,
    );
  }
  lines.push(`legend: ${legendParts.join(', ')}, . = empty`);
  lines.push(`last move: ${state.lastMove ?? '(none)'}`);

  const result = ccResult(state);
  if (result) {
    lines.push(
      result.draw
        ? `status: shared placement (${result.winners.join(', ')}) by ${result.reason} after ${state.moveCount} moves`
        : `status: ${result.winners[0] ?? 'nobody'} wins by ${result.reason} after ${state.moveCount} moves`,
    );
  } else {
    lines.push(
      `status: p${state.toMove} to move — round ${state.round}/200, their move #${state.movesBy[state.toMove]! + 1}`,
    );
  }
  return lines.join('\n');
}
