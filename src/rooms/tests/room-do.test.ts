/**
 * GameRoom Durable Object wrapper tests, driven through fetch() with an
 * in-memory storage/alarm mock and a mock R2 bucket. Verifies the internal
 * HTTP API, persistence across a fresh instance (hydration), the alarm/tick
 * timeout path, spectator endpoints (JSON + SSE, public data only), the
 * replay endpoint, and the R2 upload guard.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../../crypto/chain.ts';
import { roundAt } from '../../crypto/drand.ts';
import { generateKeypair, signEd25519 } from '../../crypto/ed25519.ts';
import type { ReplayFile } from '../../kernel/replay.ts';
import type { Json, MoveSubmission, PlayerId } from '../../kernel/types.ts';
import { moveSignMessage } from '../core.ts';
import { GameRoom, setGameResolverForTests, type RoomCtx, type RoomEnv, type RoomStorage } from '../room.ts';
import { miniGame, P0, P1, secretProbe } from './mini-game.ts';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockStorage implements RoomStorage {
  data = new Map<string, unknown>();
  alarmAt: number | null = null;
  // eslint-disable-next-line @typescript-eslint/require-await
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as T);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmAt = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime();
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

class MockBucket {
  puts: { key: string; value: string }[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async put(key: string, value: string): Promise<unknown> {
    this.puts.push({ key, value });
    return null;
  }
}

function req(path: string, body?: unknown, method?: string): Request {
  return new Request(`http://room${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

const keypairs = [generateKeypair(), generateKeypair()];
const seats = [P0, P1].map((player, i) => ({
  player,
  agent_id: `agent-${i}`,
  handle: `Agent${i}`,
  pubkey_ed25519: keypairs[i]!.publicKeyHex,
}));

const GAME_ID = 'do-game-1';

function signedMoveBody(seatIdx: number, turnIndex: number, move: MoveSubmission['move'], commentary?: string) {
  const submission: MoveSubmission = { game_id: GAME_ID, turn_index: turnIndex, move };
  if (commentary !== undefined) submission.commentary = commentary;
  const signature = signEd25519(keypairs[seatIdx]!.secretKeyHex, moveSignMessage(GAME_ID, turnIndex, submission));
  return { agent_id: seats[seatIdx]!.agent_id, submission, signature };
}

const createBody = {
  game_id: GAME_ID,
  game: 'mini',
  seats,
  variant: {},
  division: 'open' as const,
  ruleset_version: '1.0.0',
  secret_hex: '22'.repeat(32),
  // The DO creates at Date.now(); the round must be at or after that moment
  // (spec randomness[1], enforced by RoomCore.create).
  drand_round: roundAt(Date.now()) + 1_000,
  drand_randomness: 'cd'.repeat(32),
  per_move_ms: 60_000,
  clock_scale: 1,
};

beforeAll(() => {
  setGameResolverForTests((id) => (id === 'mini' ? miniGame : undefined));
});
afterAll(() => {
  setGameResolverForTests(null);
});

describe('GameRoom Durable Object', () => {
  it('create -> views -> signed moves -> end -> replay + R2 upload, with persistence across instances', async () => {
    const storage = new MockStorage();
    const bucket = new MockBucket();
    const ctx: RoomCtx = { storage };
    const env: RoomEnv = { REPLAYS: bucket };

    let room = new GameRoom(ctx, env);

    const created = await room.fetch(req('/create', createBody));
    expect(created.status).toBe(201);
    const summary = (await created.json()) as { turn_index: number; commitment: string };
    expect(summary.turn_index).toBe(0);
    expect(summary.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.alarmAt).not.toBeNull(); // deadline alarm scheduled

    // Duplicate create is a conflict.
    expect((await room.fetch(req('/create', createBody))).status).toBe(409);

    // The view carries legal moves (A11: every view includes legal_moves).
    const viewRes = await room.fetch(req('/view/p0'));
    expect(viewRes.status).toBe(200);
    const view = (await viewRes.json()) as { legal_moves: unknown[]; you: { player: PlayerId } };
    expect(view.you.player).toBe(P0);
    expect(view.legal_moves).toHaveLength(2);

    // Unknown seat.
    expect((await room.fetch(req('/view/p9'))).status).toBe(404);

    // Play two moves, then simulate a DO restart (fresh instance, same storage).
    expect((await room.fetch(req('/move', signedMoveBody(0, 0, 'a', 'opening!')))).status).toBe(200);
    expect((await room.fetch(req('/move', signedMoveBody(1, 1, { index: 1 })))).status).toBe(200);

    room = new GameRoom(ctx, env); // hibernation/restart: state must come from storage
    const state = (await (await room.fetch(req('/state'))).json()) as { turn_index: number; status: string };
    expect(state.turn_index).toBe(2);
    expect(state.status).toBe('running');

    // A bad signature is a 400 with the rejection body.
    const bad = signedMoveBody(0, 2, 'a');
    bad.signature = signedMoveBody(1, 2, 'a').signature;
    const badRes = await room.fetch(req('/move', bad));
    expect(badRes.status).toBe(400);
    expect(((await badRes.json()) as { code: string }).code).toBe('bad_signature');

    // Replay is unavailable while running.
    expect((await room.fetch(req('/replay'))).status).toBe(409);

    // Finish the game.
    expect((await room.fetch(req('/move', signedMoveBody(0, 2, 'b')))).status).toBe(200);
    expect((await room.fetch(req('/move', signedMoveBody(1, 3, 'a')))).status).toBe(200);
    expect((await room.fetch(req('/move', signedMoveBody(0, 4, 'a')))).status).toBe(200);

    const replayRes = await room.fetch(req('/replay'));
    expect(replayRes.status).toBe(200);
    const replay = (await replayRes.json()) as ReplayFile;
    expect(replay.version).toBe('ludus.replay.v1');
    expect(verifyChain(GAME_ID, replay.log).ok).toBe(true);
    expect(replay.result.winners).toEqual([P0]);

    // Ended: view returns 409, alarm cleared, replay uploaded to R2 exactly once.
    expect((await room.fetch(req('/view/p0'))).status).toBe(409);
    expect(storage.alarmAt).toBeNull();
    expect(bucket.puts).toHaveLength(1);
    expect(bucket.puts[0]!.key).toBe(`${GAME_ID}.json`);
    expect((JSON.parse(bucket.puts[0]!.value) as ReplayFile).game_id).toBe(GAME_ID);

    // Spectator events (JSON): public only — no probe string before the end.
    const evRes = await room.fetch(req('/events?since=0'));
    const evBody = (await evRes.json()) as { events: { type: string; data: Json }[]; latest_seq: number };
    expect(evBody.latest_seq).toBeGreaterThan(0);
    const endIdx = evBody.events.findIndex((e) => e.type === 'end');
    const preEnd = JSON.stringify(evBody.events.slice(0, endIdx));
    expect(preEnd).not.toContain(secretProbe(P0));
    expect(preEnd).not.toContain(secretProbe(P1));
    // Applied commentary is public data after the move.
    expect(JSON.stringify(evBody.events)).toContain('opening!');
  });

  it('serves the event backlog over SSE', async () => {
    const storage = new MockStorage();
    const room = new GameRoom({ storage }, {});
    await room.fetch(req('/create', createBody));
    await room.fetch(req('/move', signedMoveBody(0, 0, 'a')));

    const sse = await room.fetch(req('/events?since=0&sse=1'));
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toBe('text/event-stream');
    const reader = (sse.body as ReadableStream<Uint8Array>).getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain('event: start');
    await reader.cancel();
  });

  it('runs the timeout path via /tick (and the alarm handler)', async () => {
    const storage = new MockStorage();
    const room = new GameRoom({ storage }, {});
    // Tiny clock so the deadline passes in real time: budget = max(1, 60000*1e-6) = 1ms.
    await room.fetch(req('/create', { ...createBody, clock_scale: 0.000001 }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const tick = await room.fetch(req('/tick', {}));
    const body = (await tick.json()) as { fired: boolean };
    expect(body.fired).toBe(true);

    const state = (await (await room.fetch(req('/state'))).json()) as {
      turn_index: number;
      strikes: Record<string, number>;
    };
    expect(state.turn_index).toBe(1);
    expect(state.strikes[P0]).toBe(1);

    // The DO alarm handler drives the same path.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await room.alarm();
    const state2 = (await (await room.fetch(req('/state'))).json()) as { turn_index: number };
    expect(state2.turn_index).toBe(2);
  });

  it('404s before create and on unknown routes; 400s on unknown games', async () => {
    const storage = new MockStorage();
    const room = new GameRoom({ storage }, {});
    expect((await room.fetch(req('/state'))).status).toBe(404);
    expect((await room.fetch(req('/nope'))).status).toBe(404);
    const bad = await room.fetch(req('/create', { ...createBody, game: 'not-a-game' }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('unknown_game');
  });
});
