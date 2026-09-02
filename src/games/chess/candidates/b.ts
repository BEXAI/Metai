/**
 * Candidate B: independent chess move-generation implementation.
 *
 * Architecture: 0x88 mailbox board, signed piece codes (white positive,
 * black negative), pseudo-legal generation + make/unmake legality filter.
 *
 * Public API:
 *   legalMovesFromFen(fen): string[]      — UCI moves, sorted lexicographically
 *   applyUci(fen, uci): string            — resulting full FEN
 *   perftFromFen(fen, depth): number      — perft node count
 */

const EMPTY = 0;
const PAWN = 1;
const KNIGHT = 2;
const BISHOP = 3;
const ROOK = 4;
const QUEEN = 5;
const KING = 6;

const WHITE = 1;
const BLACK = -1;

// Castling-rights bits.
const CR_WK = 1;
const CR_WQ = 2;
const CR_BK = 4;
const CR_BQ = 8;

// Move encoding: from (bits 0-6) | to << 7 (bits 7-13) | promo << 14 (bits 14-16) | flags.
const FLAG_EP = 1 << 17;
const FLAG_CASTLE = 1 << 18;
const FLAG_DOUBLE = 1 << 19;

const KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33] as const;
const KING_OFFSETS = [-17, -16, -15, -1, 1, 15, 16, 17] as const;
const BISHOP_RAYS = [-17, -15, 15, 17] as const;
const ROOK_RAYS = [-16, -1, 1, 16] as const;
const PROMO_PIECES = [QUEEN, ROOK, BISHOP, KNIGHT] as const;

// Rights cleared when a move touches a square (king/rook origin squares).
const CASTLE_MASK = new Int8Array(128).fill(15);
CASTLE_MASK[0] = 15 & ~CR_WQ; // a1
CASTLE_MASK[4] = 15 & ~(CR_WK | CR_WQ); // e1
CASTLE_MASK[7] = 15 & ~CR_WK; // h1
CASTLE_MASK[112] = 15 & ~CR_BQ; // a8
CASTLE_MASK[116] = 15 & ~(CR_BK | CR_BQ); // e8
CASTLE_MASK[119] = 15 & ~CR_BK; // h8

interface Pos {
  board: Int8Array; // 128 entries, 0x88 layout: sq = rank*16 + file, a1 = 0
  stm: number; // WHITE (1) or BLACK (-1)
  castling: number; // bitmask of CR_*
  ep: number; // en-passant target square (0x88) or -1
  halfmove: number;
  fullmove: number;
  kings: Int32Array; // [white king sq, black king sq]
}

interface Undo {
  captured: number;
  capturedSq: number;
  castling: number;
  ep: number;
  halfmove: number;
}

const PIECE_FROM_CHAR: Record<string, number> = {
  P: PAWN,
  N: KNIGHT,
  B: BISHOP,
  R: ROOK,
  Q: QUEEN,
  K: KING,
  p: -PAWN,
  n: -KNIGHT,
  b: -BISHOP,
  r: -ROOK,
  q: -QUEEN,
  k: -KING,
};

const CHAR_FROM_PIECE: Record<number, string> = {
  [PAWN]: 'P',
  [KNIGHT]: 'N',
  [BISHOP]: 'B',
  [ROOK]: 'R',
  [QUEEN]: 'Q',
  [KING]: 'K',
  [-PAWN]: 'p',
  [-KNIGHT]: 'n',
  [-BISHOP]: 'b',
  [-ROOK]: 'r',
  [-QUEEN]: 'q',
  [-KING]: 'k',
};

const PROMO_CHAR: Record<number, string> = {
  [KNIGHT]: 'n',
  [BISHOP]: 'b',
  [ROOK]: 'r',
  [QUEEN]: 'q',
};

function sqToAlg(sq: number): string {
  const file = sq & 7;
  const rank = sq >> 4;
  return String.fromCharCode(97 + file) + String(rank + 1);
}

function algToSq(alg: string): number {
  const file = alg.charCodeAt(0) - 97;
  const rank = alg.charCodeAt(1) - 49;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) {
    throw new Error(`bad square: ${alg}`);
  }
  return rank * 16 + file;
}

