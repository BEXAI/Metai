/**
 * Doorbells: register -> challenge -> endpoint proves control by signing the
 * frozen DOORBELL_PREFIX message; rings carry no board content and are signed
 * with the checkpoint key; five consecutive failures disable the bell.
 */

import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../../crypto/canonical.ts';
import { DOORBELL_PREFIX } from '../../kernel/replay.ts';
import type { Json } from '../../kernel/types.ts';
import { doorbellProofMessage, ringDoorbell, RING_PREFIX, type DoorbellRow } from '../../identity/doorbell.ts';
import { publicKeyOf, sign, verify } from '../../identity/ed25519.ts';
import { handleApiRequest } from '../router.ts';
import { makeTestEnv, type TestEnv } from './fakes.ts';
import { apiRequest, envelope, insertAgent, signedHeaders, type TestAgent } from './helpers.ts';

const URL_OK = 'https://agent.example/doorbell';

async function post(env: TestEnv, agent: TestAgent, path: string, bodyObj: Record<string, unknown> = {}): Promise<Response> {
  const body = JSON.stringify(bodyObj);
  const headers = { ...(await signedHeaders(env, agent, 'POST', path, body)), 'content-type': 'application/json' };
  return handleApiRequest(env, apiRequest('POST', path, { headers, body }));
}

function bellRow(env: TestEnv, agentId: string): DoorbellRow {
  return env.db.db.prepare('SELECT * FROM doorbells WHERE agent_id = ?').get(agentId) as unknown as DoorbellRow;
}

describe('register + verify', () => {
  it('registers, then verifies when the endpoint returns the right signature header', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    const reg = await post(env, agent, '/api/doorbell', { url: URL_OK });
    expect(reg.status).toBe(200);
    const challenge = String((await envelope(reg)).data?.challenge);
    expect(challenge).toMatch(/^[0-9a-f]{64}$/);

    // The endpoint proves control: signature over the DOORBELL_PREFIX message.
    env.outboundScript = (url, init) => {
      const got = new Headers(init?.headers).get('x-ludus-doorbell-challenge');
      expect(got).toBe(challenge);
      const msg = doorbellProofMessage(agent.handle, challenge, url);
      expect(msg).toBe(`${DOORBELL_PREFIX}:${agent.handle}:${challenge}:${url}`);
      return new Response('ok', { status: 200, headers: { 'x-ludus-doorbell-signature': sign(agent.secret, msg) } });
    };
    const ver = await post(env, agent, '/api/doorbell/verify');
    expect(ver.status).toBe(200);
    expect(bellRow(env, agent.agentId).verified_at).not.toBeNull();
  });

  it('rejects a wrong signature and stays unverified', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    await post(env, agent, '/api/doorbell', { url: URL_OK });
    env.outboundScript = () =>
      new Response('ok', { status: 200, headers: { 'x-ludus-doorbell-signature': 'ab'.repeat(64) } });
    const ver = await post(env, agent, '/api/doorbell/verify');
    expect(ver.status).toBe(400);
    expect((await envelope(ver)).error?.code).toBe('DOORBELL_SIG_INVALID');
    expect(bellRow(env, agent.agentId).verified_at).toBeNull();
  });

  it('rejects non-https URLs', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    const reg = await post(env, agent, '/api/doorbell', { url: 'http://agent.example/x' });
    expect(reg.status).toBe(400);
  });

  it('disable sets disabled_at', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    await post(env, agent, '/api/doorbell', { url: URL_OK });
    const res = await post(env, agent, '/api/doorbell/disable');
    expect(res.status).toBe(200);
    expect(bellRow(env, agent.agentId).disabled_at).not.toBeNull();
  });
});

describe('rings', () => {
  function verifiedBell(env: TestEnv, agent: TestAgent): DoorbellRow {
    env.db.db
      .prepare("INSERT INTO doorbells (agent_id, url, verified_at, cursor, failures, disabled_at) VALUES (?, ?, '2026-09-01T00:00:00Z', NULL, 0, NULL)")
      .run(agent.agentId, URL_OK);
    return bellRow(env, agent.agentId);
  }

  const payload = { event_id: 'g_1:4', game_id: 'g_1', turn_index: 4, deadline_utc: '2026-09-01T13:00:00Z' };

  it('a ring carries only event metadata, signed with the checkpoint key', async () => {
    const checkpointSk = sha256Hex('test-checkpoint-key');
    const env = makeTestEnv({ secrets: { checkpoint_sk: checkpointSk } });
    const agent = insertAgent(env, 'alice');
    const bell = verifiedBell(env, agent);
    let seen: { body: string; sig: string | null } | null = null;
    env.outboundScript = (_url, init) => {
      seen = { body: String(init?.body), sig: new Headers(init?.headers).get('x-ludus-ring-signature') };
      return new Response('ok', { status: 200 });
    };
    const outcome = await ringDoorbell(env, bell, payload);
    expect(outcome).toBe('ok');
    const got = seen as unknown as { body: string; sig: string | null };
    expect(JSON.parse(got.body)).toEqual(payload); // no board content
    expect(got.body).toBe(canonicalJson(payload as unknown as Json));
    expect(verify(publicKeyOf(checkpointSk), `${RING_PREFIX}:${got.body}`, got.sig ?? '')).toBe(true);
    // Success resets failures and advances the cursor.
    const after = bellRow(env, agent.agentId);
    expect(after.failures).toBe(0);
    expect(after.cursor).toBe('g_1:4');
  });

  it('five consecutive failures disable the doorbell; a success resets the count', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    verifiedBell(env, agent);
    env.outboundScript = () => new Response('boom', { status: 500 });

    for (let i = 1; i <= 4; i++) {
      const outcome = await ringDoorbell(env, bellRow(env, agent.agentId), payload);
      expect(outcome).toBe('failed');
      expect(bellRow(env, agent.agentId).failures).toBe(i);
      expect(bellRow(env, agent.agentId).disabled_at).toBeNull();
    }

    // A success in between resets the streak.
    env.outboundScript = () => new Response('ok', { status: 200 });
    expect(await ringDoorbell(env, bellRow(env, agent.agentId), payload)).toBe('ok');
    expect(bellRow(env, agent.agentId).failures).toBe(0);

    // Now five straight failures -> disabled.
    env.outboundScript = () => new Response('boom', { status: 500 });
    for (let i = 1; i <= 5; i++) {
      await ringDoorbell(env, bellRow(env, agent.agentId), payload);
    }
    const after = bellRow(env, agent.agentId);
    expect(after.failures).toBe(5);
    expect(after.disabled_at).not.toBeNull();
  });

  it('a thrown fetch counts as a failure too', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    verifiedBell(env, agent);
    env.outboundScript = () => {
      throw new Error('network down');
    };
    expect(await ringDoorbell(env, bellRow(env, agent.agentId), payload)).toBe('failed');
    expect(bellRow(env, agent.agentId).failures).toBe(1);
  });
});
