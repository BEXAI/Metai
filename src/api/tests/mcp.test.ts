/**
 * MCP server: tools/list matches spec api.mcp_tools EXACTLY (names + order),
 * readOnlyHint annotations, the /mcp/read door only exposes read tools, and
 * tools/call delegates to the SAME handlers as HTTP (a move submitted via
 * MCP reaches the room byte-identically to one submitted via HTTP).
 */

import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../../crypto/canonical.ts';
import { authMessage, issueChallenge } from '../../identity/auth.ts';
import { sign } from '../../identity/ed25519.ts';
import { handleMcpRpc } from '../../mcp.ts';
import type { Json } from '../../kernel/types.ts';
import { handleApiRequest } from '../router.ts';
import { insertGame, makeTestEnv, type TestEnv } from './fakes.ts';
import { apiRequest, insertAgent, type TestAgent } from './helpers.ts';

/** The list frozen in LUDUS_BUILD_SPEC.json §api.mcp_tools — do not derive. */
const SPEC_MCP_TOOLS = [
  'register', 'homologate', 'lobby_join', 'lobby_leave', 'my_games', 'view', 'legal_moves',
  'move', 'resign', 'offer_draw', 'game', 'replay', 'leaderboard', 'rules', 'pulse', 'docket',
];

const READ_TOOLS = ['my_games', 'view', 'legal_moves', 'game', 'replay', 'leaderboard', 'rules', 'pulse', 'docket'];

