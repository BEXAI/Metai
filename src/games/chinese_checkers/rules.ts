/**
 * Chinese Checkers rules (spec games.M2_large_boards_and_multiplayer.chinese_checkers).
 *
 * Board: the 121-hole star, in DOUBLED coordinates (col, row):
 *   rows 1 (top apex) .. 17 (bottom apex); holes per row
 *   1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1, centred on column 13,
 *   every other column. Labels are column letter (a=1 .. y=25) + row number,
 *   e.g. 'm1' top apex, 'a5' far left, 'm17' bottom apex. The six neighbours
 *   of (c, r) are (c±2, r) and (c±1, r±1); a jump lands at (c±4, r) / (c±2, r±2).
 *
 * Triangles (10 holes each): N rows 1-4; S rows 14-17; NW rows 5-8 with
 * c <= 12-r; NE rows 5-8 with c >= 14+r; SW rows 10-13 with c <= r-6;
 * SE rows 10-13 with c >= 32-r. Opposites: N-S, NE-SW, NW-SE.
 *
 * Seat -> start triangle (clockwise seating; goal is always the opposite):
 *   2 players: [N, S]        3 players: [N, SE, SW]
 *   4 players: [N, NE, S, SW]  6 players: [N, NE, SE, S, SW, NW]
 * (5 players is not a legal configuration and initialState throws.)
 *
 * A move is one step to an adjacent empty hole OR a chain of jumps, each over
 * exactly one adjacent peg (any colour) into the empty hole directly beyond.
 * The chain may stop at any landing. Enumeration is a BFS over the static
 * jump graph (pegs are never removed, so reachability is path-independent):
 * a global visited set caps the search, endpoints are deduped, and each
 * endpoint keeps its BFS-shortest path as the canonical notation. The origin
 * hole counts as empty during the chain (the peg has left it). A step and a
 * chain to the same hole are the same move; the step is kept.
 *
 * Anti-stall (spec-exact):
 *  - a move may not END in the player's own start triangle unless it also
 *    STARTED there (pegs never re-enter; shuffling inside before leaving is
 *    allowed, and merely passing through in a chain is allowed);
 *  - a player who still has a peg in their start triangle after their 30th
 *    move forfeits (their pegs stay on the board as frozen obstacles);
 *  - global limit of 200 rounds, then ranking by pegs in the goal triangle;
 *    every player tied at the top shares the placement (draw flag set when
 *    more than one).
 *
 * Win: all 10 holes of your goal triangle occupied by your pegs — the game
 * ends immediately. A blocked player has the explicit move 'pass' (counts as
 * one of their own moves for the 30-move rule).
 *
 * Seed draws: NONE (perfect information, no randomness; seat 0 moves first).
 */

import type { GameEvent, PlayerId, RuleError } from '../../kernel/types.ts';

export type CcState = {
  /** Number of players: 2, 3, 4 or 6. */
  n: number;
  /** 121 chars in HOLES order: '.' or seat digit '0'..'5'. */
  board: string;
  /** Seat to move (always an active seat while the game runs). */
  toMove: number;
  /** Current round, 1-based; the game ends when it exceeds 200. */
  round: number;
  /** Moves made by each seat (passes included). */
  movesBy: number[];
  forfeited: boolean[];
  lastMove: string | null;
  moveCount: number;
};

/** Moves are notation strings: 'm3-l4' (step), 'd5-f7-h9' (jump chain), 'pass'. */
export type CcMove = string;

const LETTERS = 'abcdefghijklmnopqrstuvwxy'; // 25 columns

const ROW_COUNTS = [1, 2, 3, 4, 13, 12, 11, 10, 9, 10, 11, 12, 13, 4, 3, 2, 1];

export type Hole = { c: number; r: number; label: string };

/** The 121 holes in canonical order: rows 1..17 top to bottom, columns ascending. */
export const HOLES: Hole[] = (() => {
  const holes: Hole[] = [];
  for (let r = 1; r <= 17; r++) {
    const k = ROW_COUNTS[r - 1]!;
    for (let i = 0; i < k; i++) {
      const c = 13 - (k - 1) + 2 * i;
      holes.push({ c, r, label: `${LETTERS[c - 1]!}${r}` });
    }
  }
  return holes;
})();

