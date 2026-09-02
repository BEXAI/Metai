/**
 * Gate A5 fixtures: hand-verified positions with exact legal-turn counts and
 * specific required turns — must-use-both-dice, larger-die-only, bar-entry
 * priority, bear-off exact/overshoot, doubles enumeration, dance, hitting,
 * gammon/backgammon scoring — plus notation, parsing, codec, and apply
 * rejection tests.
 */

import { describe, expect, it } from 'vitest';
import { hashState } from '../../../kernel/hash.ts';
import { createSeedStream } from '../../../kernel/seed.ts';
import { sha256Hex } from '../../../crypto/canonical.ts';
import { isParseError, isRuleError } from '../../../kernel/types.ts';
import backgammon from '../index.ts';
import { startingPoints, type BgMove, type BgState } from '../rules.ts';

const game = backgammon;

/** Builds a state from absolute points; off counts auto-derived (15 per side). */
function st(o: {
  p0?: Record<number, number>;
  p1?: Record<number, number>;
  bar?: [number, number];
  turn?: number;
  dice: number[];
  turnIndex?: number;
}): BgState {
  const points = new Array<number>(24).fill(0);
  let n0 = 0;
  let n1 = 0;
  for (const [p, c] of Object.entries(o.p0 ?? {})) {
    points[Number(p) - 1] = c;
    n0 += c;
  }
  for (const [p, c] of Object.entries(o.p1 ?? {})) {
    const i = Number(p) - 1;
    if (points[i] !== 0) throw new Error(`fixture point conflict at ${p}`);
    points[i] = -c;
    n1 += c;
  }
  const bar = o.bar ?? [0, 0];
  const off = [15 - n0 - bar[0], 15 - n1 - bar[1]];
  if (off[0]! < 0 || off[1]! < 0) throw new Error('fixture has more than 15 checkers');
  return {
    points,
    bar: bar.slice(),
    off,
    turn: o.turn ?? 0,
    dice: o.dice.slice(),
    turnIndex: o.turnIndex ?? 10,
    lastMove: null,
  };
}

function notations(state: BgState): string[] {
  return game
    .legalMoves(state, `p${state.turn}`)
    .map((m) => game.moveToNotation(m, state))
    .sort();
}

function seed(tag: string) {
  return createSeedStream(sha256Hex(`bg-fixture:${tag}`));
}

