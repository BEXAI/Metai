/**
 * Hand-verified fixtures for candidate "b" backgammon complete-turn enumerator.
 *
 * Every fixture is a full 15-vs-15 checker position (the mkPos helper throws if
 * totals are wrong) with a board diagram, drawn from the MOVER's perspective:
 * the mover (X) moves from point 24 toward point 1 and bears off from 1-6; the
 * opponent is O. Diagram rows: top = points 24..13, bottom = points 12..1.
 *
 * Conventions asserted throughout:
 *   - hop strings 'from/to', from in 24..1|'bar', to in 24..1|'off'
 *   - each turn canonically ordered by descending from-point ('bar' = 25),
 *     ties by descending to-point ('off' = 0)
 *   - turn list sorted by the same comparator applied hop-by-hop
 *   - dance (no legal hop with either die) returns [] — NOT [[]]
 *   - hits carry no annotation; landing on an opponent blot always hits
 */
import { describe, expect, it } from 'vitest';
import { legalTurns, type BgPos } from '../b.ts';

/** Build a BgPos from sparse per-point counts; enforces 15 checkers per side. */
function mkPos(opts: {
  mover?: Record<number, number>;
  opp?: Record<number, number>;
  bar?: [number, number];
  off?: [number, number];
}): BgPos {
  const points: number[] = new Array<number>(24).fill(0);
  const bar: [number, number] = opts.bar ?? [0, 0];
  const off: [number, number] = opts.off ?? [0, 0];
  let mover = bar[0] + off[0];
  let opp = bar[1] + off[1];
  for (const [pStr, n] of Object.entries(opts.mover ?? {})) {
    const p = Number(pStr);
    if (!Number.isInteger(p) || p < 1 || p > 24) throw new Error(`bad point ${pStr}`);
    points[p - 1] = n;
    mover += n;
  }
  for (const [pStr, n] of Object.entries(opts.opp ?? {})) {
    const p = Number(pStr);
    if (!Number.isInteger(p) || p < 1 || p > 24) throw new Error(`bad point ${pStr}`);
    if ((points[p - 1] ?? 0) !== 0) throw new Error(`point ${pStr} assigned to both sides`);
    points[p - 1] = -n;
    opp += n;
  }
  if (mover !== 15 || opp !== 15) {
    throw new Error(`checker totals mover=${mover} opp=${opp}; fixtures must be 15/15`);
  }
  return { points, bar, off };
}

