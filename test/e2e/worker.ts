/**
 * E2E shim Worker. Wraps the REAL Ludus Worker (src/index.ts) unchanged and
 * adds ONLY the integration glue that is missing from this build plus a few
 * test-only doors. Every /api/*, /mcp*, /watch/* request flows through the
 * real router, the real rooms, the real crypto — nothing in the product path
 * is stubbed or altered here.
 *
 * Missing product wiring this shim supplies (documented as product gaps in
 * notes/e2e-driver.md — the e2e task explicitly forbids editing src/):
 *   1. PAIRING: src/match/pairing.ts has no cronTick(env) export and nothing
 *      else calls runPairingSweep, so lobby rows never become games. The shim
 *      runs runPairingSweep on every cron tick / POST /e2e/sweep with a
 *      D1-backed LobbyRepo and a GameFactory that creates the GameRoom DO and
 *      inserts the games row (exactly what notes/T7/T8 describe as the
 *      missing integration).
 *   2. END-OF-GAME PERSISTENCE: the room never writes D1, so games rows stay
 *      'live' forever and /api/games/:id/replay 409s forever. The finalize
 *      sweep copies the ended room's log/events/result/reveal into D1 and
 *      flips status to 'ended'.
 *   3. RATINGS: nothing calls closeRatingPeriod. The finalize sweep applies a
 *      per-game Glicko-2 update (T8's rate/pairwise decomposition) so
 *      leaderboards show results.
 *
 * Test-only doors (all POST, only meaningful under wrangler dev):
 *   /e2e/config  { seats?: {game: n}, per_move_ms?, per_move_ms_by_game? }
 *   /e2e/lobby   { game, variant?, division?, agent_id }  — direct lobby
 *                INSERT for unlisted games (tictactoe is spec-unlisted).
 *   /e2e/sweep   run pairing + finalize now; returns a report.
 *   /e2e/unlimit delete rate-limit buckets (the 120 req/min/IP KV bucket
 *                throttles a fast local driver; deleting it is test-only).
 *   /e2e/ping    liveness.
 */

import app, { toApiEnv, type WorkerEnv } from '../../src/index.ts';
import { GAMES } from '../../src/games/index.ts';
import {
  runPairingSweep,
  initialPairerState,
  CryptoSecretProvider,
  type CreateGameCommand,
  type GameFactory,
  type PairerState,
  type PairingAgentInfo,
} from '../../src/match/pairing.ts';
import type { Division, LobbyKey, LobbyRepo, LobbyRow } from '../../src/match/lobby.ts';
import {
  DEFAULT_GLICKO2,
  pairwiseResults,
  rate,
  standingsFromResult,
  type Glicko2Rating,
  type Standing,
} from '../../src/match/glicko2.ts';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { playerId, type GameResult, type Json } from '../../src/kernel/types.ts';

export { GameRoom } from '../../src/index.ts';

// ---------------------------------------------------------------------------
// E2E config (KV)
// ---------------------------------------------------------------------------

interface E2eConfig {
  /** Seats needed per game queue; default = game meta players.min. */
  seats?: Record<string, number>;
  /** Per-move clock for newly created rooms (ms); default 60000. */
  per_move_ms?: number;
  per_move_ms_by_game?: Record<string, number>;
}

const CFG_KEY = 'e2e:cfg';
const PAIRER_KEY = 'e2e:pairer';

