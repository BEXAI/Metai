/**
 * Chess rules engine (track T3a). Pure, no I/O, no randomness.
 *
 * Internal representation: mailbox-120 (10x12 board with two-file / two-rank
 * sentinel border, OFF = 99). Moves are packed ints:
 *   move = from120 | (to120 << 7) | (promoType << 14)
 * where promoType is 0 (none) or the piece type N=2, B=3, R=4, Q=5.
 * Legality = pseudo-legal generation + make / own-king-attacked / unmake.
 *
 * The JSON game state (ChessState) is a FEN-equivalent plain object plus a
 * repetition-count table and the last move (see index.ts / notes/T3a-chess.md).
 * The en-passant field is normalized FIDE-style: it is set ONLY when at least
 * one *legal* en-passant capture exists, so repetition keys are exactly FIDE
 * "same position" keys (side to move, castling rights, real ep availability).
 */

import { playerId, type GameResult } from '../../kernel/types.ts';

// ---------------------------------------------------------------------------
// Pieces and squares
// ---------------------------------------------------------------------------

export const EMPTY = 0;
export const OFF = 99;
export const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;
export const WP = 1, WN = 2, WB = 3, WR = 4, WQ = 5, WK = 6;
export const BP = 7, BN = 8, BB = 9, BR = 10, BQ = 11, BK = 12;

const PIECE_CHARS = '.PNBRQKpnbrqk'; // index = piece code
const FILES = 'abcdefgh';

export function typeOf(p: number): number {
  return p > 6 ? p - 6 : p;
}
/** 0 = white, 1 = black. Only call on non-empty piece codes. */
export function colorOf(p: number): 0 | 1 {
  return p > 6 ? 1 : 0;
}
export function pieceChar(p: number): string {
  return PIECE_CHARS.charAt(p);
}
export function pieceFromChar(ch: string): number {
  const i = PIECE_CHARS.indexOf(ch);
  return i > 0 ? i : -1;
}

/** sq64: rank * 8 + file, rank 0 = rank '1'. sq120 = 21 + rank*10 + file. */
export const SQ120: readonly number[] = (() => {
  const a: number[] = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) a[r * 8 + f] = 21 + r * 10 + f;
  return a;
})();

export function fileOf120(s: number): number {
  return (s - 21) % 10;
}
export function rankOf120(s: number): number {
  return Math.floor((s - 21) / 10);
}
export function sqName(s120: number): string {
  return FILES.charAt(fileOf120(s120)) + String(rankOf120(s120) + 1);
}
/** 'e4' -> 120-index, or -1 if malformed. */
export function sqFromName(name: string): number {
  if (name.length !== 2) return -1;
  const f = FILES.indexOf(name.charAt(0));
  const r = Number(name.charAt(1)) - 1;
  if (f < 0 || r < 0 || r > 7 || !Number.isInteger(r)) return -1;
  return 21 + r * 10 + f;
}
/** Square shade for bishop comparisons: (rank + file) & 1. */
export function sqShade(s120: number): number {
  return (rankOf120(s120) + fileOf120(s120)) & 1;
}

// ---------------------------------------------------------------------------
// Move packing
// ---------------------------------------------------------------------------

export function mvFrom(m: number): number {
  return m & 127;
}
export function mvTo(m: number): number {
  return (m >> 7) & 127;
}
export function mvPromo(m: number): number {
  return (m >> 14) & 7;
}
function mv(from: number, to: number, promo = 0): number {
  return from | (to << 7) | (promo << 14);
}

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

export interface Pos {
  board: Int16Array; // 120 entries, OFF on the border
  turn: 0 | 1;
  castling: number; // bit 1 = K, 2 = Q, 4 = k, 8 = q
  ep: number; // 120-index of the en-passant target square, or -1
  halfmove: number;
  fullmove: number;
  kingSq: Int16Array; // [whiteKing120, blackKing120]
  // undo stacks (parallel)
  uCap: number[];
  uCapSq: number[];
  uCastling: number[];
  uEp: number[];
  uHalf: number[];
  uPiece: number[];
}