describe('backgammon enumeration fixtures (hand-verified)', () => {
  it('F1 must use both dice — order forced through the open route', () => {
    // p0: 24, 2. Dice 6-3. abs 21 blocked, 18/15 open; the 3 alone is unplayable
    // (2/-1 needs all home). Only 24/18 then 18/15 uses both dice.
    const s = st({
      p0: { 24: 1, 2: 1 },
      p1: { 21: 2, 19: 5, 20: 4, 17: 4 },
      dice: [6, 3],
    });
    expect(notations(s)).toEqual(['24/18 18/15']);
  });

  it('F2 only one die playable — the larger must be chosen', () => {
    // p0: lone checker on 24. 18 and 21 open but 15 blocked, so 6 and 3 are each
    // playable alone, never together => must play the 6: 24/18.
    const s = st({
      p0: { 24: 1 },
      p1: { 15: 2, 19: 5, 20: 4, 17: 4 },
      dice: [6, 3],
    });
    expect(notations(s)).toEqual(['24/18']);
  });

  it('F3 must use both — the only complete turn plays 6 then the 3 elsewhere', () => {
    // 21 and 15 blocked: 3-first via 24/21 impossible; after 24/18 the 3 must be 5/2.
    const s = st({
      p0: { 24: 1, 5: 1 },
      p1: { 21: 2, 15: 2, 19: 5, 20: 3, 17: 3 },
      dice: [6, 3],
    });
    expect(notations(s)).toEqual(['24/18 5/2']);
  });

  it('F4 doubles enumeration — 2-2 with checkers on 6 and 4: exactly 5 distinct turns', () => {
    // Chain flow 6 -> 4 -> 2 -> off; feasible (a,b,c) multisets of hops with
    // a+b+c=4: (0,2,2) (1,3,0) (1,2,1) (2,2,0) (2,1,1).
    const s = st({
      p0: { 6: 2, 4: 2 },
      p1: { 20: 5, 19: 5, 17: 5 },
      dice: [2, 2, 2, 2],
    });
    const got = notations(s);
    expect(got).toHaveLength(5);
    expect(got).toEqual(
      [
        '4/2(2) 2/off(2)',
        '6/4 4/2(3)',
        '6/4 4/2(2) 2/off',
        '6/4(2) 4/2(2)',
        '6/4(2) 4/2 2/off',
      ].sort(),
    );
  });

  it('F5 bar entry has absolute priority — second bar checker blocks everything else', () => {
    // Two on the bar, dice 5-3; the 5-entry (rel 20) is blocked. Only bar/22
    // enters; the second checker still on the bar freezes the 13-point spares.
    const s = st({
      p0: { 13: 3 },
      p1: { 20: 2, 19: 5, 24: 4, 23: 4 },
      bar: [2, 0],
      dice: [5, 3],
    });
    expect(notations(s)).toEqual(['bar/22']);
  });

  it('F5b bar entry with both dice — 4 distinct turns (routes are distinct by hop multiset)', () => {
    const s = st({
      p0: { 13: 1 },
      p1: { 19: 5, 23: 5, 24: 5 },
      bar: [1, 0],
      dice: [5, 3],
    });
    const got = notations(s);
    expect(got).toHaveLength(4);
    expect(got).toEqual(['bar/20 13/10', 'bar/20 20/17', 'bar/22 13/8', 'bar/22 22/17'].sort());
  });

  it('F6a bear-off exact and overshoot — dice 6-3 on 5,5,3: exactly 2 turns', () => {
    // 6 overshoots only from the highest point (5). The 3 either bears off the
    // 3-point exactly or moves 5/2.
    const s = st({
      p0: { 5: 2, 3: 1 },
      p1: { 19: 5, 20: 5, 17: 5 },
      dice: [6, 3],
    });
    expect(notations(s)).toEqual(['5/off 3/off', '5/off 5/2'].sort());
  });

  it('F6b doubles bear-off with overshoot ordering — only 3 of 4 sixes playable', () => {
    // 5,2,2: the 5 must come off before 2/off overshoots are legal; 1 turn, 3 hops.
    const s = st({
      p0: { 5: 1, 2: 2 },
      p1: { 19: 5, 20: 5, 17: 5 },
      dice: [6, 6, 6, 6],
    });
    expect(notations(s)).toEqual(['5/off 2/off(2)']);
  });

  it('F7 dance — both entry points blocked gives the explicit (no play) turn', () => {
    const s = st({
      p0: { 13: 2 },
      p1: { 19: 2, 22: 2, 24: 5, 23: 6 },
      bar: [1, 0],
      dice: [6, 3],
    });
    const legal = game.legalMoves(s, 'p0');
    expect(legal).toHaveLength(1);
    expect((legal[0] as BgMove).hops).toEqual([]);
    expect(game.moveToNotation(legal[0]!, s)).toBe('(no play)');

    // Applying the dance flips the turn without touching the board.
    const applied = game.apply(s, 'p0', legal[0]!, seed('dance'));
    expect(isRuleError(applied)).toBe(false);
    if (!isRuleError(applied)) {
      const ns = applied.state as BgState;
      expect(ns.turn).toBe(1);
      expect(ns.points).toEqual(s.points);
      expect(ns.bar).toEqual(s.bar);
      expect(ns.dice.length === 2 || ns.dice.length === 4).toBe(true);
    }
  });

  it('F8 overshoot forbidden while a higher point is occupied (die 5 on 4,2)', () => {
    // Dice 5-1, checkers on 4 and 2: 5 may bear off only from the 4 (highest).
    // 2/off with the 5 is illegal while the 4-point is occupied.
    const s = st({
      p0: { 4: 1, 2: 1 },
      p1: { 19: 5, 20: 5, 17: 5 },
      dice: [5, 1],
    });
    // 5: 4/off only. 1: 4/3, 2/1. Sequences: 4/off then 2/1 ; 4/3 then... 5 from 3? no
    // (2 occupied? highest is 3 -> 3/off legal!) — verify by enumeration:
    //   5 first: 4/off, then 1: 2/1  => {4/off, 2/1}
    //   1 first: 4/3, then 5: 3/off (3 is now highest) => {4/3, 3/off}
    //            2/1, then 5: 4/off => {2/1, 4/off} (duplicate of the first)
    const got = notations(s);
    expect(got).toEqual(['4/off 2/1', '4/3 3/off'].sort());
  });
});

describe('backgammon hitting', () => {
  it('hits a blot, sends it to the bar, and marks the notation with *', () => {
    const s = st({
      p0: { 13: 2 },
      p1: { 8: 1, 19: 5, 20: 5, 23: 4 },
      dice: [5, 3],
    });
    const legal = game.legalMoves(s, 'p0');
    const target = legal.find((m) => game.moveToNotation(m, s) === '13/8* 13/10');
    expect(target).toBeDefined();
    const applied = game.apply(s, 'p0', target!, seed('hit'));
    expect(isRuleError(applied)).toBe(false);
    if (!isRuleError(applied)) {
      const ns = applied.state as BgState;
      expect(ns.bar[1]).toBe(1); // p1 blot on the bar
      expect(ns.points[8 - 1]).toBe(1); // p0 owns the 8-point now
      expect(ns.points[10 - 1]).toBe(1);
      expect(ns.points[13 - 1]).toBe(0);
    }
  });
});

