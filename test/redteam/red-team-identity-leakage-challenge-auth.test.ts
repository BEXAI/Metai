/**
 * RED TEAM red-team-identity-leakage — attack family 5: challenge auth
 * (spec §api.write_signed "authenticated by a signed challenge, never a
 * bearer secret"; src/identity/auth.ts). Plus registration key-possession
 * attacks and Ed25519 signature-malleability hardening.
 *
 * Attacks: reuse a consumed challenge; use an expired one; sign with the
 * wrong key; sign for a different path/method/body than requested; replay a
 * whole signed HTTP request; register with a key you don't hold; forge a
 * "different" signature for the same move via s+L malleability.
 */

import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { signEd25519, verifyEd25519 } from '../../src/crypto/ed25519.ts';
import { authMessage, issueChallenge } from '../../src/identity/auth.ts';
import { publicKeyOf, sign } from '../../src/identity/ed25519.ts';
import { playerId, type MoveSubmission } from '../../src/kernel/types.ts';
import { moveSignMessage, RoomCore, type SubmitReject } from '../../src/rooms/core.ts';
import { miniGame } from '../../src/rooms/tests/mini-game.ts';
import { handleApiRequest } from '../../src/api/router.ts';
import { insertGame, makeTestEnv, type TestEnv } from '../../src/api/tests/fakes.ts';
import { apiRequest, envelope, insertAgent, signedHeaders, testKeys, type TestAgent } from '../../src/api/tests/helpers.ts';

async function code(res: Response): Promise<string | undefined> {
  return (await envelope(res)).error?.code;
}

function authHeaders(agent: { handle: string; secret: string }, challenge: string, message: string): Record<string, string> {
  return {
    'x-ludus-agent': agent.handle,
    'x-ludus-challenge': challenge,
    'x-ludus-signature': sign(agent.secret, message),
  };
}

// ---------------------------------------------------------------------------
// 1. Challenge reuse (single-use is the whole point)
// ---------------------------------------------------------------------------

describe('challenge reuse', () => {
  it('replaying the exact same signed request 401s the second time', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    const headers = await signedHeaders(env, alice, 'GET', '/api/my/games');

    const first = await handleApiRequest(env, apiRequest('GET', '/api/my/games', { headers }));
    expect(first.status).toBe(200);

    const replay = await handleApiRequest(env, apiRequest('GET', '/api/my/games', { headers }));
    expect(replay.status).toBe(401);
    expect(await code(replay)).toBe('CHALLENGE_SPENT');
  });

  it('a consumed challenge is dead even with a FRESH valid signature on another path', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    const headers = await signedHeaders(env, alice, 'GET', '/api/my/games');
    expect((await handleApiRequest(env, apiRequest('GET', '/api/my/games', { headers }))).status).toBe(200);

    const challenge = headers['x-ludus-challenge']!;
    const message2 = authMessage('alice', challenge, 'GET', '/api/my/games', null);
    const res = await handleApiRequest(
      env,
      apiRequest('GET', '/api/my/games', { headers: authHeaders(alice, challenge, message2) }),
    );
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('CHALLENGE_SPENT');
  });

  it('a replayed signed MOVE request reaches the room exactly once', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    insertGame(env, {
      id: 'g-replay',
      game: 'toy',
      status: 'live',
      seats: [{ player: 'p0', agent_id: alice.agentId, handle: 'alice', pubkey_ed25519: alice.pubkey }],
    });
    env.rooms.script = () =>
      new Response(JSON.stringify({ ok: true, applied: true, ended: false, deadline_at_ms: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const submission = { game_id: 'g-replay', turn_index: 0, move: { index: 0 } };
    const moveSig = signEd25519(alice.secret, moveSignMessage('g-replay', 0, submission as MoveSubmission));
    const rawBody = JSON.stringify({ ...submission, signature: moveSig });
    const headers = { ...(await signedHeaders(env, alice, 'POST', '/api/games/g-replay/moves', rawBody)), 'content-type': 'application/json' };

    const first = await handleApiRequest(env, apiRequest('POST', '/api/games/g-replay/moves', { headers, body: rawBody }));
    expect(first.status).toBe(200);
    const replay = await handleApiRequest(env, apiRequest('POST', '/api/games/g-replay/moves', { headers, body: rawBody }));
    expect(replay.status).toBe(401);
    expect(await code(replay)).toBe('CHALLENGE_SPENT');
    expect(env.rooms.calls).toHaveLength(1); // the room never saw the replay
  });
});

// ---------------------------------------------------------------------------
// 2. Expired challenges
// ---------------------------------------------------------------------------

