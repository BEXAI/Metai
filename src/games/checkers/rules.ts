/**
 * Checkers pure rules.
 *
 * Default variant 'english' (English draughts, 8x8, 32 dark squares):
 *  - men move diagonally forward one square; kings move both ways;
 *  - captures are by short jump and MANDATORY; multi-jumps continue with the
 *    same piece until no further jump exists (one move = the full chain);
 *  - any maximal chain may be chosen (no majority rule);
 *  - men capture forward only; kings capture both ways;
 *  - a man reaching the crowning row is crowned and the move ENDS there;
 *  - draw after 40 moves by each side (80 plies) without a capture or a man
 *    move, or on threefold repetition of position-with-side-to-move;
 *  - a player who cannot move on their turn loses.
 *
 * Variant 'international' (International draughts, 10x10, 50 squares):
 *  - men move forward but capture forward AND backward;
 *  - kings are FLYING: they slide any distance, capture a single piece at any
 *    distance along a diagonal, and may land on any empty square beyond it;
 *  - MAJORITY rule: only chains capturing the maximum number of pieces are
 *    legal (kings and men count equally);
 *  - a man that merely passes through the crowning row mid-chain is NOT
 *    crowned; it is crowned only if its move ENDS on the crowning row;
 *  - captured pieces stay on the board (blocking) until the chain completes,
 *    and no piece may be jumped twice;
 *  - draw and no-move rules as above.
 *
 * Geometry: dark squares are numbered 1..32 (english) / 1..50 (international)
 * left to right, top to bottom. Row 0 is the TOP. Dark squares sit where
 * (row + col) is odd, so square 1 is at (row 0, col 1). Black ('b'/'B') always
 * starts on the low-numbered squares moving DOWN (+row); White ('w'/'W')
 * starts on the high-numbered squares moving UP (-row).
 *
 * Seats follow the official first mover of each variant: english — Black
 * moves first, so p0 = Black, p1 = White; international — White moves first,
 * so p0 = White, p1 = Black.
 *
 * No seed draws are made (perfect information, no randomness).
 */

import { playerId, type GameResult, type PlayerId, type RuleError } from '../../kernel/types.ts';

export type CheckersVariant = 'english' | 'international';

export type CheckersState = {
  variant: CheckersVariant;
  /** One char per dark square (index = square - 1): '.', 'b', 'w', 'B', 'W'. */
  board: string;
  /** Color to move: 'b' or 'w'. */
  toMove: 'b' | 'w';
  /** Plies since the last capture or man move (draw at 80 = 40 by each side). */
  quietClock: number;
  moveCount: number;
  lastMove: string | null;
  /** Repetition counts of `board + toMove` since the last capture/man move. */
  rep: Record<string, number>;
};

/** A move is the visited-square path: [from, to] quiet, [from, land, land...] jumps. */
export type CheckersMove = number[];

