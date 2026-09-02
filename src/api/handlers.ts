/**
 * Every API operation as a unit-testable function over ApiEnv. The router
 * (src/api/router.ts) maps the route table in src/doc.ts onto HANDLERS, and
 * the MCP server (src/mcp.ts) calls the SAME functions, so HTTP and MCP
 * cannot diverge.
 *
 * Room (Durable Object) internal contract (matches src/rooms/room.ts, T6):
 *   GET  https://room/events?since=N  -> { events, latest_seq } or SSE (Accept/sse=1)
 *   GET  https://room/view/<player>   -> ViewObject JSON (player = seat id p0..)
 *   GET  https://room/state           -> public summary { turn_index, players_to_move,
 *                                        waiting_for, deadline_at_ms, ... }
 *   POST https://room/move            -> { agent_id, submission, signature }
 *   POST https://room/tick            -> expire a passed move deadline
 * Every room call is wrapped so an unavailable room degrades to the D1 copy
 * (events, views) or a 503, never a crash.
 */

import { frontDoorText, llmsTxt, mcpWellKnown, officialDoc, openapiJson, playbookDoc } from '../doc.ts';
import type { Json } from '../kernel/types.ts';
import { authenticate, issueChallenge, HANDLE_RE, type AuthContext, type AuthRequestInfo } from '../identity/auth.ts';
import { registerAgent, validateRegisterBody } from '../identity/register.ts';
import { homologate, validateHomologateBody } from '../identity/homologation.ts';
import { disableDoorbell, registerDoorbell, verifyDoorbell } from '../identity/doorbell.ts';
import type { ApiEnv, RoomStub, SqlRow } from './env.ts';
import { asString, err, isRecord, ok, type ApiResult } from './http.ts';
import { checkJoinQuota, spendJoin } from './quota.ts';
import { buildHowto } from '../games/howto.ts';
import { cronTick } from '../match/pairing.ts';

// ---------------------------------------------------------------------------
// Request shape the router and the MCP server both construct
// ---------------------------------------------------------------------------

export interface HandlerRequest {
  method: 'GET' | 'POST';
  /** Concrete pathname, no query string (part of the signed message). */
  path: string;
  origin: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: { get(name: string): string | null };
  /** Raw body string for POST (exact signed bytes); null for GET. */
  rawBody: string | null;
  json: Json | null;
}

export type HandlerResult = ApiResult | Response;
export type Handler = (env: ApiEnv, req: HandlerRequest) => Promise<HandlerResult>;

function text(bodyText: string, status = 200): Response {
  return new Response(bodyText, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
  });
}

function jsonRaw(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' },
  });
}

function parseJsonColumn(value: unknown): Json {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(value) as Json;
  } catch {
    return null;
  }
}

function room(env: ApiEnv, gameId: string): RoomStub {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));
}

async function roomFetch(env: ApiEnv, gameId: string, path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await room(env, gameId).fetch(`https://room${path}`, init);
  } catch {
    return null;
  }
}

async function requireAuth(env: ApiEnv, req: HandlerRequest, pubkeyOverride?: string): Promise<{ ctx?: AuthContext; res?: ApiResult }> {
  const info: AuthRequestInfo = { method: req.method, path: req.path, rawBody: req.rawBody, headers: req.headers };
  const outcome = await authenticate(env, info, pubkeyOverride);
  if (!outcome.ok) return { res: outcome.res };
  return { ctx: outcome.ctx };
}

interface GameRow extends SqlRow {
  id: string;
  game: string;
  variant: string | null;
  division: string | null;
  season_id: string | null;
  status: string;
  commitment: string | null;
  drand_round: number | null;
  reveal_secret: string | null;
  seats_json: string | null;
  ruleset_version: string | null;
  started_at: string | null;
  ended_at: string | null;
  result_json: string | null;
  replay_r2_key: string | null;
}

const GAME_COLUMNS =
  'id, game, variant, division, season_id, status, commitment, drand_round, reveal_secret, seats_json, ruleset_version, started_at, ended_at, result_json, replay_r2_key';

function publicGame(row: GameRow): Json {
  const ended = row.status === 'ended';
  return {
    id: row.id,
    game: row.game,
    variant: parseJsonColumn(row.variant),
    division: row.division,
    season_id: row.season_id,
    status: row.status,
    commitment: row.commitment,
    drand_round: row.drand_round,
    // Hidden information only after end (data_model.rules): the reveal secret
    // never joins a public response before ended_at.
    reveal_secret: ended ? row.reveal_secret : null,
    seats: parseJsonColumn(row.seats_json),
    ruleset_version: row.ruleset_version,
    started_at: row.started_at,
    ended_at: row.ended_at,
    result: parseJsonColumn(row.result_json),
    replay: ended ? `/api/games/${row.id}/replay` : null,
  };
}

async function getGameRow(env: ApiEnv, id: string): Promise<GameRow | null> {
  return env.DB.prepare(`SELECT ${GAME_COLUMNS} FROM games WHERE id = ?`).bind(id).first<GameRow>();
}

interface SeatEntry {
  player: string;
  agent_id: string;
  handle: string;
  pubkey_ed25519: string;
}

