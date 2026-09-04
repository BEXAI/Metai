/**
 * The public API half of the speech channel (plan E10):
 *  - `utterance` is accepted, validated and forwarded to the room verbatim;
 *  - the two agent-authored MOVE fields have transport ceilings, and hitting
 *    one is a 400 BEFORE auth and before the room — never a strike;
 *  - every response that can carry another agent's words declares them in
 *    metadata.untrusted_fields, and the one that cannot still declares none;
 *  - the field is discoverable: route table -> openapi -> MCP inputSchema.
 */

import { describe, expect, it } from 'vitest';
import { ROUTES, openapiJson } from '../../doc.ts';
import { TOOLS, toolsList } from '../../mcp.ts';
import { handleApiRequest } from '../router.ts';
import { insertGame, makeTestEnv, type TestEnv } from './fakes.ts';
import { apiRequest, envelope, insertAgent, signedHeaders, type TestAgent } from './helpers.ts';

function seat(agent: TestAgent, player = 'p0'): { player: string; agent_id: string; handle: string; pubkey_ed25519: string } {
  return { player, agent_id: agent.agentId, handle: agent.handle, pubkey_ed25519: agent.pubkey };
}

const SIG = 'ab'.repeat(64);

/** A live werewolf-shaped game with `alice` in seat p0. */
function liveGame(): { env: TestEnv; agent: TestAgent } {
  const env = makeTestEnv();
  const agent = insertAgent(env, 'alice');
  insertGame(env, { id: 'g_ww', game: 'toy', status: 'live', seats: [seat(agent)] });
  return { env, agent };
}

async function postMove(env: TestEnv, agent: TestAgent, body: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify(body);
  const headers = { ...(await signedHeaders(env, agent, 'POST', '/api/games/g_ww/moves', raw)), 'content-type': 'application/json' };
  return handleApiRequest(env, apiRequest('POST', '/api/games/g_ww/moves', { headers, body: raw }));
}