describe('backgammon scoring (gammon / backgammon multipliers)', () => {
  const bearOffLast = (p1Extra: { p1?: Record<number, number>; bar?: [number, number] }) => {
    const s = st({
      p0: { 1: 1 },
      p1: p1Extra.p1 ?? { 12: 14 },
      bar: p1Extra.bar ?? [0, 0],
      dice: [3, 1],
    });
    const legal = game.legalMoves(s, 'p0');
    expect(legal).toHaveLength(1); // larger-die rule: 1/off with the 3, one deduped turn
    expect(game.moveToNotation(legal[0]!, s)).toBe('1/off');
    const applied = game.apply(s, 'p0', legal[0]!, seed('score'));
    expect(isRuleError(applied)).toBe(false);
    if (isRuleError(applied)) throw new Error('unreachable');
    const result = game.isTerminal(applied.state);
    expect(result).not.toBeNull();
    return result!;
  };

  it('single game: loser has borne off at least one', () => {
    // p1: 14 on abs 12, 1 already off.
    const r = bearOffLast({ p1: { 12: 14 } });
    expect(r.winners).toEqual(['p0']);
    expect(r.reason).toBe('bearoff');
    expect(r.scores).toEqual({ p0: 1, p1: 0 });
  });

  it('gammon: loser bore off none', () => {
    const r = bearOffLast({ p1: { 12: 15 } });
    expect(r.reason).toBe('gammon');
    expect(r.scores).toEqual({ p0: 2, p1: 0 });
  });

  it("backgammon: loser bore off none with a checker in the winner's home", () => {
    const r = bearOffLast({ p1: { 12: 14, 3: 1 } });
    expect(r.reason).toBe('backgammon');
    expect(r.scores).toEqual({ p0: 3, p1: 0 });
  });

  it('backgammon: loser bore off none with a checker on the bar', () => {
    const r = bearOffLast({ p1: { 12: 14 }, bar: [0, 1] });
    expect(r.reason).toBe('backgammon');
    expect(r.scores).toEqual({ p0: 3, p1: 0 });
  });
});

describe('backgammon apply rejections', () => {
  it('rejects an incomplete turn when both dice are playable', () => {
    const s = st({
      p0: { 5: 2, 3: 1 },
      p1: { 19: 5, 20: 5, 17: 5 },
      dice: [6, 3],
    });
    const bad: BgMove = { hops: [{ from: 5, to: 0, die: 6 }] };
    const applied = game.apply(s, 'p0', bad, seed('incomplete'));
    expect(isRuleError(applied)).toBe(true);
    if (isRuleError(applied)) expect(applied.code).toBe('incomplete_turn');
  });

  it('rejects playing only the smaller die when the larger is required', () => {
    const s = st({
      p0: { 24: 1 },
      p1: { 15: 2, 19: 5, 20: 4, 17: 4 },
      dice: [6, 3],
    });
    const bad: BgMove = { hops: [{ from: 24, to: 21, die: 3 }] };
    const applied = game.apply(s, 'p0', bad, seed('smaller'));
    expect(isRuleError(applied)).toBe(true);
    if (isRuleError(applied)) expect(applied.code).toBe('incomplete_turn');
  });

  it('rejects moving a non-bar checker while on the bar, and wrong player', () => {
    const s = st({
      p0: { 13: 3 },
      p1: { 20: 2, 19: 5, 24: 4, 23: 4 },
      bar: [2, 0],
      dice: [5, 3],
    });
    const bad: BgMove = { hops: [{ from: 13, to: 8, die: 5 }] };
    const applied = game.apply(s, 'p0', bad, seed('barfirst'));
    expect(isRuleError(applied)).toBe(true);
    if (isRuleError(applied)) expect(applied.code).toBe('illegal_hop');

    const wrong = game.apply(s, 'p1', { hops: [] }, seed('wrongplayer'));
    expect(isRuleError(wrong)).toBe(true);
    if (isRuleError(wrong)) expect(wrong.code).toBe('not_your_turn');
  });

  it('accepts a legal turn regardless of which die is assigned to which hop', () => {
    // Dice 6-5, lone checkers on 2 and 1 (all home): '2/off 1/off' is ONE turn;
    // both die assignments produce the same board and must both be accepted.
    const s = st({ p0: { 2: 1, 1: 1 }, p1: { 19: 5, 20: 5, 17: 5 }, dice: [6, 5] });
    expect(notations(s)).toEqual(['2/off 1/off']);
    const alt: BgMove = { hops: [{ from: 2, to: 0, die: 5 }, { from: 1, to: 0, die: 6 }] };
    const applied = game.apply(s, 'p0', alt, seed('die-agnostic'));
    expect(isRuleError(applied)).toBe(false);
  });

  it('turn limit safety valve ends the game as a draw', () => {
    const s = st({ p0: { 6: 5, 13: 10 }, p1: { 19: 15 }, dice: [4, 2], turnIndex: 2000 });
    const r = game.isTerminal(s);
    expect(r).not.toBeNull();
    expect(r!.draw).toBe(true);
    expect(r!.reason).toBe('turn_limit');
    expect(game.legalMoves(s, 'p0')).toEqual([]);
  });

  it('legalMoves is empty for the player not on roll', () => {
    const s = st({ p0: { 6: 5, 13: 10 }, p1: { 19: 15 }, dice: [4, 2], turn: 0 });
    expect(game.legalMoves(s, 'p1')).toEqual([]);
  });
});