describe('legalTurns — hand-verified fixtures', () => {
  it('fixture 1: standard opening position, dice [3,1] — all 19 distinct turns, exact', () => {
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    // X2   .   .   .   .  O5 |  .  O3   .   .   .  X5
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    // O5   .   .   .  X3   . | X5   .   .   .   .  O2
    // Both dice always playable (maxLen 2). Die 3 plays: 24/21 13/10 8/5 6/3;
    // die 1 plays: 24/23 8/7 6/5 (13/12 blocked by O5). 4x3 = 12 two-checker
    // combos plus 7 same-checker combos (21/20, 10/9, 5/4, 3/2 after the 3;
    // 23/20, 7/4, 5/2 after the 1) = 19 distinct hop multisets.
    const p = mkPos({
      mover: { 24: 2, 13: 5, 8: 3, 6: 5 },
      opp: { 19: 5, 17: 3, 12: 5, 1: 2 },
    });
    expect(legalTurns(p, [3, 1])).toEqual([
      ['24/23', '24/21'],
      ['24/23', '23/20'],
      ['24/23', '13/10'],
      ['24/23', '8/5'],
      ['24/23', '6/3'],
      ['24/21', '21/20'],
      ['24/21', '8/7'],
      ['24/21', '6/5'],
      ['13/10', '10/9'],
      ['13/10', '8/7'],
      ['13/10', '6/5'],
      ['8/7', '8/5'],
      ['8/7', '7/4'],
      ['8/7', '6/3'],
      ['8/5', '6/5'],
      ['8/5', '5/4'],
      ['6/5', '6/3'],
      ['6/5', '5/2'],
      ['6/3', '3/2'],
    ]);
  });

  it('fixture 2: classic must-use-both block — the tempting 2 kills the 6, so it is illegal', () => {
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    // X1   .   .   .   .   . | O2   .  O2   .   .  X2
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    //  .   .   .   .   .  O2 | X12  .  O2   .   .  O7
    // Dice [6,2]. Die 6 has no play at all from the start (24/18 and 13/7
    // blocked; no bear-off with checkers on 24/13). Die 2 has two plays:
    // 24/22 and 13/11. Playing 24/22 strands the 6 (22/16 blocked) for a
    // 1-hop turn, but 13/11 unlocks 11/5 — a full 2-hop sequence exists, so
    // the mover MUST play 13/11 11/5. The 24/22 play must not appear.
    const p = mkPos({
      mover: { 24: 1, 13: 2, 6: 12 },
      opp: { 18: 2, 16: 2, 7: 2, 4: 2, 1: 7 },
    });
    expect(legalTurns(p, [6, 2])).toEqual([['13/11', '11/5']]);
  });

  it('fixture 3: larger-die forcing — either die playable alone, never both; the 6 must be played', () => {
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    // X1   .   .   .   .   . |  .   .   .  O2   .   .
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    //  .   .   .   .   .   . |  .   .   .   .  X14 O13
    // Dice [6,3]. Only the 24-checker can move (the 2-point stack cannot: no
    // bear-off while 24 is occupied). 24/18 (die 6) and 24/21 (die 3) are both
    // individually legal, but 18/15 and 21/15 are blocked, so both dice can
    // never be played. Rule: the LARGER die must be used -> only 24/18.
    const p = mkPos({
      mover: { 24: 1, 2: 14 },
      opp: { 15: 2, 1: 13 },
    });
    expect(legalTurns(p, [6, 3])).toEqual([['24/18']]);
  });

  it('fixture 4: smaller die only — the larger die has no play anywhere, so the 3 is played', () => {
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    // X1   .   .   .   .   . | O2   .   .  O2   .   .
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    //  .   .   .   .   .   . |  .   .   .   .  X14 O11
    // Dice [6,3]. Die 6: 24/18 blocked, nothing else -> unplayable. Die 3:
    // 24/21 legal, then 21/15 blocked. maxLen 1 with only the smaller die
    // available -> [24/21] (larger-die rule does not apply when the larger
    // die has no legal play).
    const p = mkPos({
      mover: { 24: 1, 2: 14 },
      opp: { 18: 2, 15: 2, 1: 11 },
    });
    expect(legalTurns(p, [6, 3])).toEqual([['24/21']]);
  });

  it('fixture 5: bar entry with one entry blocked — enter on the blot (hit), then play the 6', () => {
    // bar: X1
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    //  .   .   .  O1   .  O2 |  .   .   .   .   .  X2
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    //  .   .   .   .   .   . | X12  .   .   .   .  O12
    // Dice [6,4]. Entry with the 6 would be 25-6 = 19: blocked. Entry with the
    // 4 is 25-4 = 21: an opponent blot -> bar/21 hits (no annotation). Then the
    // 6 plays 21/15 or 13/7 (6/off impossible: not all checkers home).
    const p = mkPos({
      mover: { 13: 2, 6: 12 },
      opp: { 21: 1, 19: 2, 1: 12 },
      bar: [1, 0],
    });
    expect(legalTurns(p, [6, 4])).toEqual([
      ['bar/21', '21/15'],
      ['bar/21', '13/7'],
    ]);
  });

  it('fixture 6: dance — both entry points blocked with two checkers on the bar -> []', () => {
    // bar: X2
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    //  .   .  O2   .  O2   . |  .   .   .   .   .   .
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    //  .   .   .   .   .   . | X13  .   .   .   .  O11
    // Dice [3,5]. Entries would be 25-3 = 22 and 25-5 = 20, both blocked.
    // No hop is legal with either die: the result is the empty list []
    // (meaning "no legal turn / dance"), NOT [[]].
    const p = mkPos({
      mover: { 6: 13 },
      opp: { 22: 2, 20: 2, 1: 11 },
      bar: [2, 0],
    });
    expect(legalTurns(p, [3, 5])).toEqual([]);
  });

  it('fixture 7: doubles with limited material — only 2 of the 4 sixes can be played', () => {
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    // X2   .   .   .   .   . |  .   .   .   .   .   .
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    // O2   .   .   .   .   . |  .   .   .  X13  .  O13
    // Dice [6,6]. Both 24-checkers run to 18; from 18 the next 6 (18/12) is
    // blocked, and the 3-point stack cannot move (no bear-off: checkers on
    // 18). Exactly two sixes are playable -> the unique maximal turn.
    const p = mkPos({
      mover: { 24: 2, 3: 13 },
      opp: { 12: 2, 1: 13 },
    });
    expect(legalTurns(p, [6, 6])).toEqual([['24/18', '24/18']]);
  });

  it('fixture 8: doubles, bar entry first with a hit, all four hops forced in a chain', () => {
    // bar: X1
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    //  .  O1   .   .   .   . |  .   .   .   .   .   .
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    //  .   .   .   .   .   . | X14  .  O2   .   .  O12
    // Dice [2,2]. Must enter first: bar/23 (25-2 = 23) hits the blot. The
    // 6-point stack is frozen (6/4 blocked), so the entered checker walks:
    // 23/21, 21/19, 19/17. One forced 4-hop turn.
    const p = mkPos({
      mover: { 6: 14 },
      opp: { 23: 1, 4: 2, 1: 12 },
      bar: [1, 0],
    });
    expect(legalTurns(p, [2, 2])).toEqual([['bar/23', '23/21', '21/19', '19/17']]);
  });

  it('fixture 9: bear-off — exact die vs illegal overshoot while a higher point is occupied', () => {
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    // O2  O2  O2  O2  O2  O2 | O3   .   .   .   .   .
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    //  .   .   .   .   .   . |  .  X2   .  X1  X4  X8
    // Dice [5,3]. All 15 mover checkers home -> bearing off. Die 5: only
    // 5/off (exact); 3/off with the 5 would be an overshoot while point 5 is
    // occupied -> ILLEGAL. Die 3: 5/2 (movement) or 3/off (exact); 2 and 1
    // cannot overshoot with higher points occupied. Both dice always
    // playable -> exactly two turns.
    const p = mkPos({
      mover: { 5: 2, 3: 1, 2: 4, 1: 8 },
      opp: { 24: 2, 23: 2, 22: 2, 21: 2, 20: 2, 19: 2, 18: 3 },
    });
    expect(legalTurns(p, [5, 3])).toEqual([
      ['5/2', '5/off'],
      ['5/off', '3/off'],
    ]);
  });

  it('fixture 10: bear-off overshoot legal from the highest occupied point', () => {
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    // O8  O7   .   .   .   . |  .   .   .   .   .   .
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    //  .   .   .   .   .   . |  .   .   .  X2  X2  X11
    // Dice [6,4]. Point 3 is the highest occupied point, so BOTH dice may
    // overshoot from it (no exact target exists for either). Points 2 and 1
    // may not overshoot while 3 is occupied. Unique turn: 3/off 3/off.
    const p = mkPos({
      mover: { 3: 2, 2: 2, 1: 11 },
      opp: { 24: 8, 23: 7 },
    });
    expect(legalTurns(p, [6, 4])).toEqual([['3/off', '3/off']]);
  });

  it('fixture 11: bear-off eligibility gained mid-turn — 8 exact turns', () => {
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    //  .   .   .   .  O8  O7 |  .   .   .   .   .   .
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    //  .   .   .   .   .  X1 |  .   .  X2  X2  X5  X5
    // Dice [3,2]. The straggler on 7 blocks bear-off at the start (so 3/off
    // and 2/off are NOT initially legal). Playing 7/4 or 7/5 brings all 15
    // home and unlocks bear-off for the second die (2/off exact after 7/4;
    // 3/off exact after 7/5). All maximal turns:
    const p = mkPos({
      mover: { 7: 1, 4: 2, 3: 2, 2: 5, 1: 5 },
      opp: { 20: 8, 19: 7 },
    });
    expect(legalTurns(p, [3, 2])).toEqual([
      ['7/5', '5/2'],
      ['7/5', '4/1'],
      ['7/5', '3/off'],
      ['7/4', '4/2'],
      ['7/4', '3/1'],
      ['7/4', '2/off'],
      ['4/2', '4/1'],
      ['4/1', '3/1'],
    ]);
  });

  it('fixture 12: hitting sequences — single hits and the double hit, exact', () => {
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    // X1   .  O2   .  O2   . |  .   .   .   .   .  X2
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    //  .  O1   .  O1   .   . | X12  .  O2   .  O2  O5
    // Dice [4,2]. The 24-checker (22, 20 blocked) and 6-stack (4, 2 blocked)
    // are frozen. Die 2: 13/11 hits; die 4: 13/9 hits. Sequences: hit both
    // blots (13/11 13/9), or hit one and continue with the same checker
    // (13/11 11/7 or 13/9 9/7). Hits carry no annotation.
    const p = mkPos({
      mover: { 24: 1, 13: 2, 6: 12 },
      opp: { 22: 2, 20: 2, 11: 1, 9: 1, 4: 2, 2: 2, 1: 5 },
    });
    expect(legalTurns(p, [4, 2])).toEqual([
      ['13/11', '13/9'],
      ['13/11', '11/7'],
      ['13/9', '9/7'],
    ]);
  });

  it('fixture 13: overshoot after clearing — same hops via either die order collapse to one turn', () => {
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    // O5  O5  O5   .   .   . |  .   .   .   .   .   .
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    //  .   .   .   .   .   . |  .  X1   .   .   .  X14
    // Dice [6,5]. Order 6-then-5: 5/off (overshoot from highest) then 1/off
    // (5 overshoots point 1, now the highest). Order 5-then-6: 5/off (exact)
    // then 1/off (6 overshoots). Identical hop multiset either way -> exactly
    // one turn; 1/off is NOT legal before point 5 is cleared.
    const p = mkPos({
      mover: { 5: 1, 1: 14 },
      opp: { 24: 5, 23: 5, 22: 5 },
    });
    expect(legalTurns(p, [6, 5])).toEqual([['5/off', '1/off']]);
  });

  it('fixture 14: only the larger die playable, two different ways — both single-hop turns kept', () => {
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    // X1  O2   .   .   .   . | X1  O2   .   .   .   .
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    //  .  O2   .   .   .   . |  .   .   .   .  X13 O9
    // Dice [6,1]. Die 1 is dead everywhere (24/23, 18/17, 2/1 all blocked).
    // Die 6 plays 24/18 (onto own checker) or 18/12; after either, the 1 is
    // still dead. maxLen 1 with two distinct larger-die hops -> two turns.
    const p = mkPos({
      mover: { 24: 1, 18: 1, 2: 13 },
      opp: { 23: 2, 17: 2, 11: 2, 1: 9 },
    });
    expect(legalTurns(p, [6, 1])).toEqual([['24/18'], ['18/12']]);
  });

  it('fixture 15: no moves at all without the bar (full block) -> []', () => {
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    // X2   .   .   .  O11 O2 | O2   .   .   .   .   .
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    //  .   .   .   .   .   . |  .   .   .   .   .  X13
    // Dice [6,5]. 24/18 and 24/19 both blocked; the 1-point stack cannot move
    // (any die goes off-board and bear-off is off while 24 is occupied).
    // Result: [] (dance), NOT [[]].
    const p = mkPos({
      mover: { 24: 2, 1: 13 },
      opp: { 20: 11, 19: 2, 18: 2 },
    });
    expect(legalTurns(p, [6, 5])).toEqual([]);
  });

  it('fixture 16: two on the bar, only one entry open — one checker enters, the 6 is lost', () => {
    // bar: X2
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    //  .   .   .   .   .  O2 |  .   .   .   .   .   .
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    // O13  .   .   .   .   . | X13  .   .   .   .   .
    // Dice [6,2]. Entry 25-6 = 19 is blocked; entry 25-2 = 23 is open. After
    // bar/23 one checker remains on the bar, so the 6 has no legal hop (bar
    // entry is still mandatory and 19 is still blocked). Single 1-hop turn;
    // the larger-die rule does not displace it (the 6 was never playable).
    const p = mkPos({
      mover: { 6: 13 },
      opp: { 19: 2, 12: 13 },
      bar: [2, 0],
    });
    expect(legalTurns(p, [6, 2])).toEqual([['bar/23']]);
  });

  it('fixture 17: doubles flow — one checker chain-feeds the other; unique 4-hop multiset', () => {
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    //  .   .   .   .  O5  O5 | O5   .   .   .   .   .
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    //  .   .  X1   .   .  X1 |  .   .   .   .   .  X13
    // Dice [3,3]. Available pips: the 10-checker can hop 10/7/4/1 and the
    // 7-checker 7/4/1, but only four 3s exist. Every maximal sequence uses
    // hops {10/7, 7/4, 7/4, 4/1} (two 4/1s are impossible: the second would
    // need a third 7/4). The 1-point stack never moves: bear-off with a 3
    // from point 1 would be an overshoot while point 4 is occupied.
    const p = mkPos({
      mover: { 10: 1, 7: 1, 1: 13 },
      opp: { 20: 5, 19: 5, 18: 5 },
    });
    expect(legalTurns(p, [3, 3])).toEqual([['10/7', '7/4', '7/4', '4/1']]);
  });

  it('fixture 18: doubles in bear-off with 13 already off — forced 3 of 4, movement before overshoot', () => {
    // off: X13
    // 24  23  22  21  20  19 | 18  17  16  15  14  13
    // O5  O5  O5   .   .   . |  .   .   .   .   .   .
    // 12  11  10   9   8   7 |  6   5   4   3   2   1
    //  .   .   .   .   .   . | X1   .  X1   .   .   .
    // Dice [5,5]. First 5: 6/off is illegal (5 < 6, no exact/overshoot) and
    // 4/off is an illegal overshoot while 6 is occupied -> only 6/1. Second 5:
    // 4/off (now the highest point). Third 5: 1/off. No checkers remain for
    // the fourth. Unique 3-hop turn.
    const p = mkPos({
      mover: { 6: 1, 4: 1 },
      opp: { 24: 5, 23: 5, 22: 5 },
      off: [13, 0],
    });
    expect(legalTurns(p, [5, 5])).toEqual([['6/1', '4/off', '1/off']]);
  });

  it('sanity: hop format and equal turn lengths on a dense fixture', () => {
    const p = mkPos({
      mover: { 24: 2, 13: 5, 8: 3, 6: 5 },
      opp: { 19: 5, 17: 3, 12: 5, 1: 2 },
    });
    const turns = legalTurns(p, [6, 5]);
    expect(turns.length).toBeGreaterThan(0);
    const len = turns[0]?.length ?? 0;
    const hopRe = /^(bar|2[0-4]|1[0-9]|[1-9])\/(off|2[0-4]|1[0-9]|[1-9])$/;
    for (const t of turns) {
      expect(t.length).toBe(len);
      for (const h of t) expect(h).toMatch(hopRe);
    }
    // No duplicate turns.
    expect(new Set(turns.map((t) => t.join(','))).size).toBe(turns.length);
  });

  it('rejects invalid dice and malformed points arrays', () => {
    const p = mkPos({ mover: { 6: 15 }, opp: { 19: 15 } });
    expect(() => legalTurns(p, [0, 3])).toThrow();
    expect(() => legalTurns(p, [3, 7])).toThrow();
    expect(() => legalTurns({ points: [0, 0], bar: [0, 0], off: [0, 0] }, [3, 1])).toThrow();
  });
});