describe('POST /api/games/:id/moves — utterance', () => {
  it('forwards the words to the room inside the signed submission', async () => {
    const { env, agent } = liveGame();
    env.rooms.script = () =>
      new Response(JSON.stringify({ ok: true, applied: true, notation: 'accuse(p1) "you dodged the check"' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const res = await postMove(env, agent, {
      game_id: 'g_ww',
      turn_index: 12,
      move: { index: 3 },
      utterance: 'you dodged the check',
      signature: SIG,
    });
    expect(res.status).toBe(200);
    const forwarded = JSON.parse(env.rooms.calls[0]!.body!) as { submission: { utterance?: string; signature?: string } };
    expect(forwarded.submission.utterance).toBe('you dodged the check');
    // The signature is lifted out of the submission, exactly as before — the
    // room re-verifies it over canonicalJson of everything else, utterance
    // included.
    expect(forwarded.submission.signature).toBeUndefined();
  });

  it('rejects a non-string or over-long utterance with BAD_UTTERANCE, and never calls the room', async () => {
    for (const utterance of [42, 'x'.repeat(4001)]) {
      const { env, agent } = liveGame();
      const res = await postMove(env, agent, { game_id: 'g_ww', turn_index: 12, move: { index: 0 }, utterance, signature: SIG });
      expect(res.status).toBe(400);
      expect((await envelope(res)).error?.code).toBe('BAD_UTTERANCE');
      // A REJECTION IS NEVER A STRIKE: the room — the only thing that can
      // record one — was never asked.
      expect(env.rooms.calls).toHaveLength(0);
    }
  });

  it('rejects an over-long notation string with MOVE_TOO_LONG, and never calls the room', async () => {
    const { env, agent } = liveGame();
    const res = await postMove(env, agent, {
      game_id: 'g_ww',
      turn_index: 12,
      move: `accuse(p1) "${'w'.repeat(4000)}"`,
      signature: SIG,
    });
    expect(res.status).toBe(400);
    const out = await envelope(res);
    expect(out.error?.code).toBe('MOVE_TOO_LONG');
    expect(out.error?.message).toMatch(/got \d+/); // the count, so it can be shortened
    expect(env.rooms.calls).toHaveLength(0);
  });

  it('accepts speech at the largest in-game limit — the ceiling is transport-only', async () => {
    const { env, agent } = liveGame();
    env.rooms.script = () => new Response(JSON.stringify({ ok: true, applied: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    const res = await postMove(env, agent, {
      game_id: 'g_ww',
      turn_index: 12,
      move: `say ${JSON.stringify('w'.repeat(600))}`,
      utterance: 'w'.repeat(600),
      signature: SIG,
    });
    expect(res.status).toBe(200);
  });
});

describe('metadata.untrusted_fields covers every agent-authored surface', () => {
  it('the view declares all three fenced fields', async () => {
    const { env, agent } = liveGame();
    env.rooms.script = () =>
      new Response(JSON.stringify({ turn_index: 12, legal_moves: [], history: [], speech: { limit: 600 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const headers = await signedHeaders(env, agent, 'GET', '/api/games/g_ww/view');
    const out = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/games/g_ww/view', { headers })));
    const fields = out.metadata?.untrusted_fields ?? [];
    expect(fields).toContain('data.view.history[].commentary');
    expect(fields).toContain('data.view.history[].notation');
    expect(fields).toContain('data.view.private_messages[].text');
    expect(fields).toContain('data.view.public.transcript[].text');
  });

  it('the spectator feed declares the transcript and the notation', async () => {
    const env = makeTestEnv();
    insertGame(env, { id: 'g_ww', game: 'toy', status: 'ended', ended_at: '2026-09-01T11:00:00Z' });
    env.db.db
      .prepare("INSERT INTO spectator_events (game_id, seq, public_event_json, created_at) VALUES ('g_ww', 1, ?, '2026-09-01T10:00:00Z')")
      .run(JSON.stringify({ type: 'move', data: { notation: 'accuse(p1) "you dodged it"', public: { transcript: [{ text: 'hi' }] } } }));
    const out = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/games/g_ww/events')));
    const fields = out.metadata?.untrusted_fields ?? [];
    expect(fields).toContain('data.events[].event.data.commentary');
    expect(fields).toContain('data.events[].event.data.notation');
    expect(fields).toContain('data.events[].event.data.public.transcript[].text');
  });

  it('the move verdict declares the events it carries back', async () => {
    const { env, agent } = liveGame();
    // A simultaneous phase resolving on this call returns EVERY seat's move.
    env.rooms.script = () =>
      new Response(
        JSON.stringify({ ok: true, applied: true, events: [{ seq: 9, type: 'move', data: { player: 'p3', notation: 'vote(p1) "wolf"' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const out = await envelope(await postMove(env, agent, { game_id: 'g_ww', turn_index: 12, move: { index: 0 }, signature: SIG }));
    const fields = out.metadata?.untrusted_fields ?? [];
    expect(fields).toContain('data.verdict.events[].data.notation');
    expect(fields).toContain('data.verdict.events[].data.public.transcript[].text');
  });

  it('the replay declares both copies of the words: the submission and the notation', async () => {
    const env = makeTestEnv();
    insertGame(env, {
      id: 'g_ww',
      game: 'toy',
      status: 'ended',
      ended_at: '2026-09-01T11:00:00Z',
      replay_r2_key: 'replays/g_ww.json',
    });
    await env.r2.put('replays/g_ww.json', JSON.stringify({ version: 'ludus.replay.v1', log: [] }));
    const out = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/games/g_ww/replay')));
    const fields = out.metadata?.untrusted_fields ?? [];
    expect(fields).toContain('data.replay.log[].payload.submission.commentary');
    expect(fields).toContain('data.replay.log[].payload.submission.utterance');
    expect(fields).toContain('data.replay.log[].payload.notation');
  });

  it('legal_moves ships the speech channel and STILL declares nothing untrusted', async () => {
    const { env, agent } = liveGame();
    const speech = { limit: 200, maxLimit: 600, audience: 'village', note: 'Revealed together with every other ballot.' };
    env.rooms.script = () =>
      new Response(JSON.stringify({ turn_index: 12, legal_moves: [{ index: 0, move: {}, notation: 'abstain' }], speech }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const headers = await signedHeaders(env, agent, 'GET', '/api/games/g_ww/legal_moves');
    const out = await envelope(await handleApiRequest(env, apiRequest('GET', '/api/games/g_ww/legal_moves', { headers })));
    expect(out.data?.speech).toEqual(speech);
    // Everything in this payload is engine-authored: the limits, the audience
    // and the house-written note. If that ever stops being true, this
    // assertion fails rather than the omission going unnoticed.
    expect(out.metadata?.untrusted_fields).toBeUndefined();
  });
});

describe('the utterance is discoverable on all four generated surfaces', () => {
  const moveRoute = ROUTES.find((r) => `${r.method} ${r.path}` === 'POST /api/games/:id/moves')!;

  it('is a body param on the move route, and rides into openapi and MCP unchanged', () => {
    const param = (moveRoute.params ?? []).find((p) => p.name === 'utterance');
    expect(param?.in).toBe('body');
    expect(param?.required).toBeFalsy();
    expect(moveRoute.summary).toContain('utterance');

    const doc = openapiJson('https://ludus.test') as {
      paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: { properties: Record<string, unknown> } }> } }>>;
    };
    const body = doc.paths['/api/games/{id}/moves']?.post?.requestBody;
    expect(body?.content['application/json']?.schema.properties).toHaveProperty('utterance');

    const { tools } = toolsList(false) as unknown as {
      tools: { name: string; inputSchema: { properties: { body: { properties: Record<string, unknown> } } } }[];
    };
    const tool = tools.find((t) => t.name === 'move')!;
    expect(tool.inputSchema.properties.body.properties).toHaveProperty('utterance');
    // MCP_TOOL_ORDER is frozen: a new field must not become a new tool.
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
  });
});
