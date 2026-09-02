import { describe, expect, it } from 'vitest';
import { applyUci, legalMovesFromFen, perftFromFen } from '../b.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
const POS3 = '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1';
const POS4 = 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1';

describe('perft: initial position', () => {
  it('depth 1 = 20', () => {
    expect(perftFromFen(START, 1)).toBe(20);
  });
  it('depth 2 = 400', () => {
    expect(perftFromFen(START, 2)).toBe(400);
  });
  it('depth 3 = 8902', () => {
    expect(perftFromFen(START, 3)).toBe(8902);
  });
  it('depth 4 = 197281', () => {
    expect(perftFromFen(START, 4)).toBe(197281);
  });
  it('depth 5 = 4865609', { timeout: 600_000 }, () => {
    expect(perftFromFen(START, 5)).toBe(4865609);
  });
});

describe('perft: Kiwipete', () => {
  it('depth 1 = 48', () => {
    expect(perftFromFen(KIWIPETE, 1)).toBe(48);
  });
  it('depth 2 = 2039', () => {
    expect(perftFromFen(KIWIPETE, 2)).toBe(2039);
  });
  it('depth 3 = 97862', () => {
    expect(perftFromFen(KIWIPETE, 3)).toBe(97862);
  });
  it('depth 4 = 4085603', { timeout: 600_000 }, () => {
    expect(perftFromFen(KIWIPETE, 4)).toBe(4085603);
  });
});

describe('perft: position 3', () => {
  it('depth 1 = 14', () => {
    expect(perftFromFen(POS3, 1)).toBe(14);
  });
  it('depth 2 = 191', () => {
    expect(perftFromFen(POS3, 2)).toBe(191);
  });
  it('depth 3 = 2812', () => {
    expect(perftFromFen(POS3, 3)).toBe(2812);
  });
  it('depth 4 = 43238', () => {
    expect(perftFromFen(POS3, 4)).toBe(43238);
  });
  it('depth 5 = 674624', { timeout: 600_000 }, () => {
    expect(perftFromFen(POS3, 5)).toBe(674624);
  });
});

describe('perft: position 4', () => {
  it('depth 1 = 6', () => {
    expect(perftFromFen(POS4, 1)).toBe(6);
  });
  it('depth 2 = 264', () => {
    expect(perftFromFen(POS4, 2)).toBe(264);
  });
  it('depth 3 = 9467', () => {
    expect(perftFromFen(POS4, 3)).toBe(9467);
  });
  it('depth 4 = 422333', { timeout: 600_000 }, () => {
    expect(perftFromFen(POS4, 4)).toBe(422333);
  });
});

describe('perft: positions 5 and 6', () => {
  const POS5 = 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8';
  const POS6 = 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10';

  it('position 5 depths 1-4', { timeout: 600_000 }, () => {
    expect(perftFromFen(POS5, 1)).toBe(44);
    expect(perftFromFen(POS5, 2)).toBe(1486);
    expect(perftFromFen(POS5, 3)).toBe(62379);
    expect(perftFromFen(POS5, 4)).toBe(2103487);
  });

  it('position 6 depths 1-3', { timeout: 600_000 }, () => {
    expect(perftFromFen(POS6, 1)).toBe(46);
    expect(perftFromFen(POS6, 2)).toBe(2079);
    expect(perftFromFen(POS6, 3)).toBe(89890);
  });
});

describe('legalMovesFromFen', () => {
  it('initial position: exact sorted 20-move list', () => {
    expect(legalMovesFromFen(START)).toEqual([
      'a2a3', 'a2a4', 'b1a3', 'b1c3', 'b2b3', 'b2b4', 'c2c3', 'c2c4',
      'd2d3', 'd2d4', 'e2e3', 'e2e4', 'f2f3', 'f2f4', 'g1f3', 'g1h3',
      'g2g3', 'g2g4', 'h2h3', 'h2h4',
    ]);
  });

  it('output is always sorted lexicographically', () => {
    const moves = legalMovesFromFen(KIWIPETE);
    expect(moves).toEqual([...moves].sort());
    expect(moves).toHaveLength(48);
  });
});

describe('en passant', () => {
  it('ep capture that exposes own king along the rank is illegal', () => {
    // Rank 5: Ka5, black pawn d5 (just double-pushed), white pawn e5, black queen h5.
    // exd6 e.p. removes BOTH rank-5 pawns, exposing Ka5 to Qh5 -> illegal.
    const fen = '4k3/8/8/K2pP2q/8/8/8/8 w - d6 0 1';
    const moves = legalMovesFromFen(fen);
    expect(moves).not.toContain('e5d6');
    expect(moves).toContain('e5e6'); // the plain push is fine (d5 pawn still blocks)
  });

  it('normal ep capture is generated', () => {
    const fen = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1';
    expect(legalMovesFromFen(fen)).toContain('e5d6');
  });

  it('applyUci: double push sets the ep target square', () => {
    expect(applyUci(START, 'e2e4')).toBe(
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    );
  });

  it('applyUci: ep capture removes the captured pawn and clears ep', () => {
    expect(applyUci('4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1', 'd4e3')).toBe(
      '4k3/8/8/8/8/4p3/8/4K3 w - - 0 2',
    );
  });
});