describe('backgammon notation and parsing', () => {
  it('parses parenthesized, expanded, and run forms to the same turn', () => {
    const s = st({
      p0: { 6: 2, 4: 2 },
      p1: { 20: 5, 19: 5, 17: 5 },
      dice: [2, 2, 2, 2],
    });
    const a = game.parseMove('6/4(2) 4/2(2)', s, 'p0');
    const b = game.parseMove('6/4 6/4 4/2 4/2', s, 'p0');
    expect(isParseError(a)).toBe(false);
    expect(isParseError(b)).toBe(false);
    expect(game.moveToNotation(a as BgMove, s)).toBe('6/4(2) 4/2(2)');
    expect(game.moveToNotation(b as BgMove, s)).toBe('6/4(2) 4/2(2)');
  });

  it('parses a run 24/18/15 as two hops', () => {
    const s = st({
      p0: { 24: 1, 2: 1 },
      p1: { 21: 2, 19: 5, 20: 4, 17: 4 },
      dice: [6, 3],
    });
    const m = game.parseMove('24/18/15', s, 'p0');
    expect(isParseError(m)).toBe(false);
    expect(game.moveToNotation(m as BgMove, s)).toBe('24/18 18/15');
  });

  it('parses bar/off endpoints and ignores hit stars', () => {
    const s = st({
      p0: { 13: 1 },
      p1: { 19: 5, 23: 5, 24: 5 },
      bar: [1, 0],
      dice: [5, 3],
    });
    const m = game.parseMove('bar/22 22/17', s, 'p0');
    expect(isParseError(m)).toBe(false);
    expect(game.moveToNotation(m as BgMove, s)).toBe('bar/22 22/17');

    const hitState = st({
      p0: { 13: 2 },
      p1: { 8: 1, 19: 5, 20: 5, 23: 4 },
      dice: [5, 3],
    });
    const hm = game.parseMove('13/8* 13/10', hitState, 'p0');
    expect(isParseError(hm)).toBe(false);
    expect(game.moveToNotation(hm as BgMove, hitState)).toBe('13/8* 13/10');
  });

  it('round-trips notation for every legal move in several fixtures', () => {
    const states = [
      st({ p0: { 24: 2, 13: 5, 8: 3, 6: 5 }, p1: { 1: 2, 12: 5, 17: 3, 19: 5 }, dice: [6, 5] }),
      st({ p0: { 5: 2, 3: 1 }, p1: { 19: 5, 20: 5, 17: 5 }, dice: [6, 3] }),
      st({ p0: { 6: 2, 4: 2 }, p1: { 20: 5, 19: 5, 17: 5 }, dice: [2, 2, 2, 2] }),
    ];
    for (const s of states) {
      for (const mv of game.legalMoves(s, 'p0')) {
        const n = game.moveToNotation(mv, s);
        const parsed = game.parseMove(n, s, 'p0');
        expect(isParseError(parsed)).toBe(false);
        expect(game.moveToNotation(parsed as BgMove, s)).toBe(n);
      }
    }
  });

  it('rejects the kernel index fallback and garbage', () => {
    const s = st({ p0: { 6: 5, 13: 10 }, p1: { 19: 15 }, dice: [4, 2] });
    expect(isParseError(game.parseMove('#3', s, 'p0'))).toBe(true);
    expect(isParseError(game.parseMove('flip the table', s, 'p0'))).toBe(true);
    expect(isParseError(game.parseMove('11/24', s, 'p0'))).toBe(true); // wrong direction
    expect(isParseError(game.parseMove('(no play)', s, 'p0'))).toBe(true); // dice are playable
  });

  it('moveSummary produces one short line', () => {
    const s = st({
      p0: { 13: 2 },
      p1: { 8: 1, 19: 5, 20: 5, 23: 4 },
      dice: [5, 3],
    });
    const mv = game.legalMoves(s, 'p0').find((m) => game.moveToNotation(m, s) === '13/8* 13/10')!;
    const line = game.moveSummary!(mv, s);
    expect(line).toContain('hitting 1 blot');
    expect(line.includes('\n')).toBe(false);
  });
});

