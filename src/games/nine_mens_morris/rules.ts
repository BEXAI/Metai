/**
 * Nine Men's Morris rules (spec games.M1_perfect_information.nine_mens_morris).
 *
 * Standard 24-point grid, point labels a1..g7 (d4 is not a point). Phases:
 *   placing — each player places 9 men alternately (18 plies);
 *   moving  — slide to an adjacent empty point;
 *   flying  — a player reduced to exactly 3 men moves to ANY empty point.
 *
 * Mills: completing a line of three (16 mill lines) removes ONE opponent man
 * as part of the same move (notation suffix 'x<point>'). Removal preference:
 * men NOT in a mill must be taken first; only when every opponent man sits in
 * a mill may a milled man be taken. A move that completes two mills at once
 * (possible only in the placing phase on this topology) still removes one man.
 * If the opponent has no men on the board (rare placing-phase edge) the mill
 * move has no removal suffix.
 *
 * Loss: total men (board + hand) reduced to 2, or no legal move on your turn
 * (blocked; moving phase only — the placing phase always has an empty point).
 * Draw: threefold repetition of (board, side-to-move) in the moving phase, or
 * 50 consecutive plies in the moving phase without a mill being formed.
 *
 * Seed draws: NONE (perfect information, no randomness). Seat 0 ('X') always
 * places first.
 */

import type { GameEvent, PlayerId, RuleError } from '../../kernel/types.ts';

export type NmmState = {
  /** 24 chars in POINTS order: '.', 'X' (p0), 'O' (p1). */
  board: string;
  /** Seat to move: 0 | 1. */
  toMove: number;
  /** Men still in hand, by seat. */
  inHand: number[];
  phase: 'placing' | 'moving';
  /** Consecutive moving-phase plies without a mill (draw at 50). */
  quiet: number;
  /**
   * Position keys (board + toMove) of every moving-phase position reached
   * since the last removal (removals make earlier positions unreachable).
   * Threefold repetition of the current key draws the game.
   */
  history: string[];
  moveCount: number;
  lastMove: string | null;
};

/** Moves are notation strings: 'd1', 'd1xd6', 'd1-d2', 'd1-d2xd6'. */
export type NmmMove = string;

/** The 24 valid points, canonical (alphabetical) order. Board string index === position here. */
export const POINTS = [
  'a1', 'a4', 'a7', 'b2', 'b4', 'b6', 'c3', 'c4', 'c5', 'd1', 'd2', 'd3',
  'd5', 'd6', 'd7', 'e3', 'e4', 'e5', 'f2', 'f4', 'f6', 'g1', 'g4', 'g7',
] as const;

const POINT_INDEX: Record<string, number> = Object.fromEntries(POINTS.map((p, i) => [p, i]));

export function pointIndex(label: string): number | undefined {
  return POINT_INDEX[label];
}

/** The 16 mill lines (8 horizontal, 8 vertical), as point labels. */
export const MILLS: readonly (readonly [string, string, string])[] = [
  ['a1', 'd1', 'g1'],
  ['b2', 'd2', 'f2'],
  ['c3', 'd3', 'e3'],
  ['a4', 'b4', 'c4'],
  ['e4', 'f4', 'g4'],
  ['c5', 'd5', 'e5'],
  ['b6', 'd6', 'f6'],
  ['a7', 'd7', 'g7'],
  ['a1', 'a4', 'a7'],
  ['b2', 'b4', 'b6'],
  ['c3', 'c4', 'c5'],
  ['d1', 'd2', 'd3'],
  ['d5', 'd6', 'd7'],
  ['e3', 'e4', 'e5'],
  ['f2', 'f4', 'f6'],
  ['g1', 'g4', 'g7'],
];

const MILLS_IDX: number[][] = MILLS.map((m) => m.map((p) => POINT_INDEX[p]!));

/** Mills through each point index. */
const MILLS_AT: number[][][] = POINTS.map((_, i) => MILLS_IDX.filter((m) => m.includes(i)));

/** Adjacency lists (point indices), each sorted ascending for canonical order. */
export const ADJ: number[][] = (() => {
  const pairs: [string, string][] = [
    ['a1', 'd1'], ['d1', 'g1'], ['b2', 'd2'], ['d2', 'f2'], ['c3', 'd3'], ['d3', 'e3'],
    ['a4', 'b4'], ['b4', 'c4'], ['e4', 'f4'], ['f4', 'g4'], ['c5', 'd5'], ['d5', 'e5'],
    ['b6', 'd6'], ['d6', 'f6'], ['a7', 'd7'], ['d7', 'g7'],
    ['a1', 'a4'], ['a4', 'a7'], ['b2', 'b4'], ['b4', 'b6'], ['c3', 'c4'], ['c4', 'c5'],
    ['d1', 'd2'], ['d2', 'd3'], ['d5', 'd6'], ['d6', 'd7'], ['e3', 'e4'], ['e4', 'e5'],
    ['f2', 'f4'], ['f4', 'f6'], ['g1', 'g4'], ['g4', 'g7'],
  ];
  const adj: number[][] = POINTS.map(() => []);
  for (const [a, b] of pairs) {
    adj[POINT_INDEX[a]!]!.push(POINT_INDEX[b]!);
    adj[POINT_INDEX[b]!]!.push(POINT_INDEX[a]!);
  }
  for (const list of adj) list.sort((x, y) => x - y);
  return adj;
})();