function parseFen(fen: string): Pos {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) throw new Error(`bad FEN: ${fen}`);
  const placement = parts[0]!;
  const stmField = parts[1]!;
  const castlingField = parts[2]!;
  const epField = parts[3]!;
  const halfmove = parts.length > 4 ? parseInt(parts[4]!, 10) : 0;
  const fullmove = parts.length > 5 ? parseInt(parts[5]!, 10) : 1;
  if (!Number.isFinite(halfmove) || !Number.isFinite(fullmove)) {
    throw new Error(`bad FEN counters: ${fen}`);
  }

  const board = new Int8Array(128);
  const kings = new Int32Array([-1, -1]);
  const ranks = placement.split('/');
  if (ranks.length !== 8) throw new Error(`bad FEN placement: ${placement}`);
  for (let r = 0; r < 8; r++) {
    const rankStr = ranks[7 - r]!; // FEN lists rank 8 first
    let file = 0;
    for (const ch of rankStr) {
      if (ch >= '1' && ch <= '8') {
        file += ch.charCodeAt(0) - 48;
      } else {
        const piece = PIECE_FROM_CHAR[ch];
        if (piece === undefined || file > 7) {
          throw new Error(`bad FEN placement: ${placement}`);
        }
        const sq = r * 16 + file;
        board[sq] = piece;
        if (piece === KING) kings[0] = sq;
        if (piece === -KING) kings[1] = sq;
        file++;
      }
    }
    if (file !== 8) throw new Error(`bad FEN rank: ${rankStr}`);
  }

  let castling = 0;
  if (castlingField !== '-') {
    for (const ch of castlingField) {
      if (ch === 'K') castling |= CR_WK;
      else if (ch === 'Q') castling |= CR_WQ;
      else if (ch === 'k') castling |= CR_BK;
      else if (ch === 'q') castling |= CR_BQ;
      else throw new Error(`bad FEN castling: ${castlingField}`);
    }
  }

  const ep = epField === '-' ? -1 : algToSq(epField);
  const stm = stmField === 'w' ? WHITE : BLACK;

  return { board, stm, castling, ep, halfmove, fullmove, kings };
}

function writeFen(pos: Pos): string {
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empties = 0;
    for (let f = 0; f < 8; f++) {
      const piece = pos.board[r * 16 + f]!;
      if (piece === EMPTY) {
        empties++;
      } else {
        if (empties > 0) {
          row += String(empties);
          empties = 0;
        }
        row += CHAR_FROM_PIECE[piece]!;
      }
    }
    if (empties > 0) row += String(empties);
    rows.push(row);
  }
  let castling = '';
  if (pos.castling & CR_WK) castling += 'K';
  if (pos.castling & CR_WQ) castling += 'Q';
  if (pos.castling & CR_BK) castling += 'k';
  if (pos.castling & CR_BQ) castling += 'q';
  if (castling === '') castling = '-';
  const ep = pos.ep < 0 ? '-' : sqToAlg(pos.ep);
  const stm = pos.stm === WHITE ? 'w' : 'b';
  return `${rows.join('/')} ${stm} ${castling} ${ep} ${pos.halfmove} ${pos.fullmove}`;
}

/** Is `sq` attacked by side `by` (WHITE or BLACK)? */
function isAttacked(pos: Pos, sq: number, by: number): boolean {
  const board = pos.board;
  // Pawns: a white pawn on sq-15/sq-17 attacks sq; mirrored for black.
  const p1 = sq - 15 * by;
  const p2 = sq - 17 * by;
  if (!(p1 & 0x88) && board[p1] === PAWN * by) return true;
  if (!(p2 & 0x88) && board[p2] === PAWN * by) return true;
  // Knights.
  for (const off of KNIGHT_OFFSETS) {
    const t = sq + off;
    if (!(t & 0x88) && board[t] === KNIGHT * by) return true;
  }
  // King.
  for (const off of KING_OFFSETS) {
    const t = sq + off;
    if (!(t & 0x88) && board[t] === KING * by) return true;
  }
  // Diagonal sliders.
  for (const ray of BISHOP_RAYS) {
    let t = sq + ray;
    while (!(t & 0x88)) {
      const piece = board[t]!;
      if (piece !== EMPTY) {
        if (piece === BISHOP * by || piece === QUEEN * by) return true;
        break;
      }
      t += ray;
    }
  }
  // Orthogonal sliders.
  for (const ray of ROOK_RAYS) {
    let t = sq + ray;
    while (!(t & 0x88)) {
      const piece = board[t]!;
      if (piece !== EMPTY) {
        if (piece === ROOK * by || piece === QUEEN * by) return true;
        break;
      }
      t += ray;
    }
  }
  return false;
}

function pushPawnMove(moves: number[], from: number, to: number, promoRank: number, flags: number): void {
  if (to >> 4 === promoRank) {
    for (const promo of PROMO_PIECES) {
      moves.push(from | (to << 7) | (promo << 14) | flags);
    }
  } else {
    moves.push(from | (to << 7) | flags);
  }
}

