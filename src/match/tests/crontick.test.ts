/**
 * cronTick end-to-end over in-memory fakes: real schema.sql (node:sqlite),
 * recorded GameRoom /create calls, games rows, lobby clearing, operator
 * conflicts, house backfill, drand fallback, and /api/pulse reflecting a
 * waiting turn on a game the WIRED path created.
 */

import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils';
import { sha256Hex } from '../../crypto/canonical.ts';
import { makeCommitment } from '../../crypto/commit.ts';
import { roundAt, type DrandFetch } from '../../crypto/drand.ts';
import { handleApiRequest } from '../../api/router.ts';
import { makeTestEnv, type TestEnv } from '../../api/tests/fakes.ts';
import { apiRequest, envelope, insertAgent, signedHeaders, type TestAgent } from '../../api/tests/helpers.ts';
import { cronTick, testSecretProvider } from '../pairing.ts';

// ---------------------------------------------------------------- helpers --

function joinLobby(
  env: TestEnv,
  agent: TestAgent,
  opts: { game?: string; variant?: string; division?: string; joinedAt?: string } = {},
): void {
  env.db.db
    .prepare('INSERT INTO lobby (game, variant, division, agent_id, joined_at) VALUES (?, ?, ?, ?, ?)')
    .run(
      opts.game ?? 'toy',
      opts.variant ?? 'standard',
      opts.division ?? 'open',
      agent.agentId,
      opts.joinedAt ?? '2026-09-01T00:00:00Z',
    );
}

function lobbyAgents(env: TestEnv): string[] {
  return (env.db.db.prepare('SELECT agent_id FROM lobby ORDER BY agent_id').all() as { agent_id: string }[]).map(
    (r) => r.agent_id,
  );
}

interface GamesRow {
  id: string;
  game: string;
  variant: string;
  division: string;
  season_id: string;
  status: string;
  commitment: string;
  drand_round: number;
  reveal_secret: string | null;
  seats_json: string;
  ruleset_version: string;
  replay_r2_key: string;
}

function gamesRows(env: TestEnv): GamesRow[] {
  return env.db.db.prepare('SELECT * FROM games ORDER BY id').all() as unknown as GamesRow[];
}

interface CreateBodySent {
  game_id: string;
  game: string;
  seats: { player: string; agent_id: string; handle: string; pubkey_ed25519: string }[];
  variant: Record<string, unknown>;
  division: string;
  ruleset_version: string;
  secret_hex: string;
  drand_round: number;
  drand_randomness: string;
}

const DRAND_SIG = 'ab'.repeat(48);
const DRAND_RANDOMNESS = sha256Hex(hexToBytes(DRAND_SIG));

const drandOk: DrandFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ round: 999, signature: DRAND_SIG }),
});

const drandDown: DrandFetch = async () => {
  throw new Error('network unreachable');
};

