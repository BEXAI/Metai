/**
 * GameRoom chunked-persistence + finalization tests (e2e-driver findings
 * 1-5, notes/e2e-driver.md):
 *   1. bounded chunked storage — no monolithic snapshot value, wake-time
 *      reassembly equals the pre-sleep room, core value size stays flat
 *   2. end-of-game D1 finalization (games UPSERT + game_log +
 *      spectator_events + private_views), exactly once
 *   3. R2 replay key 'replays/<game_id>.json'
 *   4. ratings hook called after finalize; failures never un-finalize
 *   5. game-module events in log payloads + public-only spectator emission
 * plus storage-failure injection proving memory and storage never desync,
 * and the legacy single-blob ('room' key) migration.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../../crypto/chain.ts';
import { roundAt } from '../../crypto/drand.ts';
import { generateKeypair, signEd25519 } from '../../crypto/ed25519.ts';
import type { LogEntry, ReplayFile } from '../../kernel/replay.ts';
import type { GameEvent, Json, MoveSubmission } from '../../kernel/types.ts';
import { moveSignMessage, RoomCore } from '../core.ts';
import { GameRoom, setGameResolverForTests, setRatingsHookForTests, type RoomEnv } from '../room.ts';
import { FakeDb, MockBucket, MockStorage, req } from './helpers.ts';
import { miniGame, P0, P1, secretProbe } from './mini-game.ts';

const SECRET = '22'.repeat(32);
const DRAND = 'cd'.repeat(32);

const keypairs = [generateKeypair(), generateKeypair()];
const seats = [P0, P1].map((player, i) => ({
  player,
  agent_id: `agent-${i}`,
  handle: `Agent${i}`,
  pubkey_ed25519: keypairs[i]!.publicKeyHex,
}));

function createBody(gameId: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    game_id: gameId,
    game: 'mini',
    seats,
    variant: {},
    division: 'open',
    ruleset_version: '1.0.0',
    secret_hex: SECRET,
    drand_round: roundAt(Date.now()) + 1_000,
    drand_randomness: DRAND,
    per_move_ms: 60_000,
    clock_scale: 1,
    ...extra,
  };
}

function signedMoveBody(gameId: string, seatIdx: number, turnIndex: number, move: MoveSubmission['move']) {
  const submission: MoveSubmission = { game_id: gameId, turn_index: turnIndex, move };
  const signature = signEd25519(keypairs[seatIdx]!.secretKeyHex, moveSignMessage(gameId, turnIndex, submission));
  return { agent_id: seats[seatIdx]!.agent_id, submission, signature };
}

async function body<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Plays the standard 5-move mini game to its end through the DO. */
async function playToEnd(room: GameRoom, gameId: string): Promise<void> {
  const moves: MoveSubmission['move'][] = ['a', { index: 1 }, 'b', 'a', 'a'];
  for (let t = 0; t < 5; t++) {
    const res = await room.fetch(req('/move', signedMoveBody(gameId, t % 2, t, moves[t]!)));
    expect(res.status, `move ${t}`).toBe(200);
  }
}

let ratingsCalls: string[] = [];

beforeAll(() => {
  setGameResolverForTests((id) => (id === 'mini' ? miniGame : undefined));
  setRatingsHookForTests(async (_env: RoomEnv, gameId: string) => {
    ratingsCalls.push(gameId);
  });
});
afterAll(() => {
  setGameResolverForTests(null);
  setRatingsHookForTests(null);
});

// ---------------------------------------------------------------------------
// 1. Chunked persistence
// ---------------------------------------------------------------------------

