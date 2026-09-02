/**
 * RED TEAM red-team-rules — chess (spec games.M1_perfect_information.chess,
 * acceptance A3). Attack family 1 (illegal move accepted / legal move
 * rejected) and family 2 (draw rules). Every test asserts the DEFENDED
 * behavior the spec demands ("FIDE laws"); a test that fails today
 * demonstrates an exploitable hole.
 *
 * Seeded randomness only; chess draws nothing from the stream.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { isRuleError } from '../../src/kernel/types.ts';
import chess, { type ChessState } from '../../src/games/chess/index.ts';
import { posKey } from '../../src/games/chess/rules.ts';

const seed = () => createSeedStream(sha256Hex('redteam-rules-chess'));

function decode(fen: string): ChessState {
  return chess.decodeState(fen);
}

function legal(state: ChessState, player: string): string[] {
  return chess.legalMoves(state, player);
}

function apply(state: ChessState, player: string, uci: string) {
  return chess.apply(state, player, uci, seed());
}

describe('phantom-rook castling via decodeState (castling rights inconsistent with the board)', () => {
  // FEN claims the white kingside right 'K', but the h1 rook does not exist
  // (white's only rook is on a1). FIDE castling requires the rook to be on its
  // original square; a decoded state must not let the king "castle" with a
  // rook that is not there. decodeState already normalizes the ep field the
  // FIDE way — castling rights must get the same treatment (drop rights whose
  // rook or king is off its home square), or movegen must check the rook.
  it('kingside castle with no h1 rook is not offered and not applicable', () => {
    const st = decode('r3k3/8/8/8/8/8/8/R3K3 w K - 0 1');
    const moves = legal(st, 'p0');
    expect(moves).not.toContain('e1g1');
    const r = apply(st, 'p0', 'e1g1');
    expect(isRuleError(r)).toBe(true);
  });

  it('queenside castle with no a1 rook is not offered and not applicable', () => {
    const st = decode('4k2r/8/8/8/8/8/8/4K2R w Q - 0 1');
    const moves = legal(st, 'p0');
    expect(moves).not.toContain('e1c1');
    const r = apply(st, 'p0', 'e1c1');
    expect(isRuleError(r)).toBe(true);
  });

  it('black kingside castle with no h8 rook is not offered', () => {
    const st = decode('r3k3/8/8/8/8/8/8/R3K3 b k - 0 1');
    expect(legal(st, 'p1')).not.toContain('e8g8');
    expect(isRuleError(apply(st, 'p1', 'e8g8'))).toBe(true);
  });

  it('castling with a phantom rook must never mint material out of thin air', () => {
    // Even if a fix chooses to reject at decode time, this guards the invariant:
    // applying every legal move from the crafted state keeps the piece count.
    const st = decode('r3k3/8/8/8/8/8/8/R3K3 w K - 0 1');
    const count = (b: string): number => [...b].filter((c) => c !== '.').length;
    for (const m of legal(st, 'p0')) {
      const r = apply(st, 'p0', m);
      if (isRuleError(r)) continue;
      expect(count((r.state as ChessState).board)).toBe(count(st.board));
    }
  });
});

describe('en passant into a discovered DIAGONAL check (ep pin through the captured pawn square)', () => {
  // Ba1..d4..h8: white pawn d2 will double-push to d4, blocking the diagonal
  // to the black king on h8. Black exd3 e.p. would remove the d4 pawn and
  // step OFF the diagonal — exposing Kh8 to Ba1 — so it is illegal, and the
  // FIDE-normalized ep field must be '-' (no legal ep capture exists).
  const PRE = '7k/8/8/8/4p3/8/3P4/B3K3 w - - 0 1';

  it('the ep capture is rejected and the ep field is normalized away', () => {
    const pre = decode(PRE);
    const pushed = apply(pre, 'p0', 'd2d4');
    if (isRuleError(pushed)) throw new Error(pushed.message);
    const st = pushed.state as ChessState;
    expect(st.ep).toBe('-'); // X-FEN normalization: no LEGAL ep capture exists
    expect(legal(st, 'p1')).not.toContain('e4d3');
    expect(isRuleError(apply(st, 'p1', 'e4d3'))).toBe(true);
  });

  it('control: without the bishop the same ep capture is offered and applies', () => {
    const pre = decode('7k/8/8/8/4p3/8/3P4/4K3 w - - 0 1');
    const pushed = apply(pre, 'p0', 'd2d4');
    if (isRuleError(pushed)) throw new Error(pushed.message);
    const st = pushed.state as ChessState;
    expect(st.ep).toBe('d3');
    expect(legal(st, 'p1')).toContain('e4d3');
    const took = apply(st, 'p1', 'e4d3');
    if (isRuleError(took)) throw new Error(took.message);
    const after = took.state as ChessState;
    // the d4 pawn must be gone (ep removes the pawn BEHIND the landing square)
    expect(after.board.split('P').length - 1).toBe(0);
  });
});

describe('castling rights after a promotion-capture ON the rook home square', () => {
  it('g7xh8=Q removes the black kingside right', () => {
    const st = decode('4k2r/6P1/8/8/8/8/8/4K3 w k - 0 1');
    expect(legal(st, 'p0')).toContain('g7h8q');
    const r = apply(st, 'p0', 'g7h8q');
    if (isRuleError(r)) throw new Error(r.message);
    const after = r.state as ChessState;
    expect(after.castling).toBe('-');
    // and black may never castle kingside later — no rook, no right
    expect(legal(after, 'p1')).not.toContain('e8g8');
  });

  it('b2xa1=N removes the white queenside right', () => {
    const st = decode('4k3/8/8/8/8/8/1p6/R3K2R b KQ - 0 1');
    expect(legal(st, 'p1')).toContain('b2a1n');
    const r = apply(st, 'p1', 'b2a1n');
    if (isRuleError(r)) throw new Error(r.message);
    const after = r.state as ChessState;
    expect(after.castling).toBe('K'); // queenside gone, kingside kept
    expect(legal(after, 'p0')).not.toContain('e1c1');
    expect(legal(after, 'p0')).toContain('e1g1');
  });
});

describe('fifty-move and threefold draw rules (attack family 2)', () => {
  it('halfmove clock 100 is an automatic draw', () => {
    const st = decode('4k3/8/8/8/8/8/8/4KR2 w - - 100 80');
    const t = chess.isTerminal(st);
    expect(t).not.toBeNull();
    expect(t!.draw).toBe(true);
    expect(t!.reason).toBe('fifty_move_rule');
  });

  it('halfmove 99 is not yet a draw; a quiet move then draws at 100', () => {
    const st = decode('4k3/8/8/8/8/8/8/4KR2 w - - 99 80');
    expect(chess.isTerminal(st)).toBeNull();
    const r = apply(st, 'p0', 'f1f2');
    if (isRuleError(r)) throw new Error(r.message);
    const t = chess.isTerminal(r.state as ChessState);
    expect(t?.reason).toBe('fifty_move_rule');
  });

  it('STALEMATE delivered exactly at halfmove 100 outranks the fifty-move reason', () => {
    // Black to move, stalemated, clock at 100: FIDE gives stalemate precedence.
    const st = decode('7k/5Q2/6K1/8/8/8/8/8 b - - 100 90');
    const t = chess.isTerminal(st);
    expect(t).not.toBeNull();
    expect(t!.reason).toBe('stalemate');
  });

  it('a third repetition recorded in the state draws immediately', () => {
    const st = decode('4k3/8/8/8/8/8/8/4KR2 w - - 10 30');
    st.reps[posKey(st)] = 3; // states are plain JSON — craft the count
    const t = chess.isTerminal(st);
    expect(t?.reason).toBe('threefold_repetition');
    expect(t?.draw).toBe(true);
  });

  it('a mating move that is also the 100th halfmove is still checkmate', () => {
    // White mates with Ra8# from halfmove 99 (king cannot reach the a8 rook).
    const st = decode('4k3/8/4K3/8/8/8/8/R7 w - - 99 80');
    const r = apply(st, 'p0', 'a1a8');
    if (isRuleError(r)) throw new Error(r.message);
    const t = chess.isTerminal(r.state as ChessState);
    expect(t?.reason).toBe('checkmate');
    expect(t?.winners).toEqual(['p0']);
  });
});

describe('apply robustness: malformed moves return RuleError, never throw', () => {
  it('non-string and garbage moves are structured rejections', () => {
    const st = chess.initialState(seed(), ['p0', 'p1'], {});
    for (const bad of [null, 42, { index: 0 }, 'e9e4', 'castle', '0000', 'e2e2']) {
      let out: unknown;
      expect(() => {
        out = chess.apply(st, 'p0', bad as never, seed());
      }).not.toThrow();
      expect(isRuleError(out)).toBe(true);
    }
  });
});
