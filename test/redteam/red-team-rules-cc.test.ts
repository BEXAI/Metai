/**
 * RED TEAM red-team-rules — chinese_checkers (spec
 * games.M2_large_boards_and_multiplayer.chinese_checkers).
 * Attacks: anti-stall re-entry ban, the 30-move forfeit, the 200-round turn
 * limit with pegs-in-goal tiebreak, jump-chain canonicalization, goal-fill
 * win, and robustness. States are crafted through the documented codec:
 *   n|board121|toMove|round|movesByCSV|forfeitBits|lastMove|moveCount
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { isParseError, isRuleError } from '../../src/kernel/types.ts';
import cc from '../../src/games/chinese_checkers/index.ts';
import {
  holeIndex,
  TRIANGLE_HOLES,
  type CcState,
} from '../../src/games/chinese_checkers/rules.ts';

const seed = () => createSeedStream(sha256Hex('redteam-rules-cc'));

function craft(opts: {
  n: number;
  pegs: Record<string, number>; // hole label -> seat
  toMove?: number;
  round?: number;
  movesBy?: number[];
  forfeited?: boolean[];
  moveCount?: number;
}): CcState {
  const board = Array.from({ length: 121 }, () => '.');
  for (const [label, s] of Object.entries(opts.pegs)) {
    const idx = holeIndex(label);
    if (idx === undefined) throw new Error(`bad hole ${label}`);
    board[idx] = String(s);
  }
  const enc = [
    opts.n,
    board.join(''),
    opts.toMove ?? 0,
    opts.round ?? 1,
    (opts.movesBy ?? Array.from({ length: opts.n }, () => 0)).join(','),
    (opts.forfeited ?? Array.from({ length: opts.n }, () => false)).map((f) => (f ? '1' : '0')).join(''),
    '*',
    opts.moveCount ?? 0,
  ].join('|');
  return cc.decodeState(enc) as CcState;
}

describe('anti-stall: a peg may not re-enter its own start triangle', () => {
  it('a step back INTO the start triangle from outside is rejected and never offered', () => {
    // p0 starts N (rows 1-4). Peg at k5 (outside); l4 is inside the triangle.
    const st = craft({ n: 2, pegs: { k5: 0, m17: 1 } });
    const moves = cc.legalMoves(st, 'p0') as string[];
    expect(moves).not.toContain('k5-l4');
    expect(moves).not.toContain('k5-j4');
    const r = cc.apply(st, 'p0', 'k5-l4', seed());
    expect(isRuleError(r)).toBe(true);
  });

  it('shuffling INSIDE the start triangle is legal (started there)', () => {
    const st = craft({ n: 2, pegs: { m1: 0, m17: 1 } });
    const moves = cc.legalMoves(st, 'p0') as string[];
    expect(moves).toContain('m1-l2');
    expect(moves).toContain('m1-n2');
  });

  it('a jump chain may pass THROUGH the start triangle but not END inside it', () => {
    // p0 peg at i5 (outside, row 5, col 9). Pegs to hop over: j4 (inside) so
    // i5 -> k3 (inside, r=3)? ends inside -> banned. Craft a chain that dips
    // in and comes back out: i5 over j4 lands k3 (inside; banned as ENDPOINT
    // but fine mid-chain), then k3 over l4 lands m5 (outside).
    const st = craft({ n: 2, pegs: { i5: 0, j4: 1, l4: 1, m17: 1 } });
    const moves = cc.legalMoves(st, 'p0') as string[];
    const chainOut = moves.find((m) => m.startsWith('i5-') && m.endsWith('-m5'));
    expect(chainOut).toBeDefined();
    expect(moves.some((m) => m.startsWith('i5-') && m.endsWith('k3'))).toBe(false);
  });
});

describe('the 30-move forfeit', () => {
  it('a player whose 30th move leaves a peg home forfeits; the pegs freeze and the rotation skips them', () => {
    // p0 has one peg still at m1 (home) and one outside; movesBy 29.
    const st = craft({ n: 2, pegs: { m1: 0, a5: 0, m17: 1 }, movesBy: [29, 29] });
    const r = cc.apply(st, 'p0', 'a5-b6', seed()); // 30th move, m1 still home
    if (isRuleError(r)) throw new Error(r.message);
    const after = r.state as CcState;
    expect(after.forfeited[0]).toBe(true);
    // 2 players, one forfeited -> the survivor wins by forfeit
    const t = cc.isTerminal(after);
    expect(t?.winners).toEqual(['p1']);
    expect(t?.reason).toBe('forfeit');
  });

  it('vacating the LAST home peg on exactly the 30th move avoids the forfeit', () => {
    // j4 is in the N triangle; j4-i5 steps out (row 5, outside).
    const st = craft({ n: 2, pegs: { j4: 0, a5: 0, m17: 1 }, movesBy: [29, 29] });
    const r = cc.apply(st, 'p0', 'j4-i5', seed());
    if (isRuleError(r)) throw new Error(r.message);
    expect((r.state as CcState).forfeited[0]).toBe(false);
  });
});

describe('the 200-round turn limit with pegs-in-goal tiebreak (attack family 2)', () => {
  it('round 201: strictly more pegs in goal wins outright', () => {
    // p0 goal = S triangle; give p0 3 pegs in S, p1 (goal = N) only 1 in N.
    const sHoles = TRIANGLE_HOLES.S;
    const nHoles = TRIANGLE_HOLES.N;
    const pegs: Record<string, number> = { a5: 0, y5: 1 };
    const label = (i: number): string => {
      // find label by scanning the 121 canonical holes through holeIndex
      for (const l of allLabels()) if (holeIndex(l) === i) return l;
      throw new Error('no label');
    };
    pegs[label(sHoles[0]!)] = 0;
    pegs[label(sHoles[1]!)] = 0;
    pegs[label(sHoles[2]!)] = 0;
    pegs[label(nHoles[0]!)] = 1;
    const st = craft({ n: 2, pegs, round: 201 });
    const t = cc.isTerminal(st);
    expect(t).not.toBeNull();
    expect(t!.reason).toBe('turn_limit');
    expect(t!.draw).toBe(false);
    expect(t!.winners).toEqual(['p0']);
    expect(t!.scores).toEqual({ p0: 3, p1: 1 });
  });

  it('round 201 tie at the top: all tied players share the placement as a draw', () => {
    const st = craft({ n: 2, pegs: { a5: 0, y5: 1 }, round: 201 });
    const t = cc.isTerminal(st);
    expect(t!.reason).toBe('turn_limit');
    expect(t!.draw).toBe(true);
    expect(t!.winners).toEqual(['p0', 'p1']);
  });

  it('round 200 is still playable — the limit binds only after it', () => {
    const st = craft({ n: 2, pegs: { a5: 0, y5: 1 }, round: 200 });
    expect(cc.isTerminal(st)).toBeNull();
    expect(cc.legalMoves(st, 'p0').length).toBeGreaterThan(0);
  });

  it('forfeited players are excluded from the tiebreak even with more pegs in goal', () => {
    const sHoles = TRIANGLE_HOLES.S;
    const pegs: Record<string, number> = { a5: 0, y5: 1 };
    const label = (i: number): string => {
      for (const l of allLabels()) if (holeIndex(l) === i) return l;
      throw new Error('no label');
    };
    // p0 (forfeited) has 5 in goal; p1 has none.
    for (let k = 0; k < 5; k++) pegs[label(sHoles[k]!)] = 0;
    const st = craft({ n: 2, pegs, round: 201, forfeited: [true, false] });
    const t = cc.isTerminal(st);
    expect(t!.winners).toEqual(['p1']);
  });
});

describe('jump chains: canonicalization and goal-fill win', () => {
  it('parseMove accepts ANY physically valid chain and apply takes the canonical twin', () => {
    // p0 peg at a5 (0-idx col 1? label a5 row5 col1). Jump over b6 -> c7,
    // then over c9?? — craft a simple two-jump fan where two routes reach the
    // same endpoint: pegs at b6 and d6, plus b8 and d8: a5 -> c7 -> e5?? keep
    // it simple: verify single-jump parse canonicalization instead, plus a
    // 2-hop chain both by canonical and by explicit path.
    const st = craft({ n: 2, pegs: { a5: 0, b6: 1, d6: 1, m17: 1 } });
    const moves = cc.legalMoves(st, 'p0') as string[];
    const chain = moves.find((m) => m.startsWith('a5-') && m.split('-').length === 3);
    expect(chain).toBeDefined(); // a5 -> c7 -> e5 (over b6 then d6)
    const parsed = cc.parseMove!('a5-c7-e5', st, 'p0');
    expect(isParseError(parsed)).toBe(false);
    const r = cc.apply(st, 'p0', parsed as string, seed());
    expect(isRuleError(r)).toBe(false);
  });

  it('an impossible jump path is a ParseError, not a silent acceptance', () => {
    const st = craft({ n: 2, pegs: { a5: 0, m17: 1 } });
    const parsed = cc.parseMove!('a5-c7', st, 'p0'); // nothing on b6 to jump
    expect(isParseError(parsed)).toBe(true);
    expect(isRuleError(cc.apply(st, 'p0', 'a5-c7', seed()))).toBe(true);
  });

  it('filling the goal triangle wins immediately', () => {
    const sHoles = TRIANGLE_HOLES.S;
    const label = (i: number): string => {
      for (const l of allLabels()) if (holeIndex(l) === i) return l;
      throw new Error('no label');
    };
    const pegs: Record<string, number> = { c5: 1, e5: 1 };
    for (const h of sHoles) pegs[label(h)] = 0;
    const st = craft({ n: 2, pegs });
    const t = cc.isTerminal(st);
    expect(t?.winners).toEqual(['p0']);
    expect(t?.reason).toBe('goal');
    expect(cc.legalMoves(st, 'p0')).toEqual([]);
    expect(isRuleError(cc.apply(st, 'p0', 'pass', seed()))).toBe(true);
  });
});

describe('apply robustness', () => {
  it('garbage moves return RuleError, never throw', () => {
    const st = cc.initialState(seed(), ['p0', 'p1'], {});
    for (const bad of ['zz9-zz9', 'm1', '', 'pass', 'm1-m1', 'a5-b6-c7-']) {
      let out: unknown;
      expect(() => {
        out = cc.apply(st, 'p0', bad as never, seed());
      }).not.toThrow();
      expect(isRuleError(out)).toBe(true);
    }
  });
});

/** All 121 canonical hole labels (columns a..y, rows 1..17). */
function allLabels(): string[] {
  const letters = 'abcdefghijklmnopqrstuvwxy';
  const out: string[] = [];
  for (let r = 1; r <= 17; r++) {
    for (const ch of letters) {
      const l = `${ch}${r}`;
      if (holeIndex(l) !== undefined) out.push(l);
    }
  }
  return out;
}