export const SYMBOLS = ['X', 'O'] as const;

export function initialNmmState(players: PlayerId[]): NmmState {
  if (players.length !== 2) throw new Error('nine_mens_morris: exactly 2 players required');
  return {
    board: '.'.repeat(24),
    toMove: 0,
    inHand: [9, 9],
    phase: 'placing',
    quiet: 0,
    history: [],
    moveCount: 0,
    lastMove: null,
  };
}

export function onBoardCount(board: string, seat: number): number {
  const sym = SYMBOLS[seat]!;
  let n = 0;
  for (const ch of board) if (ch === sym) n++;
  return n;
}

/** Is the man at `idx` part of a completed mill on `board`? */
export function inMill(board: string, idx: number): boolean {
  const sym = board[idx]!;
  if (sym === '.') return false;
  return MILLS_AT[idx]!.some((mill) => mill.every((i) => board[i] === sym));
}

/** Does placing/arriving at `idx` (already written into board) complete a mill for its owner? */
function formsMill(board: string, idx: number): boolean {
  return inMill(board, idx);
}

/** Removal candidates for a mill formed against `oppSeat`, canonical order. */
export function removalCandidates(board: string, oppSeat: number): number[] {
  const sym = SYMBOLS[oppSeat]!;
  const all: number[] = [];
  const unmilled: number[] = [];
  for (let i = 0; i < 24; i++) {
    if (board[i] === sym) {
      all.push(i);
      if (!inMill(board, i)) unmilled.push(i);
    }
  }
  return unmilled.length > 0 ? unmilled : all;
}

function setAt(board: string, idx: number, ch: string): string {
  return board.slice(0, idx) + ch + board.slice(idx + 1);
}

function isFlying(state: NmmState, seat: number): boolean {
  return state.phase === 'moving' && onBoardCount(state.board, seat) === 3;
}

/** Complete canonical-order move list for `seat` (the enumerator; no terminal check). */
export function enumerateNmm(state: NmmState, seat: number): NmmMove[] {
  const sym = SYMBOLS[seat]!;
  const opp = 1 - seat;
  const moves: NmmMove[] = [];

  if (state.phase === 'placing') {
    for (let to = 0; to < 24; to++) {
      if (state.board[to] !== '.') continue;
      const after = setAt(state.board, to, sym);
      if (formsMill(after, to)) {
        const candidates = removalCandidates(after, opp);
        if (candidates.length === 0) moves.push(POINTS[to]!);
        else for (const rc of candidates) moves.push(`${POINTS[to]!}x${POINTS[rc]!}`);
      } else {
        moves.push(POINTS[to]!);
      }
    }
    return moves;
  }

  const flying = isFlying(state, seat);
  for (let from = 0; from < 24; from++) {
    if (state.board[from] !== sym) continue;
    const dests: number[] = [];
    if (flying) {
      for (let to = 0; to < 24; to++) if (state.board[to] === '.') dests.push(to);
    } else {
      for (const to of ADJ[from]!) if (state.board[to] === '.') dests.push(to);
    }
    for (const to of dests) {
      const after = setAt(setAt(state.board, from, '.'), to, sym);
      if (formsMill(after, to)) {
        const candidates = removalCandidates(after, opp);
        if (candidates.length === 0) moves.push(`${POINTS[from]!}-${POINTS[to]!}`);
        else for (const rc of candidates) moves.push(`${POINTS[from]!}-${POINTS[to]!}x${POINTS[rc]!}`);
      } else {
        moves.push(`${POINTS[from]!}-${POINTS[to]!}`);
      }
    }
  }
  return moves;
}

function err(code: string, message: string): RuleError {
  return { error: true, code, message };
}

function positionKey(board: string, toMove: number): string {
  return board + toMove;
}

