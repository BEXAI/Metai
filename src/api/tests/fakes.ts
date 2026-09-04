/**
 * In-memory fakes for the narrow ApiEnv (src/api/env.ts).
 *
 * The D1 fake wraps node:sqlite and loads the REAL schema — schema.sql plus
 * every migrations/*.sql in order (migrations/apply.ts) — so every unit test
 * also exercises the schema (PKs, unique indexes, ON CONFLICT clauses)
 * exactly as D1 (SQLite) will, and no migration can ship to production
 * without a test seeing it. KV honors TTLs against the injectable test
 * clock. The room namespace fake lets tests script the Durable Object's
 * responses and records every forwarded request.
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { applySchema } from '../../../migrations/apply.ts';

// Vite (vitest's transformer) predates the node:sqlite builtin and tries to
// bundle it; createRequire loads it at runtime, outside the transform.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import type { AnyGame, Json } from '../../kernel/types.ts';
import type { ApiEnv, Db, DbStatement, Kv, R2Like, RoomNamespace, SqlRow } from '../env.ts';

// ------------------------------------------------------------------ clock --

export interface TestClock {
  ms: number;
  advance(ms: number): void;
}

export function makeClock(startMs = Date.parse('2026-09-01T12:00:00Z')): TestClock {
  return {
    ms: startMs,
    advance(delta: number) {
      this.ms += delta;
    },
  };
}

// --------------------------------------------------------------------- D1 --

export class FakeDb implements Db {
  readonly db: DatabaseSyncType;
  /** Schema files applied, in order ('schema.sql', 'migrations/0002_...'). */
  readonly schemaApplied: string[];

  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.schemaApplied = applySchema((sql) => this.db.exec(sql));
  }

  prepare(query: string): DbStatement {
    const db = this.db;
    const makeStatement = (bound: unknown[]): DbStatement => ({
      bind(...values: unknown[]): DbStatement {
        return makeStatement(values);
      },
      async all<T = SqlRow>(): Promise<{ results: T[] }> {
        const stmt = db.prepare(query);
        return { results: stmt.all(...(bound as never[])) as T[] };
      },
      async first<T = SqlRow>(): Promise<T | null> {
        const stmt = db.prepare(query);
        const row = stmt.get(...(bound as never[]));
        return (row as T | undefined) ?? null;
      },
      async run(): Promise<unknown> {
        const stmt = db.prepare(query);
        return stmt.run(...(bound as never[]));
      },
    });
    return makeStatement([]);
  }
}

// --------------------------------------------------------------------- KV --

export class FakeKv implements Kv {
  private readonly store = new Map<string, { value: string; expMs: number | null }>();

  constructor(private readonly clock: TestClock) {}

  private alive(key: string): { value: string; expMs: number | null } | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expMs !== null && this.clock.ms >= entry.expMs) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.alive(key)?.value ?? null;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, {
      value,
      expMs: opts?.expirationTtl !== undefined ? this.clock.ms + opts.expirationTtl * 1000 : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  keys(): string[] {
    return [...this.store.keys()].filter((k) => this.alive(k) !== null);
  }
}

// --------------------------------------------------------------------- R2 --

export class FakeR2 implements R2Like {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<{ text(): Promise<string> } | null> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return { text: async () => value };
  }

  async put(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return {};
  }
}

// ------------------------------------------------------------------ rooms --

export interface RecordedRoomCall {
  gameId: string;
  url: string;
  method: string;
  body: string | null;
  headers: Record<string, string>;
}

export type RoomScript = (call: RecordedRoomCall) => Response | Promise<Response>;