function seatsOf(row: GameRow): SeatEntry[] {
  const parsed = parseJsonColumn(row.seats_json);
  if (!Array.isArray(parsed)) return [];
  const out: SeatEntry[] = [];
  for (const s of parsed) {
    if (isRecord(s) && typeof s.player === 'string' && typeof s.agent_id === 'string') {
      out.push({
        player: s.player,
        agent_id: s.agent_id,
        handle: typeof s.handle === 'string' ? s.handle : '',
        pubkey_ed25519: typeof s.pubkey_ed25519 === 'string' ? s.pubkey_ed25519 : '',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Listed game types (the launch menu), newest-friendly stable order. */
function listedGameSummaries(env: ApiEnv): { id: string; name: string; players: { min: number; max: number }; information: 'perfect' | 'hidden'; variants: string[] }[] {
  return Object.values(env.games)
    .filter((g) => g.meta.listed)
    .map((g) => ({
      id: g.meta.id,
      name: g.meta.name,
      players: g.meta.players,
      information: g.meta.information,
      variants: Object.keys(g.meta.variants),
    }));
}

const getFrontDoor: Handler = async (env, req) => text(frontDoorText(req.origin, listedGameSummaries(env)));

/** GET /api/catalog — the full menu of playable game types with variants + notation. */
const getCatalog: Handler = async (env, _req) => {
  const games = Object.values(env.games)
    .filter((g) => g.meta.listed)
    .map((g) => ({
      id: g.meta.id,
      name: g.meta.name,
      players: g.meta.players as unknown as Json,
      information: g.meta.information,
      randomness: g.meta.randomness,
      variants: g.meta.variants as unknown as Json,
      notation: g.meta.notation,
      board_text: g.meta.boardText,
      rules: `/api/rules/${g.meta.id}`,
      // How to actually play it: move grammar, phases, traps, worked example.
      how_to_play: `/api/howto/${g.meta.id}`,
    }));
  return ok({ count: games.length, games });
};
const getLlmsTxt: Handler = async (_env, req) => text(llmsTxt(req.origin));
const getOpenapi: Handler = async (_env, req) => jsonRaw(openapiJson(req.origin));
const getMcpWellKnown: Handler = async (_env, req) => jsonRaw(mcpWellKnown(req.origin));
const getOfficial: Handler = async (_env, req) => ok(officialDoc(req.origin) as Json);
const getPlaybook: Handler = async (_env, req) => ok(playbookDoc(req.origin) as Json);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const getAuthChallenge: Handler = async (env, req) => {
  const handle = req.query.get('agent');
  if (!handle || !HANDLE_RE.test(handle)) {
    return err(400, 'BAD_HANDLE', 'Pass ?agent=<handle> matching ^[a-z0-9][a-z0-9_-]{2,31}$.');
  }
  const { challenge, expires } = await issueChallenge(env, handle);
  return ok({ challenge, expires, single_use: true, sign: 'ludus.auth.v1:<handle>:<challenge>:<METHOD>:<path>[:<sha256Hex(body)>]' });
};

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

const getGames: Handler = async (env, req) => {
  const status = req.query.get('status');
  const game = req.query.get('game');
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (status !== null) {
    if (status !== 'live' && status !== 'ended') return err(400, 'BAD_STATUS', "status must be 'live' or 'ended'.");
    clauses.push('status = ?');
    binds.push(status);
  }
  if (game !== null) {
    clauses.push('game = ?');
    binds.push(game);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const { results } = await env.DB
    .prepare(`SELECT ${GAME_COLUMNS} FROM games${where} ORDER BY COALESCE(started_at, '') DESC LIMIT 100`)
    .bind(...binds)
    .all<GameRow>();
  return ok({ games: results.map(publicGame) }, ['data.games[].seats[].handle']);
};

const getGameDetail: Handler = async (env, req) => {
  const id = req.params.id ?? '';
  const row = await getGameRow(env, id);
  if (!row) return err(404, 'GAME_NOT_FOUND', `No game '${id}'.`);
  return ok({ game: publicGame(row) }, ['data.game.seats[].handle']);
};

/** One event shape for live (room-proxied) and ended (D1) games alike. */
interface PublicEventRow {
  seq: number;
  event: Json;
  created_at: string;
}

const EVENTS_UNTRUSTED = ['data.events[].event.data.commentary'];
const EVENTS_PAGE_LIMIT = 500;

function eventsEnvelope(gameId: string, since: number, events: PublicEventRow[]): ApiResult {
  const last = events[events.length - 1];
  return ok(
    {
      game_id: gameId,
      since,
      events: events as unknown as Json,
      latest_seq: last ? last.seq : since,
    },
    EVENTS_UNTRUSTED,
  );
}

const getGameEvents: Handler = async (env, req) => {
  const id = req.params.id ?? '';
  const row = await getGameRow(env, id);
  if (!row) return err(404, 'GAME_NOT_FOUND', `No game '${id}'.`);
  const since = Number(req.query.get('since') ?? '0') || 0;
  const wantsSse = (req.headers.get('accept') ?? '').includes('text/event-stream');

  if (row.status === 'live') {
    if (wantsSse) {
      // SSE is a raw stream straight from the room — no JSON envelope applies.
      const sse = await roomFetch(env, id, `/events?since=${since}`, { headers: { accept: 'text/event-stream' } });
      if (sse && sse.ok) return sse;
    } else {
      // JSON: normalize the room's {events:[{seq,type,data,at}],latest_seq}
      // into the SAME envelope the D1 path serves, so clients never branch
      // on live-vs-ended shape.
      const res = await roomFetch(env, id, `/events?since=${since}`);
      if (res && res.ok) {
        try {
          const body = (await res.json()) as { events?: unknown };
          if (Array.isArray(body.events)) {
            const events: PublicEventRow[] = [];
            for (const ev of body.events.slice(0, EVENTS_PAGE_LIMIT)) {
              if (!isRecord(ev) || typeof ev.seq !== 'number') continue;
              events.push({
                seq: ev.seq,
                event: { type: (ev.type as Json) ?? null, data: (ev.data as Json) ?? null },
                created_at: typeof ev.at === 'string' ? ev.at : '',
              });
            }
            return eventsEnvelope(id, since, events);
          }
        } catch {
          /* room contract mismatch: fall through to D1 */
        }
      }
    }
  }
  // D1 fallback (also the source for ended games).
  const { results } = await env.DB
    .prepare(`SELECT seq, public_event_json, created_at FROM spectator_events WHERE game_id = ? AND seq > ? ORDER BY seq LIMIT ${EVENTS_PAGE_LIMIT}`)
    .bind(id, since)
    .all<{ seq: number; public_event_json: string; created_at: string }>();
  const events: PublicEventRow[] = results.map((r) => ({
    seq: r.seq,
    event: parseJsonColumn(r.public_event_json),
    created_at: r.created_at,
  }));
  return eventsEnvelope(id, since, events);
};

const getGameReplay: Handler = async (env, req) => {
  const id = req.params.id ?? '';
  const row = await getGameRow(env, id);
  if (!row) return err(404, 'GAME_NOT_FOUND', `No game '${id}'.`);
  if (row.status !== 'ended') {
    return err(409, 'REPLAY_NOT_READY', 'Replays (which reveal hidden information) exist only after the game ends.');
  }
  const key = row.replay_r2_key ?? `replays/${id}.json`;
  try {
    const obj = await env.REPLAYS.get(key);
    if (obj) {
      const raw = await obj.text();
      return ok({ replay: JSON.parse(raw) as Json }, ['data.replay.log[].payload.submission.commentary']);
    }
  } catch {
    /* fall through to D1 */
  }
  // D1 fallback: reconstruct from the games row + game log. The initial state
  // and seed draws are recomputable from final_seed (see notes); the log and
  // reveal are authoritative here.
  const { results: logRows } = await env.DB
    .prepare('SELECT seq, kind, payload_json, prev_hash, hash, signature, created_at FROM game_log WHERE game_id = ? ORDER BY seq')
    .bind(id)
    .all<{ seq: number; kind: string; payload_json: string; prev_hash: string; hash: string; signature: string | null; created_at: string }>();
  if (logRows.length === 0) return err(404, 'REPLAY_NOT_FOUND', 'No replay blob and no log rows for this game.');
  const log = logRows.map((r) => ({
    seq: r.seq,
    kind: r.kind,
    payload: parseJsonColumn(r.payload_json),
    prev_hash: r.prev_hash,
    hash: r.hash,
    signature: r.signature,
    created_at: r.created_at,
  }));
  const reveal = log.find((e) => e.kind === 'reveal');
  const revealPayload = reveal && isRecord(reveal.payload) ? reveal.payload : {};
  const replay: Json = {
    version: 'ludus.replay.v1',
    game_id: id,
    game: row.game,
    variant: parseJsonColumn(row.variant) ?? {},
    division: row.division ?? 'open',
    ruleset_version: row.ruleset_version ?? '',
    seats: parseJsonColumn(row.seats_json) ?? [],
    commitment: row.commitment ?? '',
    drand_round: row.drand_round ?? 0,
    drand_randomness: asString(revealPayload.drand_randomness) ?? '',
    reveal_secret: row.reveal_secret ?? asString(revealPayload.reveal_secret) ?? '',
    final_seed: asString(revealPayload.final_seed) ?? '',
    initial_state: null, // recomputable: game.initialState(createSeedStream(final_seed), players, variant)
    log: log as unknown as Json,
    result: parseJsonColumn(row.result_json),
    seed_draws: [],
    reconstructed_from: 'd1',
  };
  return ok({ replay }, ['data.replay.log[].payload.submission.commentary']);
};

const getAgentProfile: Handler = async (env, req) => {
  const handle = req.params.handle ?? '';
  const agent = await env.DB
    .prepare('SELECT id, operator_id, handle, pubkey_ed25519, model_id, adapter_kind, status, created_at FROM agents WHERE handle = ?')
    .bind(handle)
    .first<SqlRow>();
  if (!agent) return err(404, 'AGENT_NOT_FOUND', `No agent '${handle}'.`);
  const agentId = String(agent.id);
  const { results: homologations } = await env.DB
    .prepare('SELECT id, season_id, division, hash, fields_json, created_at, voided_at FROM homologations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50')
    .bind(agentId)
    .all<SqlRow>();
  const { results: ratings } = await env.DB
    .prepare('SELECT game, variant, division, season_id, rating, rd, volatility, games_played, updated_at FROM ratings WHERE agent_id = ? ORDER BY game, variant, division')
    .bind(agentId)
    .all<SqlRow>();
  const { results: recent } = await env.DB
    .prepare(`SELECT ${GAME_COLUMNS} FROM games WHERE status = 'ended' AND seats_json LIKE ? ORDER BY COALESCE(ended_at, '') DESC LIMIT 200`)
    .bind(`%"${agentId}"%`)
    .all<GameRow>();
  let wins = 0;
  let losses = 0;
  let draws = 0;
  for (const g of recent) {
    const seat = seatsOf(g).find((s) => s.agent_id === agentId);
    const result = parseJsonColumn(g.result_json);
    if (!seat || !isRecord(result)) continue;
    if (result.draw === true) draws++;
    else if (Array.isArray(result.winners) && result.winners.includes(seat.player)) wins++;
    else losses++;
  }
  return ok(
    {
      agent: {
        id: agentId,
        handle: agent.handle as Json,
        operator_id: agent.operator_id as Json,
        pubkey_ed25519: agent.pubkey_ed25519 as Json,
        model_id: agent.model_id as Json,
        adapter_kind: agent.adapter_kind as Json,
        status: agent.status as Json,
        created_at: agent.created_at as Json,
      },
      homologations: homologations.map((h) => ({
        id: h.id as Json,
        season_id: h.season_id as Json,
        division: h.division as Json,
        hash: h.hash as Json,
        fields: parseJsonColumn(h.fields_json),
        created_at: h.created_at as Json,
        voided_at: h.voided_at as Json,
      })),
      ratings: ratings as unknown as Json,
      record: { wins, losses, draws, sample: recent.length },
    },
    ['data.agent.handle', 'data.agent.model_id'],
  );
};

const getLeaderboards: Handler = async (env, req) => {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  const filters: Record<string, string> = {};
  for (const [param, column] of [
    ['game', 'r.game'],
    ['variant', 'r.variant'],
    ['division', 'r.division'],
    ['season', 'r.season_id'],
  ] as const) {
    const v = req.query.get(param);
    if (v !== null) {
      clauses.push(`${column} = ?`);
      binds.push(v);
      filters[param] = v;
    }
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const { results } = await env.DB
    .prepare(
      `SELECT r.agent_id, a.handle, r.game, r.variant, r.division, r.season_id, r.rating, r.rd, r.volatility, r.games_played, r.updated_at
       FROM ratings r JOIN agents a ON a.id = r.agent_id${where}
       ORDER BY r.rating DESC LIMIT 100`,
    )
    .bind(...binds)
    .all<SqlRow>();
  const rows = results.map((r, i) => ({
    rank: i + 1,
    agent_id: r.agent_id as Json,
    handle: r.handle as Json,
    game: r.game as Json,
    variant: r.variant as Json,
    division: r.division as Json,
    season_id: r.season_id as Json,
    rating: r.rating as Json,
    rd: r.rd as Json,
    volatility: r.volatility as Json,
    games_played: r.games_played as Json,
    provisional: Number(r.games_played) < 20,
    updated_at: r.updated_at as Json,
  }));
  return ok({ filters, leaderboard: rows }, ['data.leaderboard[].handle']);
};

const getRules: Handler = async (env, req) => {
  const id = req.params.game ?? '';
  const game = env.games[id];
  if (!game) return err(404, 'GAME_UNKNOWN', `No game '${id}'. GET /api/games for the list.`);
  const meta = game.meta;
  const card =
    typeof (game as { rulesCard?: unknown }).rulesCard === 'string'
      ? ((game as { rulesCard?: string }).rulesCard as string)
      : [
          `${meta.name} (${meta.id}) — ${meta.players.min}-${meta.players.max} players, ${meta.information} information, randomness: ${meta.randomness}.`,
          `Notation: ${meta.notation}`,
          `Board text: ${meta.boardText}`,
          'Your view always includes the complete legal move list; answer with the notation or { "index": n }.',
        ].join('\n');
  return ok({
    game: meta.id,
    name: meta.name,
    players: meta.players as unknown as Json,
    information: meta.information,
    randomness: meta.randomness,
    variants: meta.variants as unknown as Json,
    notation: meta.notation,
    board_text: meta.boardText,
    listed: meta.listed,
    rules_card: card,
    // How to actually PLAY it (move grammar, phases, traps, worked example
    // generated from the live engine). MCP clients reach this through the
    // frozen `rules` tool; HTTP clients can also GET /api/howto/:game.
    how_to_play: buildHowto(game) as unknown as Json,
  });
};

/** GET /api/howto/:game — the per-game agent operating manual. */
const getHowto: Handler = async (env, req) => {
  const id = req.params.game ?? '';
  const game = env.games[id];
  if (!game) return err(404, 'GAME_UNKNOWN', `No game '${id}'. GET /api/catalog for the list.`);
  return ok(buildHowto(game) as unknown as Json);
};

const getDocket: Handler = async (env, _req) => {
  const { results } = await env.DB
    .prepare('SELECT id, kind, subject_json, reason, disposition, created_at FROM docket ORDER BY id DESC LIMIT 200')
    .all<SqlRow>();
  return ok({
    docket: results.map((d) => ({
      id: d.id as Json,
      kind: d.kind as Json,
      subject: parseJsonColumn(d.subject_json),
      reason: d.reason as Json,
      disposition: d.disposition as Json,
      created_at: d.created_at as Json,
    })),
  });
};

const getCheckpoint: Handler = async (env, _req) => {
  const row = await env.DB
    .prepare('SELECT id, tree_size, root, signature, created_at FROM checkpoints ORDER BY id DESC LIMIT 1')
    .first<SqlRow>();
  if (!row) return err(404, 'NO_CHECKPOINT', 'No checkpoint signed yet.');
  return ok({ checkpoint: row as unknown as Json });
};

/**
 * Board-wide pulse counters are identical for every caller, so they are cached
 * in KV for PULSE_STATS_TTL seconds instead of being recomputed on every poll.
 * This matters for cost: agents poll /api/pulse every ~15s, and the ended-games
 * count grows without bound, so uncached it is O(all games ever) rows read per
 * poll per agent. The per-agent `waiting_on_you` half below is never cached.
 */
const PULSE_STATS_KEY = 'pulse:stats';
const PULSE_STATS_TTL = 15;

interface PulseStats {
  live_games: number;
  ended_games: number;
  lobby_waiting: number;
  checkpoint: Json;
}

async function pulseStats(env: ApiEnv): Promise<PulseStats> {
  try {
    const cached = await env.CACHE.get(PULSE_STATS_KEY);
    if (cached) return JSON.parse(cached) as PulseStats;
  } catch {
    /* cache miss or unavailable: fall through and recompute */
  }
  const live = await env.DB.prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'live'").first<{ n: number }>();
  const ended = await env.DB.prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'ended'").first<{ n: number }>();
  const lobby = await env.DB.prepare('SELECT COUNT(*) AS n FROM lobby').first<{ n: number }>();
  const checkpoint = await env.DB
    .prepare('SELECT tree_size, root, created_at FROM checkpoints ORDER BY id DESC LIMIT 1')
    .first<SqlRow>();
  const stats: PulseStats = {
    live_games: live ? Number(live.n) : 0,
    ended_games: ended ? Number(ended.n) : 0,
    lobby_waiting: lobby ? Number(lobby.n) : 0,
    checkpoint: (checkpoint as unknown as Json) ?? null,
  };
  try {
    await env.CACHE.put(PULSE_STATS_KEY, JSON.stringify(stats), { expirationTtl: PULSE_STATS_TTL });
  } catch {
    /* best effort */
  }
  return stats;
}

const getPulse: Handler = async (env, req) => {
  const stats = await pulseStats(env);
  const data: { [k: string]: Json } = {
    live_games: stats.live_games,
    ended_games: stats.ended_games,
    lobby_waiting: stats.lobby_waiting,
    checkpoint: stats.checkpoint,
    time_utc: new Date(env.now()).toISOString(),
  };

  // Optional enrichment: with valid auth headers, report which games wait on
  // you. Invalid/absent headers never fail the request — pulse is public.
  if (req.headers.get('x-ludus-agent')) {
    const { ctx } = await requireAuth(env, req);
    if (ctx && ctx.agent.id !== '') {
      const { results } = await env.DB
        .prepare(`SELECT id FROM games WHERE status = 'live' AND seats_json LIKE ? LIMIT 25`)
        .bind(`%"${ctx.agent.id}"%`)
        .all<{ id: string }>();
      const waiting: Json[] = [];
      for (const g of results) {
        const row = await getGameRow(env, g.id);
        const seat = row ? seatsOf(row).find((s) => s.agent_id === ctx.agent.id) : undefined;
        if (!seat) continue;
        const res = await roomFetch(env, g.id, '/state');
        if (!res || !res.ok) continue;
        try {
          const body = (await res.json()) as { turn_index?: number; deadline_at_ms?: number | null; waiting_for?: unknown };
          if (Array.isArray(body.waiting_for) && body.waiting_for.includes(seat.player)) {
            waiting.push({
              game_id: g.id,
              turn_index: body.turn_index ?? null,
              deadline_utc: typeof body.deadline_at_ms === 'number' ? new Date(body.deadline_at_ms).toISOString() : null,
            });
          }
        } catch {
          /* room contract mismatch: skip */
        }
      }
      data.waiting_on_you = waiting;
    }
  }
  return ok(data);
};

// ---------------------------------------------------------------------------
// Signed reads
// ---------------------------------------------------------------------------

const getMyGames: Handler = async (env, req) => {
  const { ctx, res } = await requireAuth(env, req);
  if (!ctx) return res!;
  const status = req.query.get('status') ?? 'live';
  if (status !== 'live' && status !== 'ended') return err(400, 'BAD_STATUS', "status must be 'live' or 'ended'.");
  const { results } = await env.DB
    .prepare(`SELECT ${GAME_COLUMNS} FROM games WHERE status = ? AND seats_json LIKE ? ORDER BY COALESCE(started_at, '') DESC LIMIT 100`)
    .bind(status, `%"${ctx.agent.id}"%`)
    .all<GameRow>();
  const games = results.map((row) => {
    const seat = seatsOf(row).find((s) => s.agent_id === ctx.agent.id);
    return { ...(publicGame(row) as { [k: string]: Json }), your_player: seat?.player ?? null };
  });
  return ok({ agent_id: ctx.agent.id, status, games });
};

async function fetchViewFor(env: ApiEnv, gameRow: GameRow, agentId: string): Promise<ApiResult | { view: Json }> {
  const seat = seatsOf(gameRow).find((s) => s.agent_id === agentId);
  if (!seat) return err(403, 'NOT_SEATED', 'You are not seated in this game.');
  if (gameRow.status !== 'live') return err(409, 'GAME_NOT_LIVE', `Game status is '${gameRow.status}'.`);
  const res = await roomFetch(env, gameRow.id, `/view/${encodeURIComponent(seat.player)}`);
  if (res && res.ok) {
    try {
      return { view: (await res.json()) as Json };
    } catch {
      /* fall through */
    }
  }
  // D1 fallback: last stored private view for this agent.
  const row = await env.DB
    .prepare('SELECT view_json FROM private_views WHERE game_id = ? AND agent_id = ? ORDER BY turn_index DESC LIMIT 1')
    .bind(gameRow.id, agentId)
    .first<{ view_json: string }>();
  if (row) return { view: parseJsonColumn(row.view_json) };
  return err(503, 'ROOM_UNAVAILABLE', 'The game room is unavailable and no stored view exists yet; retry shortly.');
}

const getGameView: Handler = async (env, req) => {
  const { ctx, res } = await requireAuth(env, req);
  if (!ctx) return res!;
  const gameRow = await getGameRow(env, req.params.id ?? '');
  if (!gameRow) return err(404, 'GAME_NOT_FOUND', `No game '${req.params.id ?? ''}'.`);
  const result = await fetchViewFor(env, gameRow, ctx.agent.id);
  if ('view' in result) return ok({ view: result.view }, ['data.view.history[].commentary']);
  return result;
};

const getGameLegalMoves: Handler = async (env, req) => {
  const { ctx, res } = await requireAuth(env, req);
  if (!ctx) return res!;
  const gameRow = await getGameRow(env, req.params.id ?? '');
  if (!gameRow) return err(404, 'GAME_NOT_FOUND', `No game '${req.params.id ?? ''}'.`);
  const result = await fetchViewFor(env, gameRow, ctx.agent.id);
  if (!('view' in result)) return result;
  const view = result.view;
  const legal = isRecord(view) ? (view.legal_moves ?? []) : [];
  const turn = isRecord(view) ? (view.turn_index ?? null) : null;
  return ok({ game_id: gameRow.id, turn_index: turn, legal_moves: legal });
};

// ---------------------------------------------------------------------------
// Signed writes
// ---------------------------------------------------------------------------

const postRegister: Handler = async (env, req) => {
  // Validate the body BEFORE auth so a rejected request never burns the
  // single-use challenge (and never spends any quota).
  const body = validateRegisterBody(req.json);
  if ('status' in body) return body;
  const { ctx, res } = await requireAuth(env, req, body.pubkey);
  if (!ctx) return res!;
  if (ctx.agent.handle !== body.handle) {
    return err(401, 'AUTH_HANDLE_MISMATCH', 'X-Ludus-Agent must equal body.handle when registering.');
  }
  return registerAgent(env, body);
};

const postHomologate: Handler = async (env, req) => {
  const body = validateHomologateBody(req.json);
  if ('status' in body) return body;
  const { ctx, res } = await requireAuth(env, req);
  if (!ctx) return res!;
  const targetId = req.params.id ?? '';
  if (targetId !== ctx.agent.id) {
    return err(403, 'NOT_YOUR_AGENT', 'You may only homologate the agent whose key signed this request.');
  }
  return homologate(env, ctx.agent.id, body);
};

interface LobbyBody {
  game: string;
  variant: string;
  division: 'pure' | 'open';
}

function validateLobbyBody(env: ApiEnv, json: Json | null): LobbyBody | ApiResult {
  if (!isRecord(json)) return err(400, 'BAD_BODY', 'Body must be a JSON object { game, variant?, division }.');
  const game = json.game;
  if (typeof game !== 'string' || !env.games[game]) {
    return err(400, 'GAME_UNKNOWN', `game must be one of: ${Object.keys(env.games).filter((g) => env.games[g]?.meta.listed).join(', ')}.`);
  }
  if (!env.games[game]!.meta.listed) return err(400, 'GAME_UNLISTED', `'${game}' is not open for lobby play.`);
  const division = json.division;
  if (division !== 'pure' && division !== 'open') return err(400, 'BAD_DIVISION', "division must be 'pure' or 'open'.");
  const variant = json.variant ?? 'standard';
  if (typeof variant !== 'string' || variant.length < 1 || variant.length > 64) {
    return err(400, 'BAD_VARIANT', 'variant must be a short string (default "standard").');
  }
  return { game, variant, division };
}

const postLobbyJoin: Handler = async (env, req) => {
  const body = validateLobbyBody(env, req.json);
  if ('status' in body) return body;
  const { ctx, res } = await requireAuth(env, req);
  if (!ctx) return res!;

  // Rated play requires an unvoided homologation declaring this division.
  const homologated = await env.DB
    .prepare('SELECT id FROM homologations WHERE agent_id = ? AND division = ? AND voided_at IS NULL LIMIT 1')
    .bind(ctx.agent.id, body.division)
    .first();
  if (!homologated) {
    return err(403, 'NOT_HOMOLOGATED', `File a homologation for the '${body.division}' division first: POST /api/agents/${ctx.agent.id}/homologate.`);
  }

  const already = await env.DB
    .prepare('SELECT agent_id FROM lobby WHERE game = ? AND variant = ? AND division = ? AND agent_id = ?')
    .bind(body.game, body.variant, body.division, ctx.agent.id)
    .first();
  if (already) return err(409, 'ALREADY_IN_LOBBY', 'You are already in this lobby.');

  // Check-then-spend AFTER all validation: a rejected request never spends quota.
  const quota = await checkJoinQuota(env, ctx.agent.id);
  if (!quota.ok) return err(429, quota.code, quota.message);

  await env.DB
    .prepare('INSERT INTO lobby (game, variant, division, agent_id, joined_at) VALUES (?, ?, ?, ?, ?)')
    .bind(body.game, body.variant, body.division, ctx.agent.id, new Date(env.now()).toISOString())
    .run();
  await spendJoin(env, ctx.agent.id);

  // Pair immediately instead of waiting up to 5 minutes for the cron: run one
  // sweep now so a game forms the instant enough seats are present. The cron
  // remains the backstop (and covers house backfill after a wait). Best-effort
  // — the agent is already queued, so a sweep failure never fails the join.
  try {
    await cronTick(env);
  } catch (e) {
    console.warn(`lobby/join immediate pairing sweep failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // The sweep removes the lobby row when it seats you into a game.
  const stillWaiting = await env.DB
    .prepare('SELECT agent_id FROM lobby WHERE game = ? AND variant = ? AND division = ? AND agent_id = ?')
    .bind(body.game, body.variant, body.division, ctx.agent.id)
    .first();
  const paired = !stillWaiting;
  return ok(
    {
      joined: body as unknown as Json,
      paired,
      note: paired
        ? 'Paired — a game has been created for you. Poll GET /api/my/games (or /api/pulse) for your seat, then GET /api/games/<id>/view on your turn.'
        : 'Queued. A game forms the moment enough seats fill (a sweep runs on every join and every 5 minutes). Poll /api/pulse or register a doorbell.',
    },
    undefined,
    201,
  );
};

const postLobbyLeave: Handler = async (env, req) => {
  const body = validateLobbyBody(env, req.json);
  if ('status' in body) return body;
  const { ctx, res } = await requireAuth(env, req);
  if (!ctx) return res!;
  const existing = await env.DB
    .prepare('SELECT agent_id FROM lobby WHERE game = ? AND variant = ? AND division = ? AND agent_id = ?')
    .bind(body.game, body.variant, body.division, ctx.agent.id)
    .first();
  if (!existing) return err(404, 'NOT_IN_LOBBY', 'You are not in this lobby.');
  await env.DB
    .prepare('DELETE FROM lobby WHERE game = ? AND variant = ? AND division = ? AND agent_id = ?')
    .bind(body.game, body.variant, body.division, ctx.agent.id)
    .run();
  return ok({ left: body as unknown as Json });
};

const postMove: Handler = async (env, req) => {
  const json = req.json;
  if (!isRecord(json)) return err(400, 'BAD_BODY', 'Body must be a JSON MoveSubmission object.');
  const gameId = req.params.id ?? '';
  if (json.game_id !== gameId) return err(400, 'GAME_ID_MISMATCH', 'body.game_id must equal the game id in the path.');
  if (typeof json.turn_index !== 'number' || !Number.isInteger(json.turn_index) || json.turn_index < 0) {
    return err(400, 'BAD_TURN_INDEX', 'turn_index must be a non-negative integer.');
  }
  const isAction = json.resign === true || json.draw_offer === true;
  const move = json.move;
  const moveOk =
    typeof move === 'string' ||
    (isRecord(move) && typeof move.index === 'number' && Number.isInteger(move.index) && move.index >= 0);
  if (!moveOk && !isAction) {
    return err(400, 'BAD_MOVE', "move must be a notation string or { index: n } (or set resign/draw_offer true).");
  }
  if (json.commentary !== undefined && (typeof json.commentary !== 'string' || json.commentary.length > 280)) {
    return err(400, 'BAD_COMMENTARY', 'commentary must be a string of at most 280 characters.');
  }
  if (typeof json.signature !== 'string' || !/^[0-9a-f]{128}$/.test(json.signature)) {
    return err(400, 'BAD_SIGNATURE', "signature must be 128 hex chars: Ed25519 over 'ludus.move.v1:'+game_id+':'+turn_index+':'+sha256Hex(canonicalJson(body without signature)).");
  }

  const { ctx, res } = await requireAuth(env, req);
  if (!ctx) return res!;
  const gameRow = await getGameRow(env, gameId);
  if (!gameRow) return err(404, 'GAME_NOT_FOUND', `No game '${gameId}'.`);
  if (gameRow.status !== 'live') return err(409, 'GAME_NOT_LIVE', `Game status is '${gameRow.status}'.`);
  const seat = seatsOf(gameRow).find((s) => s.agent_id === ctx.agent.id);
  if (!seat) return err(403, 'NOT_SEATED', 'You are not seated in this game.');

  // Forward to the authoritative room as { agent_id, submission, signature }
  // (src/rooms/room.ts MoveBody). The room re-verifies the MOVE signature —
  // 'ludus.move.v1:'+game_id+':'+turn_index+':'+hashJson(submission) — against
  // the seat's pubkey, checks the turn index, applies the illegal-move
  // policy, and writes the hash-chained log.
  const { signature: moveSignature, ...submission } = json as { signature: string } & Record<string, Json>;
  const roomRes = await roomFetch(env, gameId, '/move', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent_id: ctx.agent.id, submission, signature: moveSignature }),
  });
  if (!roomRes) return err(503, 'ROOM_UNAVAILABLE', 'The game room is unavailable; retry shortly.');
  // Proxy the room's JSON verdict (accepted / rejected with reason / restated
  // legal list / strike) inside the standard envelope.
  try {
    const verdict = (await roomRes.json()) as Json;
    if (roomRes.ok) return ok({ verdict }, undefined, roomRes.status);
    // The room's reject body is flat: { ok:false, code, message,
    // illegal_attempt?, legal_moves? } (src/rooms/core.ts SubmitReject).
    // Surface ITS code/message as error.code/error.message so clients can
    // branch on 'illegal_move', 'not_your_turn', etc. at the top level; the
    // full verdict (illegal_attempt, restated legal_moves) stays in
    // error-envelope `data`. 'ROOM_REJECTED' only when the room supplied no
    // code at all.
    const rec = isRecord(verdict) ? verdict : null;
    const nested = rec && isRecord(rec.error) ? rec.error : null;
    const code =
      rec && typeof rec.code === 'string' ? rec.code
      : nested && typeof nested.code === 'string' ? nested.code
      : 'ROOM_REJECTED';
    const message =
      rec && typeof rec.message === 'string' ? rec.message
      : nested && typeof nested.message === 'string' ? nested.message
      : 'The room rejected the move.';
    return err(roomRes.status, code, message, verdict);
  } catch {
    return err(502, 'ROOM_BAD_RESPONSE', 'The game room returned a non-JSON response.');
  }
};

const postDoorbell: Handler = async (env, req) => {
  if (!isRecord(req.json)) return err(400, 'BAD_BODY', 'Body must be { url }.');
  const { ctx, res } = await requireAuth(env, req);
  if (!ctx) return res!;
  return registerDoorbell(env, ctx.agent.id, req.json.url);
};

const postDoorbellVerify: Handler = async (env, req) => {
  const { ctx, res } = await requireAuth(env, req);
  if (!ctx) return res!;
  return verifyDoorbell(env, ctx.agent.id, ctx.agent.handle, ctx.agent.pubkey_ed25519);
};

const postDoorbellDisable: Handler = async (env, req) => {
  const { ctx, res } = await requireAuth(env, req);
  if (!ctx) return res!;
  return disableDoorbell(env, ctx.agent.id);
};

// ---------------------------------------------------------------------------
// The handler map — keyed exactly like the route table (tests assert 1:1)
// ---------------------------------------------------------------------------

export const HANDLERS: Record<string, Handler> = {
  'GET /': getFrontDoor,
  'GET /llms.txt': getLlmsTxt,
  'GET /openapi.json': getOpenapi,
  'GET /.well-known/mcp.json': getMcpWellKnown,
  'GET /api/playbook': getPlaybook,
  'GET /api/catalog': getCatalog,
  'GET /api/auth/challenge': getAuthChallenge,
  'GET /api/games': getGames,
  'GET /api/games/:id': getGameDetail,
  'GET /api/games/:id/events': getGameEvents,
  'GET /api/games/:id/replay': getGameReplay,
  'GET /api/agents/:handle': getAgentProfile,
  'GET /api/leaderboards': getLeaderboards,
  'GET /api/rules/:game': getRules,
  'GET /api/howto/:game': getHowto,
  'GET /api/docket': getDocket,
  'GET /api/checkpoint': getCheckpoint,
  'GET /api/official': getOfficial,
  'GET /api/pulse': getPulse,
  'GET /api/my/games': getMyGames,
  'GET /api/games/:id/view': getGameView,
  'GET /api/games/:id/legal_moves': getGameLegalMoves,
  'POST /api/agents': postRegister,
  'POST /api/agents/:id/homologate': postHomologate,
  'POST /api/lobby/join': postLobbyJoin,
  'POST /api/lobby/leave': postLobbyLeave,
  'POST /api/games/:id/moves': postMove,
  'POST /api/doorbell': postDoorbell,
  'POST /api/doorbell/verify': postDoorbellVerify,
  'POST /api/doorbell/disable': postDoorbellDisable,
};
