// Hex board: a rhombus of hexagons (11x11 default; 7x7/13x13 variants). The
// two pairs of opposite board edges belong to the two players (classic Hex
// convention); they're drawn in the two seat colors so a spectator can see
// who connects which sides.

import { makeSvg, polygon, label, svgEl } from './common.js';

const SIZE = 24; // hex "radius", center to vertex

function hexCenter(row, col) {
  const x = SIZE * Math.sqrt(3) * (col + row / 2);
  const y = SIZE * 1.5 * row;
  return [x, y];
}

// Pointy-top hexagon vertices at 90,150,210,270,330,30 degrees (clockwise
// from top). Index meaning used below: 0=top,1=upperLeft,2=lowerLeft,
// 3=bottom,4=lowerRight,5=upperRight.
function hexVertices(cx, cy) {
  const angles = [90, 150, 210, 270, 330, 30];
  return angles.map((deg) => {
    const rad = (Math.PI / 180) * deg;
    return [cx + SIZE * Math.cos(rad), cy - SIZE * Math.sin(rad)];
  });
}

// view.board is a flat string of size*size chars ('.','X'=p0,'O'=p1);
// index = row*size + col, row 0 = the TOP row, which is also display row 0
// (src/games/hex/rules.ts) — no flipping needed, unlike Go.
function ownerAt(board, size, row, col) {
  const ch = board[row * size + col];
  if (ch === 'X') return 0;
  if (ch === 'O') return 1;
  return null;
}

export function render(container, view) {
  const n = view && typeof view.size === 'number' ? view.size : undefined;
  const board = view && typeof view.board === 'string' ? view.board : undefined;
  if (!n || !board || board.length !== n * n) return false;

  const margin = SIZE * 3;
  const [maxX] = hexCenter(n - 1, n - 1);
  const w = maxX + margin * 2;
  const h = SIZE * 1.5 * (n - 1) + margin * 2;
  const svg = makeSvg(w, h, 'hex-board');
  const boardGroup = svgEl('g', { transform: `translate(${margin},${margin})` });
  svg.appendChild(boardGroup);

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const [cx, cy] = hexCenter(r, c);
      const verts = hexVertices(cx, cy);
      const cellGroup = svgEl('g', { class: 'hex-cell' });
      cellGroup.appendChild(polygon(verts, 'hex-tile'));

      // Edge-ownership coloring (top/bottom = seat 0, left/right = seat 1).
      if (r === 0) cellGroup.appendChild(edgeStroke(verts, 1, 0, 'hex-edge edge-seat-0'));
      if (r === n - 1) cellGroup.appendChild(edgeStroke(verts, 2, 3, 'hex-edge edge-seat-0'));
      if (c === 0) cellGroup.appendChild(edgeStroke(verts, 1, 2, 'hex-edge edge-seat-1'));
      if (c === n - 1) cellGroup.appendChild(edgeStroke(verts, 0, 5, 'hex-edge edge-seat-1'));
      if (r === 0) cellGroup.appendChild(edgeStroke(verts, 0, 5, 'hex-edge edge-seat-0'));
      if (r === n - 1) cellGroup.appendChild(edgeStroke(verts, 3, 4, 'hex-edge edge-seat-0'));

      const owner = ownerAt(board, n, r, c);
      if (owner !== null && owner !== undefined) {
        cellGroup.appendChild(svgEl('circle', { cx, cy, r: SIZE * 0.55, class: `hex-stone stone-seat-${owner}` }));
      }
      boardGroup.appendChild(cellGroup);
    }
  }

  // Column/row reference labels along the two straight-ish outer edges.
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
  for (let c = 0; c < n; c++) {
    const [cx, cy] = hexCenter(0, c);
    boardGroup.appendChild(label(cx, cy - SIZE * 1.6, LETTERS[c] ?? String(c), 'coord-label coord-file'));
  }
  for (let r = 0; r < n; r++) {
    const [cx, cy] = hexCenter(r, 0);
    boardGroup.appendChild(label(cx - SIZE * 1.8, cy + 4, String(r + 1), 'coord-label coord-rank'));
  }

  container.textContent = '';
  container.appendChild(svg);
  return true;
}

function edgeStroke(verts, i, j, cls) {
  const [x1, y1] = verts[i];
  const [x2, y2] = verts[j];
  return svgEl('line', { x1, y1, x2, y2, class: cls });
}