export function newPos(): Pos {
  const board = new Int16Array(120).fill(OFF);
  for (let i = 0; i < 64; i++) board[SQ120[i]!] = EMPTY;
  return {
    board,
    turn: 0,
    castling: 0,
    ep: -1,
    halfmove: 0,
    fullmove: 1,
    kingSq: new Int16Array(2),
    uCap: [],
    uCapSq: [],
    uCastling: [],
    uEp: [],
    uHalf: [],
    uPiece: [],
  };
}

const KNIGHT_D = [-21, -19, -12, -8, 8, 12, 19, 21] as const;
const KING_D = [-11, -10, -9, -1, 1, 9, 10, 11] as const;
const BISHOP_D = [-11, -9, 9, 11] as const;
const ROOK_D = [-10, -1, 1, 10] as const;

/** castling &= mask[from] & mask[to] — clears rights when king/rook moves or rook is captured. */
const CASTLE_MASK: readonly number[] = (() => {
  const m = new Array<number>(120).fill(15);
  m[25] = 15 & ~3; // e1
  m[28] = 15 & ~1; // h1
  m[21] = 15 & ~2; // a1
  m[95] = 15 & ~12; // e8
  m[98] = 15 & ~4; // h8
  m[91] = 15 & ~8; // a8
  return m;
})();

// ---------------------------------------------------------------------------
// Attack detection
// ---------------------------------------------------------------------------

export function attacked(pos: Pos, sq: number, by: 0 | 1): boolean {
  const b = pos.board;
  if (by === 0) {
    if (b[sq - 9] === WP || b[sq - 11] === WP) return true;
  } else {
    if (b[sq + 9] === BP || b[sq + 11] === BP) return true;
  }
  const kn = by === 0 ? WN : BN;
  for (let i = 0; i < 8; i++) if (b[sq + KNIGHT_D[i]!] === kn) return true;
  const kg = by === 0 ? WK : BK;
  for (let i = 0; i < 8; i++) if (b[sq + KING_D[i]!] === kg) return true;
  const rk = by === 0 ? WR : BR;
  const qn = by === 0 ? WQ : BQ;
  for (let i = 0; i < 4; i++) {
    const d = ROOK_D[i]!;
    let t = sq + d;
    while (b[t] === EMPTY) t += d;
    const q = b[t]!;
    if (q === rk || q === qn) return true;
  }
  const bi = by === 0 ? WB : BB;
  for (let i = 0; i < 4; i++) {
    const d = BISHOP_D[i]!;
    let t = sq + d;
    while (b[t] === EMPTY) t += d;
    const q = b[t]!;
    if (q === bi || q === qn) return true;
  }
  return false;
}

export function inCheck(pos: Pos): boolean {
  return attacked(pos, pos.kingSq[pos.turn]!, (pos.turn ^ 1) as 0 | 1);
}

// ---------------------------------------------------------------------------
// Make / unmake
// ---------------------------------------------------------------------------

export function make(pos: Pos, m: number): void {
  const from = m & 127;
  const to = (m >> 7) & 127;
  const promo = (m >> 14) & 7;
  const us = pos.turn;
  const b = pos.board;
  const piece = b[from]!;
  const t = typeOf(piece);
  let captured = b[to]!;
  let capSq = to;

  pos.uCastling.push(pos.castling);
  pos.uEp.push(pos.ep);
  pos.uHalf.push(pos.halfmove);
  pos.uPiece.push(piece);

  if (t === P && to === pos.ep && captured === EMPTY) {
    capSq = us === 0 ? to - 10 : to + 10;
    captured = b[capSq]!;
    b[capSq] = EMPTY;
  }
  pos.uCap.push(captured);
  pos.uCapSq.push(capSq);

  b[from] = EMPTY;
  b[to] = promo !== 0 ? (us === 0 ? promo : promo + 6) : piece;

  if (t === K) {
    pos.kingSq[us] = to;
    if (to - from === 2) {
      b[to - 1] = b[to + 1]!; // O-O: rook h -> f
      b[to + 1] = EMPTY;
    } else if (from - to === 2) {
      b[to + 1] = b[to - 2]!; // O-O-O: rook a -> d
      b[to - 2] = EMPTY;
    }
  }

  pos.ep = -1;
  if (t === P) {
    const diff = to - from;
    if (diff === 20 || diff === -20) pos.ep = from + diff / 2;
  }
  pos.castling &= CASTLE_MASK[from]! & CASTLE_MASK[to]!;
  pos.halfmove = t === P || captured !== EMPTY ? 0 : pos.halfmove + 1;
  if (us === 1) pos.fullmove++;
  pos.turn = (us ^ 1) as 0 | 1;
}

