/**
 * applyGameRatings: idempotent per-game Glicko-2 application over the real
 * schema (node:sqlite fakes) — 2-player and 4-player pairwise fixtures,
 * the rated_games idempotency marker, and the variant scope key.
 */

import { describe, expect, it } from 'vitest';
import type { GameResult } from '../../kernel/types.ts';
import { canonicalJson } from '../../crypto/canonical.ts';
import { insertGame, makeTestEnv, type TestEnv } from '../../api/tests/fakes.ts';
import { insertAgent, type TestAgent } from '../../api/tests/helpers.ts';
import {
  DEFAULT_GLICKO2,
  pairwiseResults,
  rate,
  standingsFromResult,
  type Standing,
} from '../glicko2.ts';
import { applyGameRatings, variantKeyOf } from '../ratings.ts';

interface RatingRow {
  agent_id: string;
  game: string;
  variant: string;
  division: string;
  season_id: string;
  rating: number;
  rd: number;
  volatility: number;
  games_played: number;
}

function ratingRows(env: TestEnv): RatingRow[] {
  return env.db.db.prepare('SELECT * FROM ratings ORDER BY agent_id').all() as unknown as RatingRow[];
}

function seat(agent: TestAgent, player: string): { player: string; agent_id: string; handle: string; pubkey_ed25519: string } {
  return { player, agent_id: agent.agentId, handle: agent.handle, pubkey_ed25519: agent.pubkey };
}

function endedGame(env: TestEnv, id: string, seats: ReturnType<typeof seat>[], result: GameResult): void {
  env.db.db
    .prepare(
      "INSERT OR IGNORE INTO seasons (id, name, starts_at, ends_at, ruleset_versions_json, status) VALUES ('2026-09', 'Season 2026-09', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '{}', 'active')",
    )
    .run();
  insertGame(env, {
    id,
    game: 'toy',
    status: 'ended',
    ended_at: '2026-09-01T11:30:00Z',
    seats,
    result: result as unknown as Parameters<typeof insertGame>[1]['result'],
    season_id: '2026-09',
  });
}

describe('applyGameRatings: 2-player', () => {
  it('winner up, loser down, games_played incremented, marker written — and idempotent', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice', 'op_a');
    const bob = insertAgent(env, 'bob', 'op_b');
    endedGame(env, 'g_1', [seat(alice, 'p0'), seat(bob, 'p1')], { winners: ['p0'], draw: false, reason: 'points' });

    await applyGameRatings(env, 'g_1');

    const rows = ratingRows(env);
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.agent_id === alice.agentId)!;
    const b = rows.find((r) => r.agent_id === bob.agentId)!;
    expect(a.rating).toBeGreaterThan(1500);
    expect(b.rating).toBeLessThan(1500);
    expect(a.rd).toBeLessThan(DEFAULT_GLICKO2.rd);
    expect(a.games_played).toBe(1);
    expect(b.games_played).toBe(1);
    expect(a.variant).toBe('standard'); // insertGame stores variant '{}'
    expect(a.division).toBe('open');
    expect(a.season_id).toBe('2026-09');

    // Exact match against the reference decomposition (gate A13 KAT'd rate()).
    const standings: Standing[] = standingsFromResult([alice.agentId, bob.agentId], {
      winners: ['p0'],
      draw: false,
      reason: 'points',
    }).map((p) => ({ ...p, rating: { ...DEFAULT_GLICKO2 } }));
    const expected = rate({ ...DEFAULT_GLICKO2 }, pairwiseResults(standings).get(alice.agentId)!);
    expect(a.rating).toBeCloseTo(expected.rating, 9);
    expect(a.rd).toBeCloseTo(expected.rd, 9);
    expect(a.volatility).toBeCloseTo(expected.vol, 9);

    // Idempotency: a second application (room finalize + any sweep both
    // calling in) changes nothing.
    const before = JSON.stringify(ratingRows(env));
    await applyGameRatings(env, 'g_1');
    expect(JSON.stringify(ratingRows(env))).toBe(before);
    const marker = env.db.db.prepare("SELECT game_id FROM rated_games WHERE game_id = 'g_1'").get();
    expect(marker).toBeTruthy();
  });

  it('skips games that are not ended, unknown ids, and games without a result', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice', 'op_a');
    const bob = insertAgent(env, 'bob', 'op_b');
    insertGame(env, { id: 'g_live', game: 'toy', status: 'live', seats: [seat(alice, 'p0'), seat(bob, 'p1')] });
    insertGame(env, { id: 'g_noresult', game: 'toy', status: 'ended', ended_at: '2026-09-01T11:00:00Z', seats: [seat(alice, 'p0'), seat(bob, 'p1')] });

    await applyGameRatings(env, 'g_live');
    await applyGameRatings(env, 'g_noresult');
    await applyGameRatings(env, 'g_missing');

    expect(ratingRows(env)).toHaveLength(0);
    expect(env.db.db.prepare('SELECT COUNT(*) AS n FROM rated_games').get()).toMatchObject({ n: 0 });
  });

  it('respects a pre-claimed rated_games marker (concurrent applier won)', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice', 'op_a');
    const bob = insertAgent(env, 'bob', 'op_b');
    endedGame(env, 'g_1', [seat(alice, 'p0'), seat(bob, 'p1')], { winners: ['p0'], draw: false, reason: 'points' });
    env.db.db.prepare("INSERT INTO rated_games (game_id, rated_at) VALUES ('g_1', '2026-09-01T11:31:00Z')").run();

    await applyGameRatings(env, 'g_1');
    expect(ratingRows(env)).toHaveLength(0);
  });
});