const LABEL_TO_IDX = new Map<string, number>(HOLES.map((h, i) => [h.label, i]));
const COORD_TO_IDX = new Map<number, number>(HOLES.map((h, i) => [h.r * 32 + h.c, i]));

export function holeIndex(label: string): number | undefined {
  return LABEL_TO_IDX.get(label);
}
export function holeAt(c: number, r: number): number | undefined {
  return COORD_TO_IDX.get(r * 32 + c);
}

/** Canonical direction order: up-left, up-right, left, right, down-left, down-right. */
export const DIRS: readonly [number, number][] = [
  [-1, -1],
  [1, -1],
  [-2, 0],
  [2, 0],
  [-1, 1],
  [1, 1],
];

export type Triangle = 'N' | 'NE' | 'SE' | 'S' | 'SW' | 'NW';

export function triangleOf(idx: number): Triangle | null {
  const { c, r } = HOLES[idx]!;
  if (r <= 4) return 'N';
  if (r >= 14) return 'S';
  if (r <= 8) {
    if (c <= 12 - r) return 'NW';
    if (c >= 14 + r) return 'NE';
    return null;
  }
  if (r >= 10) {
    if (c <= r - 6) return 'SW';
    if (c >= 32 - r) return 'SE';
    return null;
  }
  return null;
}

export const OPPOSITE: Record<Triangle, Triangle> = {
  N: 'S',
  S: 'N',
  NE: 'SW',
  SW: 'NE',
  NW: 'SE',
  SE: 'NW',
};

export const SEATS_BY_COUNT: Record<number, Triangle[]> = {
  2: ['N', 'S'],
  3: ['N', 'SE', 'SW'],
  4: ['N', 'NE', 'S', 'SW'],
  6: ['N', 'NE', 'SE', 'S', 'SW', 'NW'],
};

/** Hole indices of each triangle, canonical order. */
export const TRIANGLE_HOLES: Record<Triangle, number[]> = (() => {
  const out: Record<Triangle, number[]> = { N: [], NE: [], SE: [], S: [], SW: [], NW: [] };
  HOLES.forEach((_, i) => {
    const t = triangleOf(i);
    if (t) out[t].push(i);
  });
  return out;
})();

export function startTriangle(state: CcState, seat: number): Triangle {
  return SEATS_BY_COUNT[state.n]![seat]!;
}
export function goalTriangle(state: CcState, seat: number): Triangle {
  return OPPOSITE[startTriangle(state, seat)];
}

export function initialCcState(players: PlayerId[]): CcState {
  const n = players.length;
  const seats = SEATS_BY_COUNT[n];
  if (!seats) throw new Error(`chinese_checkers: player count must be 2, 3, 4 or 6, got ${n}`);
  const board = Array.from({ length: 121 }, () => '.');
  seats.forEach((tri, seat) => {
    for (const idx of TRIANGLE_HOLES[tri]) board[idx] = String(seat);
  });
  return {
    n,
    board: board.join(''),
    toMove: 0,
    round: 1,
    movesBy: Array.from({ length: n }, () => 0),
    forfeited: Array.from({ length: n }, () => false),
    lastMove: null,
    moveCount: 0,
  };
}

export function pegsInGoal(state: CcState, seat: number): number {
  const sym = String(seat);
  let count = 0;
  for (const idx of TRIANGLE_HOLES[goalTriangle(state, seat)]) {
    if (state.board[idx] === sym) count++;
  }
  return count;
}

export function goalFilled(state: CcState, seat: number): boolean {
  return pegsInGoal(state, seat) === 10;
}

function destAllowed(state: CcState, seat: number, fromIdx: number, destIdx: number): boolean {
  const own = startTriangle(state, seat);
  return triangleOf(destIdx) !== own || triangleOf(fromIdx) === own;
}