/** Generate pseudo-legal moves (castling pre-checked for through/out-of-check). */
function genMoves(pos: Pos): number[] {
  const moves: number[] = [];
  const board = pos.board;
  const stm = pos.stm;
  const promoRank = stm === WHITE ? 7 : 0;
  const startRank = stm === WHITE ? 1 : 6;
  const fwd = 16 * stm;

  for (let sq = 0; sq < 120; sq++) {
    if (sq & 0x88) continue;
    const piece = board[sq]!;
    if (piece === EMPTY || piece * stm < 0) continue;
    const kind = piece * stm;

    if (kind === PAWN) {
      const one = sq + fwd;
      if (!(one & 0x88) && board[one] === EMPTY) {
        pushPawnMove(moves, sq, one, promoRank, 0);
        if (sq >> 4 === startRank) {
          const two = one + fwd;
          if (board[two] === EMPTY) {
            moves.push(sq | (two << 7) | FLAG_DOUBLE);
          }
        }
      }
      for (const capOff of [fwd - 1, fwd + 1]) {
        const t = sq + capOff;
        if (t & 0x88) continue;
        const target = board[t]!;
        if (target * stm < 0) {
          pushPawnMove(moves, sq, t, promoRank, 0);
        } else if (
          t === pos.ep &&
          target === EMPTY &&
          ((stm === WHITE && t >> 4 === 5) || (stm === BLACK && t >> 4 === 2))
        ) {
          moves.push(sq | (t << 7) | FLAG_EP);
        }
      }
    } else if (kind === KNIGHT) {
      for (const off of KNIGHT_OFFSETS) {
        const t = sq + off;
        if (!(t & 0x88) && board[t]! * stm <= 0) {
          moves.push(sq | (t << 7));
        }
      }
    } else if (kind === KING) {
      for (const off of KING_OFFSETS) {
        const t = sq + off;
        if (!(t & 0x88) && board[t]! * stm <= 0) {
          moves.push(sq | (t << 7));
        }
      }
    } else {
      const rays = kind === BISHOP ? BISHOP_RAYS : kind === ROOK ? ROOK_RAYS : KING_OFFSETS;
      for (const ray of rays) {
        let t = sq + ray;
        while (!(t & 0x88)) {
          const target = board[t]!;
          if (target === EMPTY) {
            moves.push(sq | (t << 7));
          } else {
            if (target * stm < 0) moves.push(sq | (t << 7));
            break;
          }
          t += ray;
        }
      }
    }
  }

  // Castling. Requires: rights, rook on its origin square, squares between
  // king and rook empty, king not in check, king path squares not attacked.
  const opp = -stm;
  if (stm === WHITE) {
    if (
      pos.castling & CR_WK &&
      board[7] === ROOK &&
      board[5] === EMPTY &&
      board[6] === EMPTY &&
      !isAttacked(pos, 4, opp) &&
      !isAttacked(pos, 5, opp) &&
      !isAttacked(pos, 6, opp)
    ) {
      moves.push(4 | (6 << 7) | FLAG_CASTLE);
    }
    if (
      pos.castling & CR_WQ &&
      board[0] === ROOK &&
      board[1] === EMPTY &&
      board[2] === EMPTY &&
      board[3] === EMPTY &&
      !isAttacked(pos, 4, opp) &&
      !isAttacked(pos, 3, opp) &&
      !isAttacked(pos, 2, opp)
    ) {
      moves.push(4 | (2 << 7) | FLAG_CASTLE);
    }
  } else {
    if (
      pos.castling & CR_BK &&
      board[119] === -ROOK &&
      board[117] === EMPTY &&
      board[118] === EMPTY &&
      !isAttacked(pos, 116, opp) &&
      !isAttacked(pos, 117, opp) &&
      !isAttacked(pos, 118, opp)
    ) {
      moves.push(116 | (118 << 7) | FLAG_CASTLE);
    }
    if (
      pos.castling & CR_BQ &&
      board[112] === -ROOK &&
      board[113] === EMPTY &&
      board[114] === EMPTY &&
      board[115] === EMPTY &&
      !isAttacked(pos, 116, opp) &&
      !isAttacked(pos, 115, opp) &&
      !isAttacked(pos, 114, opp)
    ) {
      moves.push(116 | (114 << 7) | FLAG_CASTLE);
    }
  }

  return moves;
}

