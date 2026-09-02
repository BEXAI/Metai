/**
 * RED TEAM red-team-rules — backgammon (spec
 * games.M2_large_boards_and_multiplayer.backgammon, acceptance A5).
 * Attacks: must-use-both-dice edge positions where only ONE ordering works,
 * larger-die rule, bar priority, bear-off overshoot legality, forged die
 * assignments, lazy/partial turns, and the turn-limit safety valve.
 *
 * States are crafted through the documented codec:
 *   bg1|turn|turnIndex|dice|bar(p0,p1)|off(p0,p1)|points(24 abs)|lastMove
 * points: + = p0 checkers, - = p1; p0 moves 24 -> 1 (abs = relative for p0).
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { isRuleError } from '../../src/kernel/types.ts';
import bg from '../../src/games/backgammon/index.ts';
import type { BgMove, BgState, Hop } from '../../src/games/backgammon/rules.ts';

const seed = () => createSeedStream(sha256Hex('redteam-rules-backgammon'));

function craft(opts: {
  turn?: number;
  dice: number[];
  bar?: [number, number];
  off?: [number, number];
  points: Record<number, number>; // absolute point -> signed count
  turnIndex?: number;
}): BgState {
  const pts = new Array<number>(24).fill(0);
  for (const [p, c] of Object.entries(opts.points)) pts[Number(p) - 1] = c;
  const enc = [
    'bg1',
    String(opts.turn ?? 0),
    String(opts.turnIndex ?? 5),
    opts.dice.join(','),
    (opts.bar ?? [0, 0]).join(','),
    (opts.off ?? [0, 0]).join(','),
    pts.join(','),
    '~',
  ].join('|');
  return bg.decodeState(enc) as BgState;
}

const turns = (st: BgState, p = 'p0'): BgMove[] => bg.legalMoves(st, p) as BgMove[];
const hopsOf = (m: BgMove): Hop[] => m.hops;

describe('must-use-both-dice when only one ORDERING allows it', () => {
  it('the small die must be played first when the big-die-first route dead-ends', () => {
    // p0 lone runner on 24; 18 is blocked (kills 24/18 with the 6) and 14 is
    // blocked (kills 19/14 with the 5 after 24/19). Only 24/19 (5) then 19/13
    // (6) uses both dice; every legal turn must be that full sequence.
    const st = craft({
      dice: [6, 5],
      points: { 24: 1, 18: -2, 14: -2, 1: -11, 6: 14 },
    });
    const lm = turns(st);
    expect(lm).toHaveLength(1);
    expect(hopsOf(lm[0]!).map((h) => `${h.from}/${h.to}`)).toEqual(['24/19', '19/13']);
    // the lazy single hop is an incomplete turn
    const lazy = bg.apply(st, 'p0', { hops: [{ from: 24, to: 19, die: 5 }] }, seed());
    expect(isRuleError(lazy)).toBe(true);
    if (isRuleError(lazy)) expect(lazy.code).toBe('incomplete_turn');
  });

  it('doubles: all four dice must be used when any line allows it', () => {
    // 2-2 with p0 checkers on 24 and lots of open board: every turn has 4 hops.
    const st = craft({ dice: [2, 2, 2, 2], points: { 24: 2, 13: 5, 8: 3, 6: 5, 1: -2, 12: -5, 17: -3, 19: -5 } });
    for (const m of turns(st)) expect(hopsOf(m)).toHaveLength(4);
    const three = bg.apply(
      st,
      'p0',
      { hops: [{ from: 24, to: 22, die: 2 }, { from: 22, to: 20, die: 2 }, { from: 20, to: 18, die: 2 }] },
      seed(),
    );
    expect(isRuleError(three)).toBe(true);
  });
});

describe('larger-die rule', () => {
  it('when either die could be played alone but not both, the LARGER is forced', () => {
    // p0 lone checker on 24. 19 (via 5) and 18 (via 6) are both open, but both
    // continuations are blocked: 13 blocked kills 19-6 and 18-5; 12? craft:
    // block 13 (19/13 with 6 AND 18/13 with 5). Then max length is 1 and both
    // dice are individually playable -> only 24/18 (die 6) is legal.
    const st = craft({ dice: [6, 5], points: { 24: 1, 13: -2, 1: -13, 6: 14 } });
    const lm = turns(st);
    expect(lm).toHaveLength(1);
    expect(hopsOf(lm[0]!)).toEqual([{ from: 24, to: 18, die: 6 }]);
    const smaller = bg.apply(st, 'p0', { hops: [{ from: 24, to: 19, die: 5 }] }, seed());
    expect(isRuleError(smaller)).toBe(true);
  });

  it('when ONLY the smaller die has any play, playing it is legal', () => {
    // 24/18 blocked, 24/19 open, and after 24/19 the 6 has no move either
    // (19/13 blocked, no other checkers).
    const st = craft({ dice: [6, 5], points: { 24: 1, 18: -2, 13: -2, 1: -11, 6: 14 } });
    const lm = turns(st);
    expect(lm).toHaveLength(1);
    expect(hopsOf(lm[0]!)).toEqual([{ from: 24, to: 19, die: 5 }]);
  });
});

describe('bar priority', () => {
  it('with a checker on the bar, every legal turn starts from the bar and board hops alone are rejected', () => {
    const st = craft({ dice: [6, 3], bar: [1, 0], points: { 13: 5, 8: 3, 6: 6, 19: -2, 1: -2, 12: -5, 17: -3, 5: -3 } });
    // entry with 6 -> rel 19 blocked (theirs), entry with 3 -> rel 22 open.
    for (const m of turns(st)) {
      expect(hopsOf(m)[0]!.from).toBe(25);
      expect(hopsOf(m)[0]!.die).toBe(3);
    }
    const sneak = bg.apply(st, 'p0', { hops: [{ from: 13, to: 7, die: 6 }] }, seed());
    expect(isRuleError(sneak)).toBe(true);
  });

  it('fully closed board: the explicit dance is the only move; a fake hop is rejected', () => {
    const st = craft({
      dice: [6, 3],
      bar: [1, 0],
      points: { 19: -2, 20: -2, 21: -2, 22: -2, 23: -2, 24: -2, 13: 5, 8: 3, 6: 6, 1: -3 },
    });
    const lm = turns(st);
    expect(lm).toEqual([{ hops: [] }]);
    const r = bg.apply(st, 'p0', { hops: [] }, seed());
    expect(isRuleError(r)).toBe(false);
    const fake = bg.apply(st, 'p0', { hops: [{ from: 25, to: 19, die: 6 }] }, seed());
    expect(isRuleError(fake)).toBe(true);
  });

  it('a dance submitted while real moves exist is an incomplete turn', () => {
    const st = bg.initialState(seed(), ['p0', 'p1'], {}) as BgState;
    const mover = bg.playersToMove(st)[0]!;
    const r = bg.apply(st, mover, { hops: [] }, seed());
    expect(isRuleError(r)).toBe(true);
    if (isRuleError(r)) expect(r.code).toBe('incomplete_turn');
  });
});

describe('bear-off legality', () => {
  it('no bear-off while any checker is outside the home board', () => {
    // The straggler on 13 cannot reach home with either die (13-6=7, 13-5=8),
    // so NO legal turn may contain a bear-off hop. (If the straggler could
    // come home mid-turn, bearing off with the remaining die would be legal —
    // that variant is covered below.)
    const st = craft({ dice: [6, 5], points: { 13: 1, 6: 2, 5: 2, 4: 2, 3: 2, 2: 2, 1: 3, 24: -2, 19: -8, 12: -5 } });
    for (const m of turns(st)) for (const h of hopsOf(m)) expect(h.to).not.toBe(0);
    const cheat = bg.apply(st, 'p0', { hops: [{ from: 6, to: 0, die: 6 }, { from: 13, to: 8, die: 5 }] }, seed());
    expect(isRuleError(cheat)).toBe(true);
  });

  it('a straggler that comes home mid-turn unlocks bear-off for the SECOND die only', () => {
    // Checker on 7 with dice 6-5: 7/1 (6) brings everything home, then 5/off
    // is legal. But bearing off FIRST (before the straggler is home) is not.
    const st = craft({ dice: [6, 5], points: { 7: 1, 6: 2, 5: 2, 4: 2, 3: 2, 2: 2, 1: 4, 24: -2, 13: -5, 19: -8 } });
    const withOff = turns(st).filter((m) => hopsOf(m).some((h) => h.to === 0));
    expect(withOff.length).toBeGreaterThan(0);
    for (const m of withOff) {
      // in every such turn the 7-point hop precedes the bear-off
      const hs = hopsOf(m);
      const homeIdx = hs.findIndex((h) => h.from === 7);
      const offIdx = hs.findIndex((h) => h.to === 0);
      expect(homeIdx).toBeGreaterThanOrEqual(0);
      expect(homeIdx).toBeLessThan(offIdx);
    }
  });

  it('no bear-off while a checker sits on the bar (even with the rest home)', () => {
    const st = craft({ dice: [6, 2], bar: [1, 0], points: { 6: 7, 5: 7, 19: -2, 12: -5, 1: -2, 17: -3, 20: -3 } });
    for (const m of turns(st)) for (const h of hopsOf(m)) expect(h.to).not.toBe(0);
  });

  it('overshoot bear-off only from the highest occupied point', () => {
    // checkers on 4 and 2, die 5-3: 4/off with the 5 is legal (4 is highest);
    // 2/off with the 5 while 4 is occupied is NOT.
    const st = craft({ dice: [5, 3], off: [11, 0], points: { 4: 2, 2: 2, 24: -2, 13: -5, 19: -8 } });
    const cheat = bg.apply(st, 'p0', { hops: [{ from: 2, to: 0, die: 5 }, { from: 4, to: 1, die: 3 }] }, seed());
    expect(isRuleError(cheat)).toBe(true);
    const fine = bg.apply(st, 'p0', { hops: [{ from: 4, to: 0, die: 5 }, { from: 4, to: 1, die: 3 }] }, seed());
    expect(isRuleError(fine)).toBe(false);
  });

  it('forged die assignment is rejected even when the (from,to) pair looks plausible', () => {
    // 6/off costs the 6 (exact); claiming it used the 5 must fail.
    const st = craft({ dice: [6, 5], off: [13, 0], points: { 6: 1, 5: 1, 24: -2, 13: -5, 19: -8 } });
    const forged = bg.apply(st, 'p0', { hops: [{ from: 6, to: 0, die: 5 }, { from: 5, to: 0, die: 6 }] }, seed());
    expect(isRuleError(forged)).toBe(true);
    const honest = bg.apply(st, 'p0', { hops: [{ from: 6, to: 0, die: 6 }, { from: 5, to: 0, die: 5 }] }, seed());
    expect(isRuleError(honest)).toBe(false);
  });

  it('a die may not be used twice', () => {
    const st = craft({ dice: [6, 3], points: { 24: 2, 13: 5, 8: 3, 6: 5, 1: -2, 12: -5, 17: -3, 19: -5 } });
    const twice = bg.apply(st, 'p0', { hops: [{ from: 13, to: 10, die: 3 }, { from: 8, to: 5, die: 3 }] }, seed());
    expect(isRuleError(twice)).toBe(true);
  });
});

describe('scoring and the turn-limit safety valve (attack family 2)', () => {
  it('gammon and backgammon multipliers are exact', () => {
    // p0 has borne all 15 off; p1 bore off none and has a checker in p0's home.
    const gammonSt = craft({ dice: [], off: [15, 0], points: { 12: -10, 17: -5 }, turn: 1 });
    const g = bg.isTerminal(gammonSt);
    expect(g?.scores).toEqual({ p0: 2, p1: 0 });
    expect(g?.reason).toBe('gammon');

    const bgSt = craft({ dice: [], off: [15, 0], points: { 3: -1, 12: -9, 17: -5 }, turn: 1 });
    const b = bg.isTerminal(bgSt);
    expect(b?.scores).toEqual({ p0: 3, p1: 0 });
    expect(b?.reason).toBe('backgammon');

    const barSt = craft({ dice: [], off: [15, 0], bar: [0, 1], points: { 12: -9, 17: -5 }, turn: 1 });
    expect(bg.isTerminal(barSt)?.reason).toBe('backgammon');

    const single = craft({ dice: [], off: [15, 3], points: { 12: -7, 17: -5 }, turn: 1 });
    const s = bg.isTerminal(single);
    expect(s?.scores).toEqual({ p0: 1, p1: 0 });
    expect(s?.reason).toBe('bearoff');
  });

  it('turnIndex at the limit is a draw with reason turn_limit', () => {
    const st = craft({ dice: [6, 5], turnIndex: 2000, points: { 24: 2, 13: 5, 8: 3, 6: 5, 1: -2, 12: -5, 17: -3, 19: -5 } });
    const t = bg.isTerminal(st);
    expect(t?.draw).toBe(true);
    expect(t?.reason).toBe('turn_limit');
    expect(bg.playersToMove(st)).toEqual([]);
  });
});

describe('apply robustness', () => {
  it('malformed hop lists return RuleError, never throw', () => {
    const st = bg.initialState(seed(), ['p0', 'p1'], {}) as BgState;
    const mover = bg.playersToMove(st)[0]!;
    for (const bad of [
      null,
      'hello',
      { hops: 'no' },
      { hops: [{ from: 'x', to: 1, die: 1 }] },
      { hops: [{ from: 26, to: 20, die: 6 }] },
      { hops: [{ from: 24, to: 18, die: 99 }] },
      { hops: [{ from: 24.5, to: 18, die: 6 }] },
    ]) {
      let out: unknown;
      expect(() => {
        out = bg.apply(st, mover, bad as never, seed());
      }).not.toThrow();
      expect(isRuleError(out)).toBe(true);
    }
  });
});
