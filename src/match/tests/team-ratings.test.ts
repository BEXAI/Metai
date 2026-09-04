/**
 * M1: the migration applier, the team-aggregate decomposition, the real-seat
 * rating gate and the game_teams stamp.
 *
 * The load-bearing test in this file is the 2-PLAYER KAT. Werewolf is the
 * hall's first team game, and the whole team layer is only safe if it cannot
 * move a single existing rating: with no `teams` on the result the applier
 * must produce BYTE-IDENTICAL numbers to the pairwise path (asserted with
 * Object.is, not toBeCloseTo), and a 2-player game that DOES set teams must
 * reduce to exactly one opponent, i.e. to the same numbers again. If either
 * fails, chess, go, backgammon and the other nine have moved.
 *
 * Gate 3 is this file running at all: it can only do so if migrations/0002 is
 * actually applied by the test bootstrap (plan §8.7).
 */

import { describe, expect, it } from 'vitest';
import type { GameResult } from '../../kernel/types.ts';
import { insertGame, makeTestEnv, type TestEnv } from '../../api/tests/fakes.ts';
import { insertAgent, type TestAgent } from '../../api/tests/helpers.ts';
import {
  DEFAULT_GLICKO2,
  PROVISIONAL_GAMES,
  pairwiseResults,
  rate,
  standingsFromResult,
  type Glicko2Rating,
  type Standing,
} from '../glicko2.ts';
import {
  applyGameRatings,
  decomposeGame,
  isProvisionalFor,
  minRatedRealSeats,
  provisionalGamesFor,
  seatRowsOf,
  teamAggregateResults,
  type TeamStanding,
} from '../ratings.ts';
import { MemoryRatingsRepo, closeRatingPeriod, closeSeason, MemorySeasonRepo, ensureSeason, type FinishedGame } from '../seasons.ts';

interface RatingRow {
  agent_id: string;
  game: string;
  rating: number;
  rd: number;
  volatility: number;
  games_played: number;
}

interface TeamRow {
  game_id: string;
  player: string;
  agent_id: string;
  team: string;
  won: number;
}

function ratingRows(env: TestEnv): RatingRow[] {
  return env.db.db.prepare('SELECT * FROM ratings ORDER BY agent_id').all() as unknown as RatingRow[];
}

function teamRows(env: TestEnv): TeamRow[] {
  return env.db.db.prepare('SELECT * FROM game_teams ORDER BY player').all() as unknown as TeamRow[];
}

function seat(agent: TestAgent, player: string): { player: string; agent_id: string; handle: string; pubkey_ed25519: string } {
  return { player, agent_id: agent.agentId, handle: agent.handle, pubkey_ed25519: agent.pubkey };
}

function endedGame(env: TestEnv, id: string, game: string, seats: ReturnType<typeof seat>[], result: GameResult): void {
  env.db.db
    .prepare(
      "INSERT OR IGNORE INTO seasons (id, name, starts_at, ends_at, ruleset_versions_json, status) VALUES ('2026-09', 'Season 2026-09', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '{}', 'active')",
    )
    .run();
  insertGame(env, {
    id,
    game,
    status: 'ended',
    ended_at: '2026-09-01T11:30:00Z',
    seats,
    result: result as unknown as Parameters<typeof insertGame>[1]['result'],
    season_id: '2026-09',
  });
}

/** Eight seats: p0/p1 wolves, p2..p7 village. `real` of them are non-house. */
function werewolfSeats(env: TestEnv, real: number): ReturnType<typeof seat>[] {
  const seats: ReturnType<typeof seat>[] = [];
  for (let i = 0; i < 8; i++) {
    const handle = i < real ? `agent-${i}` : `house-ww-mock-0${i}`;
    seats.push(seat(insertAgent(env, handle, `op_${i}`), `p${i}`));
  }
  return seats;
}

const WEREWOLF_TEAMS: Record<string, string> = {
  p0: 'wolves',
  p1: 'wolves',
  p2: 'village',
  p3: 'village',
  p4: 'village',
  p5: 'village',
  p6: 'village',
  p7: 'village',
};

function villageWin(): GameResult {
  return {
    winners: ['p2', 'p3', 'p4', 'p5', 'p6', 'p7'],
    draw: false,
    reason: 'village',
    teams: { ...WEREWOLF_TEAMS },
  };
}

// ---------------------------------------------------------------------------