describe('chunked persistence (no monolithic snapshot value)', () => {
  it('stores bounded core + per-row keys, and a fresh instance rebuilds the identical room', async () => {
    const GAME_ID = 'persist-rt-1';
    const storage = new MockStorage();
    const room = new GameRoom({ storage }, {});
    expect((await room.fetch(req('/create', createBody(GAME_ID)))).status).toBe(201);
    expect((await room.fetch(req('/move', signedMoveBody(GAME_ID, 0, 0, 'a')))).status).toBe(200);
    expect((await room.fetch(req('/move', signedMoveBody(GAME_ID, 1, 1, 'b')))).status).toBe(200);

    // No single-blob key; the core record holds no unbounded arrays.
    expect(storage.data.has('room')).toBe(false);
    expect(storage.data.has('core')).toBe(true);
    const core = storage.data.get('core') as { snap: Record<string, unknown>; counts: { log_count: number; ev_count: number } };
    expect(core.snap['log']).toBeUndefined();
    expect(core.snap['events']).toBeUndefined();
    expect(core.snap['history']).toBeUndefined();
    expect(core.snap['seedDraws']).toBeUndefined();
    // Immutable rows exist one-per-key, matching the recorded counts.
    expect(storage.keysWithPrefix('log:')).toHaveLength(core.counts.log_count);
    expect(storage.keysWithPrefix('ev:')).toHaveLength(core.counts.ev_count);
    expect(storage.keysWithPrefix('log:')[0]).toBe('log:00000000');
    expect(storage.keysWithPrefix('sd:').length).toBeGreaterThan(0);
    expect(storage.keysWithPrefix('pv:').length).toBeGreaterThan(0);

    // Simulate hibernation: a fresh instance must serve the identical room.
    const stateA = await body<Json>(await room.fetch(req('/state')));
    const viewA = await body<Json>(await room.fetch(req('/view/p0')));
    const eventsA = await body<Json>(await room.fetch(req('/events?since=0')));

    const room2 = new GameRoom({ storage }, {});
    expect(await body<Json>(await room2.fetch(req('/state')))).toEqual(stateA);
    expect(await body<Json>(await room2.fetch(req('/view/p0')))).toEqual(viewA);
    expect(await body<Json>(await room2.fetch(req('/events?since=0')))).toEqual(eventsA);

    // The rebuilt room finishes the game with a verifiable chain.
    for (let t = 2; t < 5; t++) {
      expect((await room2.fetch(req('/move', signedMoveBody(GAME_ID, t % 2, t, 'a')))).status).toBe(200);
    }
    const replay = await body<ReplayFile>(await room2.fetch(req('/replay')));
    expect(verifyChain(GAME_ID, replay.log).ok).toBe(true);
    expect(replay.log.filter((e) => e.kind === 'move')).toHaveLength(5);
  });

  it('the core value size stays flat as the game grows (only per-row keys accumulate)', async () => {
    const GAME_ID = 'persist-flat-1';
    const storage = new MockStorage();
    const room = new GameRoom({ storage }, {});
    await room.fetch(req('/create', createBody(GAME_ID, { variant: { limit: 9 } })));

    await room.fetch(req('/move', signedMoveBody(GAME_ID, 0, 0, 'a')));
    await room.fetch(req('/move', signedMoveBody(GAME_ID, 1, 1, 'b')));
    const sizeAfter2 = storage.valueSize('core');
    const logKeysAfter2 = storage.keysWithPrefix('log:').length;

    for (let t = 2; t < 8; t++) await room.fetch(req('/move', signedMoveBody(GAME_ID, t % 2, t, 'a')));
    const sizeAfter8 = storage.valueSize('core');

    // Six more applied moves: the append-only families grew…
    expect(storage.keysWithPrefix('log:').length).toBe(logKeysAfter2 + 6);
    // …but the core record did not (a few clock digits at most).
    expect(Math.abs(sizeAfter8 - sizeAfter2)).toBeLessThan(300);
  });

  it('migrates a legacy single-blob snapshot on first wake', async () => {
    const GAME_ID = 'persist-legacy-1';
    const core = RoomCore.create(Date.now(), {
      gameId: GAME_ID,
      game: miniGame,
      variant: {},
      seats,
      division: 'open',
      rulesetVersion: '1.0.0',
      secretHex: SECRET,
      drandRound: roundAt(Date.now()) + 1_000,
      drandRandomnessHex: DRAND,
      perMoveMs: 60_000,
      clockScale: 1,
    });
    for (let t = 0; t < 2; t++) {
      const b = signedMoveBody(GAME_ID, t % 2, t, 'a');
      expect(core.submitMove(Date.now(), b.agent_id, b.submission, b.signature).ok).toBe(true);
    }
    // Reshape into the pre-chunking storage format under the old 'room' key.
    const legacy = JSON.parse(JSON.stringify(core.snapshot())) as Record<string, unknown>;
    const pvbt = legacy['privateViewsByTurn'] as Record<string, Json>;
    const maxTurn = Math.max(...Object.keys(pvbt).map(Number));
    legacy['privateViews'] = pvbt[String(maxTurn)] ?? {};
    delete legacy['privateViewsByTurn'];
    delete legacy['finalized'];
    legacy['replay'] = null;

    const storage = new MockStorage();
    storage.data.set('room', legacy);
    const room = new GameRoom({ storage }, {});
    const state = await body<{ turn_index: number; status: string }>(await room.fetch(req('/state')));
    expect(state.turn_index).toBe(2);
    expect(state.status).toBe('running');
    // Blob replaced by the chunked layout.
    expect(storage.data.has('room')).toBe(false);
    expect(storage.data.has('core')).toBe(true);
    expect(storage.keysWithPrefix('log:')).toHaveLength(4); // commitment, start, 2 moves

    // And the migrated room still finishes with a verifiable chain.
    for (let t = 2; t < 5; t++) {
      expect((await room.fetch(req('/move', signedMoveBody(GAME_ID, t % 2, t, 'a')))).status).toBe(200);
    }
    const replay = await body<ReplayFile>(await room.fetch(req('/replay')));
    expect(verifyChain(GAME_ID, replay.log).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Storage-failure injection: memory never desyncs from storage
// ---------------------------------------------------------------------------

describe('storage failure injection', () => {
  it('a failed move persist returns 500, applies nothing, and the room recovers', async () => {
    const GAME_ID = 'persist-fail-1';
    const storage = new MockStorage();
    const room = new GameRoom({ storage }, {});
    await room.fetch(req('/create', createBody(GAME_ID)));

    storage.failPuts = 1;
    const failed = await room.fetch(req('/move', signedMoveBody(GAME_ID, 0, 0, 'a')));
    expect(failed.status).toBe(500);
    expect((await body<{ code: string }>(failed)).code).toBe('persist_failed');

    // Memory was rebuilt from storage: the move never happened.
    const state = await body<{ turn_index: number; log_length: number }>(await room.fetch(req('/state')));
    expect(state.turn_index).toBe(0);
    expect(state.log_length).toBe(2); // commitment + start only

    // The very same signed submission now succeeds; no gaps or duplicate seqs.
    expect((await room.fetch(req('/move', signedMoveBody(GAME_ID, 0, 0, 'a')))).status).toBe(200);
    const events = await body<{ events: { seq: number; type: string }[] }>(await room.fetch(req('/events?since=0')));
    expect(events.events.map((e) => e.seq)).toEqual(events.events.map((_, i) => i + 1));
    expect(events.events.filter((e) => e.type === 'move')).toHaveLength(1);

    // Storage and memory agree after a restart too.
    const room2 = new GameRoom({ storage }, {});
    const state2 = await body<{ turn_index: number }>(await room2.fetch(req('/state')));
    expect(state2.turn_index).toBe(1);
  });

  it('an alarm-path persist failure never throws and retries on a fresh alarm', async () => {
    const GAME_ID = 'persist-fail-2';
    const storage = new MockStorage();
    const room = new GameRoom({ storage }, {});
    // budget = max(1, 60000 * 1e-6) = 1ms — the deadline passes immediately.
    await room.fetch(req('/create', createBody(GAME_ID, { clock_scale: 0.000001 })));
    await new Promise((resolve) => setTimeout(resolve, 20));

    storage.failPuts = 1;
    await expect(room.alarm()).resolves.toBeUndefined(); // must not crash the DO
    // Nothing was applied; a retry alarm is scheduled.
    expect(storage.alarmAt).not.toBeNull();
    const state = await body<{ turn_index: number }>(await room.fetch(req('/state')));
    expect(state.turn_index).toBe(0);

    // The retry succeeds and applies the timeout exactly once.
    await room.alarm();
    const state2 = await body<{ turn_index: number; strikes: Record<string, number> }>(await room.fetch(req('/state')));
    expect(state2.turn_index).toBe(1);
    expect(state2.strikes[P0]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. End-of-game finalization: D1 rows + R2 key + ratings hook, exactly once
// ---------------------------------------------------------------------------

describe('finalization (D1 + R2 + ratings)', () => {
  it('writes the games UPSERT, log/event/private-view rows, the R2 blob, and rates — exactly once', async () => {
    const GAME_ID = 'finalize-1';
    const storage = new MockStorage();
    const db = new FakeDb();
    const bucket = new MockBucket();
    const env: RoomEnv = { DB: db, REPLAYS: bucket };
    const room = new GameRoom({ storage }, env);
    ratingsCalls = [];

    await room.fetch(req('/create', createBody(GAME_ID)));
    await playToEnd(room, GAME_ID);
    const replay = await body<ReplayFile>(await room.fetch(req('/replay')));

    // R2: the canonical key the API resolves by default.
    expect(bucket.puts).toHaveLength(1);
    expect(bucket.puts[0]!.key).toBe(`replays/${GAME_ID}.json`);

    // games UPSERT: ended + reveal + result + replay key, idempotent by id.
    const games = db.rowsInto('games');
    expect(games).toHaveLength(1);
    expect(games[0]!.sql).toContain("ON CONFLICT(id) DO UPDATE SET status = 'ended'");
    expect(games[0]!.binds[0]).toBe(GAME_ID);
    expect(games[0]!.binds[6]).toBe(SECRET); // reveal_secret
    expect(games[0]!.binds[11]).toBe(JSON.stringify(replay.result));
    expect(games[0]!.binds[12]).toBe(`replays/${GAME_ID}.json`);

    // game_log rows mirror the replay log exactly (game_id, seq, kind, …).
    const logRows = db.rowsInto('game_log');
    expect(logRows).toHaveLength(replay.log.length);
    for (let i = 0; i < logRows.length; i++) {
      const [gid, seq, kind, payloadJson, prevHash, hash, signature, createdAt] = logRows[i]!.binds;
      const e = replay.log[i]!;
      expect([gid, seq, kind, prevHash, hash, signature, createdAt]).toEqual([
        GAME_ID, e.seq, e.kind, e.prev_hash, e.hash, e.signature, e.created_at,
      ]);
      expect(JSON.parse(payloadJson as string)).toEqual(e.payload);
    }

    // spectator_events rows mirror the live feed.
    const events = await body<{ events: { seq: number; type: string }[] }>(await room.fetch(req('/events?since=0')));
    const evRows = db.rowsInto('spectator_events');
    expect(evRows).toHaveLength(events.events.length);
    expect(evRows.map((r) => r.binds[1])).toEqual(events.events.map((e) => e.seq));

    // private_views rows: both seats for every retained turn (0..4 here).
    const pvRows = db.rowsInto('private_views');
    expect(pvRows).toHaveLength(10);
    const pvAgents = new Set(pvRows.map((r) => String(r.binds[1])));
    expect([...pvAgents].sort()).toEqual(['agent-0', 'agent-1']);
    const p0Turn0 = pvRows.find((r) => r.binds[1] === 'agent-0' && r.binds[2] === 0)!;
    expect(String(p0Turn0.binds[3])).toContain(secretProbe(P0));

    // Ratings hook ran once, after finalize, with the game id.
    expect(ratingsCalls).toEqual([GAME_ID]);

    // Exactly once: another tick, a restart, and an alarm add nothing.
    const executedBefore = db.executed.length;
    await room.fetch(req('/tick', {}));
    const room2 = new GameRoom({ storage }, env);
    await room2.alarm();
    expect((await room2.fetch(req('/replay'))).status).toBe(200);
    expect(db.executed.length).toBe(executedBefore);
    expect(bucket.puts).toHaveLength(1);
    expect(ratingsCalls).toEqual([GAME_ID]);
  });

  it('retries finalization on a later alarm when D1 fails, without failing the ending move', async () => {
    const GAME_ID = 'finalize-retry-1';
    const storage = new MockStorage();
    const db = new FakeDb();
    const bucket = new MockBucket();
    const env: RoomEnv = { DB: db, REPLAYS: bucket };
    const room = new GameRoom({ storage }, env);
    ratingsCalls = [];

    await room.fetch(req('/create', createBody(GAME_ID)));
    db.failBatches = 1;
    await playToEnd(room, GAME_ID); // ending move still 200s (asserted inside)

    // Not finalized: no D1 rows landed, no rating, a retry alarm is set.
    expect(db.rowsInto('games')).toHaveLength(0);
    expect(ratingsCalls).toEqual([]);
    expect(storage.alarmAt).not.toBeNull();

    // The retry alarm completes finalization idempotently.
    await room.alarm();
    expect(db.rowsInto('games')).toHaveLength(1);
    expect(db.rowsInto('game_log').length).toBeGreaterThan(0);
    expect(ratingsCalls).toEqual([GAME_ID]);
    expect(storage.alarmAt).toBeNull();
  });

  it('a throwing ratings hook does not un-finalize the game', async () => {
    const GAME_ID = 'finalize-rate-fail-1';
    const storage = new MockStorage();
    const db = new FakeDb();
    const env: RoomEnv = { DB: db };
    const room = new GameRoom({ storage }, env);
    let calls = 0;
    setRatingsHookForTests(async () => {
      calls += 1;
      throw new Error('glicko exploded');
    });
    try {
      await room.fetch(req('/create', createBody(GAME_ID)));
      await playToEnd(room, GAME_ID);
      expect(calls).toBe(1);
      expect(db.rowsInto('games')).toHaveLength(1);
      // Finalized despite the rating failure: nothing re-runs.
      const executedBefore = db.executed.length;
      await room.fetch(req('/tick', {}));
      await room.alarm();
      expect(db.executed.length).toBe(executedBefore);
      expect(calls).toBe(1);
    } finally {
      setRatingsHookForTests(async (_env: RoomEnv, gameId: string) => {
        ratingsCalls.push(gameId);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Game-module events: into the log, public-only into the spectator feed
// ---------------------------------------------------------------------------

describe('game events (spec §game_kernel_contract.apply)', () => {
  it('logs all apply() events with visibility and emits only the public ones live', async () => {
    const GAME_ID = 'events-1';
    const storage = new MockStorage();
    const room = new GameRoom({ storage }, {});
    await room.fetch(req('/create', createBody(GAME_ID)));
    await playToEnd(room, GAME_ID);

    const replay = await body<ReplayFile>(await room.fetch(req('/replay')));
    const moveEntries = replay.log.filter((e: LogEntry) => e.kind === 'move');
    expect(moveEntries).toHaveLength(5);
    for (const e of moveEntries) {
      const evs = (e.payload as { events?: GameEvent[] }).events;
      expect(evs, 'move payload carries apply() events').toBeDefined();
      const types = evs!.map((x) => `${x.type}:${x.visibility}`).sort();
      expect(types).toEqual(['peek:private', 'played:public']);
      // The private event (with the secret probe) IS in the log/replay…
      const peek = evs!.find((x) => x.type === 'peek')!;
      expect(JSON.stringify(peek.data)).toContain('SECRET_');
    }

    // …but the live spectator feed carries only the public ones.
    const events = await body<{ events: { type: string; data: Json }[] }>(await room.fetch(req('/events?since=0')));
    const gameEvents = events.events.filter((e) => e.type.startsWith('game:'));
    expect(gameEvents).toHaveLength(5);
    expect(gameEvents.every((e) => e.type === 'game:played')).toBe(true);
    const first = gameEvents[0]!.data as { turn_index: number; player: string; data: { roll: number } };
    expect(first.turn_index).toBe(0);
    expect(typeof first.data.roll).toBe('number');
    expect(events.events.some((e) => e.type === 'game:peek')).toBe(false);

    // The probe never reaches any pre-end spectator event.
    const endIdx = events.events.findIndex((e) => e.type === 'end');
    const preEnd = JSON.stringify(events.events.slice(0, endIdx));
    expect(preEnd).not.toContain(secretProbe(P0));
    expect(preEnd).not.toContain(secretProbe(P1));

    // Chain still verifies with the enriched payloads.
    expect(verifyChain(GAME_ID, replay.log).ok).toBe(true);
  });
});
