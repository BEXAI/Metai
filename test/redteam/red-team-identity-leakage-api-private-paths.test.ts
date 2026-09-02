/**
 * RED TEAM red-team-identity-leakage — attack family 3 (API):
 * reach another agent's private view, a live game's hidden data, or the
 * reveal secret through the HTTP surface (src/api/handlers.ts). Asserts the
 * DEFENDED behavior of spec §api.write_signed, §identity_and_integrity
 * .spectator_reveal, and data_model.rules ("reveal_secret and private_views
 * never join into a public response before ended_at").
 */

import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../../src/api/router.ts';
import { insertGame, makeTestEnv, type TestEnv } from '../../src/api/tests/fakes.ts';
import { apiRequest, envelope, insertAgent, signedHeaders, type TestAgent } from '../../src/api/tests/helpers.ts';

const ALICE_TOKEN = 'ALICE_PRIVATE_VIEW_TOKEN_DO_NOT_LEAK';
const BOB_TOKEN = 'BOB_PRIVATE_VIEW_TOKEN_DO_NOT_LEAK';

function seatFor(agent: TestAgent, player: string) {
  return { player, agent_id: agent.agentId, handle: agent.handle, pubkey_ed25519: agent.pubkey };
}

function twoSeatGame(env: TestEnv, id: string, alice: TestAgent, bob: TestAgent, status = 'live'): void {
  insertGame(env, {
    id,
    game: 'toy',
    status,
    seats: [seatFor(bob, 'p0'), seatFor(alice, 'p1')],
  });
}

async function get(env: TestEnv, agent: TestAgent, pathAndQuery: string, signPath?: string) {
  const path = signPath ?? pathAndQuery.split('?')[0]!;
  const headers = await signedHeaders(env, agent, 'GET', path);
  return handleApiRequest(env, apiRequest('GET', pathAndQuery, { headers }));
}

// ---------------------------------------------------------------------------
// 1. /view and /legal_moves: seat binding comes from the signature, full stop
// ---------------------------------------------------------------------------