describe('migration applier', () => {
  it('applies schema.sql AND every migration into the test database', () => {
    const env = makeTestEnv();
    expect(env.db.schemaApplied[0]).toBe('schema.sql');
    expect(env.db.schemaApplied).toContain('migrations/0002_werewolf_platform.sql');
    // Ordered, and schema.sql always first.
    const serials = env.db.schemaApplied.slice(1).map((f) => f.slice('migrations/'.length, 'migrations/'.length + 4));
    expect([...serials].sort()).toEqual(serials);
  });

  it('0002 is really in the database: game_teams, rated_games.outcome, games.house_seats', () => {
    const env = makeTestEnv();
    const tables = (env.db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(tables).toContain('game_teams');
    const cols = (t: string): string[] =>
      (env.db.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name);
    expect(cols('rated_games')).toContain('outcome');
    expect(cols('games')).toContain('house_seats');
    expect(cols('game_teams')).toEqual(['game_id', 'player', 'agent_id', 'team', 'won']);
    // The default keeps every pre-existing INSERT (which names no outcome) honest.
    env.db.db.prepare("INSERT INTO rated_games (game_id, rated_at) VALUES ('g_x', '2026-09-01T00:00:00Z')").run();
    expect(env.db.db.prepare("SELECT outcome FROM rated_games WHERE game_id = 'g_x'").get()).toMatchObject({
      outcome: 'rated',
    });
  });

  it('a database WITHOUT 0002 still rates, and says so in the docket', async () => {
    // The deploy failure this guards. Nothing in the deploy path enforces
    // "schema.sql plus every migration", and against a pre-0002 database the
    // three-column claim is the FIRST statement applyGameRatings runs: it
    // threw, room.ts swallowed the throw into one log line, finalize reported
    // success, and NOTHING retried (no ratings step in the cron, one call per
    // game). Every game in all thirteen games would finish permanently
    // unrated. Degrading beats dying — loudly, on /api/docket.
    const env = makeTestEnv();
    env.db.db.exec('DROP TABLE game_teams');
    env.db.db.exec('DROP TABLE rated_games');
    env.db.db.exec('CREATE TABLE rated_games (game_id TEXT PRIMARY KEY, rated_at TEXT NOT NULL)');

    const alice = insertAgent(env, 'alice', 'op_a');
    const bob = insertAgent(env, 'bob', 'op_b');
    endedGame(env, 'g_pre0002', 'toy', [seat(alice, 'p0'), seat(bob, 'p1')], {
      winners: ['p0'],
      draw: false,
      reason: 'points',
      teams: { p0: 'left', p1: 'right' },
    });
    await applyGameRatings(env, 'g_pre0002');

    // The ratings moved — that is the whole point.
    const rows = ratingRows(env);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.agent_id === alice.agentId)!.rating).toBeGreaterThan(DEFAULT_GLICKO2.rating);
    // The game is claimed exactly once, in the pre-0002 shape.
    expect(env.db.db.prepare('SELECT COUNT(*) AS n FROM rated_games').get()).toMatchObject({ n: 1 });
    // And the shortfall is an operational row, not a console line.
    const docket = env.db.db.prepare("SELECT kind, reason FROM docket WHERE kind = 'schema_gap'").all() as {
      kind: string;
      reason: string;
    }[];
    expect(docket).toHaveLength(1);
    expect(docket[0]!.reason).toContain('0002_werewolf_platform.sql');
  });
});

// ---------------------------------------------------------------------------

