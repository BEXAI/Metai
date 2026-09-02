import { describe, expect, it } from 'vitest';
import { createSeedStream } from '../../../kernel/seed.ts';
import { finalHashOfPlayout, runPlayouts } from '../../../kernel/playout.ts';
import { sha256Hex } from '../../../crypto/canonical.ts';
import { hashState } from '../../../kernel/hash.ts';
import { isParseError, isRuleError } from '../../../kernel/types.ts';
import nmm from '../index.ts';
import { ADJ, decodeNmm, encodeNmm, MILLS, POINTS, type NmmState } from '../rules.ts';

const seed = () => createSeedStream(sha256Hex('nmm-test'));

function fresh(): NmmState {
  return nmm.initialState(seed(), ['p0', 'p1'], {});
}

function play(state: NmmState, seat: 0 | 1, move: string): NmmState {
  const r = nmm.apply(state, `p${seat}`, move, seed());
  if (isRuleError(r)) throw new Error(`apply ${move} failed: ${r.code} ${r.message}`);
  return r.state;
}

/** Build a board string from {label: 'X'|'O'} placements. */
function boardOf(men: Record<string, 'X' | 'O'>): string {
  const arr = Array.from({ length: 24 }, () => '.');
  for (const [label, sym] of Object.entries(men)) {
    const i = POINTS.indexOf(label as (typeof POINTS)[number]);
    if (i < 0) throw new Error(`bad label ${label}`);
    arr[i] = sym;
  }
  return arr.join('');
}

function craft(partial: Partial<NmmState> & { board: string }): NmmState {
  return {
    toMove: 0,
    inHand: [0, 0],
    phase: 'moving',
    quiet: 0,
    history: [],
    moveCount: 30,
    lastMove: null,
    ...partial,
  };
}

describe('nine mens morris board data', () => {
  it('24 points, 16 mills, symmetric adjacency', () => {
    expect(POINTS).toHaveLength(24);
    expect(new Set(POINTS).size).toBe(24);
    expect(MILLS).toHaveLength(16);
    for (const mill of MILLS) for (const p of mill) expect(POINTS).toContain(p);
    // adjacency symmetric, degree 2..4
    ADJ.forEach((list, i) => {
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list.length).toBeLessThanOrEqual(4);
      for (const j of list) expect(ADJ[j]!).toContain(i);
    });
    // total edges = 32
    expect(ADJ.reduce((n, l) => n + l.length, 0)).toBe(64);
  });
});

