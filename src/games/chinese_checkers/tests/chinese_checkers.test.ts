import { describe, expect, it } from 'vitest';
import { createSeedStream } from '../../../kernel/seed.ts';
import { finalHashOfPlayout, runPlayouts } from '../../../kernel/playout.ts';
import { sha256Hex } from '../../../crypto/canonical.ts';
import { hashState } from '../../../kernel/hash.ts';
import { isParseError, isRuleError, playerId } from '../../../kernel/types.ts';
import cc from '../index.ts';
import {
  decodeCc,
  encodeCc,
  holeIndex,
  HOLES,
  OPPOSITE,
  TRIANGLE_HOLES,
  triangleOf,
  type CcState,
  type Triangle,
} from '../rules.ts';

const seed = () => createSeedStream(sha256Hex('cc-test'));

function fresh(n: number): CcState {
  return cc.initialState(seed(), Array.from({ length: n }, (_, i) => playerId(i)), {});
}

/** Blank-board state for fixtures; place pegs with `men`: {label: seat}. */
function craft(n: number, men: Record<string, number>, partial: Partial<CcState> = {}): CcState {
  const board = Array.from({ length: 121 }, () => '.');
  for (const [label, seat] of Object.entries(men)) {
    const idx = holeIndex(label);
    if (idx === undefined) throw new Error(`bad label ${label}`);
    board[idx] = String(seat);
  }
  return {
    n,
    board: board.join(''),
    toMove: 0,
    round: 1,
    movesBy: Array.from({ length: n }, () => 0),
    forfeited: Array.from({ length: n }, () => false),
    lastMove: null,
    moveCount: 0,
    ...partial,
  };
}

function play(state: CcState, seat: number, move: string): CcState {
  const r = cc.apply(state, `p${seat}`, move, seed());
  if (isRuleError(r)) throw new Error(`apply ${move} failed: ${r.code} ${r.message}`);
  return r.state;
}

describe('chinese checkers board topology', () => {
  it('121 holes, unique labels, star row shape', () => {
    expect(HOLES).toHaveLength(121);
    expect(new Set(HOLES.map((h) => h.label)).size).toBe(121);
    expect(HOLES[0]!.label).toBe('m1'); // top apex
    expect(HOLES[120]!.label).toBe('m17'); // bottom apex
    expect(holeIndex('a5')).toBeDefined(); // far left of the wide row
    expect(holeIndex('y5')).toBeDefined();
    expect(holeIndex('a1')).toBeUndefined(); // row 1 has only column m
  });

  it('six triangles of 10 holes each; opposite map is an involution', () => {
    const tris: Triangle[] = ['N', 'NE', 'SE', 'S', 'SW', 'NW'];
    const seen = new Set<number>();
    for (const t of tris) {
      expect(TRIANGLE_HOLES[t]).toHaveLength(10);
      for (const i of TRIANGLE_HOLES[t]) {
        expect(triangleOf(i)).toBe(t);
        seen.add(i);
      }
      expect(OPPOSITE[OPPOSITE[t]]).toBe(t);
    }
    expect(seen.size).toBe(60); // 61 hexagon holes remain neutral
  });
});

describe('chinese checkers setup', () => {
  it('2p: N vs S; 3p: N/SE/SW; 4p: N/NE/S/SW; 6p: all corners; 5p rejected', () => {
    const count = (s: CcState, d: string) => s.board.split('').filter((ch) => ch === d).length;
    const s2 = fresh(2);
    for (const i of TRIANGLE_HOLES.N) expect(s2.board[i]).toBe('0');
    for (const i of TRIANGLE_HOLES.S) expect(s2.board[i]).toBe('1');
    expect(count(s2, '.')).toBe(101);

    const s3 = fresh(3);
    for (const i of TRIANGLE_HOLES.SE) expect(s3.board[i]).toBe('1');
    for (const i of TRIANGLE_HOLES.SW) expect(s3.board[i]).toBe('2');

    const s4 = fresh(4);
    for (const i of TRIANGLE_HOLES.NE) expect(s4.board[i]).toBe('1');
    for (const i of TRIANGLE_HOLES.SW) expect(s4.board[i]).toBe('3');

    const s6 = fresh(6);
    for (const [seat, tri] of (['N', 'NE', 'SE', 'S', 'SW', 'NW'] as Triangle[]).entries()) {
      for (const i of TRIANGLE_HOLES[tri]) expect(s6.board[i]).toBe(String(seat));
    }
    expect(() => fresh(5)).toThrow();
    expect(() => fresh(1)).toThrow();
  });

  it('initial moves: steps out of the triangle and the in-triangle double jump', () => {
    const s = fresh(2);
    const legal = cc.legalMoves(s, 'p0');
    expect(legal).toContain('l4-k5'); // step out
    expect(legal).toContain('j4-i5');
    expect(legal).toContain('m3-k5'); // jump over l4
    expect(legal).toContain('m3-o5'); // jump over n4
    expect(cc.legalMoves(s, 'p1')).toEqual([]);
    expect(new Set(legal).size).toBe(legal.length); // no duplicates
  });
});