describe('the 2-player KAT: the twelve existing games cannot move', () => {
  const decisive: GameResult = { winners: ['p0'], draw: false, reason: 'points' };

  function reference(seatIds: string[], result: GameResult): Map<string, Glicko2Rating> {
    const standings: Standing[] = standingsFromResult(seatIds, result).map((p) => ({
      ...p,
      rating: { ...DEFAULT_GLICKO2 },
    }));
    const pairs = pairwiseResults(standings);
    return new Map(seatIds.map((id) => [id, rate({ ...DEFAULT_GLICKO2 }, pairs.get(id)!)]));
  }

  it('no teams -> decomposeGame IS pairwiseResults, structurally identical', () => {
    const ids = ['a', 'b'];
    const got = decomposeGame(ids, decisive, () => ({ ...DEFAULT_GLICKO2 }));
    const want = pairwiseResults(
      standingsFromResult(ids, decisive).map((p) => ({ ...p, rating: { ...DEFAULT_GLICKO2 } })),
    );
    expect([...got.keys()]).toEqual([...want.keys()]);
    for (const id of ids) expect(got.get(id)).toEqual(want.get(id));
  });

  it('teams present -> the aggregate over ONE opponent is byte-identical to the pair', () => {
    const ids = ['a', 'b'];
    const teamed: GameResult = { ...decisive, teams: { p0: 'left', p1: 'right' } };
    const got = decomposeGame(ids, teamed, () => ({ ...DEFAULT_GLICKO2 }));
    const want = pairwiseResults(
      standingsFromResult(ids, decisive).map((p) => ({ ...p, rating: { ...DEFAULT_GLICKO2 } })),
    );
    for (const id of ids) {
      const g = got.get(id)!;
      const w = want.get(id)!;
      expect(g).toHaveLength(1);
      expect(w).toHaveLength(1);
      expect(Object.is(g[0]!.opponentRating, w[0]!.opponentRating)).toBe(true);
      expect(Object.is(g[0]!.opponentRd, w[0]!.opponentRd)).toBe(true);
      expect(Object.is(g[0]!.score, w[0]!.score)).toBe(true);
    }
  });

  it('applyGameRatings on a 2-player game is byte-identical with and without teams', async () => {
    const plain = makeTestEnv();
    const alice = insertAgent(plain, 'alice', 'op_a');
    const bob = insertAgent(plain, 'bob', 'op_b');
    endedGame(plain, 'g_1', 'toy', [seat(alice, 'p0'), seat(bob, 'p1')], decisive);
    await applyGameRatings(plain, 'g_1');

    const teamed = makeTestEnv();
    const alice2 = insertAgent(teamed, 'alice', 'op_a');
    const bob2 = insertAgent(teamed, 'bob', 'op_b');
    endedGame(teamed, 'g_1', 'toy', [seat(alice2, 'p0'), seat(bob2, 'p1')], {
      ...decisive,
      teams: { p0: 'left', p1: 'right' },
    });
    await applyGameRatings(teamed, 'g_1');

    const want = reference([alice.agentId, bob.agentId], decisive);
    for (const rows of [ratingRows(plain), ratingRows(teamed)]) {
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const w = want.get(row.agent_id)!;
        expect(Object.is(row.rating, w.rating)).toBe(true);
        expect(Object.is(row.rd, w.rd)).toBe(true);
        expect(Object.is(row.volatility, w.vol)).toBe(true);
        expect(row.games_played).toBe(1);
      }
    }
    expect(JSON.stringify(ratingRows(plain))).toBe(JSON.stringify(ratingRows(teamed)));
  });

  it('a 4-player game with no teams still takes the pairwise path exactly', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const result: GameResult = { winners: ['p2'], draw: false, reason: 'points', scores: { p0: 5, p1: 8, p2: 10, p3: 5 } };
    const got = decomposeGame(ids, result, () => ({ ...DEFAULT_GLICKO2 }));
    const want = pairwiseResults(standingsFromResult(ids, result).map((p) => ({ ...p, rating: { ...DEFAULT_GLICKO2 } })));
    for (const id of ids) {
      expect(got.get(id)).toEqual(want.get(id));
      expect(got.get(id)).toHaveLength(3); // three pairs, as always
    }
  });
});

// ---------------------------------------------------------------------------