describe('challenge expiry', () => {
  it('a challenge older than its TTL is rejected', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    const { challenge } = await issueChallenge(env, 'alice');
    env.clock.advance(5 * 60 * 1000 + 1); // one ms past the 5-minute lifetime

    const message = authMessage('alice', challenge, 'GET', '/api/my/games', null);
    const res = await handleApiRequest(
      env,
      apiRequest('GET', '/api/my/games', { headers: authHeaders(alice, challenge, message) }),
    );
    expect(res.status).toBe(401);
    expect(['CHALLENGE_SPENT', 'CHALLENGE_EXPIRED']).toContain(await code(res));
  });

  it('a KV entry that outlives its recorded exp is still rejected (and burned)', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    // Simulate KV expiry lag: the record is alive but its exp already passed.
    const challenge = 'ab'.repeat(32);
    await env.kv.put(`chal:alice:${challenge}`, JSON.stringify({ exp: env.clock.ms - 1 }), { expirationTtl: 3600 });

    const message = authMessage('alice', challenge, 'GET', '/api/my/games', null);
    const res = await handleApiRequest(
      env,
      apiRequest('GET', '/api/my/games', { headers: authHeaders(alice, challenge, message) }),
    );
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('CHALLENGE_EXPIRED');
    // And it cannot be retried after the rejection deleted it.
    const retry = await handleApiRequest(
      env,
      apiRequest('GET', '/api/my/games', { headers: authHeaders(alice, challenge, message) }),
    );
    expect(await code(retry)).toBe('CHALLENGE_SPENT');
  });
});

// ---------------------------------------------------------------------------
// 3. Wrong key / cross-handle
// ---------------------------------------------------------------------------

describe('wrong key and cross-handle attacks', () => {
  it("bob signing alice's challenge with HIS key is rejected; alice can still use it", async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    const bob = insertAgent(env, 'bob', 'op_other');
    const { challenge } = await issueChallenge(env, 'alice');
    const message = authMessage('alice', challenge, 'GET', '/api/my/games', null);

    const forged = await handleApiRequest(
      env,
      apiRequest('GET', '/api/my/games', {
        headers: { 'x-ludus-agent': 'alice', 'x-ludus-challenge': challenge, 'x-ludus-signature': sign(bob.secret, message) },
      }),
    );
    expect(forged.status).toBe(401);
    expect(await code(forged)).toBe('SIG_INVALID');

    // A failed forgery must NOT burn the challenge for its rightful owner...
    const legit = await handleApiRequest(
      env,
      apiRequest('GET', '/api/my/games', { headers: authHeaders(alice, challenge, message) }),
    );
    expect(legit.status).toBe(200);
    // ...and success burns it.
    const after = await handleApiRequest(
      env,
      apiRequest('GET', '/api/my/games', { headers: authHeaders(alice, challenge, message) }),
    );
    expect(after.status).toBe(401);
  });

  it("using alice's challenge under bob's handle fails (challenges are handle-scoped)", async () => {
    const env = makeTestEnv();
    insertAgent(env, 'alice');
    const bob = insertAgent(env, 'bob', 'op_other');
    const { challenge } = await issueChallenge(env, 'alice');
    const message = authMessage('bob', challenge, 'GET', '/api/my/games', null);
    const res = await handleApiRequest(
      env,
      apiRequest('GET', '/api/my/games', { headers: authHeaders(bob, challenge, message) }),
    );
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('CHALLENGE_SPENT'); // unknown under bob's scope
  });
});

// ---------------------------------------------------------------------------
// 4. Signing for a different path/method/body than requested
// ---------------------------------------------------------------------------

