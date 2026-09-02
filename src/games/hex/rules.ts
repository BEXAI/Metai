/**
 * Hex rules (spec games.M1_perfect_information.hex).
 *
 * Board: N x N rhombus (N = 7, 11 or 13; default 11). Cells are labelled
 * column letter + row number: a1 top-left, rows increase downward in the
 * render. Hex adjacency in (col, row): (c±1, r), (c, r±1), (c+1, r-1),
 * (c-1, r+1).
 *
 * Sides: p0 ('X') connects the North edge (row 1) to the South edge (row N).
 *        p1 ('O') connects the West edge (column a) to the East edge.
 *
 * First move: seat 0 always moves first (no seed draw; the pie rule is the
 * balancing mechanism). SWAP (pie) rule, steal-the-move convention: on the
 * second ply of the game (exactly one stone on the board, p1 to move) p1's
 * move list additionally contains 'swap', which flips the ownership of the
 * first stone IN PLACE to p1 (no mirroring). Edge assignments never change.
 * After a swap it is p0's turn again.
 *
 * No draws are possible (Hex theorem); the game ends exactly when a player
 * connects their two sides, detected by union-find with four virtual edge
 * nodes.
 *
 * Seed draws: NONE (perfect information, no randomness).
 */

import type { GameEvent, PlayerId, RuleError } from '../../kernel/types.ts';

export type HexState = {
  size: number;
  /** size*size chars, row-major from row 1: '.', 'X' (p0), 'O' (p1). */
  board: string;
  /** Seat to move: 0 | 1. */
  toMove: number;
  moveCount: number;
  swapUsed: boolean;
  lastMove: string | null;
};

/** Moves are notation strings: 'f6' or 'swap'. */
export type HexMove = string;

export const HEX_SIZES = [7, 11, 13] as const;

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

export function cellLabel(col: number, row: number): string {
  return `${LETTERS[col]!}${row + 1}`;
}

/** Returns [col, row] 0-based, or null when off-board for this size. */
export function parseCell(label: string, size: number): [number, number] | null {
  const m = /^([a-z])([0-9]{1,2})$/.exec(label);
  if (!m) return null;
  const col = LETTERS.indexOf(m[1]!);
  const row = Number(m[2]!) - 1;
  if (col < 0 || col >= size || row < 0 || row >= size) return null;
  return [col, row];
}

export function cellIndex(col: number, row: number, size: number): number {
  return row * size + col;
}

/** The six hex neighbours of (col, row) that are on the board. */
export function neighbors(col: number, row: number, size: number): [number, number][] {
  const deltas: [number, number][] = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [1, -1],
    [-1, 1],
  ];
  const out: [number, number][] = [];
  for (const [dc, dr] of deltas) {
    const c = col + dc;
    const r = row + dr;
    if (c >= 0 && c < size && r >= 0 && r < size) out.push([c, r]);
  }
  return out;
}

export function initialHexState(players: PlayerId[], sizeRaw: unknown): HexState {
  const size = Number(sizeRaw ?? 11);
  if (!(HEX_SIZES as readonly number[]).includes(size)) {
    throw new Error(`hex: size must be one of ${HEX_SIZES.join(', ')}, got ${String(sizeRaw)}`);
  }
  if (players.length !== 2) throw new Error('hex: exactly 2 players required');
  return {
    size,
    board: '.'.repeat(size * size),
    toMove: 0,
    moveCount: 0,
    swapUsed: false,
    lastMove: null,
  };
}

function swapAvailable(state: HexState): boolean {
  return state.moveCount === 1 && state.toMove === 1 && !state.swapUsed;
}

/** Complete canonical-order move list for the seat to move: empty cells in row-major order, then 'swap' when available. */
export function enumerateHex(state: HexState): HexMove[] {
  const moves: HexMove[] = [];
  const { size, board } = state;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[cellIndex(c, r, size)] === '.') moves.push(cellLabel(c, r));
    }
  }
  if (swapAvailable(state)) moves.push('swap');
  return moves;
}

function err(code: string, message: string): RuleError {
  return { error: true, code, message };
}

