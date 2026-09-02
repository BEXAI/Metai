/**
 * ASCII board render for Go. Column letters on BOTH the top and bottom edges
 * (spec trap note), row numbers on both sides, star points marked '+', the
 * last move wrapped in parentheses, capture counts, and a one-line status.
 * Go is perfect-information, so every viewer (including spectators) sees the
 * same board; the viewer only changes the "You are …" line.
 */

import type { PlayerId } from '../../kernel/types.ts';
import { GO_LETTERS, colLetter } from './notation.ts';
import { BLACK, EMPTY, scoreGo, type GoState } from './rules.ts';

function starPoints(size: number): Set<number> {
  let pts: [number, number][] = [];
  if (size === 19) {
    pts = [];
    for (const c of [3, 9, 15]) for (const r of [3, 9, 15]) pts.push([c, r]);
  } else if (size === 13) {
    pts = [[3, 3], [3, 9], [9, 3], [9, 9], [6, 6]];
  } else if (size === 9) {
    pts = [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]];
  }
  return new Set(pts.map(([c, r]) => r * size + c));
}

/** Board index of the last move, or null when there is none / it was a pass. */
function lastPlayIndex(state: GoState): number | null {
  if (state.last === null) return null;
  const m = /^[BW]\[([A-Z])([0-9]{1,2})\]$/.exec(state.last);
  if (!m) return null; // 'B[pass]' / 'W[pass]'
  const col = GO_LETTERS.indexOf(m[1]!);
  const row = Number(m[2]!) - 1;
  if (col < 0 || col >= state.size || row < 0 || row >= state.size) return null;
  return row * state.size + col;
}

function describeLast(state: GoState): string {
  if (state.last === null) return '(none)';
  const m = /^([BW])\[(.+)\]$/.exec(state.last);
  if (!m) return state.last;
  const who = m[1] === 'B' ? 'Black' : 'White';
  return `${who} ${m[2]!}`;
}

export function renderGo(state: GoState, viewer: PlayerId | null): string {
  const { size, board } = state;
  const stars = starPoints(size);
  const lastIdx = lastPlayIndex(state);
  const letters = '   ' + Array.from({ length: size }, (_, c) => colLetter(c)).join(' ');

  const lines: string[] = [letters];
  for (let row = size - 1; row >= 0; row--) {
    const label = String(row + 1).padStart(2);
    let line = label;
    for (let col = 0; col < size; col++) {
      const idx = row * size + col;
      const sep = idx === lastIdx ? '(' : col > 0 && idx - 1 === lastIdx ? ')' : ' ';
      const raw = board[idx]!;
      const cell = raw === EMPTY ? (stars.has(idx) ? '+' : '.') : raw;
      line += sep + cell;
    }
    line += (row * size + size - 1 === lastIdx ? ')' : ' ') + ' ' + String(row + 1);
    lines.push(line);
  }
  lines.push(letters);

  lines.push('');
  lines.push('X=Black(p0)  O=White(p1)  +=star point  ( )=last move');
  lines.push(
    `Captures: Black ${state.capB}, White ${state.capW}   Komi: ${state.komi}   Consecutive passes: ${state.passes}`,
  );
  lines.push(`Last move: ${describeLast(state)}`);
  if (viewer === 'p0') lines.push(`You are Black (${BLACK}).`);
  else if (viewer === 'p1') lines.push('You are White (O).');

  if (state.ended) {
    const s = scoreGo(state);
    const verdict =
      s.black > s.whiteTotal
        ? `Black wins by ${s.black - s.whiteTotal}.`
        : s.whiteTotal > s.black
          ? `White wins by ${s.whiteTotal - s.black}.`
          : 'Draw.';
    lines.push(
      `Game over (two passes) — area score Black ${s.black} : White ${s.whiteTotal} (incl. komi ${state.komi}). ${verdict}`,
    );
  } else {
    const who = state.toMove === 'B' ? 'Black (p0)' : 'White (p1)';
    lines.push(`${who} to move — move ${state.moves.length + 1}.`);
  }
  return lines.join('\n');
}