describe('teamAggregateResults', () => {
  const standing = (agent_id: string, team: string, rating: number, rd: number): TeamStanding => ({
    agent_id,
    team,
    position: 1,
    rating: { rating, rd, vol: 0.06 },
  });

  it('2v6: one result per player, mean opponent rating, RMS opponent RD', () => {
    const wolves = [standing('w0', 'wolves', 1600, 100), standing('w1', 'wolves', 1400, 200)];
    const village = [
      standing('v0', 'village', 1500, 100),
      standing('v1', 'village', 1500, 300),
      standing('v2', 'village', 1600, 100),
      standing('v3', 'village', 1400, 100),
      standing('v4', 'village', 1500, 100),
      standing('v5', 'village', 1500, 100),
    ];
    const out = teamAggregateResults([...wolves, ...village], new Set(['village']), false);

    expect(out.size).toBe(8);
    for (const [, results] of out) expect(results).toHaveLength(1);

    const wolfSide = out.get('w0')!;
    expect(wolfSide[0]!.opponentRating).toBeCloseTo(1500, 12); // mean of the six
    expect(wolfSide[0]!.opponentRd).toBeCloseTo(Math.sqrt((100 ** 2 * 5 + 300 ** 2) / 6), 12);
    expect(wolfSide[0]!.score).toBe(0);

    const villageSide = out.get('v0')!;
    expect(villageSide[0]!.opponentRating).toBeCloseTo(1500, 12); // (1600+1400)/2
    expect(villageSide[0]!.opponentRd).toBeCloseTo(Math.sqrt((100 ** 2 + 200 ** 2) / 2), 12);
    expect(villageSide[0]!.score).toBe(1);

    // The 32 fabricated intra-team draws the pairwise path would invent are gone.
    const pairs = pairwiseResults([...wolves, ...village]);
    expect(pairs.get('v0')).toHaveLength(7);
  });

  it('asymmetric team sizes are NOT scaled: 1v7 gives each side exactly one result', () => {
    const solo = [standing('s', 'A', 1500, 350)];
    const many = Array.from({ length: 7 }, (_, i) => standing(`m${i}`, 'B', 1500, 350));
    const out = teamAggregateResults([...solo, ...many], new Set(['A']), false);
    for (const [, results] of out) expect(results).toHaveLength(1);
    expect(out.get('s')![0]!.score).toBe(1);
    expect(out.get('m0')![0]!.score).toBe(0);
  });

  it('a draw scores 0.5 for everyone', () => {
    const out = teamAggregateResults(
      [standing('a', 'A', 1500, 350), standing('b', 'B', 1500, 350)],
      new Set(),
      true,
    );
    for (const [, results] of out) expect(results[0]!.score).toBe(0.5);
  });

  it('degenerate: a decisive result whose winners span several teams rates as a draw', () => {
    const out = teamAggregateResults(
      [standing('a', 'A', 1500, 350), standing('b', 'B', 1500, 350), standing('c', 'C', 1500, 350)],
      new Set(['A', 'B']),
      false,
    );
    for (const [, results] of out) expect(results[0]!.score).toBe(0.5);
  });

  it('degenerate: a decisive result with NO winning team also rates as a draw', () => {
    const out = teamAggregateResults([standing('a', 'A', 1500, 350), standing('b', 'B', 1500, 350)], new Set(), false);
    for (const [, results] of out) expect(results[0]!.score).toBe(0.5);
  });

  it('everyone on one team observed nothing', () => {
    const out = teamAggregateResults([standing('a', 'A', 1500, 350), standing('b', 'A', 1500, 350)], new Set(['A']), false);
    for (const [, results] of out) expect(results).toEqual([]);
  });

  it('a forfeit result reaches the degenerate branch through teamsOf (E13)', () => {
    // forfeit() builds { winners: all-others } inline; endGame stamps teamsOf
    // onto it, so both teams appear among the winners and it lands here.
    const ids = ['a', 'b', 'c', 'd'];
    const forfeit: GameResult = {
      winners: ['p1', 'p2', 'p3'],
      draw: false,
      reason: 'forfeit',
      teams: { p0: 'wolves', p1: 'wolves', p2: 'village', p3: 'village' },
    };
    const out = decomposeGame(ids, forfeit, () => ({ ...DEFAULT_GLICKO2 }));
    for (const id of ids) expect(out.get(id)![0]!.score).toBe(0.5);
  });

  it('an incomplete team map falls back to the pairwise path rather than half-modelling', () => {
    const ids = ['a', 'b', 'c'];
    const result: GameResult = { winners: ['p0'], draw: false, reason: 'points', teams: { p0: 'A', p2: 'B' } };
    const out = decomposeGame(ids, result, () => ({ ...DEFAULT_GLICKO2 }));
    for (const id of ids) expect(out.get(id)).toHaveLength(2); // pairs, not aggregate
  });
});

// ---------------------------------------------------------------------------

