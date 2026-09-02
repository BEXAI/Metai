/**
 * RED TEAM red-team-rules — islanders (spec
 * games.M3_hidden_information_and_trading.islanders, acceptance A7).
 * Attacks: malformed trade/discard payloads (apply must return RuleError,
 * never throw), the distance rule, discard rounding on exactly 7/8/9 cards,
 * longest-road recompute when a rival village splits a road, the simultaneous
 * discard phase, progress-card same-turn ban, and the 100-round tiebreak.
 */

import { describe, expect, it } from 'vitest';
import { isRuleError } from '../../src/kernel/types.ts';
import {
  applyMove,
  legalMoves,
  isTerminal,
  playersToMove,
  longestRoadLength,
  victoryPoints,
  ROUND_LIMIT,
  type IslMove,
  type IslState,
} from '../../src/games/islanders/rules.ts';
import {
  craft,
  give,
  placeRoad,
  placeVillage,
  mustApply,
  mustReject,
  freshSeed,
  seedForRoll,
} from '../../src/games/islanders/tests/helpers.ts';
import { VERTEX_ADJ, VERTEX_EDGES, EDGE_VERTICES } from '../../src/games/islanders/rules.ts';

describe('malformed moves MUST be RuleErrors, never exceptions', () => {
  it('an offer without give/get does not throw', () => {
    const s = craft(3);
    let out: unknown;
    expect(() => {
      out = applyMove(s, 'p0', { type: 'offer', to: 'p1' } as unknown as IslMove, freshSeed('x'));
    }).not.toThrow();
    expect(isRuleError(out)).toBe(true);
  });

  it('null/garbage multisets in offer, counter, discard, bounty do not throw', () => {
    const s = craft(3);
    const bads: unknown[] = [
      { type: 'offer', to: 'p1', give: null, get: { palm: 1 } },
      { type: 'offer', to: 'p1', give: { palm: 1 }, get: 7 },
      { type: 'offer', to: 'p1', give: { palm: -1 }, get: { coral: 1 } },
      { type: 'discard', cards: null },
      { type: 'discard' },
      { type: 'play_progress', card: 'bounty', take: null },
      { type: 'counter', id: 1, give: null, get: null },
    ];
    for (const bad of bads) {
      let out: unknown;
      expect(() => {
        out = applyMove(s, 'p0', bad as IslMove, freshSeed('y'));
      }).not.toThrow();
      expect(isRuleError(out)).toBe(true);
    }
  });
});

describe('distance rule and road connectivity', () => {
  it('a village adjacent to ANY building is rejected in the main phase', () => {
    const s = craft(3);
    // p0 village at some vertex v; pick a neighbor w; p0 road touching w.
    const v = Object.keys(VERTEX_ADJ)[0]!;
    const w = VERTEX_ADJ[v]![0]!;
    placeVillage(s, v, 'p0');
    const edgeToW = VERTEX_EDGES[w]!.find((e) => !VERTEX_EDGES[v]!.includes(e)) ?? VERTEX_EDGES[w]![0]!;
    placeRoad(s, edgeToW, 'p0');
    give(s, 'p0', { palm: 1, coral: 1, reed: 1, taro: 1 });
    const code = mustReject(s, 'p0', { type: 'build_village', vertex: w });
    expect(code).toBe('distance_rule');
    const offered = legalMoves(s, 'p0').filter((m) => m.type === 'build_village');
    expect(offered.every((m) => m.type !== 'build_village' || m.vertex !== w)).toBe(true);
  });

  it('a village not touching one of your roads is rejected even at legal distance', () => {
    const s = craft(3);
    give(s, 'p0', { palm: 1, coral: 1, reed: 1, taro: 1 });
    const far = Object.keys(VERTEX_ADJ)[20]!;
    const code = mustReject(s, 'p0', { type: 'build_village', vertex: far });
    expect(['bad_placement', 'distance_rule']).toContain(code);
  });

  it('a road may not extend THROUGH an opponent building (it may touch it)', () => {
    const s = craft(3);
    // p0 road e1 ending at vertex v where p1 has a village; the far edges of v
    // must not be open to p0.
    const v = Object.keys(VERTEX_ADJ).find((x) => VERTEX_EDGES[x]!.length === 3)!;
    const [e1, e2] = VERTEX_EDGES[v]! as [string, string, string];
    placeRoad(s, e1, 'p0');
    placeVillage(s, v, 'p1');
    give(s, 'p0', { palm: 5, coral: 5 });
    const code = mustReject(s, 'p0', { type: 'build_road', edge: e2 });
    expect(code).toBe('bad_placement');
  });
});