export function unmake(pos: Pos, m: number): void {
  const from = m & 127;
  const to = (m >> 7) & 127;
  pos.turn = (pos.turn ^ 1) as 0 | 1;
  const us = pos.turn;
  const b = pos.board;
  const piece = pos.uPiece.pop()!;
  const captured = pos.uCap.pop()!;
  const capSq = pos.uCapSq.pop()!;
  pos.halfmove = pos.uHalf.pop()!;
  pos.ep = pos.uEp.pop()!;
  pos.castling = pos.uCastling.pop()!;
  if (us === 1) pos.fullmove--;

  b[to] = EMPTY;
  b[from] = piece;
  if (capSq === to) {
    if (captured !== EMPTY) b[to] = captured;
  } else {
    b[capSq] = captured;
  }
  if (typeOf(piece) === K) {
    pos.kingSq[us] = from;
    if (to - from === 2) {
      b[to + 1] = b[to - 1]!;
      b[to - 1] = EMPTY;
    } else if (from - to === 2) {
      b[to - 2] = b[to + 1]!;
      b[to + 1] = EMPTY;
    }
  }
}

// ---------------------------------------------------------------------------
// Move generation
// ---------------------------------------------------------------------------

function pushPawn(out: number[], from: number, to: number, us: 0 | 1): void {
  const promoRank = us === 0 ? to >= 91 : to <= 28;
  if (promoRank) {
    out.push(mv(from, to, N), mv(from, to, B), mv(from, to, R), mv(from, to, Q));
  } else {
    out.push(mv(from, to));
  }
}

export function genPseudo(pos: Pos): number[] {
  const out: number[] = [];
  const us = pos.turn;
  const b = pos.board;
  for (let s64 = 0; s64 < 64; s64++) {
    const s = SQ120[s64]!;
    const p = b[s]!;
    if (p === EMPTY || colorOf(p) !== us) continue;
    const t = typeOf(p);
    if (t === P) {
      const fwd = us === 0 ? 10 : -10;
      const one = s + fwd;
      if (b[one] === EMPTY) {
        pushPawn(out, s, one, us);
        const home = us === 0 ? s >= 31 && s <= 38 : s >= 81 && s <= 88;
        if (home && b[one + fwd] === EMPTY) out.push(mv(s, one + fwd));
      }
      for (let k = 0; k < 2; k++) {
        const to = s + fwd + (k === 0 ? -1 : 1);
        const q = b[to]!;
        if (q === OFF) continue;
        if (q !== EMPTY && colorOf(q) !== us) pushPawn(out, s, to, us);
        else if (to === pos.ep && q === EMPTY) out.push(mv(s, to));
      }
    } else if (t === N || t === K) {
      const dirs = t === N ? KNIGHT_D : KING_D;
      for (let i = 0; i < 8; i++) {
        const to = s + dirs[i]!;
        const q = b[to]!;
        if (q === OFF) continue;
        if (q === EMPTY || colorOf(q) !== us) out.push(mv(s, to));
      }
    } else {
      const dirs = t === B ? BISHOP_D : t === R ? ROOK_D : KING_D; // queen = all 8 king dirs
      for (let i = 0; i < dirs.length; i++) {
        const d = dirs[i]!;
        let to = s + d;
        for (;;) {
          const q = b[to]!;
          if (q === OFF) break;
          if (q === EMPTY) {
            out.push(mv(s, to));
            to += d;
            continue;
          }
          if (colorOf(q) !== us) out.push(mv(s, to));
          break;
        }
      }
    }
  }
  // Castling: rights bit, empty between, king not in / through / into check.
  if (us === 0) {
    if ((pos.castling & 1) !== 0 && b[26] === EMPTY && b[27] === EMPTY &&
        !attacked(pos, 25, 1) && !attacked(pos, 26, 1) && !attacked(pos, 27, 1)) {
      out.push(mv(25, 27));
    }
    if ((pos.castling & 2) !== 0 && b[24] === EMPTY && b[23] === EMPTY && b[22] === EMPTY &&
        !attacked(pos, 25, 1) && !attacked(pos, 24, 1) && !attacked(pos, 23, 1)) {
      out.push(mv(25, 23));
    }
  } else {
    if ((pos.castling & 4) !== 0 && b[96] === EMPTY && b[97] === EMPTY &&
        !attacked(pos, 95, 0) && !attacked(pos, 96, 0) && !attacked(pos, 97, 0)) {
      out.push(mv(95, 97));
    }
    if ((pos.castling & 8) !== 0 && b[94] === EMPTY && b[93] === EMPTY && b[92] === EMPTY &&
        !attacked(pos, 95, 0) && !attacked(pos, 94, 0) && !attacked(pos, 93, 0)) {
      out.push(mv(95, 93));
    }
  }
  return out;
}