function make(pos: Pos, m: number): Undo {
  const board = pos.board;
  const stm = pos.stm;
  const from = m & 127;
  const to = (m >> 7) & 127;
  const promo = (m >> 14) & 7;
  const piece = board[from]!;

  let captured = board[to]!;
  let capturedSq = to;
  if (m & FLAG_EP) {
    capturedSq = to - 16 * stm;
    captured = board[capturedSq]!;
    board[capturedSq] = EMPTY;
  }

  const undo: Undo = {
    captured,
    capturedSq,
    castling: pos.castling,
    ep: pos.ep,
    halfmove: pos.halfmove,
  };

  board[to] = promo !== 0 ? promo * stm : piece;
  board[from] = EMPTY;

  if (m & FLAG_CASTLE) {
    if (to > from) {
      // Kingside: rook h-file -> f-file.
      board[to - 1] = board[to + 1]!;
      board[to + 1] = EMPTY;
    } else {
      // Queenside: rook a-file -> d-file.
      board[to + 1] = board[to - 2]!;
      board[to - 2] = EMPTY;
    }
  }

  if (piece === KING * stm) {
    pos.kings[stm === WHITE ? 0 : 1] = to;
  }

  pos.castling &= CASTLE_MASK[from]! & CASTLE_MASK[to]!;
  pos.ep = m & FLAG_DOUBLE ? from + 16 * stm : -1;
  pos.halfmove = piece === PAWN * stm || captured !== EMPTY ? 0 : pos.halfmove + 1;
  if (stm === BLACK) pos.fullmove++;
  pos.stm = -stm;
  return undo;
}

function unmake(pos: Pos, m: number, undo: Undo): void {
  pos.stm = -pos.stm;
  const stm = pos.stm; // side that made the move
  const board = pos.board;
  const from = m & 127;
  const to = (m >> 7) & 127;
  const promo = (m >> 14) & 7;

  const moved = promo !== 0 ? PAWN * stm : board[to]!;
  board[from] = moved;
  board[to] = EMPTY;
  if (undo.captured !== EMPTY) {
    board[undo.capturedSq] = undo.captured;
  }

  if (m & FLAG_CASTLE) {
    if (to > from) {
      board[to + 1] = board[to - 1]!;
      board[to - 1] = EMPTY;
    } else {
      board[to - 2] = board[to + 1]!;
      board[to + 1] = EMPTY;
    }
  }

  if (moved === KING * stm) {
    pos.kings[stm === WHITE ? 0 : 1] = from;
  }

  pos.castling = undo.castling;
  pos.ep = undo.ep;
  pos.halfmove = undo.halfmove;
  if (stm === BLACK) pos.fullmove--;
}

/** After make(), was the move by `mover` legal (its king not attacked)? */
function moverKingSafe(pos: Pos, mover: number): boolean {
  const kingSq = pos.kings[mover === WHITE ? 0 : 1]!;
  return !isAttacked(pos, kingSq, -mover);
}

function moveToUci(m: number): string {
  const from = m & 127;
  const to = (m >> 7) & 127;
  const promo = (m >> 14) & 7;
  let uci = sqToAlg(from) + sqToAlg(to);
  if (promo !== 0) uci += PROMO_CHAR[promo]!;
  return uci;
}

function legalMoves(pos: Pos): number[] {
  const out: number[] = [];
  const mover = pos.stm;
  for (const m of genMoves(pos)) {
    const undo = make(pos, m);
    if (moverKingSafe(pos, mover)) out.push(m);
    unmake(pos, m, undo);
  }
  return out;
}

export function legalMovesFromFen(fen: string): string[] {
  const pos = parseFen(fen);
  return legalMoves(pos).map(moveToUci).sort();
}

export function applyUci(fen: string, uci: string): string {
  const pos = parseFen(fen);
  for (const m of legalMoves(pos)) {
    if (moveToUci(m) === uci) {
      make(pos, m);
      return writeFen(pos);
    }
  }
  throw new Error(`illegal move ${uci} in ${fen}`);
}

function perft(pos: Pos, depth: number): number {
  const mover = pos.stm;
  let nodes = 0;
  for (const m of genMoves(pos)) {
    const undo = make(pos, m);
    if (moverKingSafe(pos, mover)) {
      nodes += depth === 1 ? 1 : perft(pos, depth - 1);
    }
    unmake(pos, m, undo);
  }
  return nodes;
}

export function perftFromFen(fen: string, depth: number): number {
  if (depth <= 0) return 1;
  const pos = parseFen(fen);
  return perft(pos, depth);
}
