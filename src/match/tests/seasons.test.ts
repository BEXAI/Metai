import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../crypto/canonical.ts';
import { DEFAULT_GLICKO2, rate } from '../glicko2.ts';
import {
  MemoryRatingsRepo,
  MemorySeasonRepo,
  closeRatingPeriod,
  closeSeason,
  dailyPeriodBounds,
  ensureSeason,
  seasonBounds,
  seasonIdFor,
  type FinishedGame,
} from '../seasons.ts';

function fg(partial: Partial<FinishedGame> & Pick<FinishedGame, 'game_id' | 'seat_agents' | 'result'>): FinishedGame {
  return {
    game: 'chess',
    variant: '{}',
    division: 'pure',
    season_id: '2026-09',
    ended_at: '2026-09-01T12:00:00.000Z',
    ...partial,
  };
}

describe('season calendar (UTC)', () => {
  it('seasonIdFor uses the UTC month', () => {
    expect(seasonIdFor('2026-09-15T23:59:59Z')).toBe('2026-09');
    // 23:30 on Aug 31 in UTC-2 is already September UTC... use an explicit instant:
    expect(seasonIdFor('2026-08-31T23:59:59.999Z')).toBe('2026-08');
    expect(seasonIdFor('2026-12-31T23:59:59Z')).toBe('2026-12');
    expect(seasonIdFor(new Date(Date.UTC(2027, 0, 1)))).toBe('2027-01');
  });

  it('seasonBounds spans the whole month, end exclusive at next month start', () => {
    expect(seasonBounds('2026-09')).toEqual({
      starts_at: '2026-09-01T00:00:00.000Z',
      ends_at: '2026-10-01T00:00:00.000Z',
    });
    expect(seasonBounds('2026-12').ends_at).toBe('2027-01-01T00:00:00.000Z');
    expect(() => seasonBounds('september')).toThrow();
    expect(() => seasonBounds('2026-13')).toThrow();
  });

  it('dailyPeriodBounds ends at the latest 00:00 UTC', () => {
    expect(dailyPeriodBounds('2026-09-02T13:45:00Z')).toEqual({
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-09-02T00:00:00.000Z',
    });
    expect(dailyPeriodBounds('2026-09-02T00:00:00Z').end).toBe('2026-09-02T00:00:00.000Z');
  });

  it('ensureSeason pins ruleset versions once and is idempotent', async () => {
    const repo = new MemorySeasonRepo();
    const v1 = { chess: '1.0.0', go: '1.0.0' };
    const s1 = await ensureSeason('2026-09-10T00:00:00Z', v1, repo);
    expect(s1.id).toBe('2026-09');
    expect(s1.status).toBe('open');
    expect(s1.ruleset_versions_json).toBe(canonicalJson(v1));
    // Second call with DIFFERENT versions must not re-pin.
    const s2 = await ensureSeason('2026-09-20T00:00:00Z', { chess: '9.9.9' }, repo);
    expect(s2.ruleset_versions_json).toBe(canonicalJson(v1));
  });
});

