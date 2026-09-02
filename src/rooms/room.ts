/**
 * GameRoom — the Durable Object class wrapping RoomCore (src/rooms/core.ts).
 *
 * One DO instance per live game. All game-session rules live in the pure
 * RoomCore; this class only does I/O: routing the internal HTTP API, DO
 * alarms for move deadlines, persistence of the core snapshot in
 * ctx.storage, spectator fan-out (JSON polling + SSE), and the R2 replay
 * upload when the game ends.
 *
 * Internal API (the Worker in src/index.ts routes here; the DO trusts its
 * caller — agent authentication is the Ed25519 signature on each move):
 *   POST /create   { game_id, game, seats, variant?, division?, ruleset_version?,
 *                    secret_hex?, drand_round, drand_randomness,
 *                    per_move_ms?, clock_scale?, rules_card? }
 *   POST /move     { agent_id, submission, signature }
 *   POST /tick     {}                    — runs the timeout check now (tests/ops)
 *   GET  /view/:player                   — ViewObject for that seat
 *   GET  /events?since=N[&sse=1]         — spectator events after seq N (public only)
 *   GET  /replay                         — ReplayFile once ended (409 before)
 *   GET  /state                          — public state summary
 *
 * The class is re-exported from src/index.ts by T7 for wrangler; tests drive
 * it directly with an in-memory ctx/env mock (the structural RoomCtx/RoomEnv
 * interfaces below are satisfied by the real DurableObjectState/Env).
 */

import { generateSecretHex } from '../crypto/commit.ts';
import { getGame } from '../games/index.ts';
import type { AnyGame, Json, MoveSubmission, PlayerId, VariantConfig } from '../kernel/types.ts';
import {
  RoomCore,
  type CreateRoomParams,
  type RoomSeat,
  type RoomSnapshot,
  type SpectatorEvent,
} from './core.ts';

// ---------------------------------------------------------------------------
// Structural dependency types (satisfied by real DurableObjectState / Env)
// ---------------------------------------------------------------------------

export interface RoomStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface RoomCtx {
  storage: RoomStorage;
}

/** Minimal R2 surface the room uses (satisfied by a real R2Bucket binding). */
export interface ReplayBucket {
  put(key: string, value: string): Promise<unknown>;
}

export interface RoomEnv {
  /** R2 replay bucket. When the binding is absent the upload is skipped. */
  REPLAYS?: ReplayBucket;
}

// ---------------------------------------------------------------------------
// Game resolution (injectable so room tests can register fixture games)
// ---------------------------------------------------------------------------

type GameResolver = (id: string) => AnyGame | undefined;
let resolveGame: GameResolver = (id) => getGame(id);

/** Tests may swap the registry lookup; pass null to restore the default. */
export function setGameResolverForTests(fn: GameResolver | null): void {
  resolveGame = fn ?? ((id) => getGame(id));
}

// ---------------------------------------------------------------------------
// Request/response helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'room';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function errorJson(status: number, code: string, message: string): Response {
  return json({ ok: false, code, message }, status);
}

interface CreateBody {
  game_id: string;
  game: string;
  seats: RoomSeat[];
  variant?: VariantConfig;
  division?: 'pure' | 'open';
  ruleset_version?: string;
  secret_hex?: string;
  drand_round: number;
  drand_randomness: string;
  per_move_ms?: number;
  /** Cumulative per-side clock budget, ms; null disables. Omitted = the game's spec default. */
  per_side_ms?: number | null;
  clock_scale?: number;
  rules_card?: string;
}

interface MoveBody {
  agent_id: string;
  submission: MoveSubmission;
  signature: string;
}

interface SseSubscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}

// ---------------------------------------------------------------------------
// The Durable Object
// ---------------------------------------------------------------------------

export class GameRoom {
  private readonly ctx: RoomCtx;
  private readonly env: RoomEnv;
  private core: RoomCore | null = null;
  private loaded = false;
  private replayUploaded = false;
  private readonly subscribers = new Set<SseSubscriber>();
  private readonly encoder = new TextEncoder();

  constructor(ctx: RoomCtx, env: RoomEnv) {
    this.ctx = ctx;
    this.env = env;
  }