export function genLegal(pos: Pos): number[] {
  const us = pos.turn;
  const them = (us ^ 1) as 0 | 1;
  const pseudo = genPseudo(pos);
  const out: number[] = [];
  for (let i = 0; i < pseudo.length; i++) {
    const m = pseudo[i]!;
    make(pos, m);
    if (!attacked(pos, pos.kingSq[us]!, them)) out.push(m);
    unmake(pos, m);
  }
  return out;
}

export function perft(pos: Pos, depth: number): number {
  const moves = genLegal(pos);
  if (depth <= 1) return moves.length;
  let n = 0;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]!;
    make(pos, m);
    n += perft(pos, depth - 1);
    unmake(pos, m);
  }
  return n;
}

// ---------------------------------------------------------------------------
// FEN
// ---------------------------------------------------------------------------

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function castleBits(s: string): number {
  if (s === '-') return 0;
  let bits = 0;
  for (const ch of s) {
    const i = 'KQkq'.indexOf(ch);
    if (i < 0) throw new Error(`bad castling field '${s}'`);
    bits |= 1 << i;
  }
  return bits;
}

export function castleStr(bits: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) if ((bits & (1 << i)) !== 0) s += 'KQkq'.charAt(i);
  return s === '' ? '-' : s;
}

export function posFromFen(fen: string): Pos {
  const parts = fen.trim().split(/\s+/);
  if (parts.length !== 6) throw new Error(`FEN must have 6 fields, got ${parts.length}: '${fen}'`);
  const [boardF, turnF, castF, epF, halfF, fullF] = parts as [string, string, string, string, string, string];
  const pos = newPos();
  const ranks = boardF.split('/');
  if (ranks.length !== 8) throw new Error(`FEN board must have 8 ranks: '${boardF}'`);
  let wk = 0;
  let bk = 0;
  for (let r = 0; r < 8; r++) {
    const rank = 7 - r; // FEN starts at rank 8
    let file = 0;
    for (const ch of ranks[r]!) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      const p = pieceFromChar(ch);
      if (p < 0 || file > 7) throw new Error(`bad FEN board rank '${ranks[r]}'`);
      const s = 21 + rank * 10 + file;
      pos.board[s] = p;
      if (p === WK) {
        pos.kingSq[0] = s;
        wk++;
      } else if (p === BK) {
        pos.kingSq[1] = s;
        bk++;
      }
      file++;
    }
    if (file !== 8) throw new Error(`FEN rank '${ranks[r]}' does not cover 8 files`);
  }
  if (wk !== 1 || bk !== 1) throw new Error(`FEN must have exactly one king per side (found ${wk} white, ${bk} black)`);
  if (turnF !== 'w' && turnF !== 'b') throw new Error(`bad FEN turn field '${turnF}'`);
  pos.turn = turnF === 'w' ? 0 : 1;
  pos.castling = castleBits(castF);
  if (epF === '-') {
    pos.ep = -1;
  } else {
    const s = sqFromName(epF);
    const r = s >= 0 ? rankOf120(s) : -1;
    if (s < 0 || (r !== 2 && r !== 5)) throw new Error(`bad FEN en-passant field '${epF}'`);
    pos.ep = s;
  }
  const half = Number(halfF);
  const full = Number(fullF);
  if (!Number.isInteger(half) || half < 0 || !Number.isInteger(full) || full < 1) {
    throw new Error(`bad FEN clocks '${halfF} ${fullF}'`);
  }
  pos.halfmove = half;
  pos.fullmove = full;
  return pos;
}

