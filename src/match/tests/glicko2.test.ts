import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GLICKO2,
  GLICKO2_TAU,
  MAX_RD,
  PROVISIONAL_GAMES,
  isProvisional,
  pairwiseResults,
  rate,
  standingsFromResult,
  type Glicko2Result,
  type Standing,
} from '../glicko2.ts';

describe('glicko2 rate() — gate A13', () => {
  it('matches the worked example in Glickman\'s paper exactly (tau=0.5)', () => {
    // r=1500 RD=200 vol=0.06 vs (1400,30,win), (1550,100,loss), (1700,300,loss)
    const player = { rating: 1500, rd: 200, vol: 0.06 };
    const results: Glicko2Result[] = [
      { opponentRating: 1400, opponentRd: 30, score: 1 },
      { opponentRating: 1550, opponentRd: 100, score: 0 },
      { opponentRating: 1700, opponentRd: 300, score: 0 },
    ];
    const updated = rate(player, results, GLICKO2_TAU);
    expect(Math.abs(updated.rating - 1464.06)).toBeLessThan(0.5);
    expect(Math.abs(updated.rd - 151.52)).toBeLessThan(0.5);
    expect(Math.abs(updated.vol - 0.05999)).toBeLessThan(0.001);
  });

  it('result order does not change the outcome (one period, batched)', () => {
    const player = { rating: 1500, rd: 200, vol: 0.06 };
    const results: Glicko2Result[] = [
      { opponentRating: 1400, opponentRd: 30, score: 1 },
      { opponentRating: 1550, opponentRd: 100, score: 0 },
      { opponentRating: 1700, opponentRd: 300, score: 0 },
    ];
    const a = rate(player, results);
    const b = rate(player, [results[2]!, results[0]!, results[1]!]);
    expect(a.rating).toBeCloseTo(b.rating, 10);
    expect(a.rd).toBeCloseTo(b.rd, 10);
    expect(a.vol).toBeCloseTo(b.vol, 10);
  });

  it('no results: rating and vol unchanged, RD grows (step 6), capped at 350', () => {
    const idle = rate({ rating: 1600, rd: 50, vol: 0.06 }, []);
    expect(idle.rating).toBe(1600);
    expect(idle.vol).toBe(0.06);
    expect(idle.rd).toBeGreaterThan(50);
    expect(idle.rd).toBeLessThan(55);

    const maxed = rate({ ...DEFAULT_GLICKO2 }, []);
    expect(maxed.rd).toBe(MAX_RD);
  });

  it('a win raises rating, a loss lowers it, a draw vs equal leaves it ~unchanged', () => {
    const p = { rating: 1500, rd: 100, vol: 0.06 };
    const opp = { opponentRating: 1500, opponentRd: 100 };
    expect(rate(p, [{ ...opp, score: 1 }]).rating).toBeGreaterThan(1500);
    expect(rate(p, [{ ...opp, score: 0 }]).rating).toBeLessThan(1500);
    expect(rate(p, [{ ...opp, score: 0.5 }]).rating).toBeCloseTo(1500, 6);
  });

  it('rejects out-of-range scores', () => {
    expect(() =>
      rate({ rating: 1500, rd: 100, vol: 0.06 }, [{ opponentRating: 1500, opponentRd: 100, score: 2 }]),
    ).toThrow(/score/);
  });

  it('provisional flag: fewer than 20 rated games', () => {
    expect(PROVISIONAL_GAMES).toBe(20);
    expect(isProvisional(0)).toBe(true);
    expect(isProvisional(19)).toBe(true);
    expect(isProvisional(20)).toBe(false);
  });
});