/** Script the fake DO: 201 on /create, scripted /state for pulse checks. */
function scriptRoom(env: TestEnv, state?: () => unknown): void {
  env.rooms.script = (call) => {
    if (call.url.endsWith('/create') && call.method === 'POST') {
      return new Response(JSON.stringify({}), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (call.url.endsWith('/state') && state) {
      return new Response(JSON.stringify(state()), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: false, code: 'no_game', message: 'unscripted' }), { status: 404 });
  };
}

// ------------------------------------------------------------------ tests --

describe('cronTick: lobby -> DO create -> games row -> lobby cleared', () => {
  it('creates the game for real with commitment, drand, seats, and replay key', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice', 'op_a');
    const bob = insertAgent(env, 'bob', 'op_b');
    joinLobby(env, alice, { joinedAt: '2026-09-01T00:00:00Z' });
    joinLobby(env, bob, { joinedAt: '2026-09-01T00:00:01Z' });
    scriptRoom(env);

    const out = await cronTick(env, { secrets: testSecretProvider('e2e-a'), drandFetch: drandOk });
    expect(out.paired).toBe(1);

    // Exactly one DO /create, carrying the full CreateRoomParams the room expects.
    const creates = env.rooms.calls.filter((c) => c.url.endsWith('/create'));
    expect(creates).toHaveLength(1);
    const sent = JSON.parse(creates[0]!.body ?? '{}') as CreateBodySent;
    expect(sent.game_id.startsWith('game_')).toBe(true);
    expect(sent.game).toBe('toy');
    expect(sent.division).toBe('open');
    expect(sent.variant).toEqual({});
    expect(sent.seats.map((s) => s.player)).toEqual(['p0', 'p1']);
    expect(new Set(sent.seats.map((s) => s.agent_id))).toEqual(new Set([alice.agentId, bob.agentId]));
    for (const seatSent of sent.seats) {
      const expected = seatSent.agent_id === alice.agentId ? alice : bob;
      expect(seatSent.pubkey_ed25519).toBe(expected.pubkey);
      expect(seatSent.handle).toBe(expected.handle);
    }
    expect(sent.secret_hex).toMatch(/^[0-9a-f]{64}$/);
    // The recorded round is safely at/after the commitment time (RoomCore.create's check).
    expect(sent.drand_round).toBeGreaterThan(roundAt(env.clock.ms));
    expect(sent.drand_randomness).toBe(DRAND_RANDOMNESS);
    // The DO id is the game id (env.GAME_ROOM.idFromName(game_id)).
    expect(creates[0]!.gameId).toBe(sent.game_id);

    // The games row matches the room's game exactly.
    const rows = gamesRows(env);
    expect(rows).toHaveLength(1);
    const g = rows[0]!;
    expect(g.id).toBe(sent.game_id);
    expect(g.status).toBe('live');
    expect(g.commitment).toBe(makeCommitment(sent.game_id, sent.secret_hex));
    expect(g.drand_round).toBe(sent.drand_round);
    expect(g.reveal_secret).toBeNull();
    expect(g.replay_r2_key).toBe(`replays/${sent.game_id}.json`);
    expect(g.season_id).toBe('2026-09');
    expect(JSON.parse(g.seats_json)).toEqual(sent.seats);
    // Season row satisfied the FK; lobby queue key recorded for ratings scope.
    expect(env.db.db.prepare("SELECT id FROM seasons WHERE id = '2026-09'").get()).toBeTruthy();
    expect(await env.kv.get(`vkey:${sent.game_id}`)).toBe('standard');

    // Seated lobby rows deleted.
    expect(lobbyAgents(env)).toEqual([]);
  });

  it('never seats two agents of one operator; the conflicting entry waits', async () => {
    const env = makeTestEnv();
    const a1 = insertAgent(env, 'a1', 'op_shared');
    const a2 = insertAgent(env, 'a2', 'op_shared');
    const b1 = insertAgent(env, 'b1', 'op_other');
    joinLobby(env, a1, { joinedAt: '2026-09-01T00:00:00Z' });
    joinLobby(env, a2, { joinedAt: '2026-09-01T00:00:01Z' });
    joinLobby(env, b1, { joinedAt: '2026-09-01T00:00:02Z' });
    scriptRoom(env);

    const out = await cronTick(env, { secrets: testSecretProvider('e2e-b'), drandFetch: drandOk });
    expect(out.paired).toBe(1);
    const seated = new Set(
      (JSON.parse(gamesRows(env)[0]!.seats_json) as { agent_id: string }[]).map((s) => s.agent_id),
    );
    expect(seated).toEqual(new Set([a1.agentId, b1.agentId]));
    expect(lobbyAgents(env)).toEqual([a2.agentId]);

    // Next tick: a2 alone, still no partner -> no game; waited-sweep state persisted in KV.
    const again = await cronTick(env, { secrets: testSecretProvider('e2e-b'), drandFetch: drandOk });
    expect(again.paired).toBe(0);
    expect(lobbyAgents(env)).toEqual([a2.agentId]);
    const state = JSON.parse((await env.kv.get('pairer:state')) ?? '{}') as { sweeps: Record<string, number> };
    expect(Object.values(state.sweeps)).toEqual([2]);
  });

  it('backfills with registered house agents after 2 waited sweeps', async () => {
    const env = makeTestEnv();
    const solo = insertAgent(env, 'solo', 'op_solo');
    const houseRandom = insertAgent(env, 'house-random-1', 'op_house');
    insertAgent(env, 'house-anthropic-1', 'op_house'); // excluded: no key in ApiEnv
    joinLobby(env, solo);
    scriptRoom(env);

    const opts = { secrets: testSecretProvider('e2e-c'), drandFetch: drandOk };
    expect((await cronTick(env, opts)).paired).toBe(0); // waited 0
    expect((await cronTick(env, opts)).paired).toBe(0); // waited 1
    expect((await cronTick(env, opts)).paired).toBe(1); // waited 2 -> backfill

    const seats = JSON.parse(gamesRows(env)[0]!.seats_json) as { agent_id: string }[];
    expect(new Set(seats.map((s) => s.agent_id))).toEqual(new Set([solo.agentId, houseRandom.agentId]));
    expect(lobbyAgents(env)).toEqual([]);
  });

  it('drand unreachable: zero randomness is mixed and a docket entry records it', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice', 'op_a');
    const bob = insertAgent(env, 'bob', 'op_b');
    joinLobby(env, alice);
    joinLobby(env, bob, { joinedAt: '2026-09-01T00:00:01Z' });
    scriptRoom(env);

    const out = await cronTick(env, { secrets: testSecretProvider('e2e-d'), drandFetch: drandDown });
    expect(out.paired).toBe(1);
    const sent = JSON.parse(env.rooms.calls.find((c) => c.url.endsWith('/create'))!.body ?? '{}') as CreateBodySent;
    expect(sent.drand_randomness).toBe('0'.repeat(64));
    const docket = env.db.db.prepare('SELECT kind, subject_json, disposition FROM docket').all() as {
      kind: string;
      subject_json: string;
      disposition: string;
    }[];
    expect(docket).toHaveLength(1);
    expect(docket[0]!.kind).toBe('drand_unavailable');
    expect(docket[0]!.disposition).toBe('noted');
    expect((JSON.parse(docket[0]!.subject_json) as { game_id: string }).game_id).toBe(sent.game_id);
  });

  it('a failing room /create propagates (cron step catches) and leaves the lobby intact', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice', 'op_a');
    const bob = insertAgent(env, 'bob', 'op_b');
    joinLobby(env, alice);
    joinLobby(env, bob, { joinedAt: '2026-09-01T00:00:01Z' });
    // default script: every room call 404s
    await expect(cronTick(env, { secrets: testSecretProvider('e2e-e'), drandFetch: drandOk })).rejects.toThrow(
      /room \/create/,
    );
    expect(gamesRows(env)).toHaveLength(0);
    expect(lobbyAgents(env).sort()).toEqual([alice.agentId, bob.agentId].sort());
  });
});

