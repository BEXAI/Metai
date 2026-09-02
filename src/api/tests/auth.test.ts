/**
 * Signed-challenge auth (gate A9 at the API layer): valid signature accepted;
 * expired, replayed, malformed, wrong-signature, and another-agent's-key
 * requests rejected — and a rejected request never burns the challenge of a
 * different agent nor spends any quota.
 */

import { describe, expect, it } from 'vitest';
import { authMessage, issueChallenge } from '../../identity/auth.ts';
import { sign } from '../../identity/ed25519.ts';
import { handleApiRequest } from '../router.ts';
import { makeTestEnv } from './fakes.ts';
import { apiRequest, envelope, insertAgent, signedHeaders, testKeys } from './helpers.ts';

describe('GET /api/auth/challenge', () => {
  it('issues a 64-hex single-use challenge with an expiry', async () => {
    const env = makeTestEnv();
    const res = await handleApiRequest(env, apiRequest('GET', '/api/auth/challenge?agent=alice'));
    expect(res.status).toBe(200);
    const body = await envelope(res);
    expect(body.ok).toBe(true);
    expect(String(body.data?.challenge)).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(String(body.data?.expires))).toBeGreaterThan(env.clock.ms);
  });

  it('rejects bad handles', async () => {
    const env = makeTestEnv();
    const res = await handleApiRequest(env, apiRequest('GET', '/api/auth/challenge?agent=NOT%20OK'));
    expect(res.status).toBe(400);
  });
});

describe('signed requests', () => {
  it('accepts a valid signature on a signed route', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    const headers = await signedHeaders(env, agent, 'GET', '/api/my/games');
    const res = await handleApiRequest(env, apiRequest('GET', '/api/my/games', { headers }));
    expect(res.status).toBe(200);
    const body = await envelope(res);
    expect(body.data?.agent_id).toBe(agent.agentId);
  });

  it('rejects a missing header set with instructions', async () => {
    const env = makeTestEnv();
    const res = await handleApiRequest(env, apiRequest('GET', '/api/my/games'));
    expect(res.status).toBe(401);
    const body = await envelope(res);
    expect(body.error?.code).toBe('AUTH_MISSING');
  });

  it('rejects an expired challenge', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    const headers = await signedHeaders(env, agent, 'GET', '/api/my/games');
    env.clock.advance(301_000); // past the 5-minute TTL
    const res = await handleApiRequest(env, apiRequest('GET', '/api/my/games', { headers }));
    expect(res.status).toBe(401);
    const body = await envelope(res);
    // KV TTL already dropped it -> SPENT; value-level expiry -> EXPIRED. Both reject.
    expect(['CHALLENGE_SPENT', 'CHALLENGE_EXPIRED']).toContain(body.error?.code);
  });

  it('rejects a replayed challenge (single use)', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    const headers = await signedHeaders(env, agent, 'GET', '/api/my/games');
    const first = await handleApiRequest(env, apiRequest('GET', '/api/my/games', { headers }));
    expect(first.status).toBe(200);
    const replay = await handleApiRequest(env, apiRequest('GET', '/api/my/games', { headers }));
    expect(replay.status).toBe(401);
    expect((await envelope(replay)).error?.code).toBe('CHALLENGE_SPENT');
  });

  it('rejects a wrong signature (tampered path)', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    const { challenge } = await issueChallenge(env, agent.handle);
    // Signature over a DIFFERENT path than requested.
    const message = authMessage(agent.handle, challenge, 'GET', '/api/pulse', null);
    const headers = {
      'x-ludus-agent': agent.handle,
      'x-ludus-challenge': challenge,
      'x-ludus-signature': sign(agent.secret, message),
    };
    const res = await handleApiRequest(env, apiRequest('GET', '/api/my/games', { headers }));
    expect(res.status).toBe(401);
    expect((await envelope(res)).error?.code).toBe('SIG_INVALID');
  });

  it("rejects another agent's key (A9)", async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    insertAgent(env, 'mallory', 'op_other');
    const mallocKeys = testKeys('mallory');
    const { challenge } = await issueChallenge(env, alice.handle);
    // Mallory signs a request claiming to be alice.
    const message = authMessage(alice.handle, challenge, 'GET', '/api/my/games', null);
    const headers = {
      'x-ludus-agent': alice.handle,
      'x-ludus-challenge': challenge,
      'x-ludus-signature': sign(mallocKeys.secret, message),
    };
    const res = await handleApiRequest(env, apiRequest('GET', '/api/my/games', { headers }));
    expect(res.status).toBe(401);
    expect((await envelope(res)).error?.code).toBe('SIG_INVALID');
    // ... and the challenge is NOT burned by a failed attempt, so a rejection
    // costs the caller nothing. (The failure itself is recorded in the logs;
    // it deliberately no longer spends a KV write — see logAuthFailure.)
    const stillThere = await env.db
      .prepare('SELECT challenge FROM auth_challenges WHERE handle = ? AND challenge = ?')
      .bind(alice.handle, challenge)
      .first();
    expect(stillThere).not.toBeNull();
  });

  it('rejects an unknown agent', async () => {
    const env = makeTestEnv();
    const keys = testKeys('ghost');
    const { challenge } = await issueChallenge(env, 'ghost');
    const headers = {
      'x-ludus-agent': 'ghost',
      'x-ludus-challenge': challenge,
      'x-ludus-signature': sign(keys.secret, authMessage('ghost', challenge, 'GET', '/api/my/games', null)),
    };
    const res = await handleApiRequest(env, apiRequest('GET', '/api/my/games', { headers }));
    expect(res.status).toBe(401);
    expect((await envelope(res)).error?.code).toBe('AUTH_UNKNOWN_AGENT');
  });

  it('POST signatures cover the exact raw body bytes', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    const body = JSON.stringify({ game: 'toy', division: 'open', variant: 'standard' });
    const headers = await signedHeaders(env, agent, 'POST', '/api/lobby/leave', body);
    // Tamper with the body after signing (still a valid body shape, so the
    // request reaches signature verification).
    const tampered = body.replace('standard', 'standarD');
    const res = await handleApiRequest(
      env,
      apiRequest('POST', '/api/lobby/leave', { headers: { ...headers, 'content-type': 'application/json' }, body: tampered }),
    );
    expect(res.status).toBe(401);
    expect((await envelope(res)).error?.code).toBe('SIG_INVALID');
  });
});
