// One parametric SVG grid renderer for chess, checkers, reversi, connect_drop
// and tictactoe. Each game encodes its board completely differently (a FEN
// string with no board field at all for chess; per-column bottom-to-top
// strings for connect_drop; flat row-major strings with different row
// directions for tictactoe/reversi; a dark-squares-only numbered string for
// checkers) — see notes/T9.md for exactly which fields this reads, keyed
// against each game's actual src/games/<id>/rules.ts state comment. A
// per-game "normalize" step converts the real view into one common
// { rows, cols, grid[r][c], fileLabel(c), rankLabel(r) } shape; a single
// shared draw routine turns that into SVG.

import { makeSvg, rect, label, svgEl } from './common.js';
import { text, svgTitle } from '../dom.js';

const FILES = 'abcdefghijklmnopqrstuvwxyz';
const CELL = 64;
const MARGIN = 28;

// --- FEN (chess) ------------------------------------------------------------

function parseFenBoard(fen) {
  if (typeof fen !== 'string') return null;
  const boardPart = fen.trim().split(/\s+/)[0];
  if (!boardPart) return null;
  const ranks = boardPart.split('/');
  if (ranks.length !== 8) return null;
  const grid = [];
  for (const rankStr of ranks) {
    const row = [];
    for (const ch of rankStr) {
      if (/[1-8]/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) row.push(null);
      } else if (/[kqrbnpKQRBNP]/.test(ch)) {
        row.push({ color: ch === ch.toUpperCase() ? 'w' : 'b', type: ch.toUpperCase() });
      } else {
        return null; // malformed FEN
      }
    }
    if (row.length !== 8) return null;
    grid.push(row);
  }
  return grid; // grid[0] = rank 8 (top) .. grid[7] = rank 1 (bottom)
}

// The raw internal ChessState (as seen in a replay's initial_state, which is
// not run through publicView) stores the same layout as a flattened FEN
// board field directly: 64 chars, index = rank*8 + file, rank 0 = rank 8.
function parseFlatChessBoard(board) {
  if (typeof board !== 'string' || board.length !== 64) return null;
  const grid = [];
  for (let r = 0; r < 8; r++) {
    const row = [];
    for (let f = 0; f < 8; f++) {
      const ch = board[r * 8 + f];
      row.push(ch === '.' || !ch ? null : { color: ch === ch.toUpperCase() ? 'w' : 'b', type: ch.toUpperCase() });
    }
    grid.push(row);
  }
  return grid;
}

// --- per-game normalizers: real view -> { rows, cols, grid, fileLabel, rankLabel } --

function normalizeChess(view) {
  const grid = parseFenBoard(view && view.fen) ?? parseFlatChessBoard(view && view.board);
  if (!grid) return null;
  return {
    rows: 8,
    cols: 8,
    grid,
    fileLabel: (c) => FILES[c],
    rankLabel: (r) => String(8 - r), // grid row 0 is rank 8
    squareLabel: null,
  };
}

function normalizeTictactoe(view) {
  const board = view && typeof view.board === 'string' ? view.board : null;
  if (!board || board.length !== 9) return null;
  const grid = [];
  for (let d = 0; d < 3; d++) {
    const rank = 3 - d; // displayed row 0 = rank 3 (top)
    const row = [];
    for (let col = 0; col < 3; col++) {
      const ch = board[(rank - 1) * 3 + col];
      row.push(ch === 'X' || ch === 'O' ? { mark: ch } : null);
    }
    grid.push(row);
  }
  return { rows: 3, cols: 3, grid, fileLabel: (c) => FILES[c], rankLabel: (r) => String(3 - r), squareLabel: null };
}

function normalizeConnectDrop(view) {
  const cols = view && Array.isArray(view.cols) ? view.cols : null;
  if (!cols || cols.length === 0) return null;
  const nCols = cols.length;
  const nRows = Math.max(6, ...cols.map((s) => (typeof s === 'string' ? s.length : 0)));
  const grid = [];
  for (let d = 0; d < nRows; d++) {
    const rowFromBottom = nRows - 1 - d; // displayed row 0 = top
    const row = [];
    for (let c = 0; c < nCols; c++) {
      const colStr = typeof cols[c] === 'string' ? cols[c] : '';
      const ch = rowFromBottom < colStr.length ? colStr[rowFromBottom] : null;
      row.push(ch === 'X' || ch === 'O' ? { mark: ch } : null);
    }
    grid.push(row);
  }
  return { rows: nRows, cols: nCols, grid, fileLabel: (c) => FILES[c], rankLabel: (r) => String(nRows - r), squareLabel: null };
}

function normalizeReversi(view) {
  const board = view && typeof view.board === 'string' ? view.board : null;
  if (!board || board.length !== 64) return null;
  const grid = [];
  for (let r = 0; r < 8; r++) {
    // board row 1..8 counted from the TOP; grid row 0 (top) === board row 1.
    const row = [];
    for (let c = 0; c < 8; c++) {
      const ch = board[r * 8 + c];
      row.push(ch === 'B' || ch === 'W' ? { disc: ch } : null);
    }
    grid.push(row);
  }
  return { rows: 8, cols: 8, grid, fileLabel: (c) => FILES[c], rankLabel: (r) => String(r + 1), squareLabel: null };
}