/**
 * All jump-chain endpoints from `fromIdx`, deduped, with the BFS-shortest
 * canonical path to each. The origin counts as empty; the search is a plain
 * BFS over the static jump graph, so the visited set both caps the search
 * and is exactly the dedupe-by-endpoint the spec asks for.
 */
export function jumpEndpoints(
  board: string,
  fromIdx: number,
): { endpoint: number; path: number[] }[] {
  const parent = new Map<number, number>();
  const visited = new Set<number>([fromIdx]);
  const queue: number[] = [fromIdx];
  const order: number[] = [];
  while (queue.length > 0) {
    const u = queue.shift()!;
    const { c, r } = HOLES[u]!;
    for (const [dc, dr] of DIRS) {
      const mid = holeAt(c + dc, r + dr);
      const land = holeAt(c + 2 * dc, r + 2 * dr);
      if (mid === undefined || land === undefined) continue;
      if (mid === fromIdx || board[mid] === '.') continue; // nothing (left) to jump over
      if (land !== fromIdx && board[land] !== '.') continue; // landing must be empty
      if (visited.has(land)) continue;
      visited.add(land);
      parent.set(land, u);
      queue.push(land);
      order.push(land);
    }
  }
  return order.map((endpoint) => {
    const path: number[] = [];
    for (let at: number | undefined = endpoint; at !== undefined; at = parent.get(at)) {
      path.push(at);
      if (at === fromIdx) break;
    }
    path.reverse();
    return { endpoint, path };
  });
}

/** Complete canonical-order move list for `seat` (no turn/terminal checks). */
export function enumerateCc(state: CcState, seat: number): CcMove[] {
  const sym = String(seat);
  const moves: CcMove[] = [];
  for (let from = 0; from < 121; from++) {
    if (state.board[from] !== sym) continue;
    const fromLabel = HOLES[from]!.label;
    const { c, r } = HOLES[from]!;
    const stepDests: number[] = [];
    for (const [dc, dr] of DIRS) {
      const dest = holeAt(c + dc, r + dr);
      if (dest === undefined || state.board[dest] !== '.') continue;
      if (!destAllowed(state, seat, from, dest)) continue;
      stepDests.push(dest);
    }
    stepDests.sort((a, b) => a - b);
    for (const dest of stepDests) moves.push(`${fromLabel}-${HOLES[dest]!.label}`);

    const stepSet = new Set(stepDests);
    const jumps = jumpEndpoints(state.board, from)
      .filter((j) => !stepSet.has(j.endpoint) && destAllowed(state, seat, from, j.endpoint))
      .sort((a, b) => a.endpoint - b.endpoint);
    for (const j of jumps) moves.push(j.path.map((i) => HOLES[i]!.label).join('-'));
  }
  if (moves.length === 0) moves.push('pass');
  return moves;
}

function err(code: string, message: string): RuleError {
  return { error: true, code, message };
}

function nextActiveSeat(n: number, forfeited: boolean[], after: number): number {
  for (let d = 1; d <= n; d++) {
    const s = (after + d) % n;
    if (!forfeited[s]) return s;
  }
  return after;
}