/** 64-char board string in FEN square order (a8..h8, a7..h7, ..., a1..h1), '.' = empty. */
export function boardStringOfPos(pos: Pos): string {
  let s = '';
  for (let r = 7; r >= 0; r--) {
    for (let f = 0; f < 8; f++) s += pieceChar(pos.board[21 + r * 10 + f]!);
  }
  return s;
}

export function fenBoardField(board64: string): string {
  const ranks: string[] = [];
  for (let r = 0; r < 8; r++) {
    let out = '';
    let run = 0;
    for (let f = 0; f < 8; f++) {
      const ch = board64.charAt(r * 8 + f);
      if (ch === '.') {
        run++;
      } else {
        if (run > 0) {
          out += String(run);
          run = 0;
        }
        out += ch;
      }
    }
    if (run > 0) out += String(run);
    ranks.push(out);
  }
  return ranks.join('/');
}

// ---------------------------------------------------------------------------
// JSON game state
// ---------------------------------------------------------------------------

export type ChessState = {
  /** 64 chars in FEN square order, '.' = empty. */
  board: string;
  turn: 'w' | 'b';
  /** Subset of 'KQkq' in that order, or '-'. */
  castling: string;
  /** En-passant target square, set ONLY when a legal ep capture exists; else '-'. */
  ep: string;
  halfmove: number;
  fullmove: number;
  /** Repetition table: position key -> occurrence count. Cleared on every irreversible move. */
  reps: { [key: string]: number };
  lastMove: string | null; // UCI
  lastSan: string | null; // SAN of the same move
};

/** FIDE repetition key: placement + side to move + castling rights + real ep availability. */
export function posKey(s: Pick<ChessState, 'board' | 'turn' | 'castling' | 'ep'>): string {
  return `${s.board} ${s.turn} ${s.castling} ${s.ep}`;
}

export function stateToPos(s: ChessState): Pos {
  const pos = newPos();
  if (s.board.length !== 64) throw new Error('state board must be 64 chars');
  for (let i = 0; i < 64; i++) {
    const ch = s.board.charAt(i);
    if (ch === '.') continue;
    const p = pieceFromChar(ch);
    if (p < 0) throw new Error(`bad board char '${ch}'`);
    const rank = 7 - (i >> 3);
    const file = i & 7;
    const sq = 21 + rank * 10 + file;
    pos.board[sq] = p;
    if (p === WK) pos.kingSq[0] = sq;
    else if (p === BK) pos.kingSq[1] = sq;
  }
  pos.turn = s.turn === 'w' ? 0 : 1;
  pos.castling = castleBits(s.castling);
  pos.ep = s.ep === '-' ? -1 : sqFromName(s.ep);
  pos.halfmove = s.halfmove;
  pos.fullmove = s.fullmove;
  return pos;
}

/** True when the side to move has at least one LEGAL en-passant capture. */
export function epCaptureLegal(pos: Pos): boolean {
  if (pos.ep < 0) return false;
  const us = pos.turn;
  const them = (us ^ 1) as 0 | 1;
  const fwd = us === 0 ? 10 : -10;
  const pawn = us === 0 ? WP : BP;
  for (let k = 0; k < 2; k++) {
    const from = pos.ep - fwd + (k === 0 ? -1 : 1);
    if (pos.board[from] === pawn) {
      const m = mv(from, pos.ep);
      make(pos, m);
      const ok = !attacked(pos, pos.kingSq[us]!, them);
      unmake(pos, m);
      if (ok) return true;
    }
  }
  return false;
}

/**
 * Builds the JSON state from a position, normalizing ep and updating the
 * repetition table. prevReps is the table BEFORE this move; it is discarded
 * when the move was irreversible (halfmove clock just reset to 0).
 */
export function stateFromPos(
  pos: Pos,
  prevReps: { [key: string]: number } | null,
  lastMove: string | null,
  lastSan: string | null,
): ChessState {
  const ep = pos.ep >= 0 && epCaptureLegal(pos) ? sqName(pos.ep) : '-';
  const st: ChessState = {
    board: boardStringOfPos(pos),
    turn: pos.turn === 0 ? 'w' : 'b',
    castling: castleStr(pos.castling),
    ep,
    halfmove: pos.halfmove,
    fullmove: pos.fullmove,
    reps: {},
    lastMove,
    lastSan,
  };
  const key = posKey(st);
  const base = pos.halfmove === 0 || prevReps === null ? {} : prevReps;
  st.reps = { ...base, [key]: (base[key] ?? 0) + 1 };
  return st;
}