describe('discard rounding: MORE than seven discards half rounded down (attack family 2)', () => {
  function rollSeven(hands: Record<string, Record<string, number>>): IslState {
    const s = craft(3);
    for (const [p, h] of Object.entries(hands)) give(s, p, h);
    // p0 ends the turn; the seed makes turn 2 roll a 7.
    const sd = seedForRoll(2, (t) => t === 7);
    return mustApply(s, 'p0', { type: 'end_turn' }, sd);
  }

  it('7 cards: exempt. 8 cards: discard 4. 9 cards: discard 4.', () => {
    const s = rollSeven({
      p0: { palm: 7 },
      p1: { palm: 4, coral: 4 },
      p2: { palm: 5, coral: 4 },
    });
    expect(s.phase).toBe('discard');
    expect(s.discardDue['p0']).toBeUndefined(); // exactly 7 keeps everything
    expect(s.discardDue['p1']).toBe(4);
    expect(s.discardDue['p2']).toBe(4);
    // wrong-count discards rejected both ways
    expect(mustReject(s, 'p1', { type: 'discard', cards: { palm: 3 } })).toBe('wrong_count');
    expect(mustReject(s, 'p1', { type: 'discard', cards: { palm: 4, coral: 1 } })).toBe('wrong_count');
    expect(mustReject(s, 'p1', { type: 'discard', cards: { reed: 4 } })).toBe('not_held');
  });

  it('the raider phase is locked until EVERY owing player has discarded (room trap)', () => {
    // p0 ends the turn, so the roller of turn 2 is p1 (exempt at 7 cards);
    // p0 and p2 owe simultaneous discards.
    const s = rollSeven({
      p0: { palm: 4, coral: 4 },
      p1: { palm: 7 },
      p2: { palm: 5, coral: 4 },
    });
    expect(new Set(playersToMove(s))).toEqual(new Set(['p0', 'p2']));
    // the roller cannot move the raider yet
    expect(isRuleError(applyMove(s, 'p1', { type: 'move_bandit', hex: 'A', victim: '-' }, freshSeed('r')))).toBe(true);
    // discards land in ANY order; after the last the raider unlocks for the ROLLER
    const s1 = mustApply(s, 'p2', { type: 'discard', cards: { palm: 4 } });
    expect(s1.phase).toBe('discard');
    const s2 = mustApply(s1, 'p0', { type: 'discard', cards: { palm: 4 } });
    expect(s2.phase).toBe('raider');
    expect(playersToMove(s2)).toEqual(['p1']);
    // a second discard from p2 is rejected — no double-dipping into the bank
    expect(isRuleError(applyMove(s2, 'p2', { type: 'discard', cards: { coral: 4 } }, freshSeed('z')))).toBe(true);
  });
});