export function applyCc(
  state: CcState,
  seat: number,
  move: CcMove,
): { state: CcState; events: GameEvent[] } | RuleError {
  if (ccResult(state) !== null) return err('game_over', 'the game is already decided');
  if (seat !== state.toMove) return err('not_your_turn', `it is seat ${state.toMove}'s turn`);

  const legal = enumerateCc(state, seat);
  if (!legal.includes(move)) {
    return err('illegal_move', `'${move}' is not a legal move here (submit the canonical path from legal_moves)`);
  }

  const events: GameEvent[] = [];
  let board = state.board;
  if (move === 'pass') {
    events.push({ type: 'pass', data: { player: `p${seat}` }, visibility: 'public' });
  } else {
    const labels = move.split('-');
    const from = LABEL_TO_IDX.get(labels[0]!)!;
    const to = LABEL_TO_IDX.get(labels[labels.length - 1]!)!;
    board = board.slice(0, from) + '.' + board.slice(from + 1);
    board = board.slice(0, to) + String(seat) + board.slice(to + 1);
    events.push({
      type: 'move',
      data: { player: `p${seat}`, path: labels, jumps: isStepMove(move) ? 0 : labels.length - 1 },
      visibility: 'public',
    });
  }

  const movesBy = state.movesBy.slice();
  movesBy[seat] = movesBy[seat]! + 1;

  const forfeited = state.forfeited.slice();
  const own = SEATS_BY_COUNT[state.n]![seat]!;
  const sym = String(seat);
  if (movesBy[seat]! >= 30 && TRIANGLE_HOLES[own].some((i) => board[i] === sym)) {
    forfeited[seat] = true;
    events.push({
      type: 'forfeit',
      data: { player: `p${seat}`, reason: 'start triangle not vacated within 30 moves' },
      visibility: 'public',
    });
  }

  const next = nextActiveSeat(state.n, forfeited, seat);
  const round = next <= seat ? state.round + 1 : state.round;

  const nextState: CcState = {
    n: state.n,
    board,
    toMove: next,
    round,
    movesBy,
    forfeited,
    lastMove: move,
    moveCount: state.moveCount + 1,
  };
  return { state: nextState, events };
}

/** Is a two-hole move a single step (adjacent), as opposed to a one-jump chain? */
export function isStepMove(move: CcMove): boolean {
  const labels = move.split('-');
  if (labels.length !== 2) return false;
  const a = LABEL_TO_IDX.get(labels[0]!);
  const b = LABEL_TO_IDX.get(labels[1]!);
  if (a === undefined || b === undefined) return false;
  const dc = HOLES[b]!.c - HOLES[a]!.c;
  const dr = HOLES[b]!.r - HOLES[a]!.r;
  return DIRS.some(([xc, xr]) => xc === dc && xr === dr);
}

export function ccResult(
  state: CcState,
): { winners: string[]; draw: boolean; reason: string; scores: Record<string, number> } | null {
  const scores: Record<string, number> = {};
  for (let s = 0; s < state.n; s++) scores[`p${s}`] = pegsInGoal(state, s);

  const active: number[] = [];
  for (let s = 0; s < state.n; s++) if (!state.forfeited[s]) active.push(s);

  for (const s of active) {
    if (goalFilled(state, s)) {
      return { winners: [`p${s}`], draw: false, reason: 'goal', scores };
    }
  }
  if (active.length === 1) {
    return { winners: [`p${active[0]!}`], draw: false, reason: 'forfeit', scores };
  }
  if (active.length === 0) {
    return { winners: [], draw: true, reason: 'forfeit', scores }; // defensive; unreachable
  }
  if (state.round > 200) {
    const best = Math.max(...active.map((s) => pegsInGoal(state, s)));
    const winners = active.filter((s) => pegsInGoal(state, s) === best).map((s) => `p${s}`);
    return { winners, draw: winners.length > 1, reason: 'turn_limit', scores };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Codec: 'n|board|toMove|round|movesBy(,)|forfeited(01)|lastMove|moveCount'
// ---------------------------------------------------------------------------

export function encodeCc(state: CcState): string {
  return [
    state.n,
    state.board,
    state.toMove,
    state.round,
    state.movesBy.join(','),
    state.forfeited.map((f) => (f ? '1' : '0')).join(''),
    state.lastMove ?? '*',
    state.moveCount,
  ].join('|');
}

export function decodeCc(encoded: string): CcState {
  const parts = encoded.split('|');
  if (parts.length !== 8) throw new Error('chinese_checkers: malformed state string');
  const board = parts[1]!;
  if (board.length !== 121) throw new Error('chinese_checkers: board length mismatch');
  return {
    n: Number(parts[0]!),
    board,
    toMove: Number(parts[2]!),
    round: Number(parts[3]!),
    movesBy: parts[4]!.split(',').map(Number),
    forfeited: parts[5]!.split('').map((ch) => ch === '1'),
    lastMove: parts[6] === '*' ? null : parts[6]!,
    moveCount: Number(parts[7]!),
  };
}