export function applyNmm(
  state: NmmState,
  seat: number,
  move: NmmMove,
): { state: NmmState; events: GameEvent[] } | RuleError {
  if (seat !== state.toMove) return err('not_your_turn', `it is seat ${state.toMove}'s turn`);
  if (nmmResult(state) !== null) return err('game_over', 'the game is already decided');

  const legal = enumerateNmm(state, seat);
  if (!legal.includes(move)) {
    return err('illegal_move', `'${move}' is not a legal move here`);
  }

  const sym = SYMBOLS[seat]!;
  const oppSeat = 1 - seat;
  const events: GameEvent[] = [];

  // decompose: [from-]to[xremove]
  const [movePart, removePart] = move.split('x') as [string, string?];
  const [fromLabel, toLabel] = movePart.includes('-')
    ? (movePart.split('-') as [string, string])
    : [null, movePart];

  let board = state.board;
  if (fromLabel !== null) {
    board = setAt(board, POINT_INDEX[fromLabel]!, '.');
  }
  const toIdx = POINT_INDEX[toLabel]!;
  board = setAt(board, toIdx, sym);

  const inHand = state.inHand.slice();
  if (fromLabel === null) {
    inHand[seat] = inHand[seat]! - 1;
    events.push({ type: 'place', data: { player: `p${seat}`, at: toLabel }, visibility: 'public' });
  } else {
    events.push({ type: 'move', data: { player: `p${seat}`, from: fromLabel, to: toLabel }, visibility: 'public' });
  }

  const milled = formsMill(board, toIdx);
  if (milled) {
    events.push({ type: 'mill', data: { player: `p${seat}`, at: toLabel }, visibility: 'public' });
  }
  if (removePart !== undefined) {
    board = setAt(board, POINT_INDEX[removePart]!, '.');
    events.push({ type: 'remove', data: { player: `p${seat}`, taken: removePart }, visibility: 'public' });
  }

  const phase: NmmState['phase'] = inHand[0]! === 0 && inHand[1]! === 0 ? 'moving' : 'placing';
  const toMove = oppSeat;

  let quiet: number;
  let history: string[];
  if (phase === 'placing') {
    quiet = 0;
    history = [];
  } else {
    quiet = milled || removePart !== undefined ? 0 : state.quiet + 1;
    const key = positionKey(board, toMove);
    history = removePart !== undefined ? [key] : [...state.history, key];
  }

  const next: NmmState = {
    board,
    toMove,
    inHand,
    phase,
    quiet,
    history,
    moveCount: state.moveCount + 1,
    lastMove: move,
  };
  return { state: next, events };
}

export function nmmResult(
  state: NmmState,
): { winners: string[]; draw: boolean; reason: string } | null {
  // Loss by reduction to two men (board + hand).
  for (const seat of [0, 1]) {
    const total = onBoardCount(state.board, seat) + state.inHand[seat]!;
    if (total <= 2) return { winners: [`p${1 - seat}`], draw: false, reason: 'reduced' };
  }
  // Loss by no legal move (blocked) — only possible in the moving phase.
  if (state.phase === 'moving' && enumerateNmm(state, state.toMove).length === 0) {
    return { winners: [`p${1 - state.toMove}`], draw: false, reason: 'blocked' };
  }
  // Draw by threefold repetition (moving phase).
  if (state.phase === 'moving' && state.history.length > 0) {
    const key = positionKey(state.board, state.toMove);
    let count = 0;
    for (const k of state.history) if (k === key) count++;
    if (count >= 3) return { winners: [], draw: true, reason: 'repetition' };
  }
  // Draw by 50 moving-phase plies without a mill.
  if (state.quiet >= 50) return { winners: [], draw: true, reason: 'fifty_moves' };
  return null;
}

// ---------------------------------------------------------------------------
// Codec: 'board|toMove|ih0,ih1|phase|quiet|moveCount|lastMove|h1,h2,...'
// ---------------------------------------------------------------------------

export function encodeNmm(state: NmmState): string {
  return [
    state.board,
    state.toMove,
    `${state.inHand[0]!},${state.inHand[1]!}`,
    state.phase === 'placing' ? 'p' : 'm',
    state.quiet,
    state.moveCount,
    state.lastMove ?? '-',
    state.history.join(','),
  ].join('|');
}

export function decodeNmm(encoded: string): NmmState {
  const parts = encoded.split('|');
  if (parts.length !== 8) throw new Error('nine_mens_morris: malformed state string');
  const board = parts[0]!;
  if (board.length !== 24) throw new Error('nine_mens_morris: board length mismatch');
  const hand = parts[2]!.split(',').map(Number);
  return {
    board,
    toMove: Number(parts[1]!),
    inHand: [hand[0]!, hand[1]!],
    phase: parts[3] === 'p' ? 'placing' : 'moving',
    quiet: Number(parts[4]!),
    moveCount: Number(parts[5]!),
    lastMove: parts[6] === '-' ? null : parts[6]!,
    history: parts[7]! === '' ? [] : parts[7]!.split(','),
  };
}
