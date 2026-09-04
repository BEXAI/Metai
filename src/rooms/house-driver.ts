/**
 * The house driver (plan §8.3) — the mechanism that makes an 8-seat game
 * possible at all.
 *
 * WHY IT LIVES IN THE DURABLE OBJECT AND NOT IN THE CRON. `runCron` runs six
 * steps and none of them is a house-agent step, so a house-seated game today
 * advances only through sweepTimeouts -> /tick -> timeout() -> defaultMove:
 * every house seat is silent in every phase and takes a strike per phase, and a
 * 7-house werewolf table dies in phase 3. The 5-minute cron is also
 * structurally too slow — a 60-second night expires four times before it fires.
 *
 * Driving from the room's own alarm instead means no HTTP, no auth challenge,
 * no D1 challenge write and no /api/* rate-limit consumption: house agents
 * disappear from the request budget entirely. The DO already knows the turn
 * changed and already holds the state in memory.
 *
 * TWO HAZARDS, DESIGNED FOR RATHER THAN DISCOVERED.
 *
 * 1. RE-ENTRANCY. `this.core`, `this.loaded` and the persist watermarks are
 *    shared mutable instance state, and DO input gates do NOT serialise across
 *    arbitrary awaits — a concurrent POST /move can interleave with a
 *    multi-second model call. So every drive runs inside an explicit per-DO
 *    PROMISE CHAIN (the `serializedTick` pattern from src/match/pairing.ts),
 *    NOT blockConcurrencyWhile: blocking would guarantee consistency but stall
 *    real agents behind the model call, which is the very thing HOUSE_MOVE_DELAY_MS
 *    exists to avoid. Inside the chain, every seat is re-checked against
 *    `core.waitingFor()` and `core.turnIndex` IMMEDIATELY BEFORE submitting, so
 *    a seat whose move landed (or whose phase resolved) while the adapter was
 *    thinking is skipped rather than driven twice.
 *
 * 2. DURABILITY. The due time must survive DO eviction, which nulls the
 *    in-memory core. It lives under its OWN storage key, 'housedue' — NOT
 *    inside `snap`, which would put a room-level I/O scheduling field into the
 *    pure core's snapshot and change the persisted CoreRecord shape with no
 *    `v: 3` bump. The stored value carries the turn it was armed for as well as
 *    the time, because arming is idempotent per turn: without the turn, every
 *    persist during a simultaneous phase would push the due time out by another
 *    HOUSE_MOVE_DELAY_MS and the house seats would never be driven at all.
 *
 * ATTESTATION (plan D-10). Every drive returns `drove`, the house seats it
 * moved, in the shape a spectator surface publishes. A house seat's signature
 * attests only "the room wrote this"; marking it is not decoration, it is the
 * price of the trade.
 */

import { createWerewolfHouseAgent } from '../agents/werewolf.ts';
import type { HouseAdapter } from '../agents/adapter.ts';
import { houseSeatMarks, houseTierOfHandle, isHouseHandle, type HouseKeyring, type HouseSeatMark } from '../api/house.ts';
import type { Json, PlayerId } from '../kernel/types.ts';
import { moveSignMessage, type RoomCore, type RoomSeat, type SpectatorEvent } from './core.ts';

/** Delay before a house seat moves, so a real agent racing the same simultaneous phase is never blocked behind it. */
export const HOUSE_MOVE_DELAY_MS = 3_000;
/** Re-arm gap while the queue drains: 7 house seats resolve in ~3 wakes ~= 1 s. */
export const HOUSE_RETRY_MS = 500;
/** Bounds DO CPU per wake. */
export const HOUSE_MOVES_PER_WAKE = 3;
/** Its OWN storage key — deliberately not part of the core record. */
export const KEY_HOUSE_DUE = 'housedue';

/** The slice of DurableObjectStorage this module uses (structural). */
export interface HouseDueStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string[]): Promise<unknown>;
}

export interface HouseSeatContext {
  /** Game registry id, e.g. 'werewolf'. */
  game: string;
  gameId: string;
  player: PlayerId;
  agentId: string;
  handle: string;
}

