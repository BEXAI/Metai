/**
 * Go — Tromp-Taylor rules exactly (spec games.M2_large_boards_and_multiplayer.go).
 *
 *  - 9x9 default; 13x13 / 19x19 variants; komi 7.5 default (variant-configurable).
 *  - Suicide ILLEGAL by default; variant 'allow_suicide' permits multi-stone
 *    suicide (single-stone suicide is always barred because it recreates the
 *    current position — positional superko).
 *  - POSITIONAL superko: a play may not recreate ANY previous board position.
 *    The state carries a cheap deterministic hash of every position seen.
 *  - Two consecutive passes end the game. Area (Tromp-Taylor) scoring:
 *    stones on board + empty points that reach only one color. No dead-stone
 *    agreement — stones are counted as they stand. White gets komi.
 *
 * Board representation: string of size*size chars '.', 'X' (Black, p0),
 * 'O' (White, p1); index = row * size + col with row 0 = the BOTTOM row
 * (A1 = index 0). Resolution order for a play: place stone, remove opponent
 * groups with no liberties, then self-capture check, then superko check.
 */

import type { GameEvent, GameResult, PlayerId, RuleError, VariantConfig } from '../../kernel/types.ts';
import { pointToNotation } from './notation.ts';

export const EMPTY = '.';
export const BLACK = 'X';
export const WHITE = 'O';

export type GoColor = 'B' | 'W';

export type GoMove = { pass: true } | { pass: false; col: number; row: number };

export type GoState = {
  size: number;
  komi: number;
  allowSuicide: boolean;
  /** size*size chars of '.','X','O'; index = row*size + col; row 0 = bottom. */
  board: string;
  toMove: GoColor;
  /** Consecutive passes so far. */
  passes: number;
  /** Stones captured BY Black / BY White (suicided stones credit the opponent). Display only. */
  capB: number;
  capW: number;
  /** Last move as 'B[E5]' / 'W[pass]', or null before the first move. */
  last: string | null;
  /** boardHash of every position that has occurred, in order, INCLUDING the current one. */
  hashes: string[];
  /** SGF-style move list: 'B[E5]', 'W[pass]', ... */
  moves: string[];
  /** True once two consecutive passes have occurred. */
  ended: boolean;
};

export const GO_SIZES: readonly number[] = [9, 13, 19];
export const GO_KOMIS: readonly number[] = [7.5, 6.5, 5.5, 0.5, 7, 0];

// ---------------------------------------------------------------------------
// Cheap deterministic board hash (two FNV-1a 32-bit passes, 16 hex chars).
// Determinism matters, speed secondary; identical in Node and Workers.
// ---------------------------------------------------------------------------