  // ------------------------------------------------------------ lifecycle --

  private async load(): Promise<RoomCore | null> {
    if (this.loaded) return this.core;
    this.loaded = true;
    const snap = await this.ctx.storage.get<RoomSnapshot>(STORAGE_KEY);
    if (snap !== undefined) {
      const game = resolveGame(snap.game);
      if (!game) throw new Error(`GameRoom: game '${snap.game}' is not in the registry`);
      this.core = RoomCore.hydrate(game, snap);
    }
    return this.core;
  }

  private async persist(core: RoomCore): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY, core.snapshot());
    if (core.status === 'running' && core.deadlineAtMs !== null) {
      await this.ctx.storage.setAlarm(core.deadlineAtMs);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  /** DO alarm: the shared move deadline for the current turn/phase passed. */
  async alarm(): Promise<void> {
    const core = await this.load();
    if (!core || core.status !== 'running') return;
    const result = core.timeout(Date.now());
    await this.persist(core);
    this.broadcast(result.events);
    if (result.ended) await this.uploadReplay(core);
  }

  // -------------------------------------------------------------- routing --

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (request.method === 'POST' && path === '/create') return await this.handleCreate(request);
      if (request.method === 'POST' && path === '/move') return await this.handleMove(request);
      if (request.method === 'POST' && path === '/tick') return await this.handleTick();
      if (request.method === 'GET' && path.startsWith('/view/')) {
        return await this.handleView(path.slice('/view/'.length));
      }
      if (request.method === 'GET' && path === '/events') return await this.handleEvents(request, url);
      if (request.method === 'GET' && path === '/replay') return await this.handleReplay();
      if (request.method === 'GET' && path === '/state') return await this.handleState();
      return errorJson(404, 'not_found', `no route ${request.method} ${path}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorJson(500, 'internal', message);
    }
  }

  private async handleCreate(request: Request): Promise<Response> {
    const existing = await this.load();
    if (existing) return errorJson(409, 'already_created', 'this room already hosts a game');

    const body = (await request.json()) as CreateBody;
    if (typeof body.game_id !== 'string' || body.game_id.length === 0) {
      return errorJson(400, 'bad_request', 'game_id is required');
    }
    const game = resolveGame(body.game);
    if (!game) return errorJson(400, 'unknown_game', `game '${body.game}' is not in the registry`);
    if (!Array.isArray(body.seats) || body.seats.length === 0) {
      return errorJson(400, 'bad_request', 'seats are required');
    }
    if (!Number.isInteger(body.drand_round) || typeof body.drand_randomness !== 'string') {
      return errorJson(400, 'bad_request', 'drand_round and drand_randomness are required');
    }

    const params: CreateRoomParams = {
      gameId: body.game_id,
      game,
      variant: body.variant ?? {},
      seats: body.seats,
      division: body.division ?? 'open',
      rulesetVersion: body.ruleset_version ?? '1.0.0',
      secretHex: body.secret_hex ?? generateSecretHex(),
      drandRound: body.drand_round,
      drandRandomnessHex: body.drand_randomness,
    };
    if (body.per_move_ms !== undefined) params.perMoveMs = body.per_move_ms;
    if (body.per_side_ms !== undefined) params.perSideMs = body.per_side_ms;
    if (body.clock_scale !== undefined) params.clockScale = body.clock_scale;
    if (body.rules_card !== undefined) params.rulesCard = body.rules_card;

    let core: RoomCore;
    try {
      core = RoomCore.create(Date.now(), params);
    } catch (err) {
      return errorJson(400, 'bad_request', err instanceof Error ? err.message : String(err));
    }
    this.core = core;
    this.loaded = true;
    await this.persist(core);
    this.broadcast(core.eventsSince(0));
    return json(core.publicStateSummary(), 201);
  }

  private async handleMove(request: Request): Promise<Response> {
    const core = await this.load();
    if (!core) return errorJson(404, 'no_game', 'no game in this room yet');
    const body = (await request.json()) as MoveBody;
    if (typeof body.agent_id !== 'string' || typeof body.signature !== 'string' || body.submission == null) {
      return errorJson(400, 'bad_request', 'agent_id, submission, and signature are required');
    }
    const now = Date.now();
    // DO alarms are at-least-once and can lag: resolve an expired deadline
    // BEFORE the submission so a late move can never land as a clean move for
    // the expired turn (the core also rejects late moves as a second guard).
    const expired = core.timeout(now);
    const result = core.submitMove(now, body.agent_id, body.submission, body.signature);
    await this.persist(core);
    if (expired.fired) {
      this.broadcast(expired.events);
      if (expired.ended) await this.uploadReplay(core);
    }
    if (result.ok) {
      this.broadcast(result.events);
      if (result.ended) await this.uploadReplay(core);
      // Do not ship the events array to the mover — spectators use /events.
      const { events: _events, ...rest } = result;
      return json(rest);
    }
    return json(result, 400);
  }

  private async handleTick(): Promise<Response> {
    const core = await this.load();
    if (!core) return errorJson(404, 'no_game', 'no game in this room yet');
    const result = core.timeout(Date.now());
    await this.persist(core);
    this.broadcast(result.events);
    if (result.ended) await this.uploadReplay(core);
    return json({ fired: result.fired, ended: result.ended, deadline_at_ms: result.deadline_at_ms });
  }

  private async handleView(playerRaw: string): Promise<Response> {
    const core = await this.load();
    if (!core) return errorJson(404, 'no_game', 'no game in this room yet');
    const player = decodeURIComponent(playerRaw) as PlayerId;
    if (!core.seatByPlayer(player)) return errorJson(404, 'no_seat', `no seat for '${player}'`);
    if (core.status !== 'running') return errorJson(409, 'room_ended', 'this game has ended; fetch /replay');
    return json(core.viewFor(player, Date.now()));
  }

  private async handleEvents(request: Request, url: URL): Promise<Response> {
    const core = await this.load();
    if (!core) return errorJson(404, 'no_game', 'no game in this room yet');
    const since = Number(url.searchParams.get('since') ?? '0');
    const after = Number.isFinite(since) ? since : 0;
    const wantsSse =
      url.searchParams.get('sse') === '1' || (request.headers.get('accept') ?? '').includes('text/event-stream');
    const backlog = core.eventsSince(after);
    if (!wantsSse) {
      const last = backlog[backlog.length - 1];
      return json({ events: backlog as unknown as Json, latest_seq: last ? last.seq : after });
    }

    const encoder = this.encoder;
    const subscribers = this.subscribers;
    let sub: SseSubscriber | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const ev of backlog) {
          controller.enqueue(encoder.encode(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
        }
        sub = { controller, closed: false };
        subscribers.add(sub);
      },
      cancel() {
        if (sub) {
          sub.closed = true;
          subscribers.delete(sub);
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  private async handleReplay(): Promise<Response> {
    const core = await this.load();
    if (!core) return errorJson(404, 'no_game', 'no game in this room yet');
    const replay = core.replayFile();
    if (!replay) return errorJson(409, 'still_running', 'the game has not ended yet');
    return json(replay);
  }

  private async handleState(): Promise<Response> {
    const core = await this.load();
    if (!core) return errorJson(404, 'no_game', 'no game in this room yet');
    return json(core.publicStateSummary());
  }

  // ---------------------------------------------------------------- fanout --

  private broadcast(events: SpectatorEvent[]): void {
    if (events.length === 0 || this.subscribers.size === 0) return;
    for (const sub of this.subscribers) {
      if (sub.closed) continue;
      try {
        for (const ev of events) {
          sub.controller.enqueue(
            this.encoder.encode(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`),
          );
        }
      } catch {
        sub.closed = true;
        this.subscribers.delete(sub);
      }
    }
  }

  private async uploadReplay(core: RoomCore): Promise<void> {
    if (this.replayUploaded) return;
    const replay = core.replayFile();
    if (!replay) return;
    const bucket = this.env.REPLAYS;
    if (!bucket) return; // binding absent (local tests): skip, /replay still serves it
    try {
      await bucket.put(`${core.gameId}.json`, JSON.stringify(replay));
      this.replayUploaded = true;
    } catch {
      // R2 hiccups must never break game end; the cron/api can re-upload from storage.
    }
  }
}
