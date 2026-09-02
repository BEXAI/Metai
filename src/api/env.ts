/**
 * Narrow environment interface for the API layer (track T7).
 *
 * Handlers are pure-ish functions over `ApiEnv` so they can be unit-tested
 * with tiny in-memory fakes (src/api/tests/fakes.ts) and adapted from the
 * real Cloudflare bindings in src/index.ts. Only the methods the handlers
 * actually call are declared here — the real D1/KV/R2/DO bindings satisfy
 * these shapes structurally (a cast happens once, at the adapter boundary).
 */

import type { AnyGame } from '../kernel/types.ts';

export interface SqlRow {
  [column: string]: unknown;
}

export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  all<T = SqlRow>(): Promise<{ results: T[] }>;
  first<T = SqlRow>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface Db {
  prepare(query: string): DbStatement;
}

export interface Kv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface R2ObjectLike {
  text(): Promise<string>;
}

export interface R2Like {
  get(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: string): Promise<unknown>;
}

/** A Durable Object stub as the API uses it: an internal fetch. */
export interface RoomStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface RoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): RoomStub;
}

/**
 * Secrets come from Worker secrets / .dev.vars — NEVER from the repo.
 * checkpoint_sk: Ed25519 secret key hex used to sign Merkle checkpoints and
 * doorbell rings. Absent locally -> those cron steps are skipped.
 */
export interface Secrets {
  checkpoint_sk?: string;
}

export interface ApiEnv {
  DB: Db;
  CACHE: Kv;
  REPLAYS: R2Like;
  GAME_ROOM: RoomNamespace;
  secrets: Secrets;
  /**
   * The game registry (src/games/index.ts GAMES in production; a tiny fake in
   * unit tests so this track's suite never depends on concurrently-changing
   * game modules).
   */
  games: Record<string, AnyGame>;
  /** Injectable clock (ms epoch) so tests control TTLs, quotas, rate limits. */
  now(): number;
  /** Injectable outbound fetch (doorbell verification + rings). */
  fetchFn(input: string, init?: RequestInit): Promise<Response>;
}