describe('longest road: rival village splits the road (A7)', () => {
  /**
   * Find a simple path of `len` edges whose interior vertices are degree-3
   * (so the cut vertex always has a spare edge for p1's connecting road).
   */
  function findPath(len: number): { edges: string[]; vertices: string[]; cutIdx: number } {
    for (const start of Object.keys(VERTEX_ADJ)) {
      const edges: string[] = [];
      const vertices: string[] = [start];
      const usedV = new Set([start]);
      const dfs = (cur: string): boolean => {
        if (edges.length === len) return true;
        for (const e of VERTEX_EDGES[cur]!) {
          if (edges.includes(e)) continue;
          const [a, b] = EDGE_VERTICES[e]!;
          const nxt = a === cur ? b : a;
          if (usedV.has(nxt)) continue;
          if (edges.length < len - 1 && VERTEX_EDGES[nxt]!.length !== 3) continue; // interior must be degree 3
          edges.push(e);
          vertices.push(nxt);
          usedV.add(nxt);
          if (dfs(nxt)) return true;
          edges.pop();
          vertices.pop();
          usedV.delete(nxt);
        }
        return false;
      };
      if (!dfs(start)) continue;
      const cutIdx = [2, 3, 4].find(
        (i) => VERTEX_EDGES[vertices[i]!]!.length === 3 && VERTEX_EDGES[vertices[i]!]!.some((e) => !edges.includes(e)),
      );
      if (cutIdx === undefined) continue;
      return { edges, vertices, cutIdx };
    }
    throw new Error('no suitable path found');
  }

  it('a village that cuts the holder below 5 removes the bonus (goes to nobody)', () => {
    const s = craft(3);
    const { edges, vertices, cutIdx } = findPath(6);
    // p0 lays 5 of the 6 by hand, then builds the last via apply so the
    // engine itself computes the holder.
    for (const e of edges.slice(0, 5)) placeRoad(s, e, 'p0');
    give(s, 'p0', { palm: 1, coral: 1 });
    const s1 = mustApply(s, 'p0', { type: 'build_road', edge: edges[5]! });
    expect(s1.longestRoadHolder).toBe('p0');
    expect(victoryPoints(s1, 'p0', true)).toBeGreaterThanOrEqual(2);

    // p1's turn: build a village mid-path (splits the trail below 5 each way)
    const cut = vertices[cutIdx]!;
    s1.currentSeat = 1;
    s1.turn = 2;
    const touching = VERTEX_EDGES[cut]!.find((e) => !edges.includes(e))!;
    placeRoad(s1, touching, 'p1');
    give(s1, 'p1', { palm: 1, coral: 1, reed: 1, taro: 1 });
    const s2 = mustApply(s1, 'p1', { type: 'build_village', vertex: cut });
    expect(longestRoadLength(s2, 'p0')).toBeLessThan(5);
    expect(s2.longestRoadHolder).toBeNull(); // removed, not retained
    expect(victoryPoints(s2, 'p0', true)).toBe(0);
  });

  it('after the cut, a unique 5+ rival takes the bonus instead', () => {
    const s = craft(3);
    const { edges, vertices, cutIdx } = findPath(6);
    for (const e of edges.slice(0, 5)) placeRoad(s, e, 'p0');
    give(s, 'p0', { palm: 1, coral: 1 });
    const s1 = mustApply(s, 'p0', { type: 'build_road', edge: edges[5]! });
    expect(s1.longestRoadHolder).toBe('p0');

    // give p1 a disjoint 5-road trail on the far side of the board
    const all = Object.keys(VERTEX_ADJ);
    const farStart = [...all].reverse().find((v) => VERTEX_EDGES[v]!.length === 3 && !vertices.includes(v))!;
    const p1edges: string[] = [];
    let cur = farStart;
    const usedV = new Set([farStart]);
    while (p1edges.length < 5) {
      const e = VERTEX_EDGES[cur]!.find((x) => {
        const [a, b] = EDGE_VERTICES[x]!;
        const nxt = a === cur ? b : a;
        return !p1edges.includes(x) && !usedV.has(nxt) && !edges.includes(x) && !vertices.includes(nxt);
      });
      if (!e) throw new Error('p1 path search failed');
      const [a, b] = EDGE_VERTICES[e]!;
      cur = a === cur ? b : a;
      usedV.add(cur);
      p1edges.push(e);
    }
    for (const e of p1edges) placeRoad(s1, e, 'p1');
    expect(longestRoadLength(s1, 'p1')).toBeGreaterThanOrEqual(5);
    // p0 still holds (placements did not go through apply — holder unchanged)
    expect(s1.longestRoadHolder).toBe('p0');

    // p1 cuts p0's road with a village
    const cut = vertices[cutIdx]!;
    s1.currentSeat = 1;
    s1.turn = 2;
    const touching = VERTEX_EDGES[cut]!.find((e) => !edges.includes(e) && !p1edges.includes(e))!;
    placeRoad(s1, touching, 'p1');
    give(s1, 'p1', { palm: 1, coral: 1, reed: 1, taro: 1 });
    const s2 = mustApply(s1, 'p1', { type: 'build_village', vertex: cut });
    expect(s2.longestRoadHolder).toBe('p1'); // transferred to the unique 5+ rival
  });
});

