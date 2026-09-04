/**
 * GameRoom — the Durable Object class wrapping RoomCore (src/rooms/core.ts).
 *
 * One DO instance per live game. All game-session rules live in the pure
 * RoomCore; this class only does I/O: routing the internal HTTP API, DO
 * alarms for move deadlines, chunked persistence of the core in ctx.storage,
 * spectator fan-out (JSON polling + SSE), and end-of-game finalization
 * (R2 replay upload + D1 rows + the ratings hook).
 *
 * Storage layout (spec §architecture.state — the DO is the authoritative
 * state; a single value has a hard per-value size limit, so nothing unbounded
 * is ever stored under one key):
 *   'core'          bounded core record { v, snap (no arrays), counts }
 *   'log:<seq8>'    one LogEntry per key (append-only, immutable)
 *   'ev:<seq8>'     one SpectatorEvent per key (append-only, immutable)
 *   'hist:<idx8>'   one HistoryEntry per key (append-only, immutable)
 *   'sd:<chunk8>'   SeedDraw[] chunk per persist (append-only, immutable)
 *   'pv:<turn8>:<player>'  that seat's private view at that turn (pruned to
 *                          the last PV_RETAIN_TURNS turns)
 *   'room'          LEGACY single-blob snapshot — migrated on first wake
 *
 * Write ordering (a failed persist can never desync memory from storage):
 * every mutation is followed by ONE multi-entry storage.put({...new immutable
 * rows, core}) — atomic per the DO storage contract — and only on success do
 * the in-memory watermarks advance and events broadcast. On failure the
 * in-memory core is dropped and rebuilt from storage on the next request, so
 * memory always reflects exactly what storage holds. Reassembly slices every
 * row family to the counts recorded in the core record, so orphan rows from
 * a crashed oversized batch are ignored and harmlessly overwritten later.
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
import type { LogEntry, ReplayFile } from '../kernel/replay.ts';
import type { AnyGame, HistoryEntry, Json, MoveSubmission, PlayerId, SeedDraw, VariantConfig } from '../kernel/types.ts';
import { houseKeyringFromSeed, isHouseHandle } from '../api/house.ts';
import { HouseDriver, isHouseDrivenGame } from './house-driver.ts';
import {
  PV_RETAIN_TURNS,
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
  /** Single-entry put. */
  put<T>(key: string, value: T): Promise<void>;
  /** Multi-entry put — ATOMIC: either every entry commits or none does. */
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<unknown>;
  /** Keys are returned in ascending lexicographic order (DO contract). */
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
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

/** Minimal D1 surface the room uses (satisfied by a real D1Database binding). */
export interface RoomDbStatement {
  bind(...values: unknown[]): RoomDbStatement;
  run(): Promise<unknown>;
}

export interface RoomDb {
  prepare(query: string): RoomDbStatement;
  batch(statements: RoomDbStatement[]): Promise<unknown>;
}