export function applyHex(
  state: HexState,
  seat: number,
  move: HexMove,
): { state: HexState; events: GameEvent[] } | RuleError {
  if (seat !== state.toMove) return err('not_your_turn', `it is seat ${state.toMove}'s turn`);
  if (hexWinner(state) !== null) return err('game_over', 'the game is already decided');

  if (move === 'swap') {
    if (!swapAvailable(state)) {
      return err('swap_unavailable', "'swap' is only legal as the second player's first move of the game");
    }
    const idx = state.board.indexOf('X');
    const board = state.board.slice(0, idx) + 'O' + state.board.slice(idx + 1);
    const next: HexState = {
      size: state.size,
      board,
      toMove: 0,
      moveCount: 2,
      swapUsed: true,
      lastMove: 'swap',
    };
    return {
      state: next,
      events: [
        {
          type: 'swap',
          data: { player: `p${seat}`, stolen: cellLabel(idx % state.size, Math.floor(idx / state.size)) },
          visibility: 'public',
        },
      ],
    };
  }

  const cell = parseCell(move, state.size);
  if (!cell) return err('bad_cell', `'${move}' is not a cell on this ${state.size}x${state.size} board`);
  const [c, r] = cell;
  const idx = cellIndex(c, r, state.size);
  if (state.board[idx] !== '.') return err('occupied', `${move} is already occupied`);

  const stone = seat === 0 ? 'X' : 'O';
  const board = state.board.slice(0, idx) + stone + state.board.slice(idx + 1);
  const next: HexState = {
    size: state.size,
    board,
    toMove: 1 - state.toMove,
    moveCount: state.moveCount + 1,
    swapUsed: state.swapUsed,
    lastMove: move,
  };
  return {
    state: next,
    events: [{ type: 'place', data: { player: `p${seat}`, cell: move }, visibility: 'public' }],
  };
}

// ---------------------------------------------------------------------------
// Win detection: union-find with four virtual edge nodes.
// ---------------------------------------------------------------------------

class UnionFind {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root]! !== root) root = this.parent[root]!;
    while (this.parent[x]! !== x) {
      const next = this.parent[x]!;
      this.parent[x] = root;
      x = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/** Returns the winning seat (0 or 1) or null. Draws are impossible in Hex. */
export function hexWinner(state: HexState): number | null {
  const { size, board } = state;
  const n = size * size;
  const TOP = n;
  const BOTTOM = n + 1;
  const LEFT = n + 2;
  const RIGHT = n + 3;
  const uf = new UnionFind(n + 4);

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const idx = cellIndex(c, r, size);
      const stone = board[idx]!;
      if (stone === '.') continue;
      if (stone === 'X') {
        if (r === 0) uf.union(idx, TOP);
        if (r === size - 1) uf.union(idx, BOTTOM);
      } else {
        if (c === 0) uf.union(idx, LEFT);
        if (c === size - 1) uf.union(idx, RIGHT);
      }
      for (const [nc, nr] of neighbors(c, r, size)) {
        const nIdx = cellIndex(nc, nr, size);
        if (board[nIdx] === stone) uf.union(idx, nIdx);
      }
    }
  }
  if (uf.find(TOP) === uf.find(BOTTOM)) return 0;
  if (uf.find(LEFT) === uf.find(RIGHT)) return 1;
  return null;
}

// ---------------------------------------------------------------------------
// Codec: 'size|board|toMove|moveCount|swapUsed|lastMove'
// ---------------------------------------------------------------------------

export function encodeHex(state: HexState): string {
  return [
    state.size,
    state.board,
    state.toMove,
    state.moveCount,
    state.swapUsed ? 1 : 0,
    state.lastMove ?? '-',
  ].join('|');
}

export function decodeHex(encoded: string): HexState {
  const parts = encoded.split('|');
  if (parts.length !== 6) throw new Error('hex: malformed state string');
  const size = Number(parts[0]!);
  const board = parts[1]!;
  if (board.length !== size * size) throw new Error('hex: board length mismatch');
  return {
    size,
    board,
    toMove: Number(parts[2]!),
    moveCount: Number(parts[3]!),
    swapUsed: parts[4] === '1',
    lastMove: parts[5] === '-' ? null : parts[5]!,
  };
}