describe('backgammon state codec and setup', () => {
  it('initialState is deterministic, has the standard layout and a sorted non-double roll', () => {
    const s1 = game.initialState(seed('open'), ['p0', 'p1'], {}) as BgState;
    const s2 = game.initialState(seed('open'), ['p0', 'p1'], {}) as BgState;
    expect(hashState(s1)).toBe(hashState(s2));
    expect(s1.points).toEqual(startingPoints());
    expect(s1.dice).toHaveLength(2);
    expect(s1.dice[0]!).toBeGreaterThan(s1.dice[1]!);
    expect([0, 1]).toContain(s1.turn);
    expect(s1.bar).toEqual([0, 0]);
    expect(s1.off).toEqual([0, 0]);
  });

  it('rejects unimplemented variants and wrong player counts', () => {
    expect(() => game.initialState(seed('v'), ['p0', 'p1'], { cube: true })).toThrow(/cube/);
    expect(() => game.initialState(seed('v'), ['p0', 'p1'], { matchTo: 5 })).toThrow(/match/);
    expect(() => game.initialState(seed('v'), ['p0'], {})).toThrow(/2 players/);
  });

  it('encodeState/decodeState round-trips exactly (hash equality)', () => {
    const states = [
      game.initialState(seed('codec'), ['p0', 'p1'], {}) as BgState,
      st({ p0: { 5: 2, 3: 1 }, p1: { 19: 5, 20: 5, 17: 5 }, dice: [6, 3], turnIndex: 42 }),
      st({ p0: { 13: 3 }, p1: { 20: 2, 19: 5, 24: 4, 23: 4 }, bar: [2, 0], dice: [5, 3] }),
    ];
    // Also one with lastMove set.
    const applied = game.apply(
      states[0]!,
      `p${states[0]!.turn}`,
      game.legalMoves(states[0]!, `p${states[0]!.turn}`)[0]!,
      seed('codec-apply'),
    );
    if (!isRuleError(applied)) states.push(applied.state as BgState);

    for (const s of states) {
      const rt = game.decodeState(game.encodeState(s));
      expect(hashState(rt)).toBe(hashState(s));
    }
  });

  it('apply rolls the next dice from the seed with purpose dice:turn:N', () => {
    const s = game.initialState(seed('roll'), ['p0', 'p1'], {}) as BgState;
    const sd = seed('roll-apply');
    const mover = `p${s.turn}`;
    const applied = game.apply(s, mover, game.legalMoves(s, mover)[0]!, sd);
    expect(isRuleError(applied)).toBe(false);
    if (!isRuleError(applied)) {
      const ns = applied.state as BgState;
      expect(ns.turn).toBe(1 - s.turn);
      expect(ns.turnIndex).toBe(1);
      expect(ns.dice.length === 2 || ns.dice.length === 4).toBe(true);
      const purposes = sd.draws().map((d) => d.purpose);
      expect(purposes).toContain('dice:turn:1');
    }
  });

  it('renderText shows coordinates, bar/off/pips, legend, and respects the viewer perspective', () => {
    const s = game.initialState(seed('render'), ['p0', 'p1'], {}) as BgState;
    const asP0 = game.renderText(s, 'p0');
    const asP1 = game.renderText(s, 'p1');
    const spec = game.renderText(s, null);
    for (const r of [asP0, asP1, spec]) {
      expect(r).toContain('BAR');
      expect(r).toContain('13');
      expect(r).toContain('Pips:');
      expect(r).toContain('Off:');
      expect(r).toContain('Legend:');
    }
    expect(asP0).toContain('you (p0)');
    expect(asP1).toContain('you (p1)');
    expect(spec).toContain('X = p0');
    // Opening position is symmetric: both viewers see their own 24-point with 2 X checkers.
    expect(hashState(game.publicView(s))).toBe(hashState(game.privateView(s, 'p0')));
  });
});