export interface RoomEnv {
  /** R2 replay bucket. When the binding is absent the upload is skipped. */
  REPLAYS?: ReplayBucket;
  /** D1 database. When the binding is absent end-of-game D1 rows are skipped. */
  DB?: RoomDb;
  /**
   * The Worker secret the house-agent keys are derived from. The DO receives
   * the Worker's env, so this is the binding name, not the ApiEnv `secrets`
   * shape. Absent -> no house seat is ever driven (src/api/house.ts).
   */
  HOUSE_SK_SEED?: string;
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
// Ratings hook (src/match/ratings.ts — the T8 interface contract). Loaded
// lazily so a rating-layer problem can never break game finalization, and
// injectable so room unit tests do not depend on the ratings module.
// ---------------------------------------------------------------------------

type RatingsHook = (env: RoomEnv, gameId: string) => Promise<void>;
let ratingsHookForTests: RatingsHook | null = null;

/** Tests may swap the applyGameRatings call; pass null to restore the default. */
export function setRatingsHookForTests(fn: RatingsHook | null): void {
  ratingsHookForTests = fn;
}

// ---------------------------------------------------------------------------
// Storage keys and persistence shapes
// ---------------------------------------------------------------------------

const KEY_CORE = 'core';
/** Pre-chunking single-blob snapshot key; migrated on first wake, then deleted. */
const KEY_LEGACY = 'room';
const MAX_PUT_ENTRIES = 128; // DO storage: max keys per multi-entry put
const PUT_BATCH = 100;
const D1_BATCH = 50;
const FINALIZE_RETRY_MS = 5_000;
const ALARM_RETRY_MS = 5_000;
/** SSE reconnect hint, sent once at stream start. */
const SSE_RETRY_MS = 5_000;

function pad8(n: number): string {
  return String(n).padStart(8, '0');
}

/**
 * One SSE frame per spectator event, deliberately UNNAMED — no `event:` line.
 *
 * These frames used to carry `event: ${ev.type}`. EventSource routes a NAMED
 * frame only to a listener registered for that exact name and drops it
 * silently otherwise, and the /watch client registers just the default
 * 'message' listener — so the live stream delivered nothing, for every game,
 * and the pages fell back to 3-second polling without ever reporting an error
 * (no 'error' fires on a healthy stream). Naming the frames is also
 * structurally wrong for the open-ended `game:*` namespace, which a client
 * cannot enumerate ahead of the games that emit it.
 *
 * Nothing is lost: the type is inside the JSON payload, which is where every
 * consumer already reads it from (the polling fallback has no frame name to
 * read either).
 */
function sseFrame(ev: SpectatorEvent): string {
  return `id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/** Counts of persisted rows per family — reassembly slices to these. */
interface PersistCounts {
  log_count: number;
  ev_count: number;
  hist_count: number;
  sd_count: number;
  sd_chunks: number;
  /** Lowest private-view turn retained (older keys are pruned). */
  pv_floor: number;
}

type BoundedSnapshot = Omit<RoomSnapshot, 'log' | 'events' | 'history' | 'seedDraws' | 'privateViewsByTurn'>;

interface CoreRecord {
  v: 2;
  snap: BoundedSnapshot;
  counts: PersistCounts;
}

interface Watermarks {
  log: number;
  ev: number;
  hist: number;
  sdCount: number;
  sdChunks: number;
  pvFloor: number;
}

function zeroWatermarks(): Watermarks {
  return { log: 0, ev: 0, hist: 0, sdCount: 0, sdChunks: 0, pvFloor: 0 };
}

function boundedOf(snap: RoomSnapshot): BoundedSnapshot {
  const { log: _log, events: _events, history: _history, seedDraws: _sd, privateViewsByTurn: _pv, ...rest } = snap;
  return rest;
}

function sortedValues<T>(map: Map<string, T>): T[] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

function logStructured(kind: string, gameId: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ kind, game_id: gameId, reason, at: new Date().toISOString() }));
}

// ---------------------------------------------------------------------------
// Request/response helpers
// ---------------------------------------------------------------------------

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
  private persisted: Watermarks = zeroWatermarks();
  private readonly subscribers = new Set<SseSubscriber>();
  private readonly encoder = new TextEncoder();
  /**
   * Drives this room's house seats from the room's own alarm (§8.3). Null when
   * HOUSE_SK_SEED is not configured, which is production today — the driver is
   * then never constructed, never reads storage, and the ordinary deadline
   * timeout stays the only mover of a house seat.
   */
  private readonly houseDriver: HouseDriver | null;

  constructor(ctx: RoomCtx, env: RoomEnv) {
    this.ctx = ctx;
    this.env = env;
    const keyring = houseKeyringFromSeed(env.HOUSE_SK_SEED);
    this.houseDriver = keyring === null ? null : new HouseDriver(ctx.storage, { keyring });
  }

  /**
   * The driver, but only for a room the driver can actually move: one that
   * seats a house agent IN A GAME WITH A HOUSE POLICY.
   *
   * This guard is why the twelve existing games do no extra work at all: with
   * no house seat there is no 'housedue' key to read, arm or delete, so their
   * per-move storage traffic is byte-for-byte what it was. It is an in-memory
   * check over the seat list, and seats never change after /create.
   *
   * The GAME half of the check is load-bearing, not belt-and-braces. The pairer
   * backfills a short 2-seat chess/go/checkers queue with a general-purpose
   * `house-*` agent, and defaultAdapterFor has no policy for those games — so a
   * handle-only guard armed a driver that then stood down on every wake:
   * drive() wrote null, persist() re-armed HOUSE_MOVE_DELAY_MS out, and the
   * room woke and wrote twice every 3 s for the entire per-move budget (~20x on
   * chess, ~100x on the 5-minute default) while nothing progressed. Arming and
   * driving must agree on which rooms are drivable.
   */
  private houseFor(core: RoomCore): HouseDriver | null {
    if (this.houseDriver === null) return null;
    if (!isHouseDrivenGame(core.game.meta.id)) return null;
    return core.seats.some((s) => isHouseHandle(s.handle)) ? this.houseDriver : null;
  }

  // ------------------------------------------------------------ lifecycle --

  private async load(): Promise<RoomCore | null> {
    if (this.loaded) return this.core;
    const record = await this.ctx.storage.get<CoreRecord>(KEY_CORE);
    if (record !== undefined) {
      const { snap, watermarks } = await this.reassemble(record);
      this.core = this.hydrate(snap);
      this.persisted = watermarks;
      this.loaded = true;
      // The house due time lives under its own key so it survives eviction,
      // which nulls this.core. Read only for a room that seats a house agent.
      await this.houseFor(this.core)?.load();
      return this.core;
    }
    const legacy = await this.ctx.storage.get<RoomSnapshot>(KEY_LEGACY);
    if (legacy !== undefined) {
      // Pre-chunking blob: hydrate (core.ts normalizes the legacy fields),
      // rewrite in chunked form, then drop the blob. Crash-safe: until the
      // 'core' record lands the blob stays authoritative and migration reruns.
      this.core = this.hydrate(legacy);
      this.persisted = zeroWatermarks();
      await this.persist(this.core);
      try {
        await this.ctx.storage.delete([KEY_LEGACY]);
      } catch {
        /* stale blob is ignored once 'core' exists */
      }
      this.loaded = true;
      return this.core;
    }
    this.loaded = true;
    return null;
  }

  private hydrate(snap: RoomSnapshot): RoomCore {
    const game = resolveGame(snap.game);
    if (!game) throw new Error(`GameRoom: game '${snap.game}' is not in the registry`);
    return RoomCore.hydrate(game, snap);
  }

  /** Rebuilds the full snapshot by range-listing the chunked row families. */
  private async reassemble(record: CoreRecord): Promise<{ snap: RoomSnapshot; watermarks: Watermarks }> {
    const c = record.counts;
    const [logMap, evMap, histMap, sdMap, pvMap] = await Promise.all([
      this.ctx.storage.list<LogEntry>({ prefix: 'log:' }),
      this.ctx.storage.list<SpectatorEvent>({ prefix: 'ev:' }),
      this.ctx.storage.list<HistoryEntry>({ prefix: 'hist:' }),
      this.ctx.storage.list<SeedDraw[]>({ prefix: 'sd:' }),
      this.ctx.storage.list<Json>({ prefix: 'pv:' }),
    ]);
    // Slice every family to the recorded counts: orphan rows beyond them (a
    // crashed oversized batch) sort last and are ignored.
    const log = sortedValues(logMap).slice(0, c.log_count);
    const events = sortedValues(evMap).slice(0, c.ev_count);
    const history = sortedValues(histMap).slice(0, c.hist_count);
    const seedDraws = sortedValues(sdMap).flat().slice(0, c.sd_count);
    if (log.length !== c.log_count || events.length !== c.ev_count || history.length !== c.hist_count || seedDraws.length !== c.sd_count) {
      throw new Error(
        `GameRoom: storage rows missing for ${record.snap.game_id} ` +
          `(log ${log.length}/${c.log_count}, ev ${events.length}/${c.ev_count}, ` +
          `hist ${history.length}/${c.hist_count}, draws ${seedDraws.length}/${c.sd_count})`,
      );
    }
    const privateViewsByTurn: Record<string, Record<PlayerId, Json>> = {};
    for (const [key, view] of pvMap) {
      const m = /^pv:(\d{8}):(.+)$/.exec(key);
      if (!m) continue;
      const turn = Number(m[1]);
      if (turn < c.pv_floor) continue; // stale, pending deletion
      (privateViewsByTurn[String(turn)] ??= {})[m[2]!] = view;
    }
    const snap: RoomSnapshot = { ...record.snap, log, events, history, seedDraws, privateViewsByTurn };
    return {
      snap,
      watermarks: {
        log: c.log_count,
        ev: c.ev_count,
        hist: c.hist_count,
        sdCount: c.sd_count,
        sdChunks: c.sd_chunks,
        pvFloor: c.pv_floor,
      },
    };
  }

  /** Drops the in-memory core so the next request rebuilds it from storage. */
  private resetMemory(): void {
    this.core = null;
    this.loaded = false;
    this.persisted = zeroWatermarks();
  }

  /**
   * Durably stores everything that changed since the last successful persist:
   * new immutable rows (log/event/history/seed-draw/private-view keys) plus
   * the bounded core record, in ONE atomic multi-entry put. Watermarks only
   * advance on success; the caller must resetMemory() when this throws.
   */
  private async persist(core: RoomCore): Promise<void> {
    const snap = core.snapshot();
    const w = this.persisted;
    const entries: Record<string, unknown> = {};
    for (let i = w.log; i < snap.log.length; i++) {
      const e = snap.log[i]!;
      entries[`log:${pad8(e.seq)}`] = e;
    }
    for (let i = w.ev; i < snap.events.length; i++) {
      const e = snap.events[i]!;
      entries[`ev:${pad8(e.seq)}`] = e;
    }
    for (let i = w.hist; i < snap.history.length; i++) {
      entries[`hist:${pad8(i)}`] = snap.history[i]!;
    }
    let sdChunks = w.sdChunks;
    if (snap.seedDraws.length > w.sdCount) {
      entries[`sd:${pad8(sdChunks)}`] = snap.seedDraws.slice(w.sdCount);
      sdChunks += 1;
    }
    // Private views: only the latest refreshed turn can have changed since the
    // last persist (each mutation persists before the next turn's refresh).
    let pvMaxTurn = -1;
    for (const key of Object.keys(snap.privateViewsByTurn)) pvMaxTurn = Math.max(pvMaxTurn, Number(key));
    if (pvMaxTurn >= 0) {
      const views = snap.privateViewsByTurn[String(pvMaxTurn)];
      if (views !== undefined) {
        for (const [player, view] of Object.entries(views)) entries[`pv:${pad8(pvMaxTurn)}:${player}`] = view;
      }
    }
    const pvFloor = Math.max(w.pvFloor, Math.max(0, pvMaxTurn - PV_RETAIN_TURNS + 1));
    const counts: PersistCounts = {
      log_count: snap.log.length,
      ev_count: snap.events.length,
      hist_count: snap.history.length,
      sd_count: snap.seedDraws.length,
      sd_chunks: sdChunks,
      pv_floor: pvFloor,
    };
    const record: CoreRecord = { v: 2, snap: boundedOf(snap), counts };

    const keys = Object.keys(entries);
    if (keys.length + 1 <= MAX_PUT_ENTRIES) {
      await this.ctx.storage.put({ ...entries, [KEY_CORE]: record });
    } else {
      // Oversized delta (legacy migration): immutable rows first in batches,
      // the core record LAST — reassembly slices to the recorded counts, so a
      // crash mid-way leaves only ignored orphans that are rewritten later.
      for (let i = 0; i < keys.length; i += PUT_BATCH) {
        const batch: Record<string, unknown> = {};
        for (const k of keys.slice(i, i + PUT_BATCH)) batch[k] = entries[k];
        await this.ctx.storage.put(batch);
      }
      await this.ctx.storage.put(KEY_CORE, record);
    }

    // Storage committed — only now advance the in-memory watermarks.
    const oldFloor = w.pvFloor;
    this.persisted = {
      log: counts.log_count,
      ev: counts.ev_count,
      hist: counts.hist_count,
      sdCount: counts.sd_count,
      sdChunks: counts.sd_chunks,
      pvFloor: counts.pv_floor,
    };
    // Arm the house driver AFTER the core is durable, and unconditionally:
    // arm() is idempotent per turn (a simultaneous phase persists once per
    // submission without moving the turn index, and re-arming with a fresh
    // delay each time would push the due time out forever) and it disarms
    // itself when nothing is pending. syncAlarm runs after it, so the alarm
    // it sets already accounts for the new due time.
    const house = this.houseFor(core);
    if (house) {
      try {
        await house.arm(core, Date.now());
      } catch (err) {
        // A house seat that fails to arm is driven by the ordinary deadline
        // timeout instead; never fail a real agent's move over it.
        logStructured('room_house_arm_failure', core.gameId, err);
      }
    }
    await this.syncAlarm(core);
    await this.prunePrivateViews(core, oldFloor, pvFloor);
  }

  /**
   * The next wake: the move deadline, or the house driver's due time, whichever
   * comes first. Losses self-heal (moves/ticks run timeout()).
   */
  private nextAlarmMs(core: RoomCore): number | null {
    const deadline = core.deadlineAtMs;
    const house = this.houseFor(core)?.dueAtMs ?? null;
    if (deadline === null) return house;
    return house === null ? deadline : Math.min(deadline, house);
  }

  private async syncAlarm(core: RoomCore): Promise<void> {
    try {
      if (core.status === 'running') {
        const at = this.nextAlarmMs(core);
        if (at !== null) await this.ctx.storage.setAlarm(at);
        else await this.ctx.storage.deleteAlarm();
      } else if (core.finalized) {
        await this.ctx.storage.deleteAlarm();
      } else {
        // Ended but not yet durably finalized: keep a retry alarm pending so
        // finalization always completes even if this request dies right here.
        // finalize() success re-persists with the flag set and clears it.
        await this.ctx.storage.setAlarm(Date.now() + FINALIZE_RETRY_MS);
      }
    } catch (err) {
      logStructured('room_alarm_sync_failure', core.gameId, err);
    }
  }

  /** Best-effort delete of private-view keys below the new floor. */
  private async prunePrivateViews(core: RoomCore, oldFloor: number, newFloor: number): Promise<void> {
    if (newFloor <= oldFloor) return;
    const dead: string[] = [];
    for (let t = oldFloor; t < newFloor; t++) {
      for (const s of core.seats) dead.push(`pv:${pad8(t)}:${s.player}`);
    }
    try {
      for (let i = 0; i < dead.length; i += PUT_BATCH) {
        await this.ctx.storage.delete(dead.slice(i, i + PUT_BATCH));
      }
    } catch {
      /* orphaned keys are ignored by reassemble (below pv_floor) */
    }
  }

  /** DO alarm: a house seat is due, the move deadline passed, or a finalize retry. */
  async alarm(): Promise<void> {
    let gameId = 'unknown';
    try {
      const core = await this.load();
      if (!core) return;
      gameId = core.gameId;

      // House seats first, and BEFORE the timeout branch. Their due time is
      // always earlier than the deadline they were armed against, so a wake at
      // the house due time must not be read as an expired turn: running
      // timeout() here would strike out the very seats the driver is about to
      // move. The driver re-arms itself while its queue drains and persist()
      // sets the next alarm, so returning is the whole loop.
      const house = this.houseFor(core);
      if (core.status === 'running' && house !== null && house.dueAtMs !== null && Date.now() >= house.dueAtMs) {
        const out = await house.run(core, Date.now());
        await this.persist(core);
        this.broadcast(out.events);
        if (core.status !== 'running') await this.finalize(core);
        return;
      }

      if (core.status === 'running') {
        const result = core.timeout(Date.now());
        await this.persist(core);
        this.broadcast(result.events);
        if (core.status !== 'running') await this.finalize(core);
        return;
      }
      if (!core.finalized) await this.finalize(core);
    } catch (err) {
      // An alarm-path failure must never crash the DO: log a docket-style
      // entry, drop the (possibly desynced) memory, and retry on a new alarm.
      logStructured('room_alarm_failure', gameId, err);
      await this.docketBestEffort(gameId, 'alarm_failed', err);
      this.resetMemory();
      try {
        await this.ctx.storage.setAlarm(Date.now() + ALARM_RETRY_MS);
      } catch {
        /* the next /move or /tick resolves the expired deadline anyway */
      }
    }
  }

  // ------------------------------------------------------------- finalize --

  /**
   * Durable end-of-game finalization, exactly once (guarded by the core's
   * 'finalized' flag): R2 replay upload under 'replays/<game_id>.json', the
   * D1 games UPSERT + game_log/spectator_events/private_views inserts, then
   * the Glicko-2 ratings hook. D1 failure leaves the flag unset and schedules
   * an alarm retry; every statement is idempotent (INSERT OR REPLACE).
   */
  private async finalize(core: RoomCore): Promise<void> {
    if (core.status !== 'ended' || core.finalized) return;
    const replay = core.replayFile();
    if (!replay) return;
    const r2Key = `replays/${core.gameId}.json`;

    if (this.env.REPLAYS) {
      try {
        await this.env.REPLAYS.put(r2Key, JSON.stringify(replay));
      } catch (err) {
        // R2 hiccups never block finalization: the API serves the D1
        // reconstruction until a retry (or ops) re-uploads the blob.
        logStructured('room_replay_upload_failure', core.gameId, err);
      }
    }

    if (this.env.DB) {
      try {
        await this.finalizeD1(this.env.DB, core, replay, r2Key);
      } catch (err) {
        logStructured('room_finalize_failure', core.gameId, err);
        await this.docketBestEffort(core.gameId, 'finalize_d1_failed', err);
        try {
          await this.ctx.storage.setAlarm(Date.now() + FINALIZE_RETRY_MS);
        } catch {
          /* the next request on this room retries finalize */
        }
        return; // NOT finalized — retried by the alarm
      }
    }

    core.markFinalized();
    try {
      await this.persist(core);
    } catch (err) {
      // D1 rows are already durable and idempotent; the un-flagged core
      // simply re-runs finalize on the next wake.
      logStructured('room_finalize_flag_persist_failure', core.gameId, err);
      this.resetMemory();
      return;
    }

    // Ratings LAST, and never un-finalize on failure (interface contract:
    // applyGameRatings is itself idempotent per game).
    try {
      if (ratingsHookForTests !== null) {
        await ratingsHookForTests(this.env, core.gameId);
      } else {
        const mod: typeof import('../match/ratings.ts') = await import('../match/ratings.ts');
        type RatingsEnv = Parameters<(typeof mod)['applyGameRatings']>[0];
        // The DO receives the raw Worker bindings; applyGameRatings takes the
        // ApiEnv shape (same DB/CACHE bindings plus injectable now/fetch).
        // Adapt without clobbering an env that already carries those fields.
        const rec = this.env as unknown as Record<string, unknown>;
        const adapted = {
          ...rec,
          now: typeof rec['now'] === 'function' ? rec['now'] : () => Date.now(),
          fetchFn:
            typeof rec['fetchFn'] === 'function'
              ? rec['fetchFn']
              : (input: string, init?: RequestInit) => fetch(input, init),
          secrets: rec['secrets'] ?? {},
          games: rec['games'] ?? {},
        } as unknown as RatingsEnv;
        await mod.applyGameRatings(adapted, core.gameId);
      }
    } catch (err) {
      logStructured('room_ratings_failure', core.gameId, err);
    }
  }

  private async finalizeD1(db: RoomDb, core: RoomCore, replay: ReplayFile, r2Key: string): Promise<void> {
    const gameId = core.gameId;
    const endedAt = replay.log.find((e) => e.kind === 'end')?.created_at ?? new Date().toISOString();
    const startedAt = replay.log.find((e) => e.kind === 'start')?.created_at ?? endedAt;
    const stmts: RoomDbStatement[] = [];

    // games row: UPSERT so finalize works even if the pairing-time INSERT was
    // lost; on conflict only the end-of-game columns are touched (season_id
    // and friends stay whatever the pairer wrote).
    stmts.push(
      db
        .prepare(
          'INSERT INTO games (id, game, variant, division, status, commitment, drand_round, reveal_secret, seats_json, ruleset_version, started_at, ended_at, result_json, replay_r2_key) ' +
            "VALUES (?, ?, ?, ?, 'ended', ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET status = 'ended', ended_at = excluded.ended_at, result_json = excluded.result_json, reveal_secret = excluded.reveal_secret, replay_r2_key = excluded.replay_r2_key",
        )
        .bind(
          gameId,
          replay.game,
          JSON.stringify(replay.variant),
          replay.division,
          replay.commitment,
          replay.drand_round,
          replay.reveal_secret,
          JSON.stringify(replay.seats),
          replay.ruleset_version,
          startedAt,
          endedAt,
          JSON.stringify(replay.result),
          r2Key,
        ),
    );
    for (const e of replay.log) {
      stmts.push(
        db
          .prepare(
            'INSERT OR REPLACE INTO game_log (game_id, seq, kind, payload_json, prev_hash, hash, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(gameId, e.seq, e.kind, JSON.stringify(e.payload), e.prev_hash, e.hash, e.signature, e.created_at),
      );
    }
    for (const ev of core.eventsSince(0)) {
      stmts.push(
        db
          .prepare('INSERT OR REPLACE INTO spectator_events (game_id, seq, public_event_json, created_at) VALUES (?, ?, ?, ?)')
          .bind(gameId, ev.seq, JSON.stringify(ev), ev.at),
      );
    }
    const pvByTurn = core.snapshot().privateViewsByTurn;
    for (const [turn, views] of Object.entries(pvByTurn)) {
      for (const [player, view] of Object.entries(views)) {
        const agentId = core.seatByPlayer(player)?.agent_id;
        if (agentId === undefined) continue;
        stmts.push(
          db
            .prepare('INSERT OR REPLACE INTO private_views (game_id, agent_id, turn_index, view_json) VALUES (?, ?, ?, ?)')
            .bind(gameId, agentId, Number(turn), JSON.stringify(view)),
        );
      }
    }
    // Batched: logs can be thousands of rows.
    for (let i = 0; i < stmts.length; i += D1_BATCH) {
      await db.batch(stmts.slice(i, i + D1_BATCH));
    }
  }

  /** Append-only docket record of an operational room failure (best-effort). */
  private async docketBestEffort(gameId: string, reason: string, err: unknown): Promise<void> {
    const db = this.env.DB;
    if (!db) return;
    try {
      await db
        .prepare('INSERT INTO docket (kind, subject_json, reason, disposition, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(
          'room_failure',
          JSON.stringify({ game_id: gameId }),
          `${reason}: ${err instanceof Error ? err.message : String(err)}`,
          'noted',
          new Date().toISOString(),
        )
        .run();
    } catch {
      /* the structured console entry stands */
    }
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
    // Compute-then-swap: the new core is adopted only after it is durable.
    this.persisted = zeroWatermarks();
    try {
      await this.persist(core);
    } catch (err) {
      logStructured('room_persist_failure', body.game_id, err);
      this.persisted = zeroWatermarks();
      return errorJson(500, 'persist_failed', 'room storage rejected the create; retry');
    }
    this.core = core;
    this.loaded = true;
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
    try {
      await this.persist(core);
    } catch (err) {
      // Nothing was committed (the multi-entry put is atomic). Drop the
      // mutated memory so the next request rebuilds from storage — the
      // submission effectively never happened.
      logStructured('room_persist_failure', core.gameId, err);
      this.resetMemory();
      return errorJson(500, 'persist_failed', 'the room could not durably store this update; the submission was not applied — retry');
    }
    if (expired.fired) this.broadcast(expired.events);
    if (result.ok) this.broadcast(result.events);
    if (core.status === 'ended') await this.finalize(core);
    if (result.ok) {
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
    try {
      await this.persist(core);
    } catch (err) {
      logStructured('room_persist_failure', core.gameId, err);
      this.resetMemory();
      return errorJson(500, 'persist_failed', 'the room could not durably store this update; retry');
    }
    this.broadcast(result.events);
    if (core.status === 'ended') await this.finalize(core);
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
        // Reconnect hint plus the whole backlog in one chunk: a reader that
        // takes a single chunk gets the events, not just the directive.
        controller.enqueue(encoder.encode(`retry: ${SSE_RETRY_MS}\n\n` + backlog.map(sseFrame).join('')));
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
          sub.controller.enqueue(this.encoder.encode(sseFrame(ev)));
        }
      } catch {
        sub.closed = true;
        this.subscribers.delete(sub);
      }
    }
  }
}
