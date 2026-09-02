/**
 * Registration and homologation (gate A9 second half): handle/pubkey
 * validation, once-per-key, operator linking, and the EXACT homologation
 * hash formula from spec §identity_and_integrity.homologation.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../crypto/canonical.ts';
import { authMessage, issueChallenge } from '../../identity/auth.ts';
import { publicKeyOf, sign } from '../../identity/ed25519.ts';
import { homologationHash, type HomologationFields } from '../../identity/homologation.ts';
import { operatorIdFromToken } from '../../identity/register.ts';
import { handleApiRequest } from '../router.ts';
import { makeTestEnv, type TestEnv } from './fakes.ts';
import { apiRequest, envelope, insertAgent, signedHeaders, testKeys } from './helpers.ts';

async function registerRequest(
  env: TestEnv,
  handle: string,
  opts: { pubkey?: string; secret?: string; bodyPatch?: Record<string, unknown> } = {},
): Promise<Response> {
  const keys = testKeys(handle);
  const pubkey = opts.pubkey ?? keys.pubkey;
  const secret = opts.secret ?? keys.secret;
  const body = JSON.stringify({
    handle,
    model_id: 'claude-fable-5',
    pubkey,
    operator_token: 'operator-secret-token-1',
    ...opts.bodyPatch,
  });
  const { challenge } = await issueChallenge(env, handle);
  const headers = {
    'content-type': 'application/json',
    'x-ludus-agent': handle,
    'x-ludus-challenge': challenge,
    'x-ludus-signature': sign(secret, authMessage(handle, challenge, 'POST', '/api/agents', body)),
  };
  return handleApiRequest(env, apiRequest('POST', '/api/agents', { headers, body }));
}

describe('POST /api/agents (registration)', () => {
  it('registers with a valid signature over the body pubkey', async () => {
    const env = makeTestEnv();
    const res = await registerRequest(env, 'alice');
    expect(res.status).toBe(201);
    const body = await envelope(res);
    expect(body.data?.handle).toBe('alice');
    expect(body.data?.operator_id).toBe(operatorIdFromToken('operator-secret-token-1'));
    // The handle is marked untrusted (agent-authored) in the envelope.
    expect(body.metadata?.untrusted_fields).toContain('data.handle');
    const row = env.db.db.prepare('SELECT handle, pubkey_ed25519, status FROM agents WHERE handle = ?').get('alice') as {
      handle: string;
      pubkey_ed25519: string;
    };
    expect(row.pubkey_ed25519).toBe(testKeys('alice').pubkey);
  });

  it('same operator_token links to the same operator; different token, different operator', async () => {
    const env = makeTestEnv();
    await registerRequest(env, 'alice');
    await registerRequest(env, 'bob');
    const res = await registerRequest(env, 'carol', { bodyPatch: { operator_token: 'a-different-secret' } });
    expect(res.status).toBe(201);
    const ops = env.db.db.prepare('SELECT DISTINCT operator_id FROM agents ORDER BY operator_id').all() as { operator_id: string }[];
    expect(ops.length).toBe(2);
  });

  it('rejects a duplicate handle with 409', async () => {
    const env = makeTestEnv();
    await registerRequest(env, 'alice');
    const dup = await registerRequest(env, 'alice', { pubkey: publicKeyOf(sha256Hex('other')), secret: sha256Hex('other') });
    expect(dup.status).toBe(409);
    expect((await envelope(dup)).error?.code).toBe('HANDLE_TAKEN');
  });

  it('rejects a duplicate pubkey with 409 (register once per key)', async () => {
    const env = makeTestEnv();
    await registerRequest(env, 'alice');
    const alice = testKeys('alice');
    const dup = await registerRequest(env, 'alice2', { pubkey: alice.pubkey, secret: alice.secret });
    expect(dup.status).toBe(409);
    expect((await envelope(dup)).error?.code).toBe('KEY_ALREADY_REGISTERED');
  });

  it('rejects malformed pubkeys and handles with 400 before any auth', async () => {
    const env = makeTestEnv();
    const badKey = await registerRequest(env, 'alice', { bodyPatch: { pubkey: 'not-hex' } });
    expect(badKey.status).toBe(400);
    expect((await envelope(badKey)).error?.code).toBe('BAD_PUBKEY');
    const upper = await registerRequest(env, 'alice', {
      bodyPatch: { pubkey: testKeys('alice').pubkey.toUpperCase() },
    });
    expect((await envelope(upper)).error?.code).toBe('BAD_PUBKEY');

    for (const bad of ['Alice', 'al', 'a'.repeat(33), '-lead', 'has space']) {
      const res = await registerRequest(env, 'placeholder', { bodyPatch: { handle: bad } });
      expect(res.status, `handle ${bad}`).toBe(400);
    }
  });

  it('a rejected body does not burn the challenge (rejections spend nothing)', async () => {
    const env = makeTestEnv();
    const keys = testKeys('alice');
    const { challenge } = await issueChallenge(env, 'alice');
    const badBody = JSON.stringify({ handle: 'alice', model_id: 'm', pubkey: 'nope', operator_token: 'operator-secret-token-1' });
    const bad = await handleApiRequest(
      env,
      apiRequest('POST', '/api/agents', {
        headers: {
          'x-ludus-agent': 'alice',
          'x-ludus-challenge': challenge,
          'x-ludus-signature': sign(keys.secret, authMessage('alice', challenge, 'POST', '/api/agents', badBody)),
        },
        body: badBody,
      }),
    );
    expect(bad.status).toBe(400);
    // Same challenge still works for a valid registration.
    const goodBody = JSON.stringify({ handle: 'alice', model_id: 'm', pubkey: keys.pubkey, operator_token: 'operator-secret-token-1' });
    const good = await handleApiRequest(
      env,
      apiRequest('POST', '/api/agents', {
        headers: {
          'x-ludus-agent': 'alice',
          'x-ludus-challenge': challenge,
          'x-ludus-signature': sign(keys.secret, authMessage('alice', challenge, 'POST', '/api/agents', goodBody)),
        },
        body: goodBody,
      }),
    );
    expect(good.status).toBe(201);
  });
});

describe('homologation hash (spec formula, exact fixture)', () => {
  it('sha256 over canonical JSON of the exact field set', () => {
    const fields: HomologationFields = {
      agent_id: 'a_fixture0000000000000000000000000',
      season_id: '2026-09',
      model_id: 'claude-fable-5',
      adapter_kind: 'api',
      endpoint_url_or_null: null,
      system_prompt_sha256: sha256Hex('You are a chess agent.'),
      config_sha256: sha256Hex('{"temperature":0}'),
      tool_access: 'pure',
    };
    // Precomputed once by hand from canonicalJson (keys sorted):
    // {"adapter_kind":"api","agent_id":"a_fixture0000000000000000000000000",...}
    expect(homologationHash(fields)).toBe('89619c059d948e14152a99e31580c13eaccf5262d67cf2f5fb39ec4205313ddf');
  });
});

describe('POST /api/agents/:id/homologate', () => {
  const fixtureBody = {
    season_id: '2026-09',
    division: 'pure',
    model_id: 'claude-fable-5',
    adapter_kind: 'api',
    endpoint_url: null,
    system_prompt_sha256: sha256Hex('You are a chess agent.'),
    config_sha256: sha256Hex('{"temperature":0}'),
    tool_access: 'pure',
  };

  async function file(env: TestEnv, agent: { handle: string; secret: string; agentId: string }, patch: Record<string, unknown> = {}): Promise<Response> {
    const body = JSON.stringify({ ...fixtureBody, ...patch });
    const path = `/api/agents/${agent.agentId}/homologate`;
    const headers = { ...(await signedHeaders(env, agent, 'POST', path, body)), 'content-type': 'application/json' };
    return handleApiRequest(env, apiRequest('POST', path, { headers, body }));
  }

  it('files, voids on change, and is idempotent on identical fields', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    const first = await file(env, agent);
    expect(first.status).toBe(201);
    const firstBody = await envelope(first);
    const firstId = String(firstBody.data?.homologation_id);
    expect(String(firstBody.data?.hash)).toMatch(/^[0-9a-f]{64}$/);

    // Identical refile: unchanged, nothing voided.
    const again = await file(env, agent);
    expect(again.status).toBe(200);
    expect((await envelope(again)).data?.unchanged).toBe(true);

    // Changed field: voids the old entry, creates a new one (A9: homologated
    // fields cannot change within a season without voiding standing).
    const changed = await file(env, agent, { config_sha256: sha256Hex('{"temperature":1}') });
    expect(changed.status).toBe(201);
    const changedBody = await envelope(changed);
    expect(changedBody.data?.voided_previous).toBe(firstId);
    const oldRow = env.db.db.prepare('SELECT voided_at FROM homologations WHERE id = ?').get(firstId) as { voided_at: string | null };
    expect(oldRow.voided_at).not.toBeNull();
    const active = env.db.db
      .prepare('SELECT COUNT(*) AS n FROM homologations WHERE agent_id = ? AND voided_at IS NULL')
      .get(agent.agentId) as { n: number };
    expect(Number(active.n)).toBe(1);
  });

  it("refuses to homologate someone else's agent id", async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    const bob = insertAgent(env, 'bob', 'op_bob');
    const path = `/api/agents/${bob.agentId}/homologate`;
    const body = JSON.stringify(fixtureBody);
    const headers = { ...(await signedHeaders(env, alice, 'POST', path, body)), 'content-type': 'application/json' };
    const res = await handleApiRequest(env, apiRequest('POST', path, { headers, body }));
    expect(res.status).toBe(403);
    expect((await envelope(res)).error?.code).toBe('NOT_YOUR_AGENT');
  });

  it('pure division requires pure tool access', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    const res = await file(env, agent, { tool_access: 'engine-assisted' });
    expect(res.status).toBe(400);
    expect((await envelope(res)).error?.code).toBe('DIVISION_MISMATCH');
  });
});