describe('applyGameRatings: 4-player pairwise decomposition', () => {
  it('ranks by scores (competition ranking, ties share) and matches the reference update', async () => {
    const env = makeTestEnv();
    const agents = ['ann', 'ben', 'cam', 'dee'].map((h, i) => insertAgent(env, h, `op_${i}`));
    const result: GameResult = {
      winners: ['p2'],
      draw: false,
      reason: 'points',
      scores: { p0: 5, p1: 8, p2: 10, p3: 5 },
    };
    endedGame(
      env,
      'g_4p',
      agents.map((a, i) => seat(a, `p${i}`)),
      result,
    );

    await applyGameRatings(env, 'g_4p');

    const rows = ratingRows(env);
    expect(rows).toHaveLength(4);
    const byId = new Map(rows.map((r) => [r.agent_id, r]));
    const seatIds = agents.map((a) => a.agentId);

    // Reference computation with the same inputs.
    const standings: Standing[] = standingsFromResult(seatIds, result).map((p) => ({
      ...p,
      rating: { ...DEFAULT_GLICKO2 },
    }));
    // p2 first, p1 second, p0/p3 tied third.
    expect(standings.map((s) => s.position)).toEqual([3, 2, 1, 3]);
    const reference = pairwiseResults(standings);
    for (const id of seatIds) {
      const expected = rate({ ...DEFAULT_GLICKO2 }, reference.get(id)!);
      const got = byId.get(id)!;
      expect(got.rating).toBeCloseTo(expected.rating, 9);
      expect(got.rd).toBeCloseTo(expected.rd, 9);
      expect(got.games_played).toBe(1); // one game, not three pairs
    }
    // Winner strictly above the tied last pair; every player rated once.
    expect(byId.get(agents[2]!.agentId)!.rating).toBeGreaterThan(byId.get(agents[0]!.agentId)!.rating);
    expect(byId.get(agents[0]!.agentId)!.rating).toBeCloseTo(byId.get(agents[3]!.agentId)!.rating, 9);
  });
});

describe('rating scope variant key', () => {
  it("prefers the pairer's recorded lobby key (KV vkey:<id>) over derivation", async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice', 'op_a');
    const bob = insertAgent(env, 'bob', 'op_b');
    endedGame(env, 'g_1', [seat(alice, 'p0'), seat(bob, 'p1')], { winners: ['p0'], draw: false, reason: 'points' });
    await env.kv.put('vkey:g_1', 'blitz');

    await applyGameRatings(env, 'g_1');
    expect(ratingRows(env).every((r) => r.variant === 'blitz')).toBe(true);
  });

  it('derives the key from the variant config when KV is gone', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice', 'op_a');
    const bob = insertAgent(env, 'bob', 'op_b');
    endedGame(env, 'g_1', [seat(alice, 'p0'), seat(bob, 'p1')], { winners: ['p0'], draw: false, reason: 'points' });
    env.db.db.prepare("UPDATE games SET variant = ? WHERE id = 'g_1'").run(JSON.stringify({ starting_cash: 1000 }));

    await applyGameRatings(env, 'g_1');
    const expectedKey = canonicalJson({ starting_cash: 1000 });
    expect(ratingRows(env).every((r) => r.variant === expectedKey)).toBe(true);
  });

  it('variantKeyOf: empty/absent -> standard, JSON -> canonical, opaque -> verbatim', () => {
    expect(variantKeyOf(null)).toBe('standard');
    expect(variantKeyOf('')).toBe('standard');
    expect(variantKeyOf('{}')).toBe('standard');
    expect(variantKeyOf('{"b":2,"a":1}')).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(variantKeyOf('blitz')).toBe('blitz');
  });
});
