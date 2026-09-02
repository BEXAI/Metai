/**
 * RED TEAM red-team-liveness — attack family 4: exceed rate limits / quotas
 * by request shaping.
 *
 * Targets src/api/quota.ts, src/api/ratelimit.ts, src/api/router.ts,
 * src/identity/auth.ts (spec §matchmaking_and_ratings.quotas: "A rejected
 * request never spends a quota", api $comment):
 *   - 100 join attempts across 100 distinct queues: exactly 50 succeed, the
 *     50 rejections spend nothing;
 *   - the 21st concurrent game is rejected spending nothing; ending a game
 *     frees the slot;
 *   - rejected/malformed requests (bad signature, bad JSON, rate-limited)
 *     never spend quota AND never burn/advance the single-use challenge;
 *   - token bucket boundary: exactly 120 burst, the 121st rejected, a
 *     legitimate request succeeds after refill;
 *   - path shaping cannot reach an /api handler around the limiter.
 *
 * The variant field is an attacker-controlled free string (<= 64 chars), so
 * 100 distinct queues per day are trivially craftable — the quota, not the
 * ALREADY_IN_LOBBY check, must be the wall.
 */

import { describe, expect, it } from 'vitest';
import { utcDay, DAILY_JOINS, CONCURRENT_GAMES } from '../../src/api/quota.ts';
import { RATE_CAPACITY } from '../../src/api/ratelimit.ts';
import { handleApiRequest } from '../../src/api/router.ts';
import { insertGame, makeTestEnv, type TestEnv } from '../../src/api/tests/fakes.ts';
import { apiRequest, envelope, insertAgent, insertHomologation, signedHeaders, type TestAgent } from '../../src/api/tests/helpers.ts';
import { authMessage } from '../../src/identity/auth.ts';
import { sign } from '../../src/identity/ed25519.ts';

/** Challenges live in D1 (not KV): auth must not depend on the scarce KV write quota. */
async function challengeRow(env: TestEnv, handle: string, challenge: string): Promise<unknown> {
  return env.db
    .prepare('SELECT challenge FROM auth_challenges WHERE handle = ? AND challenge = ?')
    .bind(handle, challenge)
    .first();
}


function joinsSpent(env: TestEnv, agent: TestAgent): number {
  const r = env.db.db.prepare('SELECT joins FROM quotas WHERE agent_id = ? AND day = ?').get(agent.agentId, utcDay(env.clock.ms)) as
    | { joins: number }
    | undefined;
  return r ? Number(r.joins) : 0;
}

function lobbyCount(env: TestEnv): number {
  return Number((env.db.db.prepare('SELECT COUNT(*) AS n FROM lobby').get() as { n: number }).n);
}

async function joinReq(
  env: TestEnv,
  agent: TestAgent,
  body: Record<string, unknown>,
  opts: { ip?: string; tamper?: (h: Record<string, string>) => void; rawOverride?: string } = {},
): Promise<Response> {
  const raw = opts.rawOverride ?? JSON.stringify(body);
  const headers: Record<string, string> = {
    ...(await signedHeaders(env, agent, 'POST', '/api/lobby/join', raw)),
    'content-type': 'application/json',
  };
  if (opts.ip !== undefined) headers['cf-connecting-ip'] = opts.ip;
  if (opts.tamper) opts.tamper(headers);
  return handleApiRequest(env, apiRequest('POST', '/api/lobby/join', { headers, body: raw }));
}

// ---------------------------------------------------------------------------
// 1. 100 join attempts, 100 distinct queues
// ---------------------------------------------------------------------------

describe('daily join quota under request shaping', () => {
  it('100 joins across distinct variants: exactly 50 succeed; the 51st..100th spend nothing', { timeout: 600_000 }, async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'glutton');
    insertHomologation(env, agent, 'open');

    let ok = 0;
    let rejected = 0;
    for (let i = 0; i < 100; i++) {
      // Distinct variant => distinct queue => ALREADY_IN_LOBBY never trips.
      // Distinct IP per request keeps the token bucket out of the picture.
      const res = await joinReq(env, agent, { game: 'toy', variant: `v${i}`, division: 'open' }, { ip: `10.0.${i}.1` });
      if (res.status === 201) {
        ok++;
      } else {
        rejected++;
        expect(res.status, `attempt ${i}`).toBe(429);
        expect((await envelope(res)).error?.code, `attempt ${i}`).toBe('QUOTA_JOINS');
      }
    }

    expect(ok).toBe(DAILY_JOINS); // exactly 50
    expect(rejected).toBe(100 - DAILY_JOINS);
    // The ledger records exactly the successful joins — rejections spent 0.
    expect(joinsSpent(env, agent)).toBe(DAILY_JOINS);
    expect(lobbyCount(env)).toBe(DAILY_JOINS);

    // The wall holds on a fresh attempt too.
    const extra = await joinReq(env, agent, { game: 'toy', variant: 'v-extra', division: 'open' }, { ip: '10.9.9.9' });
    expect(extra.status).toBe(429);
    expect(joinsSpent(env, agent)).toBe(DAILY_JOINS);
  });
});

