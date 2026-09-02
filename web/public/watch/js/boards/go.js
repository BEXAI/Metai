// Go board (9/13/19): column letters A..T skipping I, shown on both the top
// and bottom edges per spec (§games.M2...go.trap). Stones drawn as circles on
// line intersections (traditional Go presentation), not filled squares.
//
// view.board is a flat string of size*size chars ('.','X'=black/p0,'O'=white/
// p1); index = row*size + col, row 0 = the BOTTOM row (src/games/go/rules.ts).

import { makeSvg, circle, line, label, rect } from './common.js';

const LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'; // no I, per convention
const CELL = 32;
const MARGIN = 36;

function hoshiPoints(n) {
  // Standard star-point layouts (0-indexed row/col, row 0 = top of the render).
  if (n === 9) return [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]];
  if (n === 13) return [[3, 3], [3, 9], [9, 3], [9, 9], [6, 6]];
  if (n === 19) return [3, 9, 15].flatMap((r) => [3, 9, 15].map((c) => [r, c]));
  return [];
}

function stoneColorAt(board, size, displayRow, col) {
  // board index uses row 0 = bottom; displayRow 0 = top of the render.
  const boardRow = size - 1 - displayRow;
  const ch = board[boardRow * size + col];
  if (ch === 'X') return 'b';
  if (ch === 'O') return 'w';
  return null;
}

export function render(container, view) {
  const size = view && typeof view.size === 'number' ? view.size : undefined;
  const board = view && typeof view.board === 'string' ? view.board : undefined;
  if (!size || !board || board.length !== size * size) return false;

  const n = size;
  const w = MARGIN * 2 + (n - 1) * CELL;
  const h = MARGIN * 2 + (n - 1) * CELL + 20; // extra for bottom labels
  const svg = makeSvg(w, h, 'go-board');

  const bg = rect(MARGIN - CELL / 2, MARGIN - CELL / 2, (n - 1) * CELL + CELL, (n - 1) * CELL + CELL, 'go-board-bg');
  svg.appendChild(bg);

  for (let i = 0; i < n; i++) {
    const x = MARGIN + i * CELL;
    const y = MARGIN + i * CELL;
    svg.appendChild(line(MARGIN, y, MARGIN + (n - 1) * CELL, y, 'go-line'));
    svg.appendChild(line(x, MARGIN, x, MARGIN + (n - 1) * CELL, 'go-line'));
  }

  for (const [r, c] of hoshiPoints(n)) {
    svg.appendChild(circle(MARGIN + c * CELL, MARGIN + r * CELL, 3, 'go-hoshi'));
  }

  // Coordinate labels on both edges (top+bottom columns, per spec trap note).
  // Row labels count from the bottom (row "1" = bottom, matching A1..T19).
  for (let c = 0; c < n; c++) {
    const x = MARGIN + c * CELL;
    svg.appendChild(label(x, MARGIN - CELL / 2 - 10, LETTERS[c] ?? String(c), 'coord-label coord-file'));
    svg.appendChild(label(x, MARGIN + (n - 1) * CELL + CELL / 2 + 16, LETTERS[c] ?? String(c), 'coord-label coord-file'));
  }
  for (let displayRow = 0; displayRow < n; displayRow++) {
    const y = MARGIN + displayRow * CELL + 4;
    const rank = n - displayRow; // display row 0 (top) = rank n
    svg.appendChild(label(MARGIN - CELL / 2 - 12, y, String(rank), 'coord-label coord-rank'));
  }

  for (let displayRow = 0; displayRow < n; displayRow++) {
    for (let c = 0; c < n; c++) {
      const color = stoneColorAt(board, n, displayRow, c);
      if (!color) continue;
      const cx = MARGIN + c * CELL;
      const cy = MARGIN + displayRow * CELL;
      svg.appendChild(circle(cx, cy, CELL * 0.46, `go-stone stone-${color}`));
    }
  }

  container.textContent = '';
  container.appendChild(svg);
  return true;
}
