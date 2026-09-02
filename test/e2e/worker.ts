/**
 * E2E shim Worker — THIN pass-through of the REAL Ludus Worker (src/index.ts).
 *
 * Since the stage-4 integration builders wired the product paths (cronTick
 * pairing in src/match/pairing.ts, end-of-game D1 persistence + R2 upload +
 * ratings in src/rooms/room.ts finalize), this shim supplies NO product
 * behavior at all: no pairing sweep, no finalize sweep, no ratings writes.
 * Every /api/*, /mcp*, /watch/* request AND the 5-minute scheduled() cron go
 * straight to the real Worker export.
 *
 * The only remnants are genuinely test-only doors (none touch a product code
 * path — all are listed in notes/e2e-driver.md and in the prover report):
 *   GET  /e2e/ping     liveness for the harness readiness poll.
 *   POST /e2e/lobby    { game, variant?, division?, agent_id } — direct D1
 *                      lobby INSERT. Needed ONLY for spec-unlisted games
 *                      (tictactoe): POST /api/lobby/join correctly rejects
 *                      them with GAME_UNLISTED, and the suite asserts that
 *                      first. The REAL cronTick pairer still forms the game.
 *   POST /e2e/unlimit  delete rl:* rate-limit KV buckets. The 120 req/min/IP
 *                      limit is real product behavior; the local driver is
 *                      much faster than any real agent.
 */

import app, { toApiEnv, type WorkerEnv } from '../../src/index.ts';

export { GameRoom } from '../../src/index.ts';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function handleE2e(request: Request, env: WorkerEnv, path: string): Promise<Response> {
  if (request.method === 'GET' && path === '/e2e/ping') return json({ ok: true, shim: 'ludus-e2e-thin' });
  if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  if (path === '/e2e/lobby') {
    const body = (await request.json()) as { game: string; variant?: string; division?: string; agent_id: string };
    if (!body.game || !body.agent_id) return json({ ok: false, error: 'game and agent_id required' }, 400);
    await env.DB
      .prepare('INSERT OR IGNORE INTO lobby (game, variant, division, agent_id, joined_at) VALUES (?,?,?,?,?)')
      .bind(body.game, body.variant ?? 'standard', body.division ?? 'open', body.agent_id, new Date().toISOString())
      .run();
    return json({ ok: true });
  }
  if (path === '/e2e/unlimit') {
    let deleted = 0;
    try {
      const list = await env.CACHE.list({ prefix: 'rl:' });
      for (const key of list.keys) {
        await env.CACHE.delete(key.name);
        deleted++;
      }
    } catch {
      /* best effort */
    }
    return json({ ok: true, deleted });
  }
  return json({ ok: false, error: `no e2e route ${path}` }, 404);
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/e2e' || url.pathname.startsWith('/e2e/')) {
      try {
        return await handleE2e(request, env, url.pathname.replace(/\/+$/, ''));
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }
    return app.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    // The REAL cron does everything now: checkpoint, doorbells, timeout
    // sweep, match tick (pairing), witness.
    await app.scheduled(controller, env, ctx);
  },
};

// Re-export for tests that want to poke the ApiEnv adapter directly.
export { toApiEnv };