describe('closeRatingPeriod', () => {
  it('applies one batched Glicko-2 update per agent (equals a manual rate() call)', async () => {
    const ratings = new MemoryRatingsRepo();
    // Pre-seed known ratings so opponents are not at defaults.
    const scope = { game: 'chess', variant: '{}', division: 'pure' as const, season_id: '2026-09' };
    await ratings.upsert({ agent_id: 'A', ...scope, rating: 1500, rd: 200, volatility: 0.06, games_played: 5, updated_at: 't0' });
    await ratings.upsert({ agent_id: 'B', ...scope, rating: 1400, rd: 30, volatility: 0.06, games_played: 30, updated_at: 't0' });
    await ratings.upsert({ agent_id: 'C', ...scope, rating: 1550, rd: 100, volatility: 0.06, games_played: 30, updated_at: 't0' });
    await ratings.upsert({ agent_id: 'D', ...scope, rating: 1700, rd: 300, volatility: 0.06, games_played: 30, updated_at: 't0' });

    // A beats B, loses to C, loses to D — the paper's example spread over 3 games.
    const finished: FinishedGame[] = [
      fg({ game_id: 'g1', seat_agents: ['A', 'B'], result: { winners: ['p0'], draw: false, reason: 'checkmate' } }),
      fg({ game_id: 'g2', seat_agents: ['A', 'C'], result: { winners: ['p1'], draw: false, reason: 'checkmate' } }),
      fg({ game_id: 'g3', seat_agents: ['D', 'A'], result: { winners: ['p0'], draw: false, reason: 'checkmate' } }),
    ];
    const report = await closeRatingPeriod('2026-09-02T00:00:00.000Z', finished, ratings, { inflateIdle: false });
    expect(report.games_rated).toBe(3);
    expect(report.agents_updated).toBe(4);

    const a = (await ratings.get({ agent_id: 'A', ...scope }))!;
    // Gate A13 numbers: the batch must reproduce the paper's worked example.
    expect(Math.abs(a.rating - 1464.06)).toBeLessThan(0.5);
    expect(Math.abs(a.rd - 151.52)).toBeLessThan(0.5);
    expect(Math.abs(a.volatility - 0.05999)).toBeLessThan(0.001);
    expect(a.games_played).toBe(8); // 5 + 3 games (not pairs)
    expect(a.updated_at).toBe('2026-09-02T00:00:00.000Z');

    // Opponents were rated against A's START-of-period rating (1500), one game each.
    const b = (await ratings.get({ agent_id: 'B', ...scope }))!;
    const manualB = rate({ rating: 1400, rd: 30, vol: 0.06 }, [{ opponentRating: 1500, opponentRd: 200, score: 0 }]);
    expect(b.rating).toBeCloseTo(manualB.rating, 8);
    expect(b.games_played).toBe(31);
  });

  it('unrated agents enter at the default 1500/350/0.06', async () => {
    const ratings = new MemoryRatingsRepo();
    const finished = [
      fg({ game_id: 'g1', seat_agents: ['new1', 'new2'], result: { winners: ['p0'], draw: false, reason: 'checkmate' } }),
    ];
    await closeRatingPeriod('2026-09-02T00:00:00.000Z', finished, ratings);
    const w = (await ratings.get({ agent_id: 'new1', game: 'chess', variant: '{}', division: 'pure', season_id: '2026-09' }))!;
    const manual = rate(DEFAULT_GLICKO2, [{ opponentRating: 1500, opponentRd: 350, score: 1 }]);
    expect(w.rating).toBeCloseTo(manual.rating, 8);
    expect(w.games_played).toBe(1);
  });

  it('multiplayer games decompose pairwise inside the batch', async () => {
    const ratings = new MemoryRatingsRepo();
    const finished = [
      fg({
        game_id: 'g1',
        game: 'islanders',
        seat_agents: ['w', 'x', 'y'],
        result: { winners: ['p0'], draw: false, reason: 'points', scores: { p0: 10, p1: 7, p2: 5 } },
      }),
    ];
    await closeRatingPeriod('2026-09-02T00:00:00.000Z', finished, ratings);
    const scope = { game: 'islanders', variant: '{}', division: 'pure' as const, season_id: '2026-09' };
    const w = (await ratings.get({ agent_id: 'w', ...scope }))!;
    const manual = rate(DEFAULT_GLICKO2, [
      { opponentRating: 1500, opponentRd: 350, score: 1 },
      { opponentRating: 1500, opponentRd: 350, score: 1 },
    ]);
    expect(w.rating).toBeCloseTo(manual.rating, 8);
    expect(w.games_played).toBe(1); // one game, two pairwise results
    const y = (await ratings.get({ agent_id: 'y', ...scope }))!;
    expect(y.rating).toBeLessThan(1500);
  });

  it('separate game/variant/division scopes never mix', async () => {
    const ratings = new MemoryRatingsRepo();
    const finished = [
      fg({ game_id: 'g1', seat_agents: ['a', 'b'], result: { winners: ['p0'], draw: false, reason: 'x' } }),
      fg({ game_id: 'g2', game: 'reversi', seat_agents: ['a', 'b'], result: { winners: ['p1'], draw: false, reason: 'x' } }),
    ];
    await closeRatingPeriod('2026-09-02T00:00:00.000Z', finished, ratings);
    const chess = (await ratings.get({ agent_id: 'a', game: 'chess', variant: '{}', division: 'pure', season_id: '2026-09' }))!;
    const reversi = (await ratings.get({ agent_id: 'a', game: 'reversi', variant: '{}', division: 'pure', season_id: '2026-09' }))!;
    expect(chess.rating).toBeGreaterThan(1500);
    expect(reversi.rating).toBeLessThan(1500);
    expect(chess.games_played).toBe(1);
  });

  it('idle rated agents get RD inflation only (rating and games unchanged)', async () => {
    const ratings = new MemoryRatingsRepo();
    const scope = { game: 'chess', variant: '{}', division: 'pure' as const, season_id: '2026-09' };
    await ratings.upsert({ agent_id: 'idle', ...scope, rating: 1600, rd: 50, volatility: 0.06, games_played: 25, updated_at: 't0' });
    const report = await closeRatingPeriod('2026-09-02T00:00:00.000Z', [], ratings);
    expect(report.agents_inflated).toBe(1);
    const idle = (await ratings.get({ agent_id: 'idle', ...scope }))!;
    expect(idle.rating).toBe(1600);
    expect(idle.games_played).toBe(25);
    expect(idle.rd).toBeGreaterThan(50);
    expect(idle.rd).toBeLessThan(55);
  });
});

