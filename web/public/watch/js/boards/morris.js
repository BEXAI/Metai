// Nine Men's Morris: the standard 24-point board (three concentric squares
// joined by four spokes), labeled a1..g7 per spec notation.
//
// view.board is a 24-char string in POINTS order ('.','X'=p0,'O'=p1); POINTS
// is the exact ordering below, matching src/games/nine_mens_morris/rules.ts.

import { makeSvg, line, circle, label } from './common.js';

const CELL = 60;
const MARGIN = 40;

// Valid points on the 7x7 letter/number grid (col a..g = 0..6, row 1..7 = 0..6).
// This exact order matches POINTS in src/games/nine_mens_morris/rules.ts —
// view.board[i] is the state of POINTS[i].
const POINTS = [
  'a1', 'a4', 'a7',
  'b2', 'b4', 'b6',
  'c3', 'c4', 'c5',
  'd1', 'd2', 'd3', 'd5', 'd6', 'd7',
  'e3', 'e4', 'e5',
  'f2', 'f4', 'f6',
  'g1', 'g4', 'g7',
];

const LINES = [
  // outer square
  ['a1', 'a4'], ['a4', 'a7'], ['a7', 'd7'], ['d7', 'g7'], ['g7', 'g4'], ['g4', 'g1'], ['g1', 'd1'], ['d1', 'a1'],
  // middle square
  ['b2', 'b4'], ['b4', 'b6'], ['b6', 'd6'], ['d6', 'f6'], ['f6', 'f4'], ['f4', 'f2'], ['f2', 'd2'], ['d2', 'b2'],
  // inner square
  ['c3', 'c4'], ['c4', 'c5'], ['c5', 'd5'], ['d5', 'e5'], ['e5', 'e4'], ['e4', 'e3'], ['e3', 'd3'], ['d3', 'c3'],
];

function pointCoord(lbl) {
  const col = lbl.charCodeAt(0) - 'a'.charCodeAt(0);
  const row = Number(lbl.slice(1)) - 1;
  return [MARGIN + col * CELL, MARGIN + (6 - row) * CELL];
}

export function render(container, view) {
  const board = view && typeof view.board === 'string' ? view.board : undefined;
  if (!board || board.length !== POINTS.length) return false;

  const w = MARGIN * 2 + 6 * CELL;
  const h = MARGIN * 2 + 6 * CELL;
  const svg = makeSvg(w, h, 'morris-board');

  for (const [a, b] of LINES) {
    const [x1, y1] = pointCoord(a);
    const [x2, y2] = pointCoord(b);
    svg.appendChild(line(x1, y1, x2, y2, 'morris-line'));
  }
  // Four spokes connecting the rings at N/E/S/W midpoints.
  for (const [a, b] of [['d1', 'd3'], ['d7', 'd5'], ['a4', 'c4'], ['g4', 'e4']]) {
    const [x1, y1] = pointCoord(a);
    const [x2, y2] = pointCoord(b);
    svg.appendChild(line(x1, y1, x2, y2, 'morris-line'));
  }

  POINTS.forEach((p, i) => {
    const [x, y] = pointCoord(p);
    const ch = board[i];
    if (ch === 'X') {
      svg.appendChild(circle(x, y, 14, 'morris-piece piece-seat-0'));
    } else if (ch === 'O') {
      svg.appendChild(circle(x, y, 14, 'morris-piece piece-seat-1'));
    } else {
      svg.appendChild(circle(x, y, 6, 'morris-point'));
    }
    svg.appendChild(label(x + 10, y - 10, p, 'coord-label morris-point-label'));
  });

  container.textContent = '';
  container.appendChild(svg);
  return true;
}