describe('path/method/body binding', () => {
  async function signedFor(
    env: TestEnv,
    agent: TestAgent,
    method: 'GET' | 'POST',
    path: string,
    rawBody: string | null,
  ): Promise<Record<string, string>> {
    const { challenge } = await issueChallenge(env, agent.handle);
    const message = authMessage(agent.handle, challenge, method, path, method === 'POST' ? (rawBody ?? '') : null);
    return authHeaders(agent, challenge, message);
  }

  it('a signature for path A does not open path B', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    insertGame(env, {
      id: 'g-a',
      game: 'toy',
      status: 'live',
      seats: [{ player: 'p0', agent_id: alice.agentId, handle: 'alice', pubkey_ed25519: alice.pubkey }],
    });
    const headers = await signedFor(env, alice, 'GET', '/api/my/games', null);
    const res = await handleApiRequest(env, apiRequest('GET', '/api/games/g-a/view', { headers }));
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('SIG_INVALID');
    expect(env.rooms.calls).toHaveLength(0);
  });

  it('a GET signature does not authorize a POST to the same-looking path', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    const body = JSON.stringify({ game: 'toy', variant: 'standard', division: 'open' });
    // Sign the GET form of the message (no method upgrade, no body hash).
    const { challenge } = await issueChallenge(env, 'alice');
    const message = authMessage('alice', challenge, 'GET', '/api/lobby/leave', null);
    const res = await handleApiRequest(
      env,
      apiRequest('POST', '/api/lobby/leave', {
        headers: { ...authHeaders(alice, challenge, message), 'content-type': 'application/json' },
        body,
      }),
    );
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('SIG_INVALID');
  });

  it('a signature over body A does not authorize body B (same path and method)', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    const bodyA = JSON.stringify({ game: 'toy', variant: 'standard', division: 'open' });
    const bodyB = JSON.stringify({ game: 'toy', variant: 'standard', division: 'pure' });
    const headers = await signedFor(env, alice, 'POST', '/api/lobby/leave', bodyA);
    const res = await handleApiRequest(
      env,
      apiRequest('POST', '/api/lobby/leave', { headers: { ...headers, 'content-type': 'application/json' }, body: bodyB }),
    );
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('SIG_INVALID');
  });

  it('even a one-byte body mutation (inside commentary) kills the request signature', async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    insertGame(env, {
      id: 'g-byte',
      game: 'toy',
      status: 'live',
      seats: [{ player: 'p0', agent_id: alice.agentId, handle: 'alice', pubkey_ed25519: alice.pubkey }],
    });
    const submission = { game_id: 'g-byte', turn_index: 0, move: { index: 0 }, commentary: 'gg wp' };
    const moveSig = signEd25519(alice.secret, moveSignMessage('g-byte', 0, submission as MoveSubmission));
    const rawBody = JSON.stringify({ ...submission, signature: moveSig });
    const headers = { ...(await signedFor(env, alice, 'POST', '/api/games/g-byte/moves', rawBody)), 'content-type': 'application/json' };

    const mutated = rawBody.replace('gg wp', 'gG wp'); // one byte flipped inside commentary
    expect(mutated).not.toBe(rawBody);
    const res = await handleApiRequest(env, apiRequest('POST', '/api/games/g-byte/moves', { headers, body: mutated }));
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('SIG_INVALID');
    expect(env.rooms.calls).toHaveLength(0);
  });

  it('missing auth headers on every write_signed route is a hard 401', async () => {
    const env = makeTestEnv();
    insertGame(env, { id: 'g-x', game: 'toy', status: 'live', seats: [] });
    const posts: [string, string][] = [
      ['/api/lobby/join', JSON.stringify({ game: 'toy', variant: 'standard', division: 'open' })],
      ['/api/lobby/leave', JSON.stringify({ game: 'toy', variant: 'standard', division: 'open' })],
      ['/api/games/g-x/moves', JSON.stringify({ game_id: 'g-x', turn_index: 0, move: 'a', signature: 'ab'.repeat(64) })],
      ['/api/doorbell', JSON.stringify({ url: 'https://example.com/hook' })],
      ['/api/doorbell/verify', '{}'],
      ['/api/doorbell/disable', '{}'],
      ['/api/agents/a_whoever/homologate', JSON.stringify({
        season_id: 's1', division: 'open', model_id: 'm', adapter_kind: 'api', endpoint_url: null,
        system_prompt_sha256: sha256Hex('s'), config_sha256: sha256Hex('c'), tool_access: 'engine-assisted',
      })],
    ];
    for (const [path, body] of posts) {
      const res = await handleApiRequest(
        env,
        apiRequest('POST', path, { headers: { 'content-type': 'application/json' }, body }),
      );
      expect(res.status, path).toBe(401);
      expect(await code(res), path).toBe('AUTH_MISSING');
    }
    for (const path of ['/api/my/games', '/api/games/g-x/view', '/api/games/g-x/legal_moves']) {
      const res = await handleApiRequest(env, apiRequest('GET', path));
      expect(res.status, path).toBe(401);
    }
    expect(env.rooms.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Registration: possession of the key being registered
// ---------------------------------------------------------------------------

describe('registration key-possession attacks', () => {
  async function register(env: TestEnv, handle: string, pubkey: string, signingSecret: string, headerHandle = handle) {
    const body = JSON.stringify({ handle, model_id: 'model-r', pubkey, operator_token: 'operator-secret-1' });
    const { challenge } = await issueChallenge(env, headerHandle);
    const message = authMessage(headerHandle, challenge, 'POST', '/api/agents', body);
    return handleApiRequest(
      env,
      apiRequest('POST', '/api/agents', {
        headers: {
          'x-ludus-agent': headerHandle,
          'x-ludus-challenge': challenge,
          'x-ludus-signature': sign(signingSecret, message),
          'content-type': 'application/json',
        },
        body,
      }),
    );
  }

  it("registering a pubkey you don't hold the secret for is rejected", async () => {
    const env = makeTestEnv();
    const victim = testKeys('victim-key');
    const attacker = testKeys('attacker-key');
    // Attacker signs with THEIR key but claims the victim's pubkey.
    const res = await register(env, 'squatter', victim.pubkey, attacker.secret);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('SIG_INVALID');
    const rows = env.db.db.prepare('SELECT id FROM agents WHERE handle = ?').all('squatter');
    expect(rows).toHaveLength(0);
  });

  it('one key registers once: a second handle on the same pubkey is refused', async () => {
    const env = makeTestEnv();
    const keys = testKeys('shared-key');
    const first = await register(env, 'original', keys.pubkey, keys.secret);
    expect(first.status).toBe(201);
    const second = await register(env, 'clone', keys.pubkey, keys.secret);
    expect(second.status).toBe(409);
    expect(await code(second)).toBe('KEY_ALREADY_REGISTERED');
  });

  it('the auth header handle must equal the body handle when registering', async () => {
    const env = makeTestEnv();
    const keys = testKeys('mismatch-key');
    const res = await register(env, 'bodyhandle', keys.pubkey, keys.secret, 'headerhandle');
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('AUTH_HANDLE_MISMATCH');
    expect(env.db.db.prepare('SELECT id FROM agents WHERE handle IN (?, ?)').all('bodyhandle', 'headerhandle')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Ed25519 malleability: (R, s+L) must not verify as a second signature
// ---------------------------------------------------------------------------

describe('signature malleability', () => {
  function malleate(sigHex: string): string {
    // s lives in the last 32 bytes, little-endian. s' = s + group order L.
    const rHex = sigHex.slice(0, 64);
    const sBytes = Uint8Array.from((sigHex.slice(64).match(/../g) ?? []).map((b) => parseInt(b, 16)));
    let s = 0n;
    for (let i = sBytes.length - 1; i >= 0; i--) s = (s << 8n) | BigInt(sBytes[i]!);
    const L = ed25519.CURVE.n;
    let s2 = s + L;
    const out: string[] = [];
    for (let i = 0; i < 32; i++) {
      out.push((s2 & 0xffn).toString(16).padStart(2, '0'));
      s2 >>= 8n;
    }
    return rHex + out.join('');
  }

  it('verifyEd25519 rejects the s+L malleated twin of a valid signature', () => {
    const secret = sha256Hex('redteam-malleability-key');
    const pub = publicKeyOf(secret);
    const message = 'ludus.move.v1:g:0:' + sha256Hex('body');
    const sig = signEd25519(secret, message);
    expect(verifyEd25519(pub, message, sig)).toBe(true);
    const evil = malleate(sig);
    expect(evil).not.toBe(sig);
    expect(evil).toHaveLength(128);
    expect(verifyEd25519(pub, message, evil)).toBe(false);
  });

  it('a room rejects a malleated signature on a real move', () => {
    const secretKey = sha256Hex('redteam-malleability-seat');
    const seat = {
      player: playerId(0),
      agent_id: 'agent-m',
      handle: 'agentm',
      pubkey_ed25519: publicKeyOf(secretKey),
    };
    const other = {
      player: playerId(1),
      agent_id: 'agent-n',
      handle: 'agentn',
      pubkey_ed25519: publicKeyOf(sha256Hex('redteam-malleability-seat-2')),
    };
    const core = RoomCore.create(1_000_000, {
      gameId: 'mall-game',
      game: miniGame,
      variant: {},
      seats: [seat, other],
      division: 'open',
      rulesetVersion: '1.0.0',
      secretHex: '11'.repeat(32),
      drandRound: 7,
      drandRandomnessHex: 'dd'.repeat(32),
    });
    const submission: MoveSubmission = { game_id: 'mall-game', turn_index: 0, move: 'a' };
    const good = signEd25519(secretKey, moveSignMessage('mall-game', 0, submission));
    const r = core.submitMove(1_000_100, 'agent-m', submission, malleate(good)) as SubmitReject;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('bad_signature');
    expect(core.turnIndex).toBe(0);
  });
});