interface RpcOut {
  jsonrpc: string;
  id: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function rpc(env: TestEnv, method: string, params: unknown = {}, readOnly = false): Promise<RpcOut> {
  const out = await handleMcpRpc(env, { jsonrpc: '2.0', id: 1, method, params }, readOnly);
  return out as unknown as RpcOut;
}

describe('initialize', () => {
  it('speaks MCP with the no-key sentence in instructions', async () => {
    const env = makeTestEnv();
    const res = await rpc(env, 'initialize');
    const result = res.result as { protocolVersion: string; instructions: string; serverInfo: { name: string } };
    expect(result.protocolVersion).toBeTruthy();
    expect(result.instructions).toContain('never generates or stores private keys');
    expect(result.serverInfo.name).toBe('naibul');
  });

  it('unknown methods -> -32601; bad jsonrpc -> -32600', async () => {
    const env = makeTestEnv();
    expect((await rpc(env, 'no/such')).error?.code).toBe(-32601);
    const bad = (await handleMcpRpc(env, { jsonrpc: '1.0', id: 1, method: 'ping' }, false)) as unknown as RpcOut;
    expect(bad.error?.code).toBe(-32600);
  });
});

describe('tools/list', () => {
  it('matches the spec tool list exactly, in order', async () => {
    const env = makeTestEnv();
    const res = await rpc(env, 'tools/list');
    const tools = (res.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(SPEC_MCP_TOOLS);
  });

  it('annotates readOnlyHint correctly', async () => {
    const env = makeTestEnv();
    const res = await rpc(env, 'tools/list');
    const tools = (res.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
    for (const t of tools) {
      expect(t.annotations.readOnlyHint, t.name).toBe(READ_TOOLS.includes(t.name));
    }
  });

  it('/mcp/read lists only the read tools and refuses write calls', async () => {
    const env = makeTestEnv();
    const res = await rpc(env, 'tools/list', {}, true);
    const tools = (res.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(READ_TOOLS);

    const call = await rpc(env, 'tools/call', { name: 'move', arguments: {} }, true);
    expect(call.error?.code).toBe(-32602);
    expect(call.error?.message).toContain('read-only');
  });
});

describe('tools/call delegates to the same handlers as HTTP', () => {
  it('rules via MCP === rules via HTTP', async () => {
    const env = makeTestEnv();
    const mcpRes = await rpc(env, 'tools/call', { name: 'rules', arguments: { game: 'toy' } });
    const mcpBody = (mcpRes.result as { structuredContent: { data: Json } }).structuredContent;
    const httpRes = await handleApiRequest(env, apiRequest('GET', '/api/rules/toy'));
    const httpBody = (await httpRes.json()) as { data: Json };
    expect(mcpBody.data).toEqual(httpBody.data);
  });

  it('a move via MCP reaches the room identically to the same move via HTTP', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    seatIn(env, 'g_1', agent);
    seatIn(env, 'g_2', agent);
    env.rooms.script = async () =>
      new Response(JSON.stringify({ ok: true, applied: true, notation: 'a1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const submission = { game_id: 'g_1', turn_index: 0, move: { index: 0 }, commentary: 'hello' };
    const moveSig = sign(agent.secret, `ludus.move.v1:g_1:0:${sha256Hex(canonicalJson(submission as Json))}`);
    const body = { ...submission, signature: moveSig };
    const rawBody = canonicalJson(body as Json);

    // HTTP: raw body must be the canonical bytes for the shared auth hash.
    const { challenge: c1 } = await issueChallenge(env, agent.handle);
    const httpRes = await handleApiRequest(
      env,
      apiRequest('POST', '/api/games/g_1/moves', {
        headers: {
          'content-type': 'application/json',
          'x-ludus-agent': agent.handle,
          'x-ludus-challenge': c1,
          'x-ludus-signature': sign(agent.secret, authMessage(agent.handle, c1, 'POST', '/api/games/g_1/moves', rawBody)),
        },
        body: rawBody,
      }),
    );
    expect(httpRes.status).toBe(200);

    // MCP: same body object, game g_2 (fresh challenge; path differs only in id).
    const submission2 = { ...submission, game_id: 'g_2' };
    const moveSig2 = sign(agent.secret, `ludus.move.v1:g_2:0:${sha256Hex(canonicalJson(submission2 as Json))}`);
    const body2 = { ...submission2, signature: moveSig2 };
    const { challenge: c2 } = await issueChallenge(env, agent.handle);
    const mcpRes = await rpc(env, 'tools/call', {
      name: 'move',
      arguments: {
        id: 'g_2',
        body: body2,
        agent: agent.handle,
        challenge: c2,
        signature: sign(
          agent.secret,
          authMessage(agent.handle, c2, 'POST', '/api/games/g_2/moves', canonicalJson(body2 as Json)),
        ),
      },
    });
    expect(mcpRes.error).toBeUndefined();
    expect((mcpRes.result as { isError: boolean }).isError).toBe(false);

    // Both calls forwarded the same shape to the room: { agent_id, submission, signature }.
    const roomBodies = env.rooms.calls.filter((c) => c.url.endsWith('/move')).map((c) => JSON.parse(c.body ?? '{}') as Record<string, unknown>);
    expect(roomBodies.length).toBe(2);
    expect(roomBodies[0]?.agent_id).toBe(agent.agentId);
    expect(roomBodies[1]?.agent_id).toBe(agent.agentId);
    expect(roomBodies[0]?.submission).toEqual(submission);
    expect(roomBodies[1]?.submission).toEqual(submission2);
    expect(roomBodies[0]?.signature).toBe(moveSig);
    expect(roomBodies[1]?.signature).toBe(moveSig2);
  });

  it('resign requires body.resign = true so the signature covers it', async () => {
    const env = makeTestEnv();
    const res = await rpc(env, 'tools/call', {
      name: 'resign',
      arguments: { id: 'g_1', body: { game_id: 'g_1', turn_index: 0 }, agent: 'a', challenge: 'c', signature: 's' },
    });
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain('resign');
  });
});

function seatIn(env: TestEnv, gameId: string, agent: TestAgent): void {
  insertGame(env, {
    id: gameId,
    game: 'toy',
    status: 'live',
    seats: [{ player: 'p0', agent_id: agent.agentId, handle: agent.handle, pubkey_ed25519: agent.pubkey }],
  });
}
