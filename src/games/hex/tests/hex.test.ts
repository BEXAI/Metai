import { describe, expect, it } from 'vitest';
import { createSeedStream } from '../../../kernel/seed.ts';
import { finalHashOfPlayout, runPlayouts } from '../../../kernel/playout.ts';
import { sha256Hex } from '../../../crypto/canonical.ts';
import { hashState } from '../../../kernel/hash.ts';
import { isParseError, isRuleError } from '../../../kernel/types.ts';
import hex from '../index.ts';
import { decodeHex, encodeHex, type HexState } from '../rules.ts';

const seed = () => createSeedStream(sha256Hex('hex-test'));

function fresh(size = 11): HexState {
  return hex.initialState(seed(), ['p0', 'p1'], { size });
}

function play(state: HexState, seat: 0 | 1, move: string): HexState {
  const r = hex.apply(state, `p${seat}`, move, seed());
  if (isRuleError(r)) throw new Error(`apply ${move} failed: ${r.code} ${r.message}`);
  return r.state;
}

describe('hex rules', () => {
  it('initial state: empty board, p0 to move, correct sizes', () => {
    for (const size of [7, 11, 13]) {
      const s = fresh(size);
      expect(s.board).toBe('.'.repeat(size * size));
      expect(hex.playersToMove(s)).toEqual(['p0']);
      expect(hex.legalMoves(s, 'p0')).toHaveLength(size * size);
      expect(hex.legalMoves(s, 'p1')).toEqual([]);
    }
    expect(() => fresh(9 as never)).toThrow();
  });

  it('p0 wins by connecting top to bottom (vertical orientation)', () => {
    let s = fresh(7);
    // p0 builds column d top to bottom; p1 answers in columns a/b without connecting.
    const p1Moves = ['a1', 'b1', 'a2', 'b2', 'a3', 'b3'];
    for (let row = 1; row <= 7; row++) {
      s = play(s, 0, `d${row}`);
      const t = hex.isTerminal(s);
      if (row < 7) {
        expect(t).toBeNull();
        s = play(s, 1, p1Moves[row - 1]!);
      } else {
        expect(t).toEqual({ winners: ['p0'], draw: false, reason: 'connection' });
        expect(hex.playersToMove(s)).toEqual([]);
        expect(hex.legalMoves(s, 'p1')).toEqual([]);
      }
    }
  });

  it('p1 wins by connecting left to right (horizontal orientation), winding path', () => {
    let s = fresh(7);
    // p1 path: a4 b4 c3 d3 e3 f2 g2 — uses the (c+1, r-1) diagonal adjacency twice.
    const p1Path = ['a4', 'b4', 'c3', 'd3', 'e3', 'f2', 'g2'];
    const p0Moves = ['a1', 'b1', 'c1', 'd1', 'e1', 'f1', 'g1', 'a2'];
    for (let i = 0; i < p1Path.length; i++) {
      s = play(s, 0, p0Moves[i]!);
      expect(hex.isTerminal(s)).toBeNull();
      s = play(s, 1, p1Path[i]!);
    }
    expect(hex.isTerminal(s)).toEqual({ winners: ['p1'], draw: false, reason: 'connection' });
  });

  it('diagonal adjacency: (c+1,r-1) touches, (c+1,r+1) does not', () => {
    let s = fresh(7);
    s = play(s, 0, 'a2');
    s = play(s, 1, 'g7');
    s = play(s, 0, 'b1'); // b1 is (c+1, r-1) from a2 -> connected chain a2-b1 touching top
    // now chain must reach bottom for a win; not yet
    expect(hex.isTerminal(s)).toBeNull();
  });

  it('swap: offered exactly on ply 2, steals the stone in place, then p0 moves', () => {
    let s = fresh(11);
    expect(hex.legalMoves(s, 'p0')).not.toContain('swap');
    s = play(s, 0, 'c2');
    const legal = hex.legalMoves(s, 'p1');
    expect(legal).toContain('swap');
    expect(legal[legal.length - 1]).toBe('swap'); // canonical order: swap last
    expect(legal).toHaveLength(11 * 11 - 1 + 1);

    const swapped = play(s, 1, 'swap');
    // stone at c2 is now O (p1), same cell, no mirroring
    const idx = 1 * 11 + 2; // row 2 (index 1), col c (index 2)
    expect(swapped.board[idx]).toBe('O');
    expect(swapped.board.split('O')).toHaveLength(2); // exactly one O
    expect(swapped.board).not.toContain('X');
    expect(swapped.toMove).toBe(0);
    expect(swapped.swapUsed).toBe(true);
    expect(hex.playersToMove(swapped)).toEqual(['p0']);
    // never offered again
    const later = play(swapped, 0, 'd4');
    expect(hex.legalMoves(later, 'p1')).not.toContain('swap');
  });

  it('swap is rejected after ply 2 and by p0', () => {
    let s = fresh(11);
    s = play(s, 0, 'c2');
    s = play(s, 1, 'd4');
    const r = hex.apply(s, 'p0', 'swap', seed());
    expect(isRuleError(r)).toBe(true);
  });

  it('rejects occupied cells, off-board cells, out-of-turn moves', () => {
    let s = fresh(7);
    s = play(s, 0, 'd4');
    expect(isRuleError(hex.apply(s, 'p1', 'd4', seed()))).toBe(true);
    expect(isRuleError(hex.apply(s, 'p1', 'h1', seed()))).toBe(true); // col h off 7x7
    expect(isRuleError(hex.apply(s, 'p0', 'a1', seed()))).toBe(true); // not p0's turn
  });

  it('notation: parse/moveToNotation round-trip, index fallback not accepted', () => {
    const s = fresh(11);
    const m = hex.parseMove('F6', s, 'p0');
    expect(m).toBe('f6');
    expect(hex.moveToNotation('f6', s)).toBe('f6');
    expect(isParseError(hex.parseMove('z9', s, 'p0'))).toBe(true);
    expect(isParseError(hex.parseMove('#3', s, 'p0'))).toBe(true);
    expect(isParseError(hex.parseMove('f14', s, 'p0'))).toBe(true);
  });

  it('encode/decode round-trips exactly (hash equality)', () => {
    let s = fresh(11);
    expect(hashState(decodeHex(encodeHex(s)))).toBe(hashState(s));
    s = play(s, 0, 'c2');
    s = play(s, 1, 'swap');
    s = play(s, 0, 'f6');
    expect(decodeHex(encodeHex(s))).toEqual(s);
    expect(hashState(decodeHex(encodeHex(s)))).toBe(hashState(s));
  });

  it('renderText shows coordinates, legend, last move and status for both viewers', () => {
    let s = fresh(7);
    s = play(s, 0, 'd4');
    for (const viewer of ['p1', null] as const) {
      const text = hex.renderText(s, viewer);
      expect(text).toContain('a b c d e f g');
      expect(text).toContain('legend:');
      expect(text).toContain('last move: d4');
      expect(text).toContain('status: p1 (O) to move');
    }
  });
});