describe('pulse over the wired path', () => {
  it('waiting_on_you lists a cronTick-created game whose room waits on the agent', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice', 'op_a');
    const bob = insertAgent(env, 'bob', 'op_b');
    joinLobby(env, alice);
    joinLobby(env, bob, { joinedAt: '2026-09-01T00:00:01Z' });

    let alicePlayer = 'p0';
    scriptRoom(env, () => ({ turn_index: 4, deadline_at_ms: env.clock.ms + 60_000, waiting_for: [alicePlayer] }));
    await cronTick(env, { secrets: testSecretProvider('e2e-f'), drandFetch: drandOk });
    const g = gamesRows(env)[0]!;
    const seats = JSON.parse(g.seats_json) as { player: string; agent_id: string }[];
    alicePlayer = seats.find((s) => s.agent_id === alice.agentId)!.player;

    const headers = await signedHeaders(env, alice, 'GET', '/api/pulse');
    const auth = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/pulse', { headers })));
    expect(auth.data?.live_games).toBe(1);
    expect(auth.data?.waiting_on_you).toEqual([
      { game_id: g.id, turn_index: 4, deadline_utc: new Date(env.clock.ms + 60_000).toISOString() },
    ]);

    // The other seat is NOT waiting.
    const bobHeaders = await signedHeaders(env, bob, 'GET', '/api/pulse');
    const bobPulse = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/pulse', { headers: bobHeaders })));
    expect(bobPulse.data?.waiting_on_you).toEqual([]);
  });
});