export interface HouseDriverDeps {
  /**
   * Null when HOUSE_SK_SEED is not configured. The driver then does NOTHING —
   * it never falls back to another key and never throws — and the ordinary
   * deadline timeout stays the backstop. The pairer refuses to form rostered
   * tables in the same state, so this is a belt-and-braces guard.
   */
  keyring: HouseKeyring | null;
  /**
   * The adapter for one house seat, or null when this game has no house policy.
   * Returning null for every game but werewolf is what stops house driving
   * being switched on for chess/go/islanders as a side effect (plan D-5).
   */
  adapterFor?(ctx: HouseSeatContext): HouseAdapter | null;
  /** Structured log sink; defaults to console.error. */
  onError?(kind: string, detail: Json): void;
}

export interface HouseDriveResult {
  /** When the driver wants to be woken again, or null when nothing is pending. */
  nextDueAtMs: number | null;
  /** House seats actually moved by this wake, marked per D-10. */
  drove: HouseSeatMark[];
  /** Spectator events produced by those submissions, in order. */
  events: SpectatorEvent[];
}

interface HouseDueRecord {
  at: number;
  turn: number;
}

/**
 * The default policy registry. A game absent from it is never house-driven.
 * `random` is deliberately not a fallback: a uniform pick over werewolf's
 * legal_moves would claim(seer) and report(pN, wolf) at random and destroy the
 * information channel the real seer needs.
 */
export function defaultAdapterFor(ctx: HouseSeatContext): HouseAdapter | null {
  if (!isHouseDrivenGame(ctx.game)) return null;
  return createWerewolfHouseAgent(ctx.agentId, ctx.gameId, houseTierOfHandle(ctx.handle));
}

/**
 * The registry above, as a predicate over the game id alone — no adapter is
 * constructed and no seat is needed.
 *
 * This exists because ARMING must agree with DRIVING. arm() used to count
 * house seats by HANDLE while drive() picked them by ADAPTER, and a room that
 * seats a `house-*` agent in any of the twelve games satisfied the first and
 * not the second: drive() stood down and wrote null, persist() immediately
 * re-armed 3 s out, and the room woke and wrote twice every 3 s for the whole
 * per-move budget while nothing progressed. A room the driver cannot move must
 * not be armed at all — the ordinary deadline timeout is its backstop.
 */
export function isHouseDrivenGame(game: string): boolean {
  return game === 'werewolf';
}

/** House seats of this room that still owe a move, in seat order. */
export function pendingHouseSeats(core: RoomCore): RoomSeat[] {
  if (core.status !== 'running') return [];
  const waiting = new Set<PlayerId>(core.waitingFor());
  return core.seats.filter((s) => waiting.has(s.player) && isHouseHandle(s.handle));
}

export class HouseDriver {
  /** One drive at a time per DO: two alarms must never drive the same seat twice. */
  private chain: Promise<unknown> = Promise.resolve();
  private record: HouseDueRecord | null = null;
  private loaded = false;

  constructor(
    private readonly storage: HouseDueStorage,
    private readonly deps: HouseDriverDeps,
  ) {}

  /** Reads 'housedue'. Call from the room's load(); safe to call repeatedly. */
  async load(): Promise<number | null> {
    if (this.loaded) return this.dueAtMs;
    const raw = await this.storage.get<HouseDueRecord>(KEY_HOUSE_DUE);
    this.record =
      raw && typeof raw.at === 'number' && typeof raw.turn === 'number' ? { at: raw.at, turn: raw.turn } : null;
    this.loaded = true;
    return this.dueAtMs;
  }

  get dueAtMs(): number | null {
    return this.record === null ? null : this.record.at;
  }

  /**
   * Arms (or disarms) the driver for the room's CURRENT turn. Call from
   * persist(), after the core has been written.
   *
   * IDEMPOTENT PER TURN. A simultaneous phase persists once per submission and
   * the turn index does not move until it resolves, so re-arming with a fresh
   * delay on every persist would push the due time out forever and the house
   * seats would never move. The armed turn is what makes that impossible.
   */
  async arm(core: RoomCore, nowMs: number): Promise<number | null> {
    await this.load();
    const turn = core.turnIndex;
    if (pendingHouseSeats(core).length === 0) return this.write(null);
    if (this.record !== null && this.record.turn === turn) return this.dueAtMs;
    return this.write({ at: nowMs + HOUSE_MOVE_DELAY_MS, turn });
  }

  /** Drops the due time (game ended, or nothing is pending). */
  async disarm(): Promise<void> {
    await this.load();
    await this.write(null);
  }