describe('hex playouts (gates A1/A2 local)', () => {
  it('200 random playouts at 11x11 terminate, all by connection, zero draws', { timeout: 600_000 }, () => {
    const stats = runPlayouts(hex, { games: 200, seedPrefix: 'hex-11' });
    expect(stats.draws).toBe(0);
    expect(stats.reasons).toEqual({ connection: 200 });
    expect((stats.winsBySeat['p0'] ?? 0) + (stats.winsBySeat['p1'] ?? 0)).toBe(200);
  });

  it('50 playouts each at 7x7 and 13x13, no draws', { timeout: 600_000 }, () => {
    for (const size of [7, 13]) {
      const stats = runPlayouts(hex, { games: 50, seedPrefix: `hex-${size}`, variant: { size } });
      expect(stats.draws).toBe(0);
      expect(stats.reasons).toEqual({ connection: 50 });
    }
  });

  it('determinism: identical seeds give identical final hashes', () => {
    const a = finalHashOfPlayout(hex, sha256Hex('hex-det-seed'), sha256Hex('hex-det-picker'), 2, { size: 11 });
    const b = finalHashOfPlayout(hex, sha256Hex('hex-det-seed'), sha256Hex('hex-det-picker'), 2, { size: 11 });
    expect(a.hash).toBe(b.hash);
    expect(a.moves).toBe(b.moves);
    const c = finalHashOfPlayout(hex, sha256Hex('hex-det-seed'), sha256Hex('hex-det-picker-2'), 2, { size: 11 });
    expect(c.hash).not.toBe(a.hash);
  });
});
