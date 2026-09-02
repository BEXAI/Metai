/**
 * Quotas (spec §matchmaking_and_ratings.quotas): 50 joins/day, 20 concurrent,
 * and the check-then-spend rule — a REJECTED request never spends a quota.
 */

import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../router.ts';
import { utcDay } from '../quota.ts';
import { insertGame, makeTestEnv, type TestEnv } from './fakes.ts';
import { apiRequest, envelope, insertAgent, insertHomologation, signedHeaders, type TestAgent } from './helpers.ts';

async function join(env: TestEnv, agent: TestAgent, body: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify(body);
  const headers = { ...(await signedHeaders(env, agent, 'POST', '/api/lobby/join', raw)), 'content-type': 'application/json' };
  return handleApiRequest(env, apiRequest('POST', '/api/lobby/join', { headers, body: raw }));
}

function joinsSpent(env: TestEnv, agent: TestAgent): number {
  const row = env.db.db.prepare('SELECT joins FROM quotas WHERE agent_id = ? AND day = ?').get(agent.agentId, utcDay(env.clock.ms)) as
    | { joins: number }
    | undefined;
  return row ? Number(row.joins) : 0;
}

describe('lobby join quotas', () => {
  it('a successful join inserts the lobby row and spends exactly one join', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    insertHomologation(env, agent, 'open');
    const res = await join(env, agent, { game: 'toy', division: 'open' });
    expect(res.status).toBe(201);
    expect(joinsSpent(env, agent)).toBe(1);
    const lobby = env.db.db.prepare('SELECT * FROM lobby WHERE agent_id = ?').all(agent.agentId);
    expect(lobby.length).toBe(1);
  });

  it('an invalid body spends nothing', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    insertHomologation(env, agent, 'open');
    const res = await join(env, agent, { game: 'no-such-game', division: 'open' });
    expect(res.status).toBe(400);
    expect(joinsSpent(env, agent)).toBe(0);
  });

  it('an unhomologated agent is rejected and spends nothing', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    const res = await join(env, agent, { game: 'toy', division: 'open' });
    expect(res.status).toBe(403);
    expect((await envelope(res)).error?.code).toBe('NOT_HOMOLOGATED');
    expect(joinsSpent(env, agent)).toBe(0);
  });

  it('a duplicate join is rejected and spends nothing more', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    insertHomologation(env, agent, 'open');
    await join(env, agent, { game: 'toy', division: 'open' });
    const dup = await join(env, agent, { game: 'toy', division: 'open' });
    expect(dup.status).toBe(409);
    expect(joinsSpent(env, agent)).toBe(1);
  });

  it('the 51st join of a UTC day is rejected without spending; a new day resets', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    insertHomologation(env, agent, 'open');
    env.db.db.prepare('INSERT INTO quotas (agent_id, day, joins) VALUES (?, ?, 50)').run(agent.agentId, utcDay(env.clock.ms));
    const res = await join(env, agent, { game: 'toy', division: 'open' });
    expect(res.status).toBe(429);
    expect((await envelope(res)).error?.code).toBe('QUOTA_JOINS');
    expect(joinsSpent(env, agent)).toBe(50);
    expect(env.db.db.prepare('SELECT COUNT(*) AS n FROM lobby').get()).toMatchObject({ n: 0 });

    env.clock.advance(24 * 3600 * 1000); // next UTC day
    const fresh = await join(env, agent, { game: 'toy', division: 'open' });
    expect(fresh.status).toBe(201);
  });

  it('a 21st concurrent game is rejected without spending', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    insertHomologation(env, agent, 'open');
    for (let i = 0; i < 20; i++) {
      insertGame(env, {
        id: `g_${i}`,
        game: 'toy',
        status: 'live',
        seats: [{ player: 'p0', agent_id: agent.agentId, handle: agent.handle, pubkey_ed25519: agent.pubkey }],
      });
    }
    const res = await join(env, agent, { game: 'toy', division: 'open' });
    expect(res.status).toBe(429);
    expect((await envelope(res)).error?.code).toBe('QUOTA_CONCURRENT');
    expect(joinsSpent(env, agent)).toBe(0);
  });

  it('ended games do not count toward concurrency', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    insertHomologation(env, agent, 'open');
    for (let i = 0; i < 20; i++) {
      insertGame(env, {
        id: `g_${i}`,
        game: 'toy',
        status: 'ended',
        ended_at: '2026-09-01T11:00:00Z',
        seats: [{ player: 'p0', agent_id: agent.agentId, handle: agent.handle, pubkey_ed25519: agent.pubkey }],
      });
    }
    const res = await join(env, agent, { game: 'toy', division: 'open' });
    expect(res.status).toBe(201);
  });
});

describe('lobby leave', () => {
  it('removes the row; leaving a lobby you are not in is a 404', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'alice');
    insertHomologation(env, agent, 'open');
    await join(env, agent, { game: 'toy', division: 'open' });
    const raw = JSON.stringify({ game: 'toy', division: 'open' });
    let headers = { ...(await signedHeaders(env, agent, 'POST', '/api/lobby/leave', raw)), 'content-type': 'application/json' };
    const res = await handleApiRequest(env, apiRequest('POST', '/api/lobby/leave', { headers, body: raw }));
    expect(res.status).toBe(200);
    expect(env.db.db.prepare('SELECT COUNT(*) AS n FROM lobby').get()).toMatchObject({ n: 0 });

    headers = { ...(await signedHeaders(env, agent, 'POST', '/api/lobby/leave', raw)), 'content-type': 'application/json' };
    const again = await handleApiRequest(env, apiRequest('POST', '/api/lobby/leave', { headers, body: raw }));
    expect(again.status).toBe(404);
  });
});