describe('castling', () => {
  it('both castles available with clear board and full rights', () => {
    const moves = legalMovesFromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(moves).toContain('e1g1');
    expect(moves).toContain('e1c1');
  });

  it('refuses to castle through an attacked square', () => {
    // Black rook on f2 attacks f1; O-O must be absent, but Kxf2 is legal.
    const moves = legalMovesFromFen('4k3/8/8/8/8/8/5r2/4K2R w K - 0 1');
    expect(moves).not.toContain('e1g1');
    expect(moves).toContain('e1f2');
  });

  it('refuses to castle out of check', () => {
    const moves = legalMovesFromFen('4k3/8/8/8/8/8/4r3/4K2R w K - 0 1');
    expect(moves).not.toContain('e1g1');
  });

  it('queenside castle needs b1 empty even though the king skips it', () => {
    const moves = legalMovesFromFen('r3k2r/8/8/8/8/8/8/RN2K2R w KQkq - 0 1');
    expect(moves).not.toContain('e1c1');
    expect(moves).toContain('e1g1');
  });

  it('queenside castle is legal when only b1 is attacked', () => {
    // Black pawn a2 attacks b1 only; king path e1-d1-c1 is clean.
    const moves = legalMovesFromFen('4k3/8/8/8/8/8/p7/R3K3 w Q - 0 1');
    expect(moves).toContain('e1c1');
  });

  it('applyUci: kingside castle moves the rook and drops both white rights', () => {
    expect(applyUci('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1')).toBe(
      'r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1',
    );
  });

  it('applyUci: king move drops both rights, rook move drops one', () => {
    expect(applyUci('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1e2')).toBe(
      'r3k2r/8/8/8/8/8/4K3/R6R b kq - 1 1',
    );
    expect(applyUci('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'h1g1')).toBe(
      'r3k2r/8/8/8/8/8/8/R3K1R1 b Qkq - 1 1',
    );
  });

  it('applyUci: capturing a rook on its origin square clears that right', () => {
    expect(applyUci('r3k2r/8/8/8/8/8/1B6/R3K2R w KQkq - 0 1', 'b2h8')).toBe(
      'r3k2B/8/8/8/8/8/8/R3K2R b KQq - 0 1',
    );
  });
});

describe('promotion', () => {
  it('quiet promotion offers exactly q/r/b/n', () => {
    const moves = legalMovesFromFen('8/P6k/8/8/8/8/8/K7 w - - 0 1');
    const promos = moves.filter((m) => m.startsWith('a7'));
    expect(promos).toEqual(['a7a8b', 'a7a8n', 'a7a8q', 'a7a8r']);
  });

  it('capture promotions are generated alongside push promotions', () => {
    const moves = legalMovesFromFen('1r6/P6k/8/8/8/8/8/K7 w - - 0 1');
    for (const m of ['a7a8q', 'a7a8r', 'a7a8b', 'a7a8n', 'a7b8q', 'a7b8r', 'a7b8b', 'a7b8n']) {
      expect(moves).toContain(m);
    }
  });

  it('applyUci: underpromotion places the chosen piece', () => {
    expect(applyUci('8/P6k/8/8/8/8/8/K7 w - - 0 1', 'a7a8n')).toBe(
      'N7/7k/8/8/8/8/8/K7 b - - 0 1',
    );
  });
});

describe('check handling', () => {
  it('double check allows only king moves', () => {
    // Nd6 and Re1 both check the e8 king; the d8 queen cannot block or capture.
    const moves = legalMovesFromFen('3qk3/8/3N4/8/8/8/8/4RK2 b - - 0 1');
    expect(moves).toEqual(['e8d7', 'e8f8']);
  });

  it('checkmate yields no legal moves', () => {
    expect(
      legalMovesFromFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'),
    ).toEqual([]);
  });

  it('stalemate yields no legal moves', () => {
    expect(legalMovesFromFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')).toEqual([]);
  });
});

describe('clock bookkeeping', () => {
  it('quiet piece move increments the halfmove clock', () => {
    expect(applyUci(START, 'g1f3')).toBe(
      'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1',
    );
  });

  it('fullmove increments only after black moves', () => {
    const afterWhite = applyUci(START, 'e2e4');
    const afterBlack = applyUci(afterWhite, 'g8f6');
    expect(afterBlack).toBe('rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2');
  });

  it('applyUci rejects illegal moves', () => {
    expect(() => applyUci(START, 'e2e5')).toThrow();
    expect(() => applyUci(START, 'e7e5')).toThrow();
  });
});
