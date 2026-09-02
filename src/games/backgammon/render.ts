/**
 * ASCII board render, always from the VIEWER's perspective: the viewer's
 * checkers are X, they move toward point 1 (bottom right) and bear off.
 * Spectators (viewer null) see the board from p0's side with a neutral legend.
 * Backgammon is a perfect-information game so everyone sees everything.
 */

import { seatIndex, type PlayerId } from '../../kernel/types.ts';
import { absOf, pipCount, terminalResult, type BgState } from './rules.ts';

function cell(sym: string, count: number, row: number): string {
  // row 1 (nearest the edge) .. 5 (nearest the middle); stacks over 5 show the count in row 5.
  let s: string;
  if (count >= row) {
    s = count > 5 && row === 5 ? String(count) : sym;
  } else {
    s = row === 1 ? '.' : ' ';
  }
  return s.padStart(3, ' ');
}

export function renderBoard(state: BgState, viewer: PlayerId | null): string {
  const v = viewer === null ? 0 : seatIndex(viewer);
  const o = 1 - v;

  const symAt = (rel: number): { sym: string; count: number } => {
    const c = state.points[absOf(v, rel) - 1] ?? 0;
    if (c === 0) return { sym: '.', count: 0 };
    const ownerSeat = c > 0 ? 0 : 1;
    return { sym: ownerSeat === v ? 'X' : 'O', count: Math.abs(c) };
  };

  const nums = (points: number[]): string =>
    points.map((p) => String(p).padStart(3, ' ')).join('');

  const half = (points: number[], barSym: string, barCount: number, topDown: boolean): string[] => {
    const rows: string[] = [];
    const order = topDown ? [1, 2, 3, 4, 5] : [5, 4, 3, 2, 1];
    for (const r of order) {
      const left = points.slice(0, 6).map((p) => {
        const { sym, count } = symAt(p);
        return cell(sym, count, r);
      });
      const right = points.slice(6).map((p) => {
        const { sym, count } = symAt(p);
        return cell(sym, count, r);
      });
      rows.push(`|${left.join('')} |${cell(barSym, barCount, r)} |${right.join('')} |`);
    }
    return rows;
  };

  const topPoints = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  const botPoints = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const rule = `+${'-'.repeat(19)}+${'-'.repeat(4)}+${'-'.repeat(19)}+`;

  const lines: string[] = [];
  lines.push(` ${nums(topPoints.slice(0, 6))}  BAR ${nums(topPoints.slice(6))}`);
  lines.push(rule);
  // Opponent's bar checkers sit in the top half (they enter in the top-right quadrant... of their view);
  // shown top = O's bar, bottom = X's bar.
  lines.push(...half(topPoints, 'O', state.bar[o] ?? 0, true));
  lines.push(rule);
  lines.push(...half(botPoints, 'X', state.bar[v] ?? 0, false));
  lines.push(rule);
  lines.push(` ${nums(botPoints.slice(0, 6))}      ${nums(botPoints.slice(6))}`);

  const youLabel = viewer === null ? 'p0' : `you (${viewer})`;
  const oppLabel = `p${o}`;
  lines.push(
    `Bar: X ${state.bar[v] ?? 0}, O ${state.bar[o] ?? 0}   Off: X ${state.off[v] ?? 0}, O ${state.off[o] ?? 0}   Pips: X ${pipCount(state, v)}, O ${pipCount(state, o)}`,
  );
  lines.push(`Last move: ${state.lastMove ?? '(none)'}`);

  const result = terminalResult(state);
  if (result) {
    const line = result.draw
      ? `Game over — draw (${result.reason}).`
      : `Game over — ${result.winners.join(', ')} wins by ${result.reason} (${
          result.scores?.[result.winners[0] ?? ''] ?? 1
        } point${(result.scores?.[result.winners[0] ?? ''] ?? 1) > 1 ? 's' : ''}).`;
    lines.push(line);
  } else {
    const mover = `p${state.turn}`;
    const moverSym = state.turn === v ? 'X' : 'O';
    lines.push(`Turn ${state.turnIndex}: ${mover} (${moverSym}) to move, dice ${state.dice.join(' ')}.`);
  }
  lines.push(
    `Legend: X = ${youLabel}, O = ${oppLabel}. Points numbered from ${
      viewer === null ? "p0's" : 'your'
    } perspective; X moves toward 1, enters from the bar on 24..19, bears off at 'off'.`,
  );
  return lines.join('\n');
}