describe('chinese checkers jump chains', () => {
  it('a chain may stop at any landing; blocked landings prune', () => {
    const s = craft(2, { m9: 0, n10: 1, p12: 1 });
    const legal = cc.legalMoves(s, 'p0');
    expect(legal).toContain('m9-o11');
    expect(legal).toContain('m9-o11-q13');
    expect(legal).toHaveLength(7); // 5 steps + 2 jump endpoints
    expect(legal.every((m) => new Set(m.split('-')).size === m.split('-').length)).toBe(true);
  });

  it('diamond position: two routes to one endpoint dedupe to the BFS-shortest path', () => {
    const s = craft(2, { m5: 0, l6: 1, n6: 1, l8: 1, n8: 1 });
    const legal = cc.legalMoves(s, 'p0');
    // note: steps to l4/n4 are pruned — they would re-enter p0's start triangle (N)
    expect(legal).toEqual([
      'm5-k5',
      'm5-o5',
      'm5-k7',
      'm5-o7',
      'm5-k7-m9', // endpoint m9 reachable via k7 AND o7; exactly one entry
    ]);
    expect(legal.filter((m) => m.endsWith('m9'))).toHaveLength(1);
  });

  it('dense field: enumeration terminates with unique endpoints per peg', () => {
    // ring of pegs around the centre lets chains cycle; visited-set must cap it
    const s = craft(2, { m9: 0, l8: 1, n8: 1, k9: 1, o9: 1, l10: 1, n10: 1, j6: 1, p6: 1, j12: 1, p12: 1 });
    const legal = cc.legalMoves(s, 'p0');
    expect(new Set(legal).size).toBe(legal.length);
    const endpoints = legal.map((m) => m.split('-').pop()!);
    expect(new Set(endpoints).size).toBe(endpoints.length); // deduped by endpoint
    for (const m of legal) {
      const labels = m.split('-');
      expect(new Set(labels).size).toBe(labels.length); // canonical paths are cycle-free
    }
  });
});

