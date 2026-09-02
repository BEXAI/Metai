// Chinese checkers: the 121-hole star board, built from the EXACT same
// doubled-coordinate generation as src/games/chinese_checkers/rules.ts#HOLES,
// so view.board[i] (a single '.'/'0'..'5' char) lines up with hole i here.
//
// Doubled coordinates (col, row): row 1 (top apex) .. row 17 (bottom apex);
// neighbours of (c,r) are (c±2,r) and (c±1,r±1). For an equilateral
// triangular lattice this converts to pixel space as
// x = c*(U/2), y = r*(U*sqrt(3)/2) for some unit spacing U.

import { makeSvg, circle, svgEl } from './common.js';
import { clear } from '../dom.js';

const LETTERS = 'abcdefghijklmnopqrstuvwxy'; // 25 columns, a=1..y=25
const ROW_COUNTS = [1, 2, 3, 4, 13, 12, 11, 10, 9, 10, 11, 12, 13, 4, 3, 2, 1];
const U = 22;

function buildHoles() {
  const holes = [];
  for (let r = 1; r <= 17; r++) {
    const k = ROW_COUNTS[r - 1];
    for (let i = 0; i < k; i++) {
      const c = 13 - (k - 1) + 2 * i;
      holes.push({ c, r, label: `${LETTERS[c - 1]}${r}` });
    }
  }
  return holes;
}

const HOLES = buildHoles(); // index i matches view.board[i] exactly

function holePixel(hole) {
  return [hole.c * (U / 2), hole.r * (U * Math.sqrt(3)) / 2];
}

export function render(container, view) {
  const board = view && typeof view.board === 'string' ? view.board : undefined;
  if (!board || board.length !== HOLES.length) return false;

  const pts = HOLES.map(holePixel);
  const pad = U * 2;
  const minX = Math.min(...pts.map((p) => p[0])) - pad;
  const minY = Math.min(...pts.map((p) => p[1])) - pad;
  const maxX = Math.max(...pts.map((p) => p[0])) + pad;
  const maxY = Math.max(...pts.map((p) => p[1])) + pad;

  const svg = makeSvg(maxX - minX, maxY - minY, 'chinese-checkers-board');
  const g = svgEl('g', { transform: `translate(${-minX},${-minY})` });
  svg.appendChild(g);

  HOLES.forEach((hole, i) => {
    const [x, y] = holePixel(hole);
    const ch = board[i];
    if (ch >= '0' && ch <= '5') {
      g.appendChild(circle(x, y, U * 0.4, `cc-peg piece-seat-${ch}`));
    } else {
      g.appendChild(circle(x, y, U * 0.22, 'cc-hole'));
    }
  });

  clear(container);
  container.appendChild(svg);
  return true;
}