describe('applyGameRatings: 8-seat team game', () => {
  it('one Glicko-2 result per player — a werewolf game moves a rating like a chess game', async () => {
    const env = makeTestEnv();
    const seats = werewolfSeats(env, 8);
    const result = villageWin();
    endedGame(env, 'g_ww', 'werewolf', seats, result);

    await applyGameRatings(env, 'g_ww');

    const rows = ratingRows(env);
    expect(rows).toHaveLength(8);
    const byId = new Map(rows.map((r) => [r.agent_id, r]));
    const seatIds = seats.map((s) => s.agent_id);
    const reference = decomposeGame(seatIds, result, () => ({ ...DEFAULT_GLICKO2 }));
    for (const id of seatIds) {
      expect(reference.get(id)).toHaveLength(1);
      const want = rate({ ...DEFAULT_GLICKO2 }, reference.get(id)!);
      const got = byId.get(id)!;
      expect(got.rating).toBeCloseTo(want.rating, 9);
      expect(got.rd).toBeCloseTo(want.rd, 9);
      expect(got.games_played).toBe(1);
    }
    // Village up, wolves down, and both wolves identical (same team, same aggregate).
    expect(byId.get(seatIds[2]!)!.rating).toBeGreaterThan(1500);
    expect(byId.get(seatIds[0]!)!.rating).toBeLessThan(1500);
    expect(byId.get(seatIds[0]!)!.rating).toBeCloseTo(byId.get(seatIds[1]!)!.rating, 12);

    // One result, not seven: RD shrinks far less than the pairwise path would.
    const pairwiseRd = rate(
      { ...DEFAULT_GLICKO2 },
      pairwiseResults(
        standingsFromResult(seatIds, result).map((p) => ({ ...p, rating: { ...DEFAULT_GLICKO2 } })),
      ).get(seatIds[0]!)!,
    ).rd;
    expect(byId.get(seatIds[0]!)!.rd).toBeGreaterThan(pairwiseRd);
  });

  it('stamps game_teams from the result the room recorded', async () => {
    const env = makeTestEnv();
    const seats = werewolfSeats(env, 8);
    endedGame(env, 'g_ww', 'werewolf', seats, villageWin());

    await applyGameRatings(env, 'g_ww');

    const teams = teamRows(env);
    expect(teams).toHaveLength(8);
    expect(teams.filter((t) => t.team === 'wolves').map((t) => t.player)).toEqual(['p0', 'p1']);
    expect(teams.filter((t) => t.won === 1).map((t) => t.player)).toEqual(['p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(teams.find((t) => t.player === 'p0')!.agent_id).toBe(seats[0]!.agent_id);

    // Idempotent: a second application adds nothing.
    await applyGameRatings(env, 'g_ww');
    expect(teamRows(env)).toHaveLength(8);
  });

  it('writes no game_teams rows for a game whose result carries no teams', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice', 'op_a');
    const bob = insertAgent(env, 'bob', 'op_b');
    endedGame(env, 'g_1', 'toy', [seat(alice, 'p0'), seat(bob, 'p1')], { winners: ['p0'], draw: false, reason: 'points' });
    await applyGameRatings(env, 'g_1');
    expect(teamRows(env)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('the real-seat gate (D-14)', () => {
  it('werewolf needs four real seats; every other game needs none', () => {
    expect(minRatedRealSeats('werewolf')).toBe(4);
    expect(minRatedRealSeats('chess')).toBe(0);
    expect(minRatedRealSeats('go')).toBe(0);
  });

  it('1 real + 7 house: recorded as an exhibition, teams stamped, NO rating moves', async () => {
    const env = makeTestEnv();
    const seats = werewolfSeats(env, 1);
    endedGame(env, 'g_ww', 'werewolf', seats, villageWin());

    await applyGameRatings(env, 'g_ww');

    expect(ratingRows(env)).toHaveLength(0);
    expect(teamRows(env)).toHaveLength(8);
    // The marker is claimed ONCE, carrying the truth. This is the assertion an
    // earlier design could not make: claiming first and marking second leaves
    // outcome at its 'rated' default because INSERT OR IGNORE changed nothing.
    expect(env.db.db.prepare("SELECT outcome FROM rated_games WHERE game_id = 'g_ww'").get()).toMatchObject({
      outcome: 'exhibition',
    });
  });

  it('3 real seats is still short; 4 tips it over', async () => {
    const three = makeTestEnv();
    endedGame(three, 'g_ww', 'werewolf', werewolfSeats(three, 3), villageWin());
    await applyGameRatings(three, 'g_ww');
    expect(ratingRows(three)).toHaveLength(0);

    const four = makeTestEnv();
    endedGame(four, 'g_ww', 'werewolf', werewolfSeats(four, 4), villageWin());
    await applyGameRatings(four, 'g_ww');
    expect(ratingRows(four)).toHaveLength(8);
    expect(four.db.db.prepare("SELECT outcome FROM rated_games WHERE game_id = 'g_ww'").get()).toMatchObject({
      outcome: 'rated',
    });
  });

  it('the gate never fires for a game with no minimum, even seated entirely by house agents', async () => {
    const env = makeTestEnv();
    const h1 = insertAgent(env, 'house-a', 'op_a');
    const h2 = insertAgent(env, 'house-b', 'op_b');
    endedGame(env, 'g_1', 'toy', [seat(h1, 'p0'), seat(h2, 'p1')], { winners: ['p0'], draw: false, reason: 'points' });
    await applyGameRatings(env, 'g_1');
    expect(ratingRows(env)).toHaveLength(2);
  });

  it('a seat with no recorded handle counts as real', () => {
    const seats = seatRowsOf(JSON.stringify([{ player: 'p1', agent_id: 'b' }, { player: 'p0', agent_id: 'a', handle: 'x' }]));
    expect(seats.map((s) => s.player)).toEqual(['p0', 'p1']);
    expect(seats[1]!.handle).toBe('');
  });
});

// ---------------------------------------------------------------------------

describe('provisional threshold', () => {
  it('werewolf is provisional for 40 games, everything else for 20', () => {
    expect(provisionalGamesFor('werewolf')).toBe(40);
    expect(provisionalGamesFor('chess')).toBe(PROVISIONAL_GAMES);
    expect(isProvisionalFor(25, 'werewolf')).toBe(true);
    expect(isProvisionalFor(25, 'chess')).toBe(false);
    expect(isProvisionalFor(40, 'werewolf')).toBe(false);
  });

  it('closeSeason reports the game-aware threshold', async () => {
    const seasons = new MemorySeasonRepo();
    const ratings = new MemoryRatingsRepo();
    await ensureSeason('2026-09-15T00:00:00Z', {}, seasons);
    for (const game of ['werewolf', 'chess']) {
      await ratings.upsert({
        agent_id: 'a',
        game,
        variant: 'standard',
        division: 'open',
        season_id: '2026-09',
        rating: 1500,
        rd: 100,
        volatility: 0.06,
        games_played: 25,
        updated_at: '2026-09-30T00:00:00.000Z',
      });
    }
    const { tables } = await closeSeason('2026-09', seasons, ratings, []);
    expect(tables['werewolf standard open']![0]!.provisional).toBe(true);
    expect(tables['chess standard open']![0]!.provisional).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('closeRatingPeriod takes the same branch as the live applier', () => {
  it('an offline rebuild of a team game reproduces the per-game application exactly', async () => {
    const env = makeTestEnv();
    const seats = werewolfSeats(env, 8);
    const result = villageWin();
    endedGame(env, 'g_ww', 'werewolf', seats, result);
    await applyGameRatings(env, 'g_ww');
    const live = ratingRows(env);

    const ratings = new MemoryRatingsRepo();
    const finished: FinishedGame[] = [
      {
        game_id: 'g_ww',
        game: 'werewolf',
        variant: 'standard',
        division: 'open',
        season_id: '2026-09',
        ended_at: '2026-09-01T11:30:00Z',
        seat_agents: seats.map((s) => s.agent_id),
        result,
      },
    ];
    await closeRatingPeriod('2026-09-02T00:00:00.000Z', finished, ratings, { inflateIdle: false });

    const offline = (await ratings.listAll()).sort((a, b) => a.agent_id.localeCompare(b.agent_id));
    expect(offline).toHaveLength(8);
    for (const row of offline) {
      const want = live.find((r) => r.agent_id === row.agent_id)!;
      expect(row.rating).toBeCloseTo(want.rating, 12);
      expect(row.rd).toBeCloseTo(want.rd, 12);
      expect(row.games_played).toBe(1);
    }
  });

  it('a period of 2-player games with no teams is untouched by the team layer', async () => {
    const ratings = new MemoryRatingsRepo();
    const finished: FinishedGame[] = [
      {
        game_id: 'g_1',
        game: 'chess',
        variant: 'standard',
        division: 'open',
        season_id: '2026-09',
        ended_at: '2026-09-01T11:30:00Z',
        seat_agents: ['a', 'b'],
        result: { winners: ['p0'], draw: false, reason: 'checkmate' },
      },
    ];
    await closeRatingPeriod('2026-09-02T00:00:00.000Z', finished, ratings, { inflateIdle: false });

    const pairs = pairwiseResults(
      standingsFromResult(['a', 'b'], finished[0]!.result).map((p) => ({ ...p, rating: { ...DEFAULT_GLICKO2 } })),
    );
    const want = rate({ ...DEFAULT_GLICKO2 }, pairs.get('a')!);
    const got = (await ratings.listAll()).find((r) => r.agent_id === 'a')!;
    expect(Object.is(got.rating, want.rating)).toBe(true);
    expect(Object.is(got.rd, want.rd)).toBe(true);
    expect(Object.is(got.volatility, want.vol)).toBe(true);
  });
});