// Checkers: a string of N*N/2 chars, one per DARK square, numbered 1..N²/2
// left-to-right/top-to-bottom (row 0 = top; square 1 sits at (row 0, col 1)).
function normalizeCheckers(view) {
  const board = view && typeof view.board === 'string' ? view.board : null;
  if (!board) return null;
  const n = board.length === 32 ? 8 : board.length === 50 ? 10 : null;
  if (!n) return null;
  const perRow = n / 2;
  const grid = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
  for (let s = 1; s <= board.length; s++) {
    const row = Math.floor((s - 1) / perRow);
    const k = (s - 1) % perRow;
    const col = row % 2 === 0 ? 2 * k + 1 : 2 * k;
    const ch = board[s - 1];
    let cell = null;
    if (ch === 'b' || ch === 'w') cell = { color: ch, king: false, square: s };
    else if (ch === 'B' || ch === 'W') cell = { color: ch.toLowerCase(), king: true, square: s };
    else cell = { color: null, king: false, square: s }; // empty dark square, still numbered
    grid[row][col] = cell;
  }
  return {
    rows: n,
    cols: n,
    grid,
    fileLabel: () => null,
    rankLabel: () => null,
    squareLabel: (r, c) => {
      const cell = grid[r][c];
      return cell ? cell.square : null;
    },
  };
}

const NORMALIZERS = {
  chess: normalizeChess,
  tictactoe: normalizeTictactoe,
  connect_drop: normalizeConnectDrop,
  reversi: normalizeReversi,
  checkers: normalizeCheckers,
};

// --- piece glyph rendering ---------------------------------------------------

const CHESS_GLYPH = {
  w: { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' },
  b: { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' },
};

function pieceNode(gameId, cell, cx, cy) {
  if (!cell) return null;
  if (gameId === 'chess') {
    const glyph = (CHESS_GLYPH[cell.color] || {})[cell.type];
    if (!glyph) return null;
    const t = svgEl('text', { x: cx, y: cy + CELL * 0.16, class: `chess-piece piece-${cell.color}`, 'text-anchor': 'middle' });
    t.appendChild(text(glyph));
    return t;
  }
  if (gameId === 'checkers') {
    if (!cell.color) return null;
    const g = svgEl('g', { class: 'checkers-piece' });
    g.appendChild(circle_(cx, cy, CELL * 0.36, `disc piece-${cell.color}`));
    if (cell.king) g.appendChild(circle_(cx, cy, CELL * 0.2, `disc-king-ring piece-${cell.color}`));
    return g;
  }
  if (gameId === 'reversi') {
    const cls = cell.disc === 'B' ? 'b' : 'w';
    return circle_(cx, cy, CELL * 0.4, `disc piece-${cls}`);
  }
  if (gameId === 'connect_drop') {
    const cls = cell.mark === 'X' ? 'seat-0' : 'seat-1';
    return circle_(cx, cy, CELL * 0.4, `disc piece-${cls}`);
  }
  if (gameId === 'tictactoe') {
    const t = svgEl('text', { x: cx, y: cy + CELL * 0.15, class: `ttt-mark mark-${cell.mark}`, 'text-anchor': 'middle' });
    t.appendChild(text(cell.mark));
    return t;
  }
  return null;
}

function circle_(cx, cy, r, cls) {
  return svgEl('circle', { cx, cy, r, class: cls });
}

export function render(container, gameId, view) {
  const normalizer = NORMALIZERS[gameId];
  const norm = normalizer ? normalizer(view) : null;
  if (!norm) return false;
  const { rows, cols, grid, fileLabel, rankLabel, squareLabel } = norm;

  const w = MARGIN * 2 + cols * CELL;
  const h = MARGIN * 2 + rows * CELL;
  const svg = makeSvg(w, h, `grid-board grid-${gameId}`);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = MARGIN + c * CELL;
      const y = MARGIN + r * CELL;
      let dark;
      if (gameId === 'connect_drop') dark = false; // single-color board; discs carry the color
      else dark = (r + c) % 2 === 1;
      svg.appendChild(rect(x, y, CELL, CELL, dark ? 'square square-dark' : 'square square-light'));
      if (squareLabel) {
        const n = squareLabel(r, c);
        if (n !== null && n !== undefined) {
          svg.appendChild(label(x + CELL - 8, y + 12, String(n), 'coord-label morris-point-label'));
        }
      }
    }
  }

  if (fileLabel) {
    for (let c = 0; c < cols; c++) {
      const lbl = fileLabel(c);
      if (lbl === null || lbl === undefined) continue;
      const x = MARGIN + c * CELL + CELL / 2;
      svg.appendChild(label(x, h - MARGIN + 18, lbl, 'coord-label coord-file'));
    }
  }
  if (rankLabel) {
    for (let r = 0; r < rows; r++) {
      const lbl = rankLabel(r);
      if (lbl === null || lbl === undefined) continue;
      const y = MARGIN + r * CELL + CELL / 2 + 5;
      svg.appendChild(label(MARGIN - 14, y, lbl, 'coord-label coord-rank'));
    }
  }

  for (let r = 0; r < rows; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < cols; c++) {
      const cx = MARGIN + c * CELL + CELL / 2;
      const cy = MARGIN + r * CELL + CELL / 2;
      const node = pieceNode(gameId, row[c], cx, cy);
      if (node) {
        const group = svgEl('g', { class: 'cell-piece' });
        group.appendChild(svgTitle(describeCell(gameId, row[c])));
        group.appendChild(node);
        svg.appendChild(group);
      }
    }
  }

  container.textContent = '';
  container.appendChild(svg);
  return true;
}

function describeCell(gameId, cell) {
  if (!cell) return 'empty';
  try {
    return `${gameId}: ${JSON.stringify(cell)}`;
  } catch {
    return String(cell);
  }
}