describe('closeSeason', () => {
  it('marks the season closed and publishes W/L/D + rating tables sorted by rating', async () => {
    const seasons = new MemorySeasonRepo();
    await ensureSeason('2026-09-01T00:00:00Z', { chess: '1.0.0' }, seasons);
    const ratings = new MemoryRatingsRepo();

    const finished: FinishedGame[] = [
      fg({ game_id: 'g1', seat_agents: ['a', 'b'], result: { winners: ['p0'], draw: false, reason: 'checkmate' } }),
      fg({ game_id: 'g2', seat_agents: ['a', 'b'], result: { winners: [], draw: true, reason: 'stalemate' } }),
      fg({ game_id: 'g3', seat_agents: ['b', 'a'], result: { winners: ['p0'], draw: false, reason: 'checkmate' } }),
    ];
    await closeRatingPeriod('2026-09-02T00:00:00.000Z', finished, ratings);

    const { season, tables } = await closeSeason('2026-09', seasons, ratings, finished);
    expect(season.status).toBe('closed');
    expect((await seasons.get('2026-09'))!.status).toBe('closed');

    const table = tables['chess {} pure'.replace(/ /g, ' ')] ?? Object.values(tables)[0]!;
    expect(table).toHaveLength(2);
    const a = table.find((r) => r.agent_id === 'a')!;
    const b = table.find((r) => r.agent_id === 'b')!;
    expect(a).toMatchObject({ wins: 1, losses: 1, draws: 1, games_played: 3, provisional: true });
    expect(b).toMatchObject({ wins: 1, losses: 1, draws: 1, games_played: 3 });
    // Sorted by rating descending.
    expect(table[0]!.rating).toBeGreaterThanOrEqual(table[1]!.rating);
    expect(() => JSON.stringify(tables)).not.toThrow();
  });

  it('throws on an unknown season', async () => {
    await expect(closeSeason('1999-01', new MemorySeasonRepo(), new MemoryRatingsRepo(), [])).rejects.toThrow(
      /unknown season/,
    );
  });
});