describe('multiplayer pairwise decomposition', () => {
  const r = (rating: number): Standing['rating'] => ({ rating, rd: 100, vol: 0.06 });

  it('each pair contributes exactly one result to each side', () => {
    const standings: Standing[] = [
      { agent_id: 'a', rating: r(1500), position: 1 },
      { agent_id: 'b', rating: r(1520), position: 2 },
      { agent_id: 'c', rating: r(1480), position: 3 },
      { agent_id: 'd', rating: r(1510), position: 4 },
    ];
    const map = pairwiseResults(standings);
    expect([...map.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
    for (const results of map.values()) expect(results).toHaveLength(3);
    // Winner beats everyone.
    expect(map.get('a')!.every((x) => x.score === 1)).toBe(true);
    // Last loses to everyone.
    expect(map.get('d')!.every((x) => x.score === 0)).toBe(true);
    // b: lost to a, beat c and d.
    const b = map.get('b')!;
    expect(b.map((x) => x.score).sort()).toEqual([0, 1, 1]);
  });

  it('scores are antisymmetric and ties give both sides 0.5', () => {
    const standings: Standing[] = [
      { agent_id: 'a', rating: r(1500), position: 1 },
      { agent_id: 'b', rating: r(1600), position: 1 },
      { agent_id: 'c', rating: r(1400), position: 3 },
    ];
    const map = pairwiseResults(standings);
    const a = map.get('a')!;
    const b = map.get('b')!;
    // a vs b tie
    expect(a.find((x) => x.opponentRating === 1600)!.score).toBe(0.5);
    expect(b.find((x) => x.opponentRating === 1500)!.score).toBe(0.5);
    // total score across all pairs = number of pairs
    let total = 0;
    for (const results of map.values()) for (const x of results) total += x.score;
    expect(total).toBe(3); // 3 pairs
  });

  it('a two-player game reduces to a single ordinary result', () => {
    const map = pairwiseResults([
      { agent_id: 'w', rating: r(1500), position: 1 },
      { agent_id: 'l', rating: r(1450), position: 2 },
    ]);
    expect(map.get('w')).toEqual([{ opponentRating: 1450, opponentRd: 100, score: 1 }]);
    expect(map.get('l')).toEqual([{ opponentRating: 1500, opponentRd: 100, score: 0 }]);
  });
});

describe('standingsFromResult', () => {
  it('ranks by score descending with competition ranking for ties', () => {
    const standings = standingsFromResult(['a', 'b', 'c', 'd'], {
      winners: ['p2'],
      draw: false,
      reason: 'points',
      scores: { p0: 5, p1: 8, p2: 10, p3: 8 },
    });
    const byId = Object.fromEntries(standings.map((s) => [s.agent_id, s.position]));
    expect(byId).toEqual({ c: 1, b: 2, d: 2, a: 4 });
  });

  it('winners=1 rest=2 when no scores', () => {
    const standings = standingsFromResult(['x', 'y', 'z'], {
      winners: ['p1'],
      draw: false,
      reason: 'resignation',
    });
    expect(standings).toEqual([
      { agent_id: 'x', position: 2 },
      { agent_id: 'y', position: 1 },
      { agent_id: 'z', position: 2 },
    ]);
  });

  it('draw with no scores ties everyone', () => {
    const standings = standingsFromResult(['x', 'y'], { winners: [], draw: true, reason: 'stalemate' });
    expect(standings.map((s) => s.position)).toEqual([1, 1]);
  });
});

describe('decomposition + rate consistency', () => {
  it('3-player all-play update equals the same results passed manually', () => {
    const ratings = {
      a: { rating: 1500, rd: 200, vol: 0.06 },
      b: { rating: 1550, rd: 120, vol: 0.06 },
      c: { rating: 1450, rd: 80, vol: 0.06 },
    };
    const standings: Standing[] = [
      { agent_id: 'a', rating: ratings.a, position: 1 },
      { agent_id: 'b', rating: ratings.b, position: 2 },
      { agent_id: 'c', rating: ratings.c, position: 3 },
    ];
    const decomposed = rate(ratings.a, pairwiseResults(standings).get('a')!);
    const manual = rate(ratings.a, [
      { opponentRating: 1550, opponentRd: 120, score: 1 },
      { opponentRating: 1450, opponentRd: 80, score: 1 },
    ]);
    expect(decomposed).toEqual(manual);
  });
});