function fnv1a(s: string, offset: number): number {
  let h = offset >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function boardHash(board: string): string {
  const h1 = fnv1a(board, 0x811c9dc5);
  const h2 = fnv1a(board, 0xcbf29ce4);
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Board helpers
// ---------------------------------------------------------------------------

export function neighborIndices(idx: number, size: number): number[] {
  const col = idx % size;
  const row = (idx - col) / size;
  const out: number[] = [];
  if (col > 0) out.push(idx - 1);
  if (col < size - 1) out.push(idx + 1);
  if (row > 0) out.push(idx - size);
  if (row < size - 1) out.push(idx + size);
  return out;
}

/** Flood-fill the group containing `start`; reports whether it has any liberty. */
function collectGroup(cells: readonly string[], size: number, start: number): { stones: number[]; hasLiberty: boolean } {
  const color = cells[start]!;
  const stones: number[] = [start];
  const seen = new Set<number>([start]);
  let hasLiberty = false;
  for (let i = 0; i < stones.length; i++) {
    for (const n of neighborIndices(stones[i]!, size)) {
      const c = cells[n]!;
      if (c === EMPTY) hasLiberty = true;
      else if (c === color && !seen.has(n)) {
        seen.add(n);
        stones.push(n);
      }
    }
  }
  return { stones, hasLiberty };
}

// ---------------------------------------------------------------------------
// Play resolution: place, capture, self-capture — WITHOUT the superko check.
// ---------------------------------------------------------------------------

export type PlayResolution =
  | { ok: true; board: string; captured: number; suicided: number }
  | { ok: false; code: 'occupied' | 'suicide'; message: string };

export function resolvePlay(
  board: string,
  size: number,
  color: GoColor,
  idx: number,
  allowSuicide: boolean,
): PlayResolution {
  const nt = pointToNotation(idx % size, (idx - (idx % size)) / size);
  if (board[idx] !== EMPTY) {
    return { ok: false, code: 'occupied', message: `point ${nt} is occupied` };
  }
  const stone = color === 'B' ? BLACK : WHITE;
  const enemy = color === 'B' ? WHITE : BLACK;
  const cells = board.split('');
  cells[idx] = stone;

  // 1. Remove adjacent opponent groups left without liberties. Distinct enemy
  //    groups are never adjacent to each other, so removal order cannot create
  //    liberties for another enemy group.
  let captured = 0;
  const checked = new Set<number>();
  for (const n of neighborIndices(idx, size)) {
    if (cells[n] !== enemy || checked.has(n)) continue;
    const g = collectGroup(cells, size, n);
    for (const s of g.stones) checked.add(s);
    if (!g.hasLiberty) {
      for (const s of g.stones) cells[s] = EMPTY;
      captured += g.stones.length;
    }
  }

  // 2. Self-capture check (only possible when nothing was captured).
  let suicided = 0;
  if (captured === 0) {
    const own = collectGroup(cells, size, idx);
    if (!own.hasLiberty) {
      if (!allowSuicide) {
        return { ok: false, code: 'suicide', message: `${nt} would be suicide (no liberties and no captures)` };
      }
      for (const s of own.stones) cells[s] = EMPTY;
      suicided = own.stones.length;
    }
  }

  return { ok: true, board: cells.join(''), captured, suicided };
}

// ---------------------------------------------------------------------------
// Full legality check for a play (resolution + positional superko).
// ---------------------------------------------------------------------------

export type PlayCheck =
  | { legal: true; board: string; captured: number; suicided: number }
  | { legal: false; code: string; message: string };

export function checkPlay(
  state: GoState,
  color: GoColor,
  col: number,
  row: number,
  hashSet?: ReadonlySet<string>,
): PlayCheck {
  if (col < 0 || col >= state.size || row < 0 || row >= state.size || !Number.isInteger(col) || !Number.isInteger(row)) {
    return { legal: false, code: 'off_board', message: `(${col},${row}) is not on the ${state.size}x${state.size} board` };
  }
  const idx = row * state.size + col;
  const r = resolvePlay(state.board, state.size, color, idx, state.allowSuicide);
  if (!r.ok) return { legal: false, code: r.code, message: r.message };
  const h = boardHash(r.board);
  const set = hashSet ?? new Set(state.hashes);
  if (set.has(h)) {
    return {
      legal: false,
      code: 'superko',
      message: `${pointToNotation(col, row)} would recreate a previous board position (positional superko)`,
    };
  }
  return { legal: true, board: r.board, captured: r.captured, suicided: r.suicided };
}

/** Complete legal move list in canonical order: plays by ascending board index (A1, B1, …), then 'pass' last. */
export function enumerateLegal(state: GoState): GoMove[] {
  if (state.ended) return [];
  const moves: GoMove[] = [];
  const set = new Set(state.hashes);
  const n = state.size * state.size;
  for (let idx = 0; idx < n; idx++) {
    if (state.board[idx] !== EMPTY) continue;
    const col = idx % state.size;
    const row = (idx - col) / state.size;
    const c = checkPlay(state, state.toMove, col, row, set);
    if (c.legal) moves.push({ pass: false, col, row });
  }
  moves.push({ pass: true });
  return moves;
}

// ---------------------------------------------------------------------------
// Initial state and apply
// ---------------------------------------------------------------------------

export function initialGoState(players: PlayerId[], variant: VariantConfig): GoState {
  if (players.length !== 2) throw new Error(`go: exactly 2 players required, got ${players.length}`);
  const sizeRaw = variant['board_size'] ?? 9;
  if (typeof sizeRaw !== 'number' || !GO_SIZES.includes(sizeRaw)) {
    throw new Error(`go: board_size must be one of ${GO_SIZES.join(', ')}`);
  }
  const komiRaw = variant['komi'] ?? 7.5;
  if (typeof komiRaw !== 'number' || !GO_KOMIS.includes(komiRaw)) {
    throw new Error(`go: komi must be one of ${GO_KOMIS.join(', ')}`);
  }
  const suicideRaw = variant['allow_suicide'] ?? false;
  if (typeof suicideRaw !== 'boolean') throw new Error('go: allow_suicide must be a boolean');
  const board = EMPTY.repeat(sizeRaw * sizeRaw);
  return {
    size: sizeRaw,
    komi: komiRaw,
    allowSuicide: suicideRaw,
    board,
    toMove: 'B',
    passes: 0,
    capB: 0,
    capW: 0,
    last: null,
    hashes: [boardHash(board)],
    moves: [],
    ended: false,
  };
}

function err(code: string, message: string): RuleError {
  return { error: true, code, message };
}

export function applyGo(state: GoState, color: GoColor | null, move: GoMove): { state: GoState; events: GameEvent[] } | RuleError {
  if (state.ended) return err('game_over', 'the game has ended (two consecutive passes)');
  if (color === null || color !== state.toMove) {
    return err('not_your_turn', `it is ${state.toMove === 'B' ? "Black's (p0)" : "White's (p1)"} turn`);
  }
  const mover: PlayerId = color === 'B' ? 'p0' : 'p1';
  const next: GoColor = color === 'B' ? 'W' : 'B';

  if (move.pass) {
    const passes = state.passes + 1;
    const tag = `${color}[pass]`;
    const ns: GoState = {
      ...state,
      toMove: next,
      passes,
      last: tag,
      moves: [...state.moves, tag],
      ended: passes >= 2,
    };
    const events: GameEvent[] = [
      { type: 'pass', data: { player: mover, color, consecutive_passes: passes }, visibility: 'public' },
    ];
    if (ns.ended) {
      const s = scoreGo(ns);
      events.push({
        type: 'game_end',
        data: { black_area: s.black, white_area: s.white, komi: ns.komi, white_total: s.whiteTotal },
        visibility: 'public',
      });
    }
    return { state: ns, events };
  }

  const c = checkPlay(state, color, move.col, move.row);
  if (!c.legal) return err(c.code, c.message);
  const nt = pointToNotation(move.col, move.row);
  const tag = `${color}[${nt}]`;
  const ns: GoState = {
    ...state,
    board: c.board,
    toMove: next,
    passes: 0,
    capB: state.capB + (color === 'B' ? c.captured : c.suicided),
    capW: state.capW + (color === 'W' ? c.captured : c.suicided),
    last: tag,
    hashes: [...state.hashes, boardHash(c.board)],
    moves: [...state.moves, tag],
    ended: false,
  };
  const events: GameEvent[] = [
    {
      type: 'play',
      data: { player: mover, color, notation: nt, captured: c.captured, suicided: c.suicided },
      visibility: 'public',
    },
  ];
  return { state: ns, events };
}

// ---------------------------------------------------------------------------
// Tromp-Taylor area scoring
// ---------------------------------------------------------------------------

export function scoreGo(state: GoState): { black: number; white: number; whiteTotal: number } {
  const { board, size } = state;
  const n = size * size;
  let black = 0;
  let white = 0;
  for (let i = 0; i < n; i++) {
    if (board[i] === BLACK) black++;
    else if (board[i] === WHITE) white++;
  }
  const visited = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (board[i] !== EMPTY || visited[i]) continue;
    // Flood one empty region; note which colors it reaches.
    const region: number[] = [i];
    visited[i] = 1;
    let reachB = false;
    let reachW = false;
    for (let k = 0; k < region.length; k++) {
      for (const nb of neighborIndices(region[k]!, size)) {
        const c = board[nb]!;
        if (c === EMPTY) {
          if (!visited[nb]) {
            visited[nb] = 1;
            region.push(nb);
          }
        } else if (c === BLACK) reachB = true;
        else reachW = true;
      }
    }
    if (reachB && !reachW) black += region.length;
    else if (reachW && !reachB) white += region.length;
    // reaches both or neither (empty board): neutral, counts for no one
  }
  return { black, white, whiteTotal: white + state.komi };
}

export function goResult(state: GoState): GameResult | null {
  if (!state.ended) return null;
  const s = scoreGo(state);
  const scores: Record<PlayerId, number> = { p0: s.black, p1: s.whiteTotal };
  if (s.black > s.whiteTotal) return { winners: ['p0'], draw: false, scores, reason: 'two_passes' };
  if (s.whiteTotal > s.black) return { winners: ['p1'], draw: false, scores, reason: 'two_passes' };
  return { winners: [], draw: true, scores, reason: 'two_passes' };
}

// ---------------------------------------------------------------------------
// Codec. Pipe-separated; every state field explicit so decode(encode(s)) is
// exact. Tests may compose positions directly: 'auto' in the hashes field
// initializes the superko history to just the given board position.
//
//   go1|size|komi|suicide|toMove|passes|capB|capW|board|last|hashes|moves|ended
// ---------------------------------------------------------------------------

export function encodeGo(state: GoState): string {
  return [
    'go1',
    String(state.size),
    String(state.komi),
    state.allowSuicide ? '1' : '0',
    state.toMove,
    String(state.passes),
    String(state.capB),
    String(state.capW),
    state.board,
    state.last ?? '-',
    state.hashes.join(','),
    state.moves.length > 0 ? state.moves.join(';') : '-',
    state.ended ? '1' : '0',
  ].join('|');
}

export function decodeGo(encoded: string): GoState {
  const parts = encoded.split('|');
  if (parts.length !== 13 || parts[0] !== 'go1') {
    throw new Error('go: bad state string (expected 13 pipe-separated fields starting with go1)');
  }
  const size = Number(parts[1]!);
  if (!GO_SIZES.includes(size)) throw new Error(`go: bad size ${parts[1]!}`);
  const komi = Number(parts[2]!);
  if (!Number.isFinite(komi)) throw new Error(`go: bad komi ${parts[2]!}`);
  const suicideField = parts[3]!;
  if (suicideField !== '0' && suicideField !== '1') throw new Error('go: bad suicide flag');
  const toMove = parts[4]!;
  if (toMove !== 'B' && toMove !== 'W') throw new Error('go: bad toMove');
  const passes = Number(parts[5]!);
  const capB = Number(parts[6]!);
  const capW = Number(parts[7]!);
  if (![passes, capB, capW].every((x) => Number.isInteger(x) && x >= 0)) {
    throw new Error('go: bad counters');
  }
  const board = parts[8]!;
  if (board.length !== size * size || !/^[.XO]*$/.test(board)) {
    throw new Error(`go: board must be ${size * size} chars of . X O`);
  }
  const last = parts[9] === '-' ? null : parts[9]!;
  const hashes = parts[10] === 'auto' ? [boardHash(board)] : parts[10]!.split(',');
  if (hashes.length === 0 || hashes.some((h) => h.length === 0)) throw new Error('go: bad hashes');
  const moves = parts[11] === '-' ? [] : parts[11]!.split(';');
  const endedField = parts[12]!;
  if (endedField !== '0' && endedField !== '1') throw new Error('go: bad ended flag');
  return {
    size,
    komi,
    allowSuicide: suicideField === '1',
    board,
    toMove,
    passes,
    capB,
    capW,
    last,
    hashes,
    moves,
    ended: endedField === '1',
  };
}
