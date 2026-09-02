/**
 * Ludus Worker entry: router + plain-text front door + MCP + cron.
 *
 * Everything interesting lives in unit-testable modules:
 *   - src/doc.ts        one route table -> front door, llms.txt, openapi, mcp.json
 *   - src/api/router.ts route matching, rate limit, envelopes
 *   - src/api/handlers.ts + src/identity/* the actual operations
 *   - src/mcp.ts        JSON-RPC 2.0 doors at /mcp and /mcp/read
 *   - src/api/cron.ts   the 5-minute scheduled work
 * This file only adapts the Cloudflare bindings to the narrow ApiEnv and
 * re-exports the GameRoom Durable Object class (owned by T6).
 *
 * Secrets: only Worker secrets / .dev.vars (gitignored). CHECKPOINT_SK is the
 * Ed25519 checkpoint signing key; ANTHROPIC_API_KEY (house agents, T6) is
 * read from env by the adapter that needs it. No key material lives in the
 * repo, and no endpoint ever asks an agent for a key.
 */

import { GAMES } from './games/index.ts';
import { robotsTxt, sitemapXml } from './doc.ts';
import { handleApiRequest } from './api/router.ts';
import { handleMcpHttp } from './mcp.ts';
import { runCron } from './api/cron.ts';
import type { ApiEnv, Db, Kv, R2Like, RoomNamespace } from './api/env.ts';

// The Durable Object class (T6 owns src/rooms/; wrangler.jsonc binds GameRoom
// to this export).
export { GameRoom } from './rooms/room.ts';

export interface WorkerEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  REPLAYS: R2Bucket;
  GAME_ROOM: DurableObjectNamespace;
  ASSETS?: Fetcher;
  /** Worker secret (never in the repo): Ed25519 hex secret for checkpoints + doorbell rings. */
  CHECKPOINT_SK?: string;
  /** Test-only: per-move clock override (ms) for pairer-created games. Never set in production. */
  PER_MOVE_MS_OVERRIDE?: string;
}

/**
 * Adapt real bindings to the narrow, fake-able ApiEnv. The casts are safe:
 * ApiEnv declares a strict subset of each binding's surface.
 */
export function toApiEnv(env: WorkerEnv): ApiEnv {
  const secrets: ApiEnv['secrets'] = {};
  if (env.CHECKPOINT_SK) secrets.checkpoint_sk = env.CHECKPOINT_SK;
  const apiEnv: ApiEnv = {
    DB: env.DB as unknown as Db,
    CACHE: env.CACHE as unknown as Kv,
    REPLAYS: env.REPLAYS as unknown as R2Like,
    GAME_ROOM: env.GAME_ROOM as unknown as RoomNamespace,
    secrets,
    games: GAMES,
    now: () => Date.now(),
    fetchFn: (input, init) => fetch(input, init),
  };
  if (env.PER_MOVE_MS_OVERRIDE) {
    const n = Number(env.PER_MOVE_MS_OVERRIDE);
    if (Number.isFinite(n) && n > 0) apiEnv.perMoveMsOverride = n;
  }
  return apiEnv;
}

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Discovery for search + AI crawlers (organic SEO/GEO).
    if (path === '/robots.txt') {
      return new Response(robotsTxt(url.origin), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
    }
    if (path === '/sitemap.xml') {
      return new Response(sitemapXml(url.origin), { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
    }

    // MCP doors (JSON-RPC 2.0). /mcp/read exposes only read tools.
    if (path === '/mcp' || path === '/mcp/') return handleMcpHttp(toApiEnv(env), request, false);
    if (path === '/mcp/read' || path === '/mcp/read/') return handleMcpHttp(toApiEnv(env), request, true);

    // Spectator SPA (Workers Assets serves /watch/* automatically when the
    // binding matches; this is the explicit fallback).
    if ((path === '/watch' || path.startsWith('/watch/')) && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return handleApiRequest(toApiEnv(env), request);
  },

  async scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCron(toApiEnv(env)).then((report) => {
        for (const s of report.steps) console.log(`cron ${s.name}: ${s.ok ? 'ok' : 'FAILED'} — ${s.detail}`);
      }),
    );
  },
};