describe('nine mens morris rules', () => {
  it('initial state: placing phase, 24 placements for p0, canonical order', () => {
    const s = fresh();
    expect(s.phase).toBe('placing');
    const legal = nmm.legalMoves(s, 'p0');
    expect(legal).toHaveLength(24);
    expect(legal[0]).toBe('a1');
    expect(nmm.legalMoves(s, 'p1')).toEqual([]);
  });

  it('mill formation during placing enumerates one move per removal candidate', () => {
    let s = fresh();
    s = play(s, 0, 'a1');
    s = play(s, 1, 'b2');
    s = play(s, 0, 'd1');
    s = play(s, 1, 'd2');
    const legal = nmm.legalMoves(s, 'p0');
    expect(legal).toContain('g1xb2');
    expect(legal).toContain('g1xd2');
    expect(legal).not.toContain('g1'); // bare g1 illegal: mill must remove
    const next = play(s, 0, 'g1xd2');
    expect(next.board[POINTS.indexOf('d2')]).toBe('.');
    expect(next.inHand).toEqual([6, 7]);
  });

  it('removal preference: men in mills are protected while unmilled men exist', () => {
    const s = craft({
      board: boardOf({ a7: 'X', d7: 'X', a1: 'O', d1: 'O', g1: 'O', b2: 'O' }),
      phase: 'placing',
      inHand: [7, 5],
      toMove: 0,
    });
    const legal = nmm.legalMoves(s, 'p0');
    const g7Moves = legal.filter((m) => m.startsWith('g7'));
    expect(g7Moves).toEqual(['g7xb2']); // a1/d1/g1 are milled and protected
  });

  it('removal preference: when ALL opponent men are in mills, any may be taken', () => {
    const s = craft({
      board: boardOf({ a7: 'X', d7: 'X', a1: 'O', d1: 'O', g1: 'O' }),
      phase: 'placing',
      inHand: [7, 6],
      toMove: 0,
    });
    const g7Moves = nmm.legalMoves(s, 'p0').filter((m) => m.startsWith('g7'));
    expect(g7Moves.sort()).toEqual(['g7xa1', 'g7xd1', 'g7xg1']);
  });

  it('mill with no opponent men on the board: bare placement, no removal suffix', () => {
    const s = craft({
      board: boardOf({ a1: 'X', d1: 'X' }),
      phase: 'placing',
      inHand: [7, 9],
      toMove: 0,
    });
    const legal = nmm.legalMoves(s, 'p0');
    expect(legal).toContain('g1');
    expect(legal.some((m) => m.startsWith('g1x'))).toBe(false);
  });

  it('double mill in one placement still removes exactly one man', () => {
    const s = craft({
      board: boardOf({ b2: 'X', f2: 'X', d1: 'X', d3: 'X', a1: 'O', a4: 'O', a7: 'O', b4: 'O' }),
      phase: 'placing',
      inHand: [5, 5],
      toMove: 0,
    });
    const d2Moves = nmm.legalMoves(s, 'p0').filter((m) => m.startsWith('d2'));
    expect(d2Moves).toEqual(['d2xb4']); // one x only; a1/a4/a7 milled and protected
    const next = play(s, 0, 'd2xb4');
    expect((next.lastMove!.match(/x/g) ?? []).length).toBe(1);
  });

  it('moving phase: slides only to adjacent empty points; oscillating mill removes again', () => {
    let s = craft({
      board: boardOf({ a1: 'X', d1: 'X', g1: 'X', e3: 'X', b2: 'O', b4: 'O', b6: 'O', f4: 'O', f6: 'O' }),
      toMove: 0,
    });
    const legal = nmm.legalMoves(s, 'p0');
    for (const m of legal) expect(m).toMatch(/^[a-g][1-7]-[a-g][1-7](x[a-g][1-7])?$/);
    expect(legal).toContain('d1-d2');
    expect(legal).not.toContain('d1-d5'); // not adjacent
    s = play(s, 0, 'd1-d2'); // breaks the a1-d1-g1 mill
    s = play(s, 1, 'b4-a4');
    // re-forming the mill grants a removal again; all O men now unmilled
    const reform = nmm.legalMoves(s, 'p0').filter((m) => m.startsWith('d2-d1x'));
    expect(reform.sort()).toEqual(['d2-d1xa4', 'd2-d1xb2', 'd2-d1xb6', 'd2-d1xf4', 'd2-d1xf6']);
    const next = play(s, 0, 'd2-d1xb2');
    expect(next.board[POINTS.indexOf('b2')]).toBe('.');
    expect(next.quiet).toBe(0); // mill resets the quiet counter
    expect(next.history).toHaveLength(1); // removal resets repetition history
  });

  it('flying: a player on exactly 3 men moves to any empty point', () => {
    const s = craft({
      board: boardOf({ a1: 'X', b2: 'X', c3: 'X', d1: 'O', d2: 'O', d3: 'O', d5: 'O' }),
      toMove: 0,
    });
    const legal = nmm.legalMoves(s, 'p0');
    expect(legal).toHaveLength(3 * 17); // 3 men x 17 empty points, no mills possible
    expect(legal).toContain('a1-g7'); // definitely not adjacent
    // opponent with 4 men does NOT fly
    const s2 = craft({ ...s, toMove: 1 });
    expect(nmm.legalMoves(s2, 'p1')).not.toContain('d5-g7');
  });

  it('loss at 2 men and loss by blocked position', () => {
    const reduced = craft({
      board: boardOf({ a1: 'O', d1: 'O', c3: 'X', c4: 'X', c5: 'X', e3: 'X', e4: 'X' }),
      toMove: 1,
    });
    expect(nmm.isTerminal(reduced)).toEqual({ winners: ['p0'], draw: false, reason: 'reduced' });

    const blocked = craft({
      board: boardOf({
        a1: 'X', d1: 'X', g1: 'X', d2: 'X',
        a4: 'O', g4: 'O', b2: 'O', f2: 'O', d3: 'O',
      }),
      toMove: 0,
    });
    expect(nmm.legalMoves(blocked, 'p0')).toEqual([]);
    expect(nmm.playersToMove(blocked)).toEqual([]);
    expect(nmm.isTerminal(blocked)).toEqual({ winners: ['p1'], draw: false, reason: 'blocked' });
  });

  it('draw by threefold repetition in the moving phase', () => {
    const board = boardOf({ a1: 'X', b2: 'X', c3: 'X', e3: 'X', a7: 'O', b6: 'O', c5: 'O', e5: 'O' });
    let s = craft({ board, history: [board + '0'] });
    const cycle = [
      [0, 'a1-a4'],
      [1, 'b6-d6'],
      [0, 'a4-a1'],
      [1, 'd6-b6'],
    ] as const;
    for (let rep = 0; rep < 2; rep++) {
      for (const [seat, mv] of cycle) {
        expect(nmm.isTerminal(s)).toBeNull();
        s = play(s, seat, mv);
      }
    }
    expect(nmm.isTerminal(s)).toEqual({ winners: [], draw: true, reason: 'repetition' });
  });

  it('draw after 50 moving-phase plies without a mill', () => {
    const board = boardOf({ a1: 'X', b2: 'X', c3: 'X', e3: 'X', a7: 'O', b6: 'O', c5: 'O', e5: 'O' });
    let s = craft({ board, quiet: 49 });
    expect(nmm.isTerminal(s)).toBeNull();
    s = play(s, 0, 'a1-a4');
    expect(s.quiet).toBe(50);
    expect(nmm.isTerminal(s)).toEqual({ winners: [], draw: true, reason: 'fifty_moves' });
  });

  it('placing -> moving transition when both hands are empty', () => {
    let s = craft({
      board: boardOf({
        a1: 'X', b2: 'X', c3: 'X', d5: 'X', e4: 'X', f6: 'X', g1: 'X', d7: 'X',
        a7: 'O', b6: 'O', c5: 'O', d2: 'O', e3: 'O', f2: 'O', g4: 'O', g7: 'O',
      }),
      phase: 'placing',
      inHand: [1, 1],
      toMove: 0,
    });
    s = play(s, 0, 'a4');
    expect(s.phase).toBe('placing');
    s = play(s, 1, 'd6');
    expect(s.phase).toBe('moving');
    expect(s.inHand).toEqual([0, 0]);
    expect(s.history).toHaveLength(1); // first moving-phase position recorded
  });

  it('illegal moves are rejected as RuleError', () => {
    const s = fresh();
    expect(isRuleError(nmm.apply(s, 'p1', 'a1', seed()))).toBe(true); // not your turn
    expect(isRuleError(nmm.apply(s, 'p0', 'a1xd1', seed()))).toBe(true); // no mill
    expect(isRuleError(nmm.apply(s, 'p0', 'a1-a4', seed()))).toBe(true); // no sliding in placing
    const s2 = play(s, 0, 'a1');
    expect(isRuleError(nmm.apply(s2, 'p1', 'a1', seed()))).toBe(true); // occupied
  });

  it('notation: parse round-trips, garbage rejected', () => {
    const s = fresh();
    expect(nmm.parseMove('D1', s, 'p0')).toBe('d1');
    expect(nmm.parseMove('d1-d2xd6', s, 'p0')).toBe('d1-d2xd6');
    expect(isParseError(nmm.parseMove('d4', s, 'p0'))).toBe(true); // d4 is not a point
    expect(isParseError(nmm.parseMove('h1', s, 'p0'))).toBe(true);
    expect(isParseError(nmm.parseMove('#3', s, 'p0'))).toBe(true);
    expect(nmm.moveToNotation('d1-d2xd6', s)).toBe('d1-d2xd6');
  });

  it('encode/decode round-trips exactly (hash equality), including history', () => {
    let s = fresh();
    expect(hashState(decodeNmm(encodeNmm(s)))).toBe(hashState(s));
    s = play(s, 0, 'a1');
    s = play(s, 1, 'b2');
    expect(decodeNmm(encodeNmm(s))).toEqual(s);
    const moving = craft({
      board: boardOf({ a1: 'X', b2: 'O' }),
      history: ['k1', 'k2'],
      quiet: 7,
      lastMove: 'a4-a1',
    });
    expect(decodeNmm(encodeNmm(moving))).toEqual(moving);
    expect(hashState(decodeNmm(encodeNmm(moving)))).toBe(hashState(moving));
  });

  it('renderText shows the grid, coordinates, legend, last move and status', () => {
    let s = fresh();
    s = play(s, 0, 'd1');
    const text = nmm.renderText(s, null);
    expect(text).toContain('a   b   c   d   e   f   g');
    expect(text).toContain('legend: X = p0');
    expect(text).toContain('last move: d1');
    expect(text).toContain('status: p1 (O) to move');
    expect(text).toContain('placing phase');
  });
});

describe('nine mens morris playouts (gates A1/A2 local)', () => {
  it('200 random playouts terminate legally', { timeout: 600_000 }, () => {
    const stats = runPlayouts(nmm, { games: 200, seedPrefix: 'nmm' });
    expect(stats.games).toBe(200);
    const reasonKeys = Object.keys(stats.reasons).sort();
    for (const k of reasonKeys) expect(['blocked', 'fifty_moves', 'reduced', 'repetition']).toContain(k);
  });

  it('determinism: identical seeds give identical final hashes', () => {
    const a = finalHashOfPlayout(nmm, sha256Hex('nmm-det-seed'), sha256Hex('nmm-det-picker'), 2);
    const b = finalHashOfPlayout(nmm, sha256Hex('nmm-det-seed'), sha256Hex('nmm-det-picker'), 2);
    expect(a.hash).toBe(b.hash);
    expect(a.moves).toBe(b.moves);
  });
});