async function readCfg(env: WorkerEnv): Promise<E2eConfig> {
  try {
    const raw = await env.CACHE.get(CFG_KEY);
    return raw ? (JSON.parse(raw) as E2eConfig) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// D1-backed LobbyRepo (the repo T7 was to wire; lives here instead)
// ---------------------------------------------------------------------------

function d1LobbyRepo(env: WorkerEnv): LobbyRepo {
  return {
    async join(row: LobbyRow): Promise<'joined' | 'already'> {
      const existing = await env.DB
        .prepare('SELECT agent_id FROM lobby WHERE game=? AND variant=? AND division=? AND agent_id=?')
        .bind(row.game, row.variant, row.division, row.agent_id)
        .first();
      if (existing) return 'already';
      await env.DB
        .prepare('INSERT INTO lobby (game, variant, division, agent_id, joined_at) VALUES (?,?,?,?,?)')
        .bind(row.game, row.variant, row.division, row.agent_id, row.joined_at)
        .run();
      return 'joined';
    },
    async leave(key: LobbyKey): Promise<boolean> {
      const res = await env.DB
        .prepare('DELETE FROM lobby WHERE game=? AND variant=? AND division=? AND agent_id=?')
        .bind(key.game, key.variant, key.division, key.agent_id)
        .run();
      return ((res as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
    },
    async list(): Promise<LobbyRow[]> {
      const { results } = await env.DB
        .prepare('SELECT game, variant, division, agent_id, joined_at FROM lobby')
        .all<LobbyRow>();
      return results;
    },
    async remove(keys: readonly LobbyKey[]): Promise<void> {
      for (const key of keys) {
        await env.DB
          .prepare('DELETE FROM lobby WHERE game=? AND variant=? AND division=? AND agent_id=?')
          .bind(key.game, key.variant, key.division, key.agent_id)
          .run();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// GameFactory: create the DO room + insert the games row
// ---------------------------------------------------------------------------

interface SeatRow {
  id: string;
  handle: string;
  pubkey_ed25519: string;
}

function variantConfigOf(variantKey: string): Json {
  if (variantKey.startsWith('{')) {
    try {
      return JSON.parse(variantKey) as Json;
    } catch {
      return {};
    }
  }
  return {};
}

function seasonIdNow(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function ensureSeason(env: WorkerEnv, seasonId: string): Promise<void> {
  const [y, m] = seasonId.split('-').map(Number);
  const start = new Date(Date.UTC(y!, m! - 1, 1)).toISOString();
  const end = new Date(Date.UTC(y!, m!, 1)).toISOString();
  await env.DB
    .prepare("INSERT OR IGNORE INTO seasons (id, name, starts_at, ends_at, ruleset_versions_json, status) VALUES (?,?,?,?,'{}','active')")
    .bind(seasonId, `Season ${seasonId}`, start, end)
    .run();
}

function e2eGameFactory(env: WorkerEnv, cfg: E2eConfig): GameFactory {
  return {
    async createGame(cmd: CreateGameCommand): Promise<string> {
      const gameId = `game_e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
      const seats: Json[] = [];
      for (let i = 0; i < cmd.seats.length; i++) {
        const agentId = cmd.seats[i]!;
        const row = await env.DB
          .prepare('SELECT id, handle, pubkey_ed25519 FROM agents WHERE id = ?')
          .bind(agentId)
          .first<SeatRow>();
        if (!row) throw new Error(`pairer seat agent '${agentId}' not in agents table`);
        seats.push({ player: playerId(i), agent_id: row.id, handle: row.handle, pubkey_ed25519: row.pubkey_ed25519 });
      }
      const variant = variantConfigOf(cmd.variant);
      const perMoveMs = cfg.per_move_ms_by_game?.[cmd.game] ?? cfg.per_move_ms ?? 60_000;
      // Local pseudo-drand: offline-deterministic; verify-replay checks the
      // recorded round+randomness structurally (it cannot re-fetch drand
      // offline anyway). Recorded in notes/e2e-driver.md.
      const drandRound = 1;
      const drandRandomness = sha256Hex(`e2e-drand:${gameId}`);
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));
      const createRes = await stub.fetch('https://room/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          game_id: gameId,
          game: cmd.game,
          seats,
          variant,
          division: cmd.division,
          ruleset_version: '1.0.0',
          drand_round: drandRound,
          drand_randomness: drandRandomness,
          per_move_ms: perMoveMs,
        }),
      });
      if (createRes.status !== 201) {
        throw new Error(`room /create for ${cmd.game} failed: ${createRes.status} ${await createRes.text()}`);
      }
      const summary = (await createRes.json()) as { commitment?: string; drand_round?: number };
      const seasonId = seasonIdNow();
      await ensureSeason(env, seasonId);
      const nowIso = new Date().toISOString();
      await env.DB
        .prepare(
          `INSERT INTO games (id, game, variant, division, season_id, status, commitment, drand_round,
             reveal_secret, seats_json, ruleset_version, started_at, replay_r2_key)
           VALUES (?,?,?,?,?,'live',?,?,NULL,?,?,?,?)`,
        )
        .bind(
          gameId,
          cmd.game,
          JSON.stringify(variant),
          cmd.division,
          seasonId,
          summary.commitment ?? null,
          summary.drand_round ?? drandRound,
          JSON.stringify(seats),
          '1.0.0',
          nowIso,
          `${gameId}.json`, // the room uploads to R2 at exactly this key
        )
        .run();
      await env.CACHE.put(`e2e:vkey:${gameId}`, cmd.variant);
      return gameId;
    },
  };
}

// ---------------------------------------------------------------------------
// The pairing sweep (what the missing cronTick would do)
// ---------------------------------------------------------------------------

async function pairingSweep(env: WorkerEnv): Promise<Json> {
  const cfg = await readCfg(env);
  const lobby = d1LobbyRepo(env);
  let state: PairerState = initialPairerState();
  try {
    const raw = await env.CACHE.get(PAIRER_KEY);
    if (raw) state = JSON.parse(raw) as PairerState;
  } catch {
    /* fresh state */
  }
  const seasonId = seasonIdNow();
  const outcome = await runPairingSweep(lobby, state, {
    seatsFor(game: string, _variant: string): number {
      return cfg.seats?.[game] ?? GAMES[game]?.meta.players.min ?? 2;
    },
    async info(
      agentIds: readonly string[],
      queue: { game: string; variant: string; division: Division },
    ): Promise<Map<string, PairingAgentInfo>> {
      const out = new Map<string, PairingAgentInfo>();
      for (const id of agentIds) {
        const agent = await env.DB
          .prepare('SELECT id, operator_id, handle FROM agents WHERE id = ?')
          .bind(id)
          .first<{ id: string; operator_id: string; handle: string }>();
        if (!agent) continue;
        const rating = await env.DB
          .prepare('SELECT rating FROM ratings WHERE agent_id=? AND game=? AND variant=? AND division=? AND season_id=?')
          .bind(id, queue.game, queue.variant, queue.division, seasonId)
          .first<{ rating: number }>();
        out.set(id, {
          agent_id: id,
          operator_id: agent.operator_id,
          rating: rating ? Number(rating.rating) : 1500,
          house: agent.handle.startsWith('house-'),
        });
      }
      return out;
    },
    houseAgents: { available: () => [] }, // e2e always fills seats with real driver agents
    secrets: new CryptoSecretProvider(),
    factory: e2eGameFactory(env, cfg),
  });
  await env.CACHE.put(PAIRER_KEY, JSON.stringify(outcome.state));
  return { created: outcome.created.map((c) => ({ game_id: c.game_id, game: c.command.game })) } as Json;
}

// ---------------------------------------------------------------------------
// Finalize sweep: ended rooms -> D1 rows + R2 blob + ratings
// ---------------------------------------------------------------------------

interface RoomStateSummary {
  status?: string;
  result?: Json;
}

interface ReplayLite {
  reveal_secret: string;
  result: GameResult;
  log: { seq: number; kind: string; payload: Json; prev_hash: string; hash: string; signature: string | null; created_at: string }[];
}

async function ratingRowOf(
  env: WorkerEnv,
  agentId: string,
  game: string,
  variant: string,
  division: string,
  seasonId: string,
): Promise<{ rating: Glicko2Rating; games_played: number }> {
  const row = await env.DB
    .prepare('SELECT rating, rd, volatility, games_played FROM ratings WHERE agent_id=? AND game=? AND variant=? AND division=? AND season_id=?')
    .bind(agentId, game, variant, division, seasonId)
    .first<{ rating: number; rd: number; volatility: number; games_played: number }>();
  if (!row) return { rating: { ...DEFAULT_GLICKO2 }, games_played: 0 };
  return {
    rating: { rating: Number(row.rating), rd: Number(row.rd), vol: Number(row.volatility) },
    games_played: Number(row.games_played),
  };
}

async function updateRatingsForGame(
  env: WorkerEnv,
  gameRow: { id: string; game: string; division: string | null; season_id: string | null },
  seatAgents: string[],
  result: GameResult,
): Promise<number> {
  const variantKey = (await env.CACHE.get(`e2e:vkey:${gameRow.id}`)) ?? 'standard';
  const division = gameRow.division ?? 'open';
  const seasonId = gameRow.season_id ?? seasonIdNow();
  const positions = standingsFromResult(seatAgents, result);
  const current = new Map<string, { rating: Glicko2Rating; games_played: number }>();
  for (const agentId of seatAgents) {
    current.set(agentId, await ratingRowOf(env, agentId, gameRow.game, variantKey, division, seasonId));
  }
  const standings: Standing[] = positions.map((p) => ({
    agent_id: p.agent_id,
    position: p.position,
    rating: current.get(p.agent_id)!.rating,
  }));
  const results = pairwiseResults(standings);
  const nowIso = new Date().toISOString();
  let updated = 0;
  for (const agentId of seatAgents) {
    const prev = current.get(agentId)!;
    const next = rate(prev.rating, results.get(agentId) ?? []);
    await env.DB
      .prepare(
        `INSERT INTO ratings (agent_id, game, variant, division, season_id, rating, rd, volatility, games_played, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (agent_id, game, variant, division, season_id)
         DO UPDATE SET rating=excluded.rating, rd=excluded.rd, volatility=excluded.volatility,
                       games_played=excluded.games_played, updated_at=excluded.updated_at`,
      )
      .bind(agentId, gameRow.game, variantKey, division, seasonId, next.rating, next.rd, next.vol, prev.games_played + 1, nowIso)
      .run();
    updated++;
  }
  return updated;
}

async function finalizeSweep(env: WorkerEnv): Promise<Json> {
  const { results: live } = await env.DB
    .prepare("SELECT id, game, division, season_id, seats_json FROM games WHERE status='live' LIMIT 100")
    .all<{ id: string; game: string; division: string | null; season_id: string | null; seats_json: string | null }>();
  const finalized: string[] = [];
  let ratingsUpdated = 0;
  for (const g of live) {
    try {
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(g.id));
      const stateRes = await stub.fetch('https://room/state');
      if (!stateRes.ok) continue;
      const summary = (await stateRes.json()) as RoomStateSummary;
      if (summary.status !== 'ended') continue;

      const replayRes = await stub.fetch('https://room/replay');
      if (!replayRes.ok) continue;
      const replayText = await replayRes.text();
      const replay = JSON.parse(replayText) as ReplayLite;

      // R2 blob: the room uploads at end; re-put only if missing.
      try {
        const existing = await env.REPLAYS.get(`${g.id}.json`);
        if (!existing) await env.REPLAYS.put(`${g.id}.json`, replayText);
      } catch {
        /* R2 unavailable: the D1 log fallback still serves a (reduced) replay */
      }

      // Persist the log + spectator events so post-DO-eviction reads work and
      // the checkpoint cron has leaves.
      for (const entry of replay.log) {
        await env.DB
          .prepare('INSERT OR IGNORE INTO game_log (game_id, seq, kind, payload_json, prev_hash, hash, signature, created_at) VALUES (?,?,?,?,?,?,?,?)')
          .bind(g.id, entry.seq, entry.kind, JSON.stringify(entry.payload), entry.prev_hash, entry.hash, entry.signature, entry.created_at)
          .run();
      }
      try {
        const evRes = await stub.fetch('https://room/events?since=0');
        if (evRes.ok) {
          const { events } = (await evRes.json()) as { events: { seq: number; type: string; data: Json; at: string }[] };
          for (const ev of events) {
            await env.DB
              .prepare('INSERT OR IGNORE INTO spectator_events (game_id, seq, public_event_json, created_at) VALUES (?,?,?,?)')
              .bind(g.id, ev.seq, JSON.stringify({ type: ev.type, data: ev.data }), ev.at)
              .run();
          }
        }
      } catch {
        /* events persistence is best-effort */
      }

      await env.DB
        .prepare("UPDATE games SET status='ended', ended_at=?, result_json=?, reveal_secret=?, replay_r2_key=? WHERE id=?")
        .bind(new Date().toISOString(), JSON.stringify(replay.result), replay.reveal_secret, `${g.id}.json`, g.id)
        .run();

      const seats = JSON.parse(g.seats_json ?? '[]') as { agent_id: string }[];
      ratingsUpdated += await updateRatingsForGame(env, g, seats.map((s) => s.agent_id), replay.result);
      finalized.push(g.id);
    } catch (e) {
      console.warn(`e2e finalize ${g.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { finalized, ratings_updated: ratingsUpdated } as unknown as Json;
}

// ---------------------------------------------------------------------------
// Serialization: wrangler dev local runs one isolate; a module-level promise
// chain keeps concurrent sweeps (cron tick + explicit /e2e/sweep) from
// double-creating games.
// ---------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function e2eSweep(env: WorkerEnv): Promise<Json> {
  return serialized(async () => {
    const pairing = await pairingSweep(env);
    const finalize = await finalizeSweep(env);
    return { pairing, finalize } as unknown as Json;
  });
}

// ---------------------------------------------------------------------------
// Shim routes + delegation to the real Worker
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function handleE2e(request: Request, env: WorkerEnv, path: string): Promise<Response> {
  if (request.method === 'GET' && path === '/e2e/ping') return json({ ok: true, shim: 'ludus-e2e' });
  if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  if (path === '/e2e/config') {
    const body = (await request.json()) as E2eConfig;
    await env.CACHE.put(CFG_KEY, JSON.stringify(body));
    return json({ ok: true, config: body });
  }
  if (path === '/e2e/lobby') {
    const body = (await request.json()) as { game: string; variant?: string; division?: string; agent_id: string };
    if (!body.game || !body.agent_id) return json({ ok: false, error: 'game and agent_id required' }, 400);
    await env.DB
      .prepare('INSERT OR IGNORE INTO lobby (game, variant, division, agent_id, joined_at) VALUES (?,?,?,?,?)')
      .bind(body.game, body.variant ?? 'standard', body.division ?? 'open', body.agent_id, new Date().toISOString())
      .run();
    return json({ ok: true });
  }
  if (path === '/e2e/sweep') {
    const report = await e2eSweep(env);
    return json({ ok: true, report });
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
    // The real cron first (checkpoints, doorbells, timeout sweep, witness)...
    await app.scheduled(controller, env, ctx);
    // ...then the integration glue the product's cron is missing (see header).
    ctx.waitUntil(
      e2eSweep(env).then((report) => {
        console.log(`e2e sweep: ${JSON.stringify(report)}`);
      }),
    );
  },
};

// Re-export for tests that want to poke the ApiEnv adapter directly.
export { toApiEnv };
