/**
 * FIDE rules fixtures: en passant (incl. ep-pin illegality), castling
 * through/into/out of check, promotion to all four pieces, automatic
 * fifty-move and threefold draws, stalemate, insufficient material, plus the
 * state codec and notation round-trips.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../crypto/canonical.ts';
import { hashState } from '../../../kernel/hash.ts';
import { createSeedStream } from '../../../kernel/seed.ts';
import { isRuleError, playerId, type SeedStream } from '../../../kernel/types.ts';
import chess, { type ChessState } from '../index.ts';

const P0 = playerId(0);
const P1 = playerId(1);

function seed(): SeedStream {
  return createSeedStream(sha256Hex('chess rules fixtures'));
}

function start(): ChessState {
  return chess.initialState(seed(), [P0, P1], {});
}

/** Applies a sequence of UCI moves, asserting each one is legal. */
function play(state: ChessState, moves: string[]): ChessState {
  let s = state;
  for (const uci of moves) {
    const mover = chess.playersToMove(s)[0]!;
    expect(chess.legalMoves(s, mover)).toContain(uci);
    const applied = chess.apply(s, mover, uci, seed());
    if (isRuleError(applied)) throw new Error(`${uci} rejected: ${applied.message}`);
    s = applied.state;
  }
  return s;
}

function pieceAt(state: ChessState, sq: string): string {
  const file = sq.charCodeAt(0) - 97;
  const rank = Number(sq.charAt(1));
  return state.board.charAt((8 - rank) * 8 + file);
}

describe('en passant', () => {
  it('capture works and removes the passed pawn', () => {
    const s = chess.decodeState('rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 2');
    expect(s.ep).toBe('e3'); // legal capture exists, so ep is kept
    expect(chess.legalMoves(s, P1)).toContain('d4e3');
    const next = play(s, ['d4e3']);
    expect(pieceAt(next, 'e3')).toBe('p');
    expect(pieceAt(next, 'e4')).toBe('.'); // captured pawn removed from e4
    expect(pieceAt(next, 'd4')).toBe('.');
    expect(next.halfmove).toBe(0);
  });

  it('ep square is only offered while it can actually be taken', () => {
    const s = play(start(), ['e2e4']);
    // No black pawn can capture on e3, so the FIDE-normalized ep field is '-'.
    expect(s.ep).toBe('-');
  });

  it('ep capture that exposes the king along the rank is illegal (ep pin)', () => {
    // Ka4 and pawn e4 (black); Pd4 just double-pushed, Rh4 (white): exd3 would
    // clear the 4th rank and leave the rook attacking the king.
    const s = chess.decodeState('8/8/8/8/k2Pp2R/8/8/4K3 b - d3 0 1');
    expect(s.ep).toBe('-'); // normalized away: the only ep capture is illegal
    expect(chess.legalMoves(s, P1)).not.toContain('e4d3');
    const applied = chess.apply(s, P1, 'e4d3', seed());
    expect(isRuleError(applied)).toBe(true);
  });

  it('same shape without the pin: ep capture is legal', () => {
    const s = chess.decodeState('8/8/8/8/k2Pp3/8/8/4KR2 b - d3 0 1');
    expect(s.ep).toBe('d3');
    const next = play(s, ['e4d3']);
    expect(pieceAt(next, 'd3')).toBe('p');
    expect(pieceAt(next, 'd4')).toBe('.');
  });
});

