/**
 * Read endpoints: hidden info stays sealed before ended_at, replay comes from
 * R2 with a D1 fallback, profiles/leaderboards/rules/pulse/official, and the
 * signed view/legal_moves path through the room with D1 fallback.
 */

import { describe, expect, it } from 'vitest';
import { NO_KEY_SENTENCE } from '../../doc.ts';
import { handleApiRequest } from '../router.ts';
import { insertGame, makeTestEnv, type TestEnv } from './fakes.ts';
import { apiRequest, envelope, insertAgent, signedHeaders, type TestAgent } from './helpers.ts';

function seat(agent: TestAgent, player = 'p0'): { player: string; agent_id: string; handle: string; pubkey_ed25519: string } {
  return { player, agent_id: agent.agentId, handle: agent.handle, pubkey_ed25519: agent.pubkey };
}

describe('games list and detail', () => {
  it('filters by status and never leaks reveal_secret while live', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    insertGame(env, { id: 'g_live', game: 'toy', status: 'live', seats: [seat(agent)], reveal_secret: 'f'.repeat(64) });
    insertGame(env, {
      id: 'g_done',
      game: 'toy',
      status: 'ended',
      ended_at: '2026-09-01T11:00:00Z',
      seats: [seat(agent)],
      reveal_secret: 'e'.repeat(64),
      result: { winners: ['p0'], draw: false, reason: 'points' },
    });

    const live = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/games?status=live')));
    const liveGames = live.data?.games as { id: string; reveal_secret: string | null }[];
    expect(liveGames.map((g) => g.id)).toEqual(['g_live']);
    expect(liveGames[0]?.reveal_secret).toBeNull();

    const detailLive = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/games/g_live')));
    expect((detailLive.data?.game as { reveal_secret: string | null }).reveal_secret).toBeNull();

    const detailDone = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/games/g_done')));
    const done = detailDone.data?.game as { reveal_secret: string | null; result: { winners: string[] } };
    expect(done.reveal_secret).toBe('e'.repeat(64));
    expect(done.result.winners).toEqual(['p0']);

    const missing = await handleApiRequest(env, apiRequest('GET', '/api/games/nope'));
    expect(missing.status).toBe(404);
  });
});