describe('GET /api/games/:id/view seat binding', () => {
  it('serves ONLY the seat bound to the authenticated key; ?player= is inert', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    const bob = insertAgent(env, 'bob', 'op_other');
    twoSeatGame(env, 'g-view', alice, bob);
    env.rooms.script = (call) =>
      new Response(JSON.stringify({ marker: 'room-view', url: call.url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    // Alice (seated p1) asks for p0's view via a query parameter.
    const res = await get(env, alice, '/api/games/g-view/view?player=p0&seat=0');
    expect(res.status).toBe(200);
    expect(env.rooms.calls).toHaveLength(1);
    const roomUrl = new URL(env.rooms.calls[0]!.url);
    expect(roomUrl.pathname).toBe('/view/p1'); // HER seat, not the requested one
  });

  it('an authenticated agent NOT seated in the game gets 403 and the room is never called', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    const bob = insertAgent(env, 'bob', 'op_b');
    const carol = insertAgent(env, 'carol', 'op_c');
    twoSeatGame(env, 'g-outsider', alice, bob);

    for (const path of ['/api/games/g-outsider/view', '/api/games/g-outsider/legal_moves']) {
      const res = await get(env, carol, path);
      expect(res.status, path).toBe(403);
      expect((await envelope(res)).error?.code, path).toBe('NOT_SEATED');
    }
    expect(env.rooms.calls).toHaveLength(0);
  });

  it('a spectator with no auth headers at all gets 401 on /view', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    const bob = insertAgent(env, 'bob', 'op_b');
    twoSeatGame(env, 'g-anon', alice, bob);
    const res = await handleApiRequest(env, apiRequest('GET', '/api/games/g-anon/view'));
    expect(res.status).toBe(401);
    expect(env.rooms.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. private_views storage is served only to its owner
// ---------------------------------------------------------------------------

describe('private_views D1 fallback ownership', () => {
  function seedPrivateViews(env: TestEnv, gameId: string, alice: TestAgent, bob: TestAgent): void {
    const ins = env.db.db.prepare(
      'INSERT INTO private_views (game_id, agent_id, turn_index, view_json) VALUES (?, ?, ?, ?)',
    );
    ins.run(gameId, alice.agentId, 3, JSON.stringify({ private: { secret: ALICE_TOKEN }, turn_index: 3 }));
    ins.run(gameId, bob.agentId, 3, JSON.stringify({ private: { secret: BOB_TOKEN }, turn_index: 3 }));
  }

  it("the room-down fallback returns the caller's stored view and never the other seat's", async () => {
    const env = makeTestEnv(); // default room script 404s -> D1 fallback
    const alice = insertAgent(env, 'alice');
    const bob = insertAgent(env, 'bob', 'op_other');
    twoSeatGame(env, 'g-pv', alice, bob);
    seedPrivateViews(env, 'g-pv', alice, bob);

    const resA = await get(env, alice, '/api/games/g-pv/view');
    expect(resA.status).toBe(200);
    const bodyA = JSON.stringify(await envelope(resA));
    expect(bodyA).toContain(ALICE_TOKEN);
    expect(bodyA).not.toContain(BOB_TOKEN);

    const resB = await get(env, bob, '/api/games/g-pv/view');
    expect(resB.status).toBe(200);
    const bodyB = JSON.stringify(await envelope(resB));
    expect(bodyB).toContain(BOB_TOKEN);
    expect(bodyB).not.toContain(ALICE_TOKEN);
  });

  it('stored private views never surface on the PUBLIC game endpoints', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    const bob = insertAgent(env, 'bob', 'op_other');
    twoSeatGame(env, 'g-pv-pub', alice, bob);
    seedPrivateViews(env, 'g-pv-pub', alice, bob);
    env.db.db
      .prepare('INSERT INTO spectator_events (game_id, seq, public_event_json, created_at) VALUES (?, ?, ?, ?)')
      .run('g-pv-pub', 1, JSON.stringify({ type: 'move', notation: 'e4' }), '2026-09-01T10:00:00Z');

    for (const path of ['/api/games/g-pv-pub', '/api/games/g-pv-pub/events', '/api/games?status=live']) {
      const res = await handleApiRequest(env, apiRequest('GET', path));
      expect(res.status, path).toBe(200);
      const body = await res.text();
      expect(body, path).not.toContain(ALICE_TOKEN);
      expect(body, path).not.toContain(BOB_TOKEN);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Replays of LIVE games (hidden info only after end)
// ---------------------------------------------------------------------------

describe('replay gating for live games', () => {
  const REVEAL = 'a1'.repeat(32);

  it('409s on a live game even when the replay blob ALREADY exists in R2', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    const bob = insertAgent(env, 'bob', 'op_other');
    insertGame(env, {
      id: 'g-early-blob',
      game: 'toy',
      status: 'live',
      seats: [seatFor(bob, 'p0'), seatFor(alice, 'p1')],
      replay_r2_key: 'replays/g-early-blob.json',
    });
    // The room uploaded early (or an attacker hopes it did).
    await env.r2.put(
      'replays/g-early-blob.json',
      JSON.stringify({ reveal_secret: REVEAL, log: [], hidden: ALICE_TOKEN }),
    );

    const res = await handleApiRequest(env, apiRequest('GET', '/api/games/g-early-blob/replay'));
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).not.toContain(REVEAL);
    expect(body).not.toContain(ALICE_TOKEN);
    expect((JSON.parse(body) as { error?: { code: string } }).error?.code).toBe('REPLAY_NOT_READY');
  });

  it('409s on a live game even when game_log rows (incl. a reveal) sit in D1', async () => {
    const env = makeTestEnv();
    insertGame(env, { id: 'g-early-log', game: 'toy', status: 'live', seats: [] });
    const ins = env.db.db.prepare(
      'INSERT INTO game_log (game_id, seq, kind, payload_json, prev_hash, hash, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
    );
    ins.run('g-early-log', 0, 'commitment', JSON.stringify({ commitment: 'c'.repeat(64) }), '0'.repeat(64), '1'.repeat(64), '2026-09-01T10:00:00Z');
    ins.run('g-early-log', 1, 'reveal', JSON.stringify({ reveal_secret: REVEAL }), '1'.repeat(64), '2'.repeat(64), '2026-09-01T10:00:01Z');

    const res = await handleApiRequest(env, apiRequest('GET', '/api/games/g-early-log/replay'));
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain(REVEAL);
  });

  it('the same replay serves normally once the game row is ended', async () => {
    const env = makeTestEnv();
    insertGame(env, {
      id: 'g-done',
      game: 'toy',
      status: 'ended',
      seats: [],
      ended_at: '2026-09-01T11:00:00Z',
      reveal_secret: REVEAL,
      replay_r2_key: 'replays/g-done.json',
    });
    await env.r2.put('replays/g-done.json', JSON.stringify({ version: 'ludus.replay.v1', reveal_secret: REVEAL, log: [] }));
    const res = await handleApiRequest(env, apiRequest('GET', '/api/games/g-done/replay'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(REVEAL);
  });
});

// ---------------------------------------------------------------------------
// 4. reveal_secret column never joins a public response pre-end
// ---------------------------------------------------------------------------

describe('reveal_secret gating on game detail and listing', () => {
  const REVEAL = 'b2'.repeat(32);

  it('a live row with reveal_secret ALREADY populated still serves null', async () => {
    const env = makeTestEnv();
    insertGame(env, { id: 'g-reveal-live', game: 'toy', status: 'live', seats: [], reveal_secret: REVEAL });

    const detail = await handleApiRequest(env, apiRequest('GET', '/api/games/g-reveal-live'));
    expect(detail.status).toBe(200);
    const detailText = await detail.text();
    expect(detailText).not.toContain(REVEAL);
    const game = (await envelope(await handleApiRequest(env, apiRequest('GET', '/api/games/g-reveal-live')))).data
      ?.game as { reveal_secret: unknown; replay: unknown };
    expect(game.reveal_secret).toBeNull();
    expect(game.replay).toBeNull(); // no replay link while live

    const list = await handleApiRequest(env, apiRequest('GET', '/api/games?status=live'));
    expect(await list.text()).not.toContain(REVEAL);
  });

  it('after ended_at the same row serves the secret (sanctioned reveal)', async () => {
    const env = makeTestEnv();
    insertGame(env, {
      id: 'g-reveal-done',
      game: 'toy',
      status: 'ended',
      seats: [],
      ended_at: '2026-09-01T11:00:00Z',
      reveal_secret: REVEAL,
    });
    const res = await handleApiRequest(env, apiRequest('GET', '/api/games/g-reveal-done'));
    expect(await res.text()).toContain(REVEAL);
  });
});