describe('progress cards: same-turn ban and one-per-turn', () => {
  it('a warrior bought this turn is unplayable; an older copy plays; only one card per turn', () => {
    const s = craft(3);
    s.bought['p0'] = ['warrior'];
    const r = applyMove(s, 'p0', { type: 'play_progress', card: 'warrior', hex: 'A', victim: '-' }, freshSeed('w'));
    expect(isRuleError(r)).toBe(true);
    if (isRuleError(r)) expect(r.code).toBe('bought_this_turn');

    s.progress['p0'] = ['warrior', 'warrior'];
    const ok = applyMove(s, 'p0', { type: 'play_progress', card: 'warrior', hex: 'A', victim: '-' }, freshSeed('w2'));
    expect(isRuleError(ok)).toBe(false);
    if (!isRuleError(ok)) {
      const second = applyMove(ok.state, 'p0', { type: 'play_progress', card: 'warrior', hex: 'B', victim: '-' }, freshSeed('w3'));
      expect(isRuleError(second)).toBe(true);
      if (isRuleError(second)) expect(second.code).toBe('one_per_turn');
    }
  });

  it('landmarks can never be played but count (hidden) toward the win check on your turn', () => {
    const s = craft(3);
    const played = applyMove(s, 'p0', { type: 'play_progress', card: 'landmark' } as unknown as IslMove, freshSeed('l'));
    expect(isRuleError(played)).toBe(true);
    // 8 visible VP + 2 hidden landmarks = 10 -> current player wins
    const vs = Object.keys(VERTEX_ADJ);
    let placed = 0;
    for (const v of vs) {
      if (placed >= 4) break;
      if (VERTEX_ADJ[v]!.every((w) => s.cities[w] === undefined) && s.cities[v] === undefined) {
        s.cities[v] = 'p0';
        placed++;
      }
    }
    expect(placed).toBe(4);
    s.progress['p0'] = ['landmark', 'landmark'];
    const t = isTerminal(s);
    expect(t?.winners).toEqual(['p0']);
    expect(t?.reason).toBe('points');
    expect(t?.scores?.['p0']).toBe(10);
  });

  it('a rival at 10 VP does NOT end the game on someone else’s turn', () => {
    const s = craft(3); // p0 is current
    const vs = Object.keys(VERTEX_ADJ);
    let placed = 0;
    for (const v of vs) {
      if (placed >= 5) break;
      if (VERTEX_ADJ[v]!.every((w) => s.cities[w] === undefined) && s.cities[v] === undefined) {
        s.cities[v] = 'p1';
        placed++;
      }
    }
    expect(placed).toBe(5); // 10 VP for p1
    expect(victoryPoints(s, 'p1', true)).toBe(10);
    expect(isTerminal(s)).toBeNull(); // not p1's turn
  });
});

describe('the 100-round turn limit: most VP, ties by resources (attack family 2)', () => {
  it('the tiebreak uses resources held; a full tie is a shared draw', () => {
    const s = craft(3);
    s.phase = 'over';
    // p0 and p1 both at 2 VP (one village each x2? villages give 1 VP) — craft
    // two villages each, p2 one.
    const vs = Object.keys(VERTEX_ADJ);
    const free: string[] = [];
    for (const v of vs) {
      if (free.length >= 5) break;
      if (free.every((w) => !VERTEX_ADJ[v]!.includes(w) && w !== v)) free.push(v);
    }
    s.villages[free[0]!] = 'p0';
    s.villages[free[1]!] = 'p0';
    s.villages[free[2]!] = 'p1';
    s.villages[free[3]!] = 'p1';
    s.villages[free[4]!] = 'p2';
    give(s, 'p1', { palm: 3 });
    give(s, 'p0', { palm: 1 });
    const t = isTerminal(s);
    expect(t?.reason).toBe('turn_limit');
    expect(t?.winners).toEqual(['p1']); // VP tie broken by more resources
    expect(t?.draw).toBe(false);

    give(s, 'p0', { coral: 2 }); // now 3 each -> full tie
    const t2 = isTerminal(s);
    expect(new Set(t2?.winners)).toEqual(new Set(['p0', 'p1']));
    expect(t2?.draw).toBe(true);
  });

  it('the game runs through round 100 and flips to over only when the last turn ends', () => {
    const s = craft(3);
    s.turn = ROUND_LIMIT * 3; // the very last turn of round 100
    s.currentSeat = (s.turn - 1) % 3;
    const cur = `p${s.currentSeat}`;
    expect(isTerminal(s)).toBeNull();
    const s2 = mustApply(s, cur, { type: 'end_turn' });
    expect(s2.phase).toBe('over');
    expect(isTerminal(s2)?.reason).toBe('turn_limit');
    expect(playersToMove(s2)).toEqual([]);
  });
});

describe('bandit discipline', () => {
  it('the raider must MOVE, must name a real victim, and cannot rob empty hands', () => {
    const s = craft(3);
    s.phase = 'raider';
    expect(isRuleError(applyMove(s, 'p0', { type: 'move_bandit', hex: s.raider, victim: '-' }, freshSeed('b')))).toBe(true);
    expect(isRuleError(applyMove(s, 'p0', { type: 'move_bandit', hex: 'ZZ', victim: '-' }, freshSeed('b')))).toBe(true);
    // put a p1 village on hex A but p1 has no cards: naming p1 must fail,
    // '-' must succeed.
    const v = Object.keys(VERTEX_ADJ).find((x) => x.includes('A'))!;
    s.villages[v] = 'p1';
    expect(isRuleError(applyMove(s, 'p0', { type: 'move_bandit', hex: 'A', victim: 'p1' }, freshSeed('b')))).toBe(true);
    const ok = applyMove(s, 'p0', { type: 'move_bandit', hex: 'A', victim: '-' }, freshSeed('b'));
    expect(isRuleError(ok)).toBe(false);
    if (!isRuleError(ok)) expect(ok.state.phase).toBe('main');
  });
});