export type EnumeratedMove = {
  path: number[];
  /** Squares of the captured pieces, in jump order ([] for quiet moves). */
  captures: number[];
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function boardSize(variant: CheckersVariant): number {
  return variant === 'english' ? 8 : 10;
}

export function squareCount(variant: CheckersVariant): number {
  const s = boardSize(variant);
  return (s * s) / 2;
}

/** Square number (1-based) -> [row, col], row 0 at the top. */
export function toRC(sq: number, variant: CheckersVariant): [number, number] {
  const half = boardSize(variant) / 2;
  const idx = sq - 1;
  const row = Math.floor(idx / half);
  const k = idx % half;
  return [row, row % 2 === 0 ? 2 * k + 1 : 2 * k];
}

/** [row, col] -> square number, or 0 when off-board or a light square. */
export function toSq(row: number, col: number, variant: CheckersVariant): number {
  const size = boardSize(variant);
  if (row < 0 || row >= size || col < 0 || col >= size) return 0;
  if ((row + col) % 2 !== 1) return 0;
  return row * (size / 2) + Math.floor(col / 2) + 1;
}

const DIAGS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

export function colorOf(ch: string): 'b' | 'w' | null {
  if (ch === 'b' || ch === 'B') return 'b';
  if (ch === 'w' || ch === 'W') return 'w';
  return null;
}

export function isKingChar(ch: string): boolean {
  return ch === 'B' || ch === 'W';
}

export function otherColor(color: 'b' | 'w'): 'b' | 'w' {
  return color === 'b' ? 'w' : 'b';
}

/** Forward row direction: black moves down (+1), white moves up (-1). */
export function forwardDir(color: 'b' | 'w'): number {
  return color === 'b' ? 1 : -1;
}

/** Crowning row for a color: black crowns at the bottom row, white at row 0. */
export function crowningRow(color: 'b' | 'w', variant: CheckersVariant): number {
  return color === 'b' ? boardSize(variant) - 1 : 0;
}

/** Seat of a color under the variant's official first mover (p0 moves first). */
export function seatOfColor(color: 'b' | 'w', variant: CheckersVariant): PlayerId {
  if (variant === 'english') return playerId(color === 'b' ? 0 : 1);
  return playerId(color === 'w' ? 0 : 1);
}

export function colorOfSeat(player: PlayerId, variant: CheckersVariant): 'b' | 'w' | null {
  if (seatOfColor('b', variant) === player) return 'b';
  if (seatOfColor('w', variant) === player) return 'w';
  return null;
}

// ---------------------------------------------------------------------------
// Initial position
// ---------------------------------------------------------------------------

export function initialCheckersState(variant: CheckersVariant): CheckersState {
  const n = squareCount(variant);
  const menRows = variant === 'english' ? 3 : 4;
  const perRow = boardSize(variant) / 2;
  const cells = Array.from({ length: n }, () => '.');
  for (let i = 0; i < menRows * perRow; i++) cells[i] = 'b';
  for (let i = n - menRows * perRow; i < n; i++) cells[i] = 'w';
  const board = cells.join('');
  const toMove: 'b' | 'w' = variant === 'english' ? 'b' : 'w';
  return {
    variant,
    board,
    toMove,
    quietClock: 0,
    moveCount: 0,
    lastMove: null,
    rep: { [board + toMove]: 1 },
  };
}

// ---------------------------------------------------------------------------
// Move enumeration
// ---------------------------------------------------------------------------

/**
 * Capture continuations from `cur` for a piece `ch` on the working board.
 * Working-board conventions: '#' marks a piece already jumped in this chain
 * (it blocks squares and cannot be jumped again); the moving piece itself has
 * been placed at `cur`.
 */
function captureSteps(
  cells: string[],
  cur: number,
  ch: string,
  variant: CheckersVariant,
): { over: number; land: number }[] {
  const color = colorOf(ch)!;
  const enemy = otherColor(color);
  const king = isKingChar(ch);
  const [r0, c0] = toRC(cur, variant);
  const out: { over: number; land: number }[] = [];

  const dirs =
    !king && variant === 'english'
      ? DIAGS.filter(([dr]) => dr === forwardDir(color)) // english men capture forward only
      : DIAGS; // kings, and international men (backward capture allowed)

  for (const [dr, dc] of dirs) {
    if (king && variant === 'international') {
      // Flying king: skip empties, then exactly one live enemy, then land on
      // any of the consecutive empty squares beyond it.
      let i = 1;
      let over = 0;
      for (;;) {
        const sq = toSq(r0 + i * dr, c0 + i * dc, variant);
        if (sq === 0) break;
        const cell = cells[sq - 1]!;
        if (cell === '.') {
          i++;
          continue;
        }
        if (colorOf(cell) === enemy) over = sq;
        break; // own piece or '#' (dead) blocks the diagonal
      }
      if (over === 0) continue;
      for (let j = i + 1; ; j++) {
        const land = toSq(r0 + j * dr, c0 + j * dc, variant);
        if (land === 0 || cells[land - 1] !== '.') break;
        out.push({ over, land });
      }
    } else {
      // Short jump: adjacent live enemy, empty square directly beyond.
      const over = toSq(r0 + dr, c0 + dc, variant);
      const land = toSq(r0 + 2 * dr, c0 + 2 * dc, variant);
      if (over === 0 || land === 0) continue;
      if (colorOf(cells[over - 1]!) !== enemy) continue;
      if (cells[land - 1] !== '.') continue;
      out.push({ over, land });
    }
  }
  return out;
}

/** All maximal capture chains for the piece on `from`. */
function captureChainsFrom(
  board: string,
  from: number,
  variant: CheckersVariant,
): EnumeratedMove[] {
  const cells = board.split('');
  const ch = cells[from - 1]!;
  const color = colorOf(ch)!;
  const king = isKingChar(ch);
  const results: EnumeratedMove[] = [];

  const dfs = (cur: number, path: number[], captures: number[]): void => {
    const steps = captureSteps(cells, cur, ch, variant);
    if (steps.length === 0) {
      if (captures.length > 0) results.push({ path: path.slice(), captures: captures.slice() });
      return;
    }
    for (const { over, land } of steps) {
      const savedOver = cells[over - 1]!;
      cells[over - 1] = '#';
      cells[cur - 1] = '.';
      cells[land - 1] = ch;
      path.push(land);
      captures.push(over);

      const [landRow] = toRC(land, variant);
      if (variant === 'english' && !king && landRow === crowningRow(color, variant)) {
        // English: crowning ends the move immediately.
        results.push({ path: path.slice(), captures: captures.slice() });
      } else {
        dfs(land, path, captures);
      }

      captures.pop();
      path.pop();
      cells[land - 1] = '.';
      cells[cur - 1] = ch;
      cells[over - 1] = savedOver;
    }
  };

  dfs(from, [from], []);
  return results;
}

/** All quiet (non-capturing) moves for the piece on `from`. */
function quietMovesFrom(board: string, from: number, variant: CheckersVariant): EnumeratedMove[] {
  const ch = board[from - 1]!;
  const color = colorOf(ch)!;
  const king = isKingChar(ch);
  const [r0, c0] = toRC(from, variant);
  const out: EnumeratedMove[] = [];

  const dirs = king ? DIAGS : DIAGS.filter(([dr]) => dr === forwardDir(color));
  for (const [dr, dc] of dirs) {
    if (king && variant === 'international') {
      for (let i = 1; ; i++) {
        const sq = toSq(r0 + i * dr, c0 + i * dc, variant);
        if (sq === 0 || board[sq - 1] !== '.') break;
        out.push({ path: [from, sq], captures: [] });
      }
    } else {
      const sq = toSq(r0 + dr, c0 + dc, variant);
      if (sq !== 0 && board[sq - 1] === '.') out.push({ path: [from, sq], captures: [] });
    }
  }
  return out;
}

function comparePaths(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/**
 * The complete legal move list for the color to move, in canonical order
 * (paths sorted lexicographically by square number). Captures mandatory;
 * international additionally keeps only maximum-capture chains.
 */
export function enumerateMoves(state: CheckersState): EnumeratedMove[] {
  const color = state.toMove;
  const n = squareCount(state.variant);
  let captures: EnumeratedMove[] = [];
  for (let sq = 1; sq <= n; sq++) {
    if (colorOf(state.board[sq - 1]!) === color) {
      captures.push(...captureChainsFrom(state.board, sq, state.variant));
    }
  }
  if (captures.length > 0) {
    if (state.variant === 'international') {
      const best = Math.max(...captures.map((m) => m.captures.length));
      captures = captures.filter((m) => m.captures.length === best);
    }
    captures.sort((a, b) => comparePaths(a.path, b.path));
    return captures;
  }
  const quiet: EnumeratedMove[] = [];
  for (let sq = 1; sq <= n; sq++) {
    if (colorOf(state.board[sq - 1]!) === color) {
      quiet.push(...quietMovesFrom(state.board, sq, state.variant));
    }
  }
  quiet.sort((a, b) => comparePaths(a.path, b.path));
  return quiet;
}

// ---------------------------------------------------------------------------
// Applying a move
// ---------------------------------------------------------------------------

export function checkersError(code: string, message: string): RuleError {
  return { error: true, code, message };
}

export type AppliedCheckersMove = {
  state: CheckersState;
  captures: number[];
  crowned: boolean;
};

export function applyCheckersMove(
  state: CheckersState,
  path: number[],
  notation: string,
): AppliedCheckersMove | RuleError {
  const legal = enumerateMoves(state);
  const match = legal.find((m) => m.path.length === path.length && comparePaths(m.path, path) === 0);
  if (!match) {
    // Friendlier diagnostics for the two classic traps.
    const hasCaptures = legal.length > 0 && legal[0]!.captures.length > 0;
    if (hasCaptures) {
      if (path.length === 2) {
        const from = path[0]!;
        if (
          colorOf(state.board[from - 1] ?? '') === state.toMove &&
          quietMovesFrom(state.board, from, state.variant).some((m) => m.path[1] === path[1])
        ) {
          return checkersError(
            'capture_mandatory',
            `captures are mandatory — quiet move ${notation} is not allowed while a jump exists`,
          );
        }
      }
      if (state.variant === 'international') {
        return checkersError(
          'not_maximal_capture',
          `${notation} is not a legal chain — international rules require capturing the maximum number of pieces`,
        );
      }
    }
    return checkersError('illegal_move', `${notation} is not a legal move here`);
  }

  const cells = state.board.split('');
  const from = path[0]!;
  const to = path[path.length - 1]!;
  const ch = cells[from - 1]!;
  const color = colorOf(ch)!;
  const wasMan = !isKingChar(ch);
  for (const cap of match.captures) cells[cap - 1] = '.';
  cells[from - 1] = '.';
  const [toRow] = toRC(to, state.variant);
  const crowned = wasMan && toRow === crowningRow(color, state.variant);
  cells[to - 1] = crowned ? ch.toUpperCase() : ch;
  const board = cells.join('');

  const irreversible = match.captures.length > 0 || wasMan;
  const nextToMove = otherColor(color);
  const key = board + nextToMove;
  const rep: Record<string, number> = irreversible
    ? { [key]: 1 }
    : { ...state.rep, [key]: (state.rep[key] ?? 0) + 1 };

  return {
    state: {
      variant: state.variant,
      board,
      toMove: nextToMove,
      quietClock: irreversible ? 0 : state.quietClock + 1,
      moveCount: state.moveCount + 1,
      lastMove: notation,
      rep,
    },
    captures: match.captures,
    crowned,
  };
}

// ---------------------------------------------------------------------------
// Terminal detection
// ---------------------------------------------------------------------------

export function checkersTerminal(state: CheckersState): GameResult | null {
  if ((state.rep[state.board + state.toMove] ?? 0) >= 3) {
    return { winners: [], draw: true, reason: 'threefold_repetition' };
  }
  if (state.quietClock >= 80) {
    return { winners: [], draw: true, reason: 'forty_move_rule' };
  }
  if (enumerateMoves(state).length === 0) {
    return {
      winners: [seatOfColor(otherColor(state.toMove), state.variant)],
      draw: false,
      reason: 'no_moves',
    };
  }
  return null;
}