// ---------------------------------------------------------------------------
// 2. Concurrent-games cap
// ---------------------------------------------------------------------------

describe('concurrent-games cap (20)', () => {
  it('the 21st concurrent join is rejected spending nothing; an ended game frees the slot', { timeout: 600_000 }, async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'busy');
    insertHomologation(env, agent, 'open');
    for (let i = 0; i < CONCURRENT_GAMES; i++) {
      insertGame(env, {
        id: `live_${i}`,
        game: 'toy',
        status: 'live',
        seats: [{ player: 'p0', agent_id: agent.agentId, handle: agent.handle, pubkey_ed25519: agent.pubkey }],
      });
    }

    const res = await joinReq(env, agent, { game: 'toy', variant: 'q1', division: 'open' });
    expect(res.status).toBe(429);
    expect((await envelope(res)).error?.code).toBe('QUOTA_CONCURRENT');
    expect(joinsSpent(env, agent)).toBe(0);
    expect(lobbyCount(env)).toBe(0);

    // One game ends -> the very same request shape now succeeds and spends 1.
    env.db.db.prepare("UPDATE games SET status = 'ended', ended_at = '2026-09-01T12:30:00Z' WHERE id = 'live_0'").run();
    const res2 = await joinReq(env, agent, { game: 'toy', variant: 'q1', division: 'open' });
    expect(res2.status).toBe(201);
    expect(joinsSpent(env, agent)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Rejected / malformed requests never spend quota or advance the nonce
// ---------------------------------------------------------------------------

describe('rejections advance nothing (quota, challenge nonce)', () => {
  it('a bad signature burns neither quota nor the challenge; the SAME challenge then succeeds', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'signer');
    insertHomologation(env, agent, 'open');
    const raw = JSON.stringify({ game: 'toy', variant: 'standard', division: 'open' });

    const goodHeaders: Record<string, string> = {
      ...(await signedHeaders(env, agent, 'POST', '/api/lobby/join', raw)),
      'content-type': 'application/json',
    };
    const challenge = goodHeaders['x-ludus-challenge']!;

    // Attack: same challenge, garbage signature.
    const badHeaders = { ...goodHeaders, 'x-ludus-signature': '0'.repeat(128) };
    const bad = await handleApiRequest(env, apiRequest('POST', '/api/lobby/join', { headers: badHeaders, body: raw }));
    expect(bad.status).toBe(401);
    expect((await envelope(bad)).error?.code).toBe('SIG_INVALID');
    expect(joinsSpent(env, agent)).toBe(0);
    expect(lobbyCount(env)).toBe(0);
    // The nonce did NOT advance: the challenge is still alive in KV.
    expect(await challengeRow(env, agent.handle, challenge)).not.toBeNull();

    // The legitimate retry with the SAME challenge succeeds.
    const good = await handleApiRequest(env, apiRequest('POST', '/api/lobby/join', { headers: goodHeaders, body: raw }));
    expect(good.status).toBe(201);
    expect(joinsSpent(env, agent)).toBe(1);
    // ... and only now is it single-use spent.
    expect(await challengeRow(env, agent.handle, challenge)).toBeNull();
    const replay = await handleApiRequest(env, apiRequest('POST', '/api/lobby/join', { headers: goodHeaders, body: raw }));
    expect(replay.status).toBe(401);
    expect((await envelope(replay)).error?.code).toBe('CHALLENGE_SPENT');
  });

  it('malformed JSON is rejected before auth: challenge alive, quota untouched, then reusable', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'mangler');
    insertHomologation(env, agent, 'open');

    // Sign over the broken body exactly as sent — the router must bounce it
    // before any handler (and before the challenge is burned).
    const brokenRaw = '{"game": "toy", "division": ';
    const headers: Record<string, string> = {
      ...(await signedHeaders(env, agent, 'POST', '/api/lobby/join', brokenRaw)),
      'content-type': 'application/json',
    };
    const challenge = headers['x-ludus-challenge']!;
    const res = await handleApiRequest(env, apiRequest('POST', '/api/lobby/join', { headers, body: brokenRaw }));
    expect(res.status).toBe(400);
    expect((await envelope(res)).error?.code).toBe('BAD_JSON');
    expect(joinsSpent(env, agent)).toBe(0);
    expect(await challengeRow(env, agent.handle, challenge)).not.toBeNull();

    // Reuse the surviving challenge for a valid body (fresh signature over it).
    const raw = JSON.stringify({ game: 'toy', variant: 'standard', division: 'open' });
    const message = authMessage(agent.handle, challenge, 'POST', '/api/lobby/join', raw);
    const headers2 = {
      'x-ludus-agent': agent.handle,
      'x-ludus-challenge': challenge,
      'x-ludus-signature': sign(agent.secret, message),
      'content-type': 'application/json',
    };
    const res2 = await handleApiRequest(env, apiRequest('POST', '/api/lobby/join', { headers: headers2, body: raw }));
    expect(res2.status).toBe(201);
    expect(joinsSpent(env, agent)).toBe(1);
  });

  it('an invalid-body-but-valid-auth rejection (unknown game) spends nothing', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'prober');
    insertHomologation(env, agent, 'open');
    const res = await joinReq(env, agent, { game: 'nope', variant: 'standard', division: 'open' });
    expect(res.status).toBe(400);
    expect(joinsSpent(env, agent)).toBe(0);
    expect(lobbyCount(env)).toBe(0);
  });

  it('a rate-limited signed join spends nothing and the challenge survives to succeed after refill', { timeout: 600_000 }, async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'flooder');
    insertHomologation(env, agent, 'open');

    // Exhaust the shared 'unknown'-IP bucket (requests carry no IP header).
    for (let i = 0; i < RATE_CAPACITY; i++) {
      await handleApiRequest(env, apiRequest('GET', '/api/pulse'));
    }

    const raw = JSON.stringify({ game: 'toy', variant: 'standard', division: 'open' });
    const headers: Record<string, string> = {
      ...(await signedHeaders(env, agent, 'POST', '/api/lobby/join', raw)),
      'content-type': 'application/json',
    };
    const challenge = headers['x-ludus-challenge']!;

    const limited = await handleApiRequest(env, apiRequest('POST', '/api/lobby/join', { headers, body: raw }));
    expect(limited.status).toBe(429);
    expect((await envelope(limited)).error?.code).toBe('RATE_LIMITED');
    expect(joinsSpent(env, agent)).toBe(0);
    expect(lobbyCount(env)).toBe(0);
    expect(await challengeRow(env, agent.handle, challenge)).not.toBeNull();

    // Refill (1 s = 2 tokens), replay the identical request: it must succeed.
    env.clock.advance(1_000);
    const ok = await handleApiRequest(env, apiRequest('POST', '/api/lobby/join', { headers, body: raw }));
    expect(ok.status).toBe(201);
    expect(joinsSpent(env, agent)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Token-bucket boundary + path shaping
// ---------------------------------------------------------------------------

describe('rate-limit boundary at 120/min/IP', () => {
  it('exactly 120 burst requests pass, the 121st is rejected, refill readmits', { timeout: 600_000 }, async () => {
    const env = makeTestEnv();
    const ip = { headers: { 'cf-connecting-ip': '203.0.113.7' } };
    for (let i = 0; i < RATE_CAPACITY; i++) {
      const res = await handleApiRequest(env, apiRequest('GET', '/api/pulse', ip));
      expect(res.status, `burst request ${i + 1}`).toBe(200);
    }
    const over = await handleApiRequest(env, apiRequest('GET', '/api/pulse', ip));
    expect(over.status).toBe(429);
    expect((await envelope(over)).error?.code).toBe('RATE_LIMITED');

    // 500 ms refills exactly one token: one request passes, the next fails.
    env.clock.advance(500);
    expect((await handleApiRequest(env, apiRequest('GET', '/api/pulse', ip))).status).toBe(200);
    expect((await handleApiRequest(env, apiRequest('GET', '/api/pulse', ip))).status).toBe(429);

    // Another IP is untouched throughout.
    const other = await handleApiRequest(env, apiRequest('GET', '/api/pulse', { headers: { 'cf-connecting-ip': '198.51.100.9' } }));
    expect(other.status).toBe(200);
  });

  it('path shaping cannot reach an /api handler around the limiter', { timeout: 600_000 }, async () => {
    const env = makeTestEnv();
    const ip = { headers: { 'cf-connecting-ip': '203.0.113.8' } };
    for (let i = 0; i < RATE_CAPACITY; i++) {
      await handleApiRequest(env, apiRequest('GET', '/api/pulse', ip));
    }

    // Dot-segments normalize into /api/pulse — still limited.
    const dotted = await handleApiRequest(env, apiRequest('GET', '/api/./pulse', ip));
    expect(dotted.status).toBe(429);
    // Path variants that skip the '/api/' limiter prefix must never dispatch
    // a handler either — 404, not 200, even with the bucket empty.
    for (const path of ['/api%2Fpulse', '//api/pulse', '/API/pulse']) {
      const res = await handleApiRequest(env, apiRequest('GET', path, ip));
      expect(res.status, path).toBe(404);
    }
    // Variants under '/api/' stay behind the limiter (429 while exhausted)
    // and match no route once refilled.
    for (const path of ['/api/pulse/', '/api//pulse']) {
      const res = await handleApiRequest(env, apiRequest('GET', path, ip));
      expect(res.status, `${path} while exhausted`).toBe(429);
    }
    env.clock.advance(5_000); // 10 tokens
    for (const path of ['/api/pulse/', '/api//pulse']) {
      const res = await handleApiRequest(env, apiRequest('GET', path, ip));
      expect(res.status, `${path} after refill`).toBe(404);
    }
  });
});