describe('chinese checkers anti-stall rules', () => {
  it('a peg outside its start triangle may not step back in', () => {
    const s = craft(2, { k5: 0, m17: 1 });
    const legal = cc.legalMoves(s, 'p0');
    expect(legal).not.toContain('k5-j4'); // j4 is in N, p0 home
    expect(legal).toContain('k5-i5');
  });

  it('a peg still inside its start triangle may shuffle within it', () => {
    const s = craft(2, { l4: 0, m17: 1 });
    const legal = cc.legalMoves(s, 'p0');
    expect(legal).toContain('l4-k3'); // within N: allowed (never left)
    expect(legal).toContain('l4-k5'); // leaving: allowed
  });

  it('jump endpoints into the own start triangle are pruned, but only for the owner', () => {
    const both = { m5: 0, l4: 1 };
    const s0 = craft(2, both);
    expect(cc.legalMoves(s0, 'p0')).not.toContain('m5-k3'); // k3 in N = p0 home
    const s1 = craft(2, { m5: 1, l4: 0, m17: 1 }, { toMove: 1 });
    expect(cc.legalMoves(s1, 'p1')).toContain('m5-k3'); // N is not p1's home
  });

  it('30th own move with a peg still at home forfeits (2p: opponent wins)', () => {
    const s = craft(
      2,
      { l4: 0, k9: 0, o9: 1, m17: 1 },
      { movesBy: [29, 10], round: 25 },
    );
    const r = cc.apply(s, 'p0', 'k9-m9', seed());
    if (isRuleError(r)) throw new Error(r.message);
    expect(r.state.forfeited).toEqual([true, false]);
    expect(r.events.some((e) => e.type === 'forfeit')).toBe(true);
    const result = cc.isTerminal(r.state);
    expect(result?.winners).toEqual(['p1']);
    expect(result?.reason).toBe('forfeit');
    expect(cc.playersToMove(r.state)).toEqual([]);
  });

  it('vacating on exactly the 30th move avoids the forfeit', () => {
    const s = craft(2, { l4: 0, m17: 1 }, { movesBy: [29, 10], round: 25 });
    const next = play(s, 0, 'l4-k5');
    expect(next.forfeited).toEqual([false, false]);
    expect(cc.isTerminal(next)).toBeNull();
  });

  it('in 6p the game continues among remaining players; forfeited seats are skipped', () => {
    // seat 0 forfeits on its 30th move (peg l4 stays home in N while k9 moves)
    const men: Record<string, number> = { l4: 0, k9: 0, o9: 1, a5: 2, y5: 3, m17: 4, c5: 5 };
    const s = craft(6, men, { movesBy: [29, 0, 0, 0, 0, 0] });
    const next = play(s, 0, 'k9-m9');
    expect(next.forfeited).toEqual([true, false, false, false, false, false]);
    expect(cc.isTerminal(next)).toBeNull(); // 5 players still active
    expect(next.toMove).toBe(1);

    // when seat 5 moves, the turn wraps past forfeited seat 0 to seat 1
    const late = craft(6, men, {
      forfeited: [true, false, false, false, false, false],
      toMove: 5,
      round: 3,
      movesBy: [30, 2, 2, 2, 2, 2],
    });
    const wrapped = play(late, 5, 'c5-d6');
    expect(wrapped.toMove).toBe(1);
    expect(wrapped.round).toBe(4);
  });

  it('turn limit: after round 200 the most pegs in goal wins; ties share the placement', () => {
    const clear = craft(2, { m17: 0, l16: 0, m1: 1, l2: 1, n2: 1, k3: 1, m3: 1 }, { round: 201 });
    const r1 = cc.isTerminal(clear);
    expect(r1).toEqual({
      winners: ['p1'],
      draw: false,
      scores: { p0: 2, p1: 5 },
      reason: 'turn_limit',
    });

    const tied = craft(2, { m17: 0, l16: 0, m1: 1, l2: 1 }, { round: 201 });
    const r2 = cc.isTerminal(tied);
    expect(r2?.winners.sort()).toEqual(['p0', 'p1']);
    expect(r2?.draw).toBe(true);
    expect(r2?.reason).toBe('turn_limit');
  });

  it('the round counter increments when the turn wraps to the first seat', () => {
    const s = craft(2, { k9: 0, o9: 1 }, { round: 200, toMove: 1 });
    expect(cc.isTerminal(s)).toBeNull();
    const next = play(s, 1, 'o9-n10');
    expect(next.round).toBe(201);
    expect(cc.isTerminal(next)?.reason).toBe('turn_limit');

    const mid = craft(2, { k9: 0, o9: 1 }, { round: 200, toMove: 0 });
    expect(play(mid, 0, 'k9-j10').round).toBe(200); // no wrap yet
  });
});