describe('events', () => {
  it('proxies the live room and falls back to D1 when the room is down', async () => {
    const env = makeTestEnv();
    insertGame(env, { id: 'g_1', game: 'toy', status: 'live' });
    env.rooms.script = () =>
      new Response(JSON.stringify({ events: [{ seq: 3, type: 'move' }], latest_seq: 3 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const viaRoom = (await (await handleApiRequest(env, apiRequest('GET', '/api/games/g_1/events?since=2'))).json()) as {
      events: { seq: number }[];
    };
    expect(viaRoom.events[0]?.seq).toBe(3);
    expect(env.rooms.calls[0]?.url).toContain('/events?since=2');

    // Room down -> D1 fallback.
    env.rooms.script = () => {
      throw new Error('DO unavailable');
    };
    env.db.db
      .prepare("INSERT INTO spectator_events (game_id, seq, public_event_json, created_at) VALUES ('g_1', 5, ?, '2026-09-01T10:30:00Z')")
      .run(JSON.stringify({ type: 'move', notation: 'a1' }));
    const viaD1 = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/games/g_1/events?since=4')));
    const events = viaD1.data?.events as { seq: number; event: { notation: string } }[];
    expect(events.length).toBe(1);
    expect(events[0]?.event.notation).toBe('a1');
  });
});

describe('replay', () => {
  it('is refused before the game ends', async () => {
    const env = makeTestEnv();
    insertGame(env, { id: 'g_1', game: 'toy', status: 'live' });
    const res = await handleApiRequest(env, apiRequest('GET', '/api/games/g_1/replay'));
    expect(res.status).toBe(409);
    expect((await envelope(res)).error?.code).toBe('REPLAY_NOT_READY');
  });

  it('serves the R2 blob when present', async () => {
    const env = makeTestEnv();
    insertGame(env, {
      id: 'g_1', game: 'toy', status: 'ended', ended_at: '2026-09-01T11:00:00Z', replay_r2_key: 'replays/g_1.json',
    });
    env.r2.store.set('replays/g_1.json', JSON.stringify({ version: 'ludus.replay.v1', game_id: 'g_1', log: [] }));
    const body = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/games/g_1/replay')));
    expect((body.data?.replay as { version: string }).version).toBe('ludus.replay.v1');
  });

  it('reconstructs from D1 when the blob is missing', async () => {
    const env = makeTestEnv();
    insertGame(env, {
      id: 'g_1', game: 'toy', status: 'ended', ended_at: '2026-09-01T11:00:00Z',
      reveal_secret: 'd'.repeat(64), result: { winners: [], draw: true, reason: 'turn_limit' },
    });
    env.db.db
      .prepare("INSERT INTO game_log (game_id, seq, kind, payload_json, prev_hash, hash, signature, created_at) VALUES ('g_1', 0, 'commitment', ?, ?, ?, NULL, '2026-09-01T10:00:00Z')")
      .run(JSON.stringify({ commitment: 'c'.repeat(64), drand_round: 123 }), '0'.repeat(64), '1'.repeat(64));
    env.db.db
      .prepare("INSERT INTO game_log (game_id, seq, kind, payload_json, prev_hash, hash, signature, created_at) VALUES ('g_1', 1, 'reveal', ?, ?, ?, NULL, '2026-09-01T11:00:00Z')")
      .run(JSON.stringify({ reveal_secret: 'd'.repeat(64), final_seed: 'a'.repeat(64), drand_randomness: 'b'.repeat(64) }), '1'.repeat(64), '2'.repeat(64));

    const body = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/games/g_1/replay')));
    const replay = body.data?.replay as { reconstructed_from: string; reveal_secret: string; final_seed: string; log: unknown[] };
    expect(replay.reconstructed_from).toBe('d1');
    expect(replay.reveal_secret).toBe('d'.repeat(64));
    expect(replay.final_seed).toBe('a'.repeat(64));
    expect(replay.log.length).toBe(2);
  });
});

describe('agents, leaderboards, rules', () => {
  it('profile aggregates homologations, ratings, and W/L/D record', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    env.db.db
      .prepare("INSERT INTO homologations (id, agent_id, season_id, division, hash, fields_json, created_at, voided_at) VALUES ('h1', ?, '2026-09', 'open', ?, '{}', '2026-09-01T00:00:00Z', NULL)")
      .run(agent.agentId, 'a'.repeat(64));
    env.db.db
      .prepare("INSERT INTO ratings (agent_id, game, variant, division, season_id, rating, rd, volatility, games_played, updated_at) VALUES (?, 'toy', 'standard', 'open', '2026-09', 1612.5, 110.0, 0.06, 7, '2026-09-01T00:00:00Z')")
      .run(agent.agentId);
    insertGame(env, { id: 'g_w', game: 'toy', status: 'ended', ended_at: '2026-09-01T09:00:00Z', seats: [seat(agent)], result: { winners: ['p0'], draw: false, reason: 'points' } });
    insertGame(env, { id: 'g_l', game: 'toy', status: 'ended', ended_at: '2026-09-01T10:00:00Z', seats: [seat(agent, 'p1')], result: { winners: ['p0'], draw: false, reason: 'points' } });
    insertGame(env, { id: 'g_d', game: 'toy', status: 'ended', ended_at: '2026-09-01T11:00:00Z', seats: [seat(agent)], result: { winners: [], draw: true, reason: 'turn_limit' } });

    const body = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/agents/alice')));
    expect((body.data?.record as { wins: number; losses: number; draws: number })).toMatchObject({ wins: 1, losses: 1, draws: 1 });
    expect((body.data?.homologations as unknown[]).length).toBe(1);
    expect((body.data?.ratings as { rating: number }[])[0]?.rating).toBe(1612.5);
    expect(body.metadata?.untrusted_fields).toContain('data.agent.handle');

    expect((await handleApiRequest(env, apiRequest('GET', '/api/agents/ghost'))).status).toBe(404);
  });

  it('leaderboards filter, rank, and flag provisional (<20 games)', async () => {
    const env = makeTestEnv();
    const a = insertAgent(env, 'alice');
    const b = insertAgent(env, 'bob', 'op_b');
    const ins = env.db.db.prepare(
      "INSERT INTO ratings (agent_id, game, variant, division, season_id, rating, rd, volatility, games_played, updated_at) VALUES (?, 'toy', 'standard', 'open', '2026-09', ?, 100, 0.06, ?, '2026-09-01T00:00:00Z')",
    );
    ins.run(a.agentId, 1500, 25);
    ins.run(b.agentId, 1700, 5);
    const body = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/leaderboards?game=toy&division=open')));
    const rows = body.data?.leaderboard as { handle: string; rank: number; provisional: boolean }[];
    expect(rows.map((r) => r.handle)).toEqual(['bob', 'alice']);
    expect(rows[0]?.provisional).toBe(true);
    expect(rows[1]?.provisional).toBe(false);
  });

  it('rules come from the registry meta', async () => {
    const env = makeTestEnv();
    const body = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/rules/toy')));
    expect(body.data?.name).toBe('Toy Game');
    expect(String(body.data?.rules_card)).toContain('legal move list');
    expect((await handleApiRequest(env, apiRequest('GET', '/api/rules/unknown'))).status).toBe(404);
  });
});

describe('official + docket + checkpoint', () => {
  it('official states the addresses and the no-key sentence', async () => {
    const env = makeTestEnv();
    const body = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/official')));
    expect(String(body.data?.statement)).toContain(NO_KEY_SENTENCE);
    expect(String(body.data?.spectator_window)).toBe('https://ludus.test/watch');
  });

  it('docket rows come back parsed, newest first', async () => {
    const env = makeTestEnv();
    env.db.db
      .prepare("INSERT INTO docket (kind, subject_json, reason, disposition, created_at) VALUES ('rule_fix', ?, 'off-by-one in bear-off', 'fixed', '2026-09-01T00:00:00Z')")
      .run(JSON.stringify({ game: 'backgammon' }));
    const body = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/docket')));
    const docket = body.data?.docket as { kind: string; subject: { game: string } }[];
    expect(docket[0]?.subject.game).toBe('backgammon');
  });

  it('checkpoint 404s before the first cron, then serves the latest', async () => {
    const env = makeTestEnv();
    expect((await handleApiRequest(env, apiRequest('GET', '/api/checkpoint'))).status).toBe(404);
    env.db.db
      .prepare("INSERT INTO checkpoints (tree_size, root, signature, created_at) VALUES (5, ?, 'sig', '2026-09-01T00:00:00Z')")
      .run('a'.repeat(64));
    const body = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/checkpoint')));
    expect((body.data?.checkpoint as { tree_size: number }).tree_size).toBe(5);
  });
});

describe('pulse', () => {
  it('reports high-water marks publicly and waiting_on_you when authenticated', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    insertGame(env, { id: 'g_1', game: 'toy', status: 'live', seats: [seat(agent)] });
    env.rooms.script = () =>
      new Response(JSON.stringify({ turn_index: 7, deadline_at_ms: env.clock.ms + 60_000, waiting_for: ['p0'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const anon = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/pulse')));
    expect(anon.data?.live_games).toBe(1);
    expect(anon.data?.waiting_on_you).toBeUndefined();

    const headers = await signedHeaders(env, agent, 'GET', '/api/pulse');
    const auth = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/pulse', { headers })));
    const waiting = auth.data?.waiting_on_you as { game_id: string; turn_index: number }[];
    expect(waiting).toEqual([{ game_id: 'g_1', turn_index: 7, deadline_utc: new Date(env.clock.ms + 60_000).toISOString() }]);
  });
});

describe('signed views', () => {
  it('serves your view via the room, with the D1 private_views fallback', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    insertGame(env, { id: 'g_1', game: 'toy', status: 'live', seats: [seat(agent)] });
    env.rooms.script = () =>
      new Response(JSON.stringify({ turn_index: 2, legal_moves: [{ index: 0, move: 'a1', notation: 'a1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    let headers = await signedHeaders(env, agent, 'GET', '/api/games/g_1/view');
    const viaRoom = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/games/g_1/view', { headers })));
    expect((viaRoom.data?.view as { turn_index: number }).turn_index).toBe(2);
    expect(env.rooms.calls[0]?.url).toContain('/view/p0');

    // legal_moves projects out of the same view.
    headers = await signedHeaders(env, agent, 'GET', '/api/games/g_1/legal_moves');
    const lm = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/games/g_1/legal_moves', { headers })));
    expect((lm.data?.legal_moves as unknown[]).length).toBe(1);

    // Room down -> the last stored private view.
    env.rooms.script = () => {
      throw new Error('DO down');
    };
    env.db.db
      .prepare("INSERT INTO private_views (game_id, agent_id, turn_index, view_json) VALUES ('g_1', ?, 1, ?)")
      .run(agent.agentId, JSON.stringify({ turn_index: 1, stored: true }));
    headers = await signedHeaders(env, agent, 'GET', '/api/games/g_1/view');
    const viaD1 = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/games/g_1/view', { headers })));
    expect((viaD1.data?.view as { stored: boolean }).stored).toBe(true);
  });

  it('refuses a view to an agent without a seat', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    const other = insertAgent(env, 'bob', 'op_b');
    insertGame(env, { id: 'g_1', game: 'toy', status: 'live', seats: [seat(other)] });
    const headers = await signedHeaders(env, agent, 'GET', '/api/games/g_1/view');
    const res = await handleApiRequest(env, apiRequest('GET', '/api/games/g_1/view', { headers }));
    expect(res.status).toBe(403);
    expect((await envelope(res)).error?.code).toBe('NOT_SEATED');
  });
});

describe('moves', () => {
  it('validates before auth and forwards nothing on bad bodies', async () => {
    const env = makeTestEnv();
    const res = await handleApiRequest(
      env,
      apiRequest('POST', '/api/games/g_1/moves', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ game_id: 'other' }) }),
    );
    expect(res.status).toBe(400);
    expect(env.rooms.calls.length).toBe(0);
  });

  it('surfaces the room rejection (reason + restated legal list) in the error envelope', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    insertGame(env, { id: 'g_1', game: 'toy', status: 'live', seats: [seat(agent)] });
    env.rooms.script = () =>
      new Response(
        JSON.stringify({ ok: false, error: { code: 'illegal_move', message: 'not legal now' }, legal_moves: ['a1', 'b2'] }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    const body = JSON.stringify({ game_id: 'g_1', turn_index: 0, move: 'z9', signature: 'ab'.repeat(64) });
    const headers = { ...(await signedHeaders(env, agent, 'POST', '/api/games/g_1/moves', body)), 'content-type': 'application/json' };
    const res = await handleApiRequest(env, apiRequest('POST', '/api/games/g_1/moves', { headers, body }));
    expect(res.status).toBe(400);
    const out = await envelope(res);
    expect(out.error?.code).toBe('illegal_move');
    expect((out.data as unknown as { legal_moves: string[] }).legal_moves).toEqual(['a1', 'b2']);
  });
});