// ---------------------------------------------------------------------------
// Terminal detection
// ---------------------------------------------------------------------------

/**
 * Spec table exactly: K vs K, K+B vs K, K+N vs K, and K+B vs K+B with both
 * bishops on the same square shade.
 */
export function insufficientMaterial(pos: Pos): boolean {
  let whiteBishops = 0;
  let blackBishops = 0;
  let whiteShade = -1;
  let blackShade = -1;
  let knights = 0;
  for (let s64 = 0; s64 < 64; s64++) {
    const s = SQ120[s64]!;
    const p = pos.board[s]!;
    if (p === EMPTY || typeOf(p) === K) continue;
    const t = typeOf(p);
    if (t === B) {
      if (colorOf(p) === 0) {
        whiteBishops++;
        whiteShade = sqShade(s);
      } else {
        blackBishops++;
        blackShade = sqShade(s);
      }
    } else if (t === N) {
      knights++;
    } else {
      return false; // any pawn, rook, or queen: sufficient
    }
  }
  const total = whiteBishops + blackBishops + knights;
  if (total === 0) return true; // K vs K
  if (total === 1) return true; // K+B vs K or K+N vs K
  if (total === 2 && whiteBishops === 1 && blackBishops === 1 && whiteShade === blackShade) return true;
  return false;
}

/**
 * Terminal check order (documented): checkmate/stalemate first (a mating move
 * that also reaches 100 halfmoves or a third repetition still wins, matching
 * FIDE art. 9.6), then insufficient material, then threefold repetition, then
 * the automatic fifty-move draw at 100 halfmoves.
 */
export function terminalOf(state: ChessState): GameResult | null {
  const pos = stateToPos(state);
  if (genLegal(pos).length === 0) {
    if (inCheck(pos)) {
      const winner = pos.turn === 0 ? playerId(1) : playerId(0);
      return { winners: [winner], draw: false, reason: 'checkmate' };
    }
    return { winners: [], draw: true, reason: 'stalemate' };
  }
  if (insufficientMaterial(pos)) return { winners: [], draw: true, reason: 'insufficient_material' };
  if ((state.reps[posKey(state)] ?? 0) >= 3) return { winners: [], draw: true, reason: 'threefold_repetition' };
  if (state.halfmove >= 100) return { winners: [], draw: true, reason: 'fifty_move_rule' };
  return null;
}

// ---------------------------------------------------------------------------
// SAN (shown in renders and summaries; never parsed)
// ---------------------------------------------------------------------------

const SAN_LETTER = '.PNBRQK';

export function toSAN(pos: Pos, m: number, legalList?: number[]): string {
  const from = m & 127;
  const to = (m >> 7) & 127;
  const promo = (m >> 14) & 7;
  const piece = pos.board[from]!;
  const t = typeOf(piece);
  let san: string;
  if (t === K && Math.abs(to - from) === 2) {
    san = to > from ? 'O-O' : 'O-O-O';
  } else {
    const isCap = pos.board[to] !== EMPTY || (t === P && to === pos.ep);
    if (t === P) {
      san = isCap ? FILES.charAt(fileOf120(from)) + 'x' + sqName(to) : sqName(to);
      if (promo !== 0) san += '=' + SAN_LETTER.charAt(promo);
    } else {
      const legal = legalList ?? genLegal(pos);
      const rivals = legal.filter(
        (x) => x !== m && ((x >> 7) & 127) === to && (x & 127) !== from && typeOf(pos.board[x & 127]!) === t,
      );
      let disamb = '';
      if (rivals.length > 0) {
        const sameFile = rivals.some((x) => fileOf120(x & 127) === fileOf120(from));
        const sameRank = rivals.some((x) => rankOf120(x & 127) === rankOf120(from));
        if (!sameFile) disamb = FILES.charAt(fileOf120(from));
        else if (!sameRank) disamb = String(rankOf120(from) + 1);
        else disamb = sqName(from);
      }
      san = SAN_LETTER.charAt(t) + disamb + (isCap ? 'x' : '') + sqName(to);
    }
  }
  make(pos, m);
  if (inCheck(pos)) san += genLegal(pos).length === 0 ? '#' : '+';
  unmake(pos, m);
  return san;
}