describe('castling', () => {
  it('cannot castle out of check', () => {
    const s = chess.decodeState('r3k2r/8/8/8/4R3/8/8/4K3 b kq - 0 1');
    const moves = chess.legalMoves(s, P1);
    expect(moves).not.toContain('e8g8');
    expect(moves).not.toContain('e8c8');
  });

  it('cannot castle through an attacked square', () => {
    const s = chess.decodeState('r3k2r/8/8/8/5R2/8/8/4K3 b kq - 0 1'); // Rf4 hits f8
    const moves = chess.legalMoves(s, P1);
    expect(moves).not.toContain('e8g8');
    expect(moves).toContain('e8c8');
  });

  it('cannot castle into check', () => {
    const s = chess.decodeState('r3k2r/8/8/8/6R1/8/8/4K3 b kq - 0 1'); // Rg4 hits g8
    const moves = chess.legalMoves(s, P1);
    expect(moves).not.toContain('e8g8');
    expect(moves).toContain('e8c8');
  });

  it('an attacked b1 does NOT stop white O-O-O (rook path is not king path)', () => {
    const s = chess.decodeState('1r2k3/8/8/8/8/8/8/R3K2R w KQ - 0 1'); // Rb8 hits b1
    const moves = chess.legalMoves(s, P0);
    expect(moves).toContain('e1c1');
    expect(moves).toContain('e1g1');
  });

  it('castling moves king and rook and clears the rights', () => {
    const s = chess.decodeState('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const afterOO = play(s, ['e1g1']);
    expect(pieceAt(afterOO, 'g1')).toBe('K');
    expect(pieceAt(afterOO, 'f1')).toBe('R');
    expect(pieceAt(afterOO, 'h1')).toBe('.');
    expect(afterOO.castling).toBe('kq');
    const afterOOO = play(s, ['e1c1']);
    expect(pieceAt(afterOOO, 'c1')).toBe('K');
    expect(pieceAt(afterOOO, 'd1')).toBe('R');
    expect(pieceAt(afterOOO, 'a1')).toBe('.');
  });

  it('capturing a rook removes that castling right', () => {
    // Ba1xh8 takes the kingside rook without giving check.
    const s = chess.decodeState('r3k2r/8/8/8/8/8/8/B3K3 w kq - 0 1');
    const next = play(s, ['a1h8']);
    expect(next.castling).toBe('q');
    expect(chess.legalMoves(next, P1)).not.toContain('e8g8');
    expect(chess.legalMoves(next, P1)).toContain('e8c8');
  });

  it('no rights, no castling moves', () => {
    const s = chess.decodeState('r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1');
    const moves = chess.legalMoves(s, P0);
    expect(moves).not.toContain('e1g1');
    expect(moves).not.toContain('e1c1');
  });
});

describe('promotion', () => {
  it('offers all four pieces, in canonical order', () => {
    const s = chess.decodeState('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    const moves = chess.legalMoves(s, P0);
    expect(moves.filter((m) => m.startsWith('a7a8'))).toEqual(['a7a8b', 'a7a8n', 'a7a8q', 'a7a8r']);
  });

  it('applies each promotion piece', () => {
    const s = chess.decodeState('4k3/P7/8/8/8/8/8/4K3 w - - 5 1');
    for (const [suffix, piece] of [
      ['q', 'Q'],
      ['r', 'R'],
      ['b', 'B'],
      ['n', 'N'],
    ] as const) {
      const next = play(s, [`a7a8${suffix}`]);
      expect(pieceAt(next, 'a8')).toBe(piece);
      expect(next.halfmove).toBe(0); // pawn move resets the clock
    }
  });

  it('promotion by capture', () => {
    const s = chess.decodeState('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    expect(chess.legalMoves(s, P0)).toContain('a7b8q');
    const next = play(s, ['a7b8q']);
    expect(pieceAt(next, 'b8')).toBe('Q');
  });
});

describe('checkmate and stalemate', () => {
  it("fool's mate", () => {
    const s = play(start(), ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    const result = chess.isTerminal(s);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('checkmate');
    expect(result!.winners).toEqual([P1]);
    expect(result!.draw).toBe(false);
    expect(s.lastSan).toBe('Qh4#');
    expect(chess.playersToMove(s)).toEqual([]);
    expect(chess.legalMoves(s, P0)).toEqual([]);
  });

  it('stalemate is an automatic draw', () => {
    const s = chess.decodeState('7k/5Q2/5K2/8/8/8/8/8 b - - 0 1');
    const result = chess.isTerminal(s);
    expect(result).toEqual({ winners: [], draw: true, reason: 'stalemate' });
  });
});

describe('fifty-move rule (automatic at 100 halfmoves)', () => {
  it('draws when the clock reaches 100', () => {
    const s = chess.decodeState('4k3/8/8/8/8/8/8/4KR2 w - - 99 60');
    expect(chess.isTerminal(s)).toBeNull();
    const next = play(s, ['f1f2']);
    expect(next.halfmove).toBe(100);
    expect(chess.isTerminal(next)).toEqual({ winners: [], draw: true, reason: 'fifty_move_rule' });
  });

  it('a mating move on the 100th halfmove is still checkmate', () => {
    const s = chess.decodeState('7k/8/6K1/8/8/8/8/R7 w - - 99 60');
    const next = play(s, ['a1a8']);
    expect(next.halfmove).toBe(100);
    const result = chess.isTerminal(next);
    expect(result!.reason).toBe('checkmate');
    expect(result!.winners).toEqual([P0]);
  });

  it('pawn moves and captures reset the clock', () => {
    const s = chess.decodeState('4k3/8/8/8/8/8/4r3/4K3 w - - 42 60');
    const next = play(s, ['e1e2']); // Kxe2
    expect(next.halfmove).toBe(0);
  });
});

describe('threefold repetition (automatic on the third occurrence)', () => {
  it('knight shuffle from the start draws on the third occurrence', () => {
    const back = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    let s = play(start(), back); // initial position, 2nd occurrence
    expect(chess.isTerminal(s)).toBeNull();
    s = play(s, back.slice(0, 3));
    expect(chess.isTerminal(s)).toBeNull();
    s = play(s, [back[3]!]); // initial position, 3rd occurrence
    expect(chess.isTerminal(s)).toEqual({ winners: [], draw: true, reason: 'threefold_repetition' });
  });

  it('positions with different castling rights are different for repetition', () => {
    // Shuffle the white rook: after Ra1-a2 and back, white lost the Q right,
    // so the "same-looking" position is NOT a repetition of the start.
    const s = play(chess.decodeState('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'), [
      'a1a2', 'a8a7', 'a2a1', 'a7a8',
    ]);
    // Key differs from the original (castling now 'Kk'), count restarted at 1... 2 total shuffles needed
    expect(chess.isTerminal(s)).toBeNull();
    expect(s.castling).toBe('Kk');
  });

  it('the repetition table resets on irreversible moves', () => {
    const s = play(start(), ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'e2e4']);
    expect(Object.keys(s.reps).length).toBe(1); // pawn move cleared history
  });
});

describe('insufficient material', () => {
  const draws = [
    ['K vs K', '4k3/8/8/8/8/8/8/4K3 w - - 0 1'],
    ['K+B vs K', '4k3/8/8/8/8/8/8/2B1K3 w - - 0 1'],
    ['K+N vs K', '4k3/8/8/8/8/8/8/1N2K3 w - - 0 1'],
    ['K+B vs K+B same shade', '4k3/8/8/8/5b2/8/8/2B1K3 w - - 0 1'], // c1 and f4 both dark
  ] as const;
  for (const [name, fen] of draws) {
    it(`${name} is a draw`, () => {
      expect(chess.isTerminal(chess.decodeState(fen))).toEqual({
        winners: [],
        draw: true,
        reason: 'insufficient_material',
      });
    });
  }

  const notDraws = [
    ['K+B vs K+B opposite shades', '4k3/8/8/8/4b3/8/8/2B1K3 w - - 0 1'], // c1 dark, e4 light
    ['K+R vs K', '4k3/8/8/8/8/8/8/R3K3 w - - 0 1'],
    ['K+P vs K', '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1'],
    ['K+N+N vs K', '4k3/8/8/8/8/8/8/1N2K1N1 w - - 0 1'],
  ] as const;
  for (const [name, fen] of notDraws) {
    it(`${name} is NOT an automatic draw`, () => {
      expect(chess.isTerminal(chess.decodeState(fen))).toBeNull();
    });
  }

  it('a capture into K vs K ends the game immediately', () => {
    const next = play(chess.decodeState('4k3/8/8/8/8/8/4r3/4K3 w - - 0 1'), ['e1e2']);
    expect(chess.isTerminal(next)).toEqual({
      winners: [],
      draw: true,
      reason: 'insufficient_material',
    });
  });
});

describe('apply guards and notation', () => {
  it('rejects moves out of turn, bad formats, and illegal moves', () => {
    const s = start();
    const outOfTurn = chess.apply(s, P1, 'e7e5', seed());
    expect(isRuleError(outOfTurn) && outOfTurn.code === 'not_your_turn').toBe(true);
    const badFormat = chess.apply(s, P0, 'Nf3', seed());
    expect(isRuleError(badFormat) && badFormat.code === 'bad_move').toBe(true);
    const illegal = chess.apply(s, P0, 'e2e5', seed());
    expect(isRuleError(illegal) && illegal.code === 'illegal_move').toBe(true);
  });

  it('parseMove accepts UCI only and round-trips with moveToNotation', () => {
    const s = start();
    expect(chess.parseMove('e2e4', s, P0)).toBe('e2e4');
    expect(chess.parseMove('  E2E4 ', s, P0)).toBe('e2e4'); // normalized
    expect(chess.parseMove('e7e8Q', s, P0)).toBe('e7e8q');
    for (const bad of ['Nf3', 'O-O', 'e4', '#3', 'e2e9', 'i2i4', '']) {
      const r = chess.parseMove(bad, s, P0);
      expect(typeof r === 'object' && r !== null && 'parseError' in r).toBe(true);
    }
    expect(chess.moveToNotation('e2e4', s)).toBe('e2e4');
  });

  it('moveSummary and SAN describe the move', () => {
    const s = play(start(), ['e2e4', 'd7d5']);
    expect(chess.moveSummary!('e4d5', s)).toContain('capturing the pawn');
    const next = play(s, ['e4d5']);
    expect(next.lastSan).toBe('exd5');
  });
});

describe('state codec', () => {
  it('encode/decode round-trips exactly (hash equality)', () => {
    let s = start();
    expect(hashState(chess.decodeState(chess.encodeState(s)))).toBe(hashState(s));
    s = play(s, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'g8f6', 'e1g1']);
    const rt = chess.decodeState(chess.encodeState(s));
    expect(hashState(rt)).toBe(hashState(s));
    expect(rt.reps).toEqual(s.reps);
    expect(rt.lastMove).toBe('e1g1');
    expect(rt.lastSan).toBe('O-O');
  });

  it('accepts plain FEN and normalizes it', () => {
    const s = chess.decodeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(Object.keys(s.reps).length).toBe(1);
    expect(s.lastMove).toBeNull();
    expect(chess.encodeState(s)).toContain('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  });

  it('throws on garbage', () => {
    expect(() => chess.decodeState('not a fen')).toThrow();
    expect(() => chess.decodeState('8/8/8/8/8/8/8/8 w - - 0 1')).toThrow(); // no kings
    expect(() => chess.decodeState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1')).toThrow();
  });

  it('renderText shows coordinates, last move, and status', () => {
    const s = play(start(), ['e2e4']);
    const text = chess.renderText(s, P1);
    expect(text).toContain('a b c d e f g h');
    expect(text).toContain('8 |');
    expect(text).toContain('1 |');
    expect(text).toContain('Last move: e2e4 (e4)');
    expect(text).toContain('Black to move');
    expect(text).toContain('You are Black (p1).');
    const spectator = chess.renderText(s, null);
    expect(spectator).not.toContain('You are');
  });
});