/** Default: every room call 404s (as if the DO had no game). */
const defaultScript: RoomScript = () =>
  new Response(JSON.stringify({ ok: false, code: 'no_game', message: 'fake room: no script' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });

export class FakeRoomNamespace implements RoomNamespace {
  readonly calls: RecordedRoomCall[] = [];
  script: RoomScript = defaultScript;

  idFromName(name: string): unknown {
    return { name };
  }

  get(id: unknown): { fetch(input: Request | string, init?: RequestInit): Promise<Response> } {
    const gameId = (id as { name: string }).name;
    const record = async (input: Request | string, init?: RequestInit): Promise<Response> => {
      const req = typeof input === 'string' ? new Request(input, init) : input;
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const body = req.method === 'POST' ? await req.text() : null;
      const call: RecordedRoomCall = { gameId, url: req.url, method: req.method, body, headers };
      this.calls.push(call);
      return this.script(call);
    };
    return { fetch: record };
  }
}

// ---------------------------------------------------------- fake registry --

function stubGame(id: string, listed: boolean): AnyGame {
  const nope = (): never => {
    throw new Error(`fake game '${id}': engine methods are not under test here`);
  };
  return {
    meta: {
      id,
      name: id === 'toy' ? 'Toy Game' : id,
      players: { min: 2, max: 2 },
      information: 'perfect',
      randomness: 'none',
      variants: {},
      notation: 'a1 style coordinates',
      boardText: '3x3 grid with coordinates',
      listed,
    },
    initialState: nope,
    playersToMove: nope,
    legalMoves: nope,
    apply: nope,
    isTerminal: nope,
    publicView: nope,
    privateView: nope,
    renderText: nope,
    encodeState: nope,
    decodeState: nope,
    parseMove: nope,
    moveToNotation: nope,
  };
}

export function fakeGames(): Record<string, AnyGame> {
  return { toy: stubGame('toy', true), smoke: stubGame('smoke', false) };
}

// ----------------------------------------------------------------- ApiEnv --

export interface TestEnv extends ApiEnv {
  clock: TestClock;
  db: FakeDb;
  kv: FakeKv;
  r2: FakeR2;
  rooms: FakeRoomNamespace;
  /** Outbound requests made through env.fetchFn (doorbells). */
  outbound: { url: string; init: RequestInit | undefined }[];
  /** Script the doorbell/webhook endpoint. */
  outboundScript: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

export function makeTestEnv(overrides: Partial<Pick<ApiEnv, 'secrets' | 'games'>> = {}): TestEnv {
  const clock = makeClock();
  const db = new FakeDb();
  const kv = new FakeKv(clock);
  const r2 = new FakeR2();
  const rooms = new FakeRoomNamespace();
  const outbound: TestEnv['outbound'] = [];
  const env: TestEnv = {
    clock,
    db,
    kv,
    r2,
    rooms,
    outbound,
    outboundScript: () => new Response('ok', { status: 200 }),
    DB: db,
    CACHE: kv,
    REPLAYS: r2,
    GAME_ROOM: rooms,
    secrets: overrides.secrets ?? {},
    games: overrides.games ?? fakeGames(),
    now: () => clock.ms,
    fetchFn: async (url: string, init?: RequestInit) => {
      outbound.push({ url, init });
      return env.outboundScript(url, init);
    },
  };
  return env;
}

// ------------------------------------------------------------ seed helpers --

/** Insert a game row directly (what the pairer/T8 does in production). */
export function insertGame(
  env: TestEnv,
  row: {
    id: string;
    game: string;
    status?: string;
    seats?: { player: string; agent_id: string; handle: string; pubkey_ed25519: string }[];
    division?: string;
    season_id?: string | null;
    reveal_secret?: string | null;
    result?: Json;
    started_at?: string;
    ended_at?: string | null;
    replay_r2_key?: string | null;
  },
): void {
  env.db.db
    .prepare(
      `INSERT INTO games (id, game, variant, division, season_id, status, commitment, drand_round, reveal_secret,
         seats_json, ruleset_version, started_at, ended_at, result_json, replay_r2_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.game,
      '{}',
      row.division ?? 'open',
      row.season_id ?? null,
      row.status ?? 'live',
      'c'.repeat(64),
      123,
      row.reveal_secret ?? null,
      JSON.stringify(row.seats ?? []),
      '1.0.0',
      row.started_at ?? '2026-09-01T10:00:00Z',
      row.ended_at ?? null,
      row.result === undefined ? null : JSON.stringify(row.result),
      row.replay_r2_key ?? null,
    );
}