describe('chinese checkers win, pass, errors', () => {
  it('filling the goal triangle wins immediately', () => {
    const men: Record<string, number> = { k9: 1 };
    for (const i of TRIANGLE_HOLES.S) men[HOLES[i]!.label] = 0;
    const s = craft(2, men);
    const r = cc.isTerminal(s);
    expect(r?.winners).toEqual(['p0']);
    expect(r?.reason).toBe('goal');
    expect(r?.scores).toEqual({ p0: 10, p1: 0 });
    expect(cc.legalMoves(s, 'p0')).toEqual([]);
  });

  it("a fully blocked player has exactly ['pass'], and pass counts as a move", () => {
    const s = craft(2, { m1: 0, l2: 1, n2: 1, k3: 1, o3: 1 });
    expect(cc.legalMoves(s, 'p0')).toEqual(['pass']);
    const next = play(s, 0, 'pass');
    expect(next.board).toBe(s.board);
    expect(next.movesBy).toEqual([1, 0]);
    expect(next.toMove).toBe(1);
  });

  it('illegal moves are rejected as RuleError', () => {
    const s = fresh(2);
    expect(isRuleError(cc.apply(s, 'p1', 'e13-e11', seed()))).toBe(true); // not p1's turn
    expect(isRuleError(cc.apply(s, 'p0', 'pass', seed()))).toBe(true); // pass only when blocked
    expect(isRuleError(cc.apply(s, 'p0', 'm9-k9', seed()))).toBe(true); // no peg at m9
    expect(isRuleError(cc.apply(s, 'p0', 'l4-l4', seed()))).toBe(true);
  });

  it('parseMove validates hops and canonicalizes alternate jump paths', () => {
    const s = craft(2, { m5: 0, l6: 1, n6: 1, l8: 1, n8: 1 });
    expect(cc.parseMove('M5-K5', s, 'p0')).toBe('m5-k5'); // step, case-normalized
    expect(cc.parseMove('m5-k7-m9', s, 'p0')).toBe('m5-k7-m9');
    expect(cc.parseMove('m5-o7-m9', s, 'p0')).toBe('m5-k7-m9'); // alternate route canonicalized
    expect(cc.parseMove('pass', s, 'p0')).toBe('pass');
    expect(isParseError(cc.parseMove('m5-m9', s, 'p0'))).toBe(true); // neither step nor jump
    expect(isParseError(cc.parseMove('d5-f7-h9', s, 'p0'))).toBe(true); // d5 is not a hole here
    expect(isParseError(cc.parseMove('m5-k7-k7', s, 'p0'))).toBe(true);
    expect(isParseError(cc.parseMove('#4', s, 'p0'))).toBe(true);
    // physically valid but rule-illegal endpoints parse and are rejected by apply
    const back = craft(2, { m5: 0, l4: 1 });
    const parsed = cc.parseMove('m5-k3', back, 'p0');
    expect(parsed).toBe('m5-k3');
    expect(isRuleError(cc.apply(back, 'p0', 'm5-k3', seed()))).toBe(true);
  });

  it('encode/decode round-trips exactly (hash equality)', () => {
    for (const n of [2, 3, 4, 6]) {
      const s = fresh(n);
      expect(decodeCc(encodeCc(s))).toEqual(s);
      expect(hashState(decodeCc(encodeCc(s)))).toBe(hashState(s));
    }
    const messy = craft(6, { m9: 3, a5: 1 }, {
      toMove: 4,
      round: 57,
      movesBy: [30, 12, 9, 9, 8, 8],
      forfeited: [true, false, false, false, false, false],
      lastMove: 'a5-c5',
      moveCount: 76,
    });
    expect(decodeCc(encodeCc(messy))).toEqual(messy);
    expect(hashState(decodeCc(encodeCc(messy)))).toBe(hashState(messy));
  });

  it('renderText shows the star, coordinates, legend and status', () => {
    const s = fresh(6);
    const text = cc.renderText(s, null);
    expect(text).toContain('a c e g i k m o q s u w y');
    expect(text).toContain(' 1  ');
    expect(text).toContain('17  ');
    for (const d of ['0', '1', '2', '3', '4', '5']) expect(text).toContain(d);
    expect(text).toContain('legend: 0 = p0 (home N, goal S: 0/10)');
    expect(text).toContain('status: p0 to move — round 1/200');
  });
});

describe('chinese checkers playouts (gates A1/A2 local)', () => {
  it('200 random 2p playouts terminate legally', { timeout: 600_000 }, () => {
    const stats = runPlayouts(cc, { games: 200, seedPrefix: 'cc-2p', players: 2 });
    expect(stats.games).toBe(200);
    for (const reason of Object.keys(stats.reasons)) {
      expect(['forfeit', 'turn_limit', 'goal']).toContain(reason);
    }
  });

  it('100 random 3p playouts terminate legally', { timeout: 600_000 }, () => {
    const stats = runPlayouts(cc, { games: 100, seedPrefix: 'cc-3p', players: 3 });
    expect(stats.games).toBe(100);
  });

  it('50 random 4p playouts terminate legally', { timeout: 600_000 }, () => {
    const stats = runPlayouts(cc, { games: 50, seedPrefix: 'cc-4p', players: 4 });
    expect(stats.games).toBe(50);
  });

  it('100 random 6p playouts terminate legally', { timeout: 600_000 }, () => {
    const stats = runPlayouts(cc, { games: 100, seedPrefix: 'cc-6p', players: 6 });
    expect(stats.games).toBe(100);
  });

  it('determinism at 2 and 6 players: identical seeds give identical hashes', () => {
    for (const n of [2, 6]) {
      const a = finalHashOfPlayout(cc, sha256Hex(`cc-det-${n}`), sha256Hex(`cc-pick-${n}`), n);
      const b = finalHashOfPlayout(cc, sha256Hex(`cc-det-${n}`), sha256Hex(`cc-pick-${n}`), n);
      expect(a.hash).toBe(b.hash);
      expect(a.moves).toBe(b.moves);
    }
  });
});