  /**
   * Drives up to HOUSE_MOVES_PER_WAKE house seats. Serialised against every
   * other run on this instance, total (an adapter that throws costs that one
   * seat its move, never the wake), and it always leaves 'housedue' consistent
   * with what is still pending.
   */
  run(core: RoomCore, nowMs: number): Promise<HouseDriveResult> {
    const next = this.chain.then(
      () => this.drive(core, nowMs),
      () => this.drive(core, nowMs),
    );
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // -------------------------------------------------------------- internals --

  private async write(record: HouseDueRecord | null): Promise<number | null> {
    this.record = record;
    this.loaded = true;
    if (record === null) await this.storage.delete([KEY_HOUSE_DUE]);
    else await this.storage.put(KEY_HOUSE_DUE, record);
    return this.dueAtMs;
  }

  private log(kind: string, detail: Json): void {
    if (this.deps.onError) {
      this.deps.onError(kind, detail);
      return;
    }
    console.error(JSON.stringify({ kind, ...(detail as object), at: new Date().toISOString() }));
  }

  private async drive(core: RoomCore, nowMs: number): Promise<HouseDriveResult> {
    await this.load();
    const empty: HouseDriveResult = { nextDueAtMs: null, drove: [], events: [] };

    const keyring = this.deps.keyring;
    if (keyring === null) {
      // Not configured: do nothing, quietly. The deadline timeout is the backstop.
      await this.write(null);
      return empty;
    }

    const game = core.snapshot().game;
    const adapterFor = this.deps.adapterFor ?? defaultAdapterFor;
    /** Pending house seats this game actually has a policy for (plan D-5). */
    const drivable = (): { seat: RoomSeat; adapter: HouseAdapter }[] => {
      const out: { seat: RoomSeat; adapter: HouseAdapter }[] = [];
      for (const seat of pendingHouseSeats(core)) {
        const adapter = adapterFor({
          game,
          gameId: core.gameId,
          player: seat.player,
          agentId: seat.agent_id,
          handle: seat.handle,
        });
        if (adapter !== null) out.push({ seat, adapter });
      }
      return out;
    };

    const drove: RoomSeat[] = [];
    const events: SpectatorEvent[] = [];

    for (const { seat, adapter } of drivable().slice(0, HOUSE_MOVES_PER_WAKE)) {
      const turnAtStart = core.turnIndex;
      let submissionEvents: SpectatorEvent[] = [];
      try {
        const view = core.viewFor(seat.player, nowMs);
        const submission = await adapter.chooseMove(view);
        // The state may have moved on while the adapter was thinking: a real
        // agent's move can resolve the phase underneath us. Re-check inside the
        // chain, immediately before submitting.
        if (core.status !== 'running' || core.turnIndex !== turnAtStart) break;
        if (!core.waitingFor().includes(seat.player)) continue;
        const signature = keyring.sign(seat.handle, moveSignMessage(core.gameId, submission.turn_index, submission));
        const res = core.submitMove(nowMs, seat.agent_id, submission, signature);
        if (!res.ok) {
          // CODE ONLY, never `res.message`. In a hidden-information game the
          // room's illegal-move wording quotes the game's RuleError verbatim,
          // and werewolf's are role oracles ("a villager's only night move is
          // sleep", "the seer's night move is peek(seat) or sleep"). That would
          // put a live seat's hidden role into an operator log stream that is
          // not treated as secret and is routinely shipped to third-party
          // observability. The code is what an operator triages on anyway.
          this.log('house_move_rejected', {
            game_id: core.gameId,
            player: seat.player,
            handle: seat.handle,
            code: res.code,
          });
          continue;
        }
        submissionEvents = res.events;
      } catch (e) {
        this.log('house_move_failed', {
          game_id: core.gameId,
          player: seat.player,
          handle: seat.handle,
          reason: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      drove.push(seat);
      events.push(...submissionEvents);
    }

    // Re-arm only while the queue is still draining AND this wake made
    // progress; 500 ms, not 3 s, because these seats were already due. The
    // `drove.length > 0` half is what keeps a game whose adapters all refuse
    // from re-arming every 500 ms forever — a wake that moved nobody stands
    // down and lets the ordinary deadline timeout be the backstop.
    const nextDueAtMs =
      drove.length > 0 && drivable().length > 0
        ? await this.write({ at: nowMs + HOUSE_RETRY_MS, turn: core.turnIndex })
        : await this.write(null);

    return { nextDueAtMs, drove: houseSeatMarks(drove), events };
  }
}
