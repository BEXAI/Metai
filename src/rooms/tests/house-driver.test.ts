/**
 * The house driver and the werewolf house agent (plan §7.7, §8.3).
 *
 * Ordered smallest-fixture-first on purpose: every mechanism (safe degradation,
 * arming, durability, re-entrancy, error isolation) is pinned on the 2-seat
 * mini fixture where a failure is unambiguous, THEN the same driver is run
 * against 8 seats — first the octo fixture, then a real 8-seat werewolf room
 * backfilled entirely by house agents and played to a result.
 *
 * All crypto is real: house seats are seated with keys derived by the keyring
 * from a test seed, so a signature the room rejects fails the test rather than
 * being mocked away.
 */

import { describe, expect, it } from 'vitest';
import { createWerewolfHouseAgent } from '../../agents/werewolf.ts';
import { submissionByIndex, type HouseAdapter } from '../../agents/adapter.ts';
import {
  HOUSE_MOVE_DELAY_MS,
  HOUSE_MOVES_PER_WAKE,
  HOUSE_RETRY_MS,
  HouseDriver,
  KEY_HOUSE_DUE,
  defaultAdapterFor,
  pendingHouseSeats,
} from '../house-driver.ts';
import {
  HOUSE_SEED_MIN_CHARS,
  WEREWOLF_HOUSE_ROSTER,
  houseKeyringFromSeed,
  houseRosterOfHandle,
  isHouseHandle,
  type HouseKeyring,
} from '../../api/house.ts';
import werewolf from '../../games/werewolf/index.ts';
import { generateKeypair, signEd25519 } from '../../crypto/ed25519.ts';
import { roundAt } from '../../crypto/drand.ts';
import { playerId, type AnyGame, type Json, type PlayerId, type ViewObject } from '../../kernel/types.ts';
import { moveSignMessage, RoomCore, type RoomSeat } from '../core.ts';
import { MockStorage } from './helpers.ts';
import { miniGame } from './mini-game.ts';
import { octoGame } from './octo-game.ts';

const SEED = 'house-test-seed-0123456789abcdef0123456789abcdef';
const KEYRING: HouseKeyring = houseKeyringFromSeed(SEED)!;
const SECRET = '11'.repeat(32);
const DRAND = 'ab'.repeat(32);
const NOW = 1_700_000_000_000;
/** RoomCore.create requires the mixed round to be at or after the commitment. */
const DRAND_ROUND = roundAt(NOW) + 10;

interface Table {
  core: RoomCore;
  seats: RoomSeat[];
  /** Secret keys for the NON-house seats only; house seats sign via the keyring. */
  keys: Map<string, string>;
}

/**
 * `handles[i]` seats player i. A handle starting with 'house-' is seated with a
 * keyring-derived key; anything else gets a fresh keypair (a real entrant).
 */
function makeTable(game: AnyGame, handles: readonly string[], gameId = 'game-house-1'): Table {
  const keys = new Map<string, string>();
  const seats: RoomSeat[] = handles.map((handle, i) => {
    const player = playerId(i);
    const agent_id = `agent-${i}`;
    if (isHouseHandle(handle)) {
      return { player, agent_id, handle, pubkey_ed25519: KEYRING.publicKeyHex(handle) };
    }
    const kp = generateKeypair();
    keys.set(agent_id, kp.secretKeyHex);
    return { player, agent_id, handle, pubkey_ed25519: kp.publicKeyHex };
  });
  const core = RoomCore.create(NOW, {
    gameId,
    game,
    variant: {},
    seats,
    division: 'open',
    rulesetVersion: '1.0.0',
    secretHex: SECRET,
    drandRound: DRAND_ROUND,
    drandRandomnessHex: DRAND,
    perMoveMs: 600_000,
    clockScale: 1,
  });
  return { core, seats, keys };
}

/** A real entrant submitting by index, signing with its own key. */
function submitReal(table: Table, player: PlayerId, index: number, nowMs = NOW): void {
  const seat = table.seats.find((s) => s.player === player)!;
  const submission = { game_id: table.core.gameId, turn_index: table.core.turnIndex, move: { index } };
  const signature = signEd25519(
    table.keys.get(seat.agent_id)!,
    moveSignMessage(table.core.gameId, submission.turn_index, submission),
  );
  const res = table.core.submitMove(nowMs, seat.agent_id, submission, signature);
  expect(res.ok).toBe(true);
}

/** An adapter that always answers index 0 — legal in every fixture. */
function indexZeroAdapter(agentId: string): HouseAdapter {
  return {
    kind: 'test-index-zero',
    agentId,
    // eslint-disable-next-line @typescript-eslint/require-await
    async chooseMove(view: ViewObject) {
      return submissionByIndex(view, 0);
    },
  };
}

const alwaysIndexZero = (ctx: { agentId: string }): HouseAdapter => indexZeroAdapter(ctx.agentId);

// ---------------------------------------------------------------------------
// Keys and safe degradation
// ---------------------------------------------------------------------------

describe('house keys degrade to OFF, never to a default', () => {
  it('an absent, blank or too-short seed yields no keyring at all', () => {
    expect(houseKeyringFromSeed(undefined)).toBeNull();
    expect(houseKeyringFromSeed(null)).toBeNull();
    expect(houseKeyringFromSeed('')).toBeNull();
    expect(houseKeyringFromSeed('   ')).toBeNull();
    expect(houseKeyringFromSeed('x'.repeat(HOUSE_SEED_MIN_CHARS - 1))).toBeNull();
    expect(houseKeyringFromSeed('x'.repeat(HOUSE_SEED_MIN_CHARS))).not.toBeNull();
  });

  it('derivation is deterministic, distinct per handle, and a valid Ed25519 key', () => {
    const other = houseKeyringFromSeed(SEED)!;
    for (const handle of WEREWOLF_HOUSE_ROSTER.slice(0, 4)) {
      expect(KEYRING.secretKeyHex(handle)).toMatch(/^[0-9a-f]{64}$/);
      expect(other.publicKeyHex(handle)).toBe(KEYRING.publicKeyHex(handle));
    }
    const pubkeys = new Set(WEREWOLF_HOUSE_ROSTER.map((h) => KEYRING.publicKeyHex(h)));
    expect(pubkeys.size).toBe(WEREWOLF_HOUSE_ROSTER.length);
    // A different seed is a different identity — no shared fallback anywhere.
    const rotated = houseKeyringFromSeed('a-completely-different-seed-value-0123456789')!;
    expect(rotated.publicKeyHex(WEREWOLF_HOUSE_ROSTER[0]!)).not.toBe(KEYRING.publicKeyHex(WEREWOLF_HOUSE_ROSTER[0]!));
  });

  it('the roster is 24 handles, all rostered to ww, all valid agent handles', () => {
    expect(WEREWOLF_HOUSE_ROSTER).toHaveLength(24);
    expect(new Set(WEREWOLF_HOUSE_ROSTER).size).toBe(24);
    for (const handle of WEREWOLF_HOUSE_ROSTER) {
      expect(handle).toMatch(/^[a-z0-9][a-z0-9_-]{2,31}$/);
      expect(houseRosterOfHandle(handle)).toBe('ww');
    }
    expect(WEREWOLF_HOUSE_ROSTER.filter((h) => h.includes('anthropic'))).toHaveLength(6);
    expect(WEREWOLF_HOUSE_ROSTER.filter((h) => h.includes('mock'))).toHaveLength(18);
  });

  it('with no keyring the driver does nothing, writes nothing, and never throws', async () => {
    const table = makeTable(miniGame, ['house-ww-mock-01', 'house-ww-mock-02']);
    const storage = new MockStorage();
    const driver = new HouseDriver(storage, { keyring: null, adapterFor: alwaysIndexZero });

    await driver.arm(table.core, NOW);
    const out = await driver.run(table.core, NOW + HOUSE_MOVE_DELAY_MS);

    expect(out.drove).toEqual([]);
    expect(out.nextDueAtMs).toBeNull();
    expect(storage.data.has(KEY_HOUSE_DUE)).toBe(false);
    expect(table.core.turnIndex).toBe(0);
    expect(table.core.log.filter((e) => e.kind === 'move')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The 2-seat fixture: arming, durability, re-entrancy, error isolation
// ---------------------------------------------------------------------------

describe('house driver on a 2-seat table', () => {
  const deps = { keyring: KEYRING, adapterFor: alwaysIndexZero };

  it('arms on a pending house seat, drives it, and marks it as a house seat', async () => {
    const table = makeTable(miniGame, ['house-ww-mock-01', 'real-agent']);
    const storage = new MockStorage();
    const driver = new HouseDriver(storage, deps);

    expect(pendingHouseSeats(table.core).map((s) => s.player)).toEqual([playerId(0)]);
    expect(await driver.arm(table.core, NOW)).toBe(NOW + HOUSE_MOVE_DELAY_MS);
    expect(storage.data.get(KEY_HOUSE_DUE)).toEqual({ at: NOW + HOUSE_MOVE_DELAY_MS, turn: 0 });

    const out = await driver.run(table.core, NOW + HOUSE_MOVE_DELAY_MS);

    expect(table.core.turnIndex).toBe(1);
    expect(out.events.length).toBeGreaterThan(0);
    expect(out.drove).toEqual([
      {
        player: playerId(0),
        agent_id: 'agent-0',
        handle: 'house-ww-mock-01',
        house: true,
        attestation: 'room_signed',
        note: expect.stringContaining('the room wrote this move'),
      },
    ]);
    // p1 is a real entrant, so nothing is pending and the driver stands down.
    expect(out.nextDueAtMs).toBeNull();
    expect(storage.data.has(KEY_HOUSE_DUE)).toBe(false);
  });

  it('the move the room recorded really is signed by the derived house key', async () => {
    const table = makeTable(miniGame, ['house-ww-mock-01', 'real-agent']);
    const driver = new HouseDriver(new MockStorage(), deps);
    await driver.run(table.core, NOW);

    const entry = table.core.log.find((e) => e.kind === 'move')!;
    const payload = entry.payload as unknown as { submission: { turn_index: number } };
    expect(entry.signature).toBe(
      KEYRING.sign(
        'house-ww-mock-01',
        moveSignMessage(table.core.gameId, payload.submission.turn_index, payload.submission as never),
      ),
    );
  });

  it('arming is idempotent within a turn and re-arms when the turn advances', async () => {
    const table = makeTable(miniGame, ['house-ww-mock-01', 'house-ww-mock-02']);
    const storage = new MockStorage();
    const driver = new HouseDriver(storage, deps);

    expect(await driver.arm(table.core, NOW)).toBe(NOW + HOUSE_MOVE_DELAY_MS);
    // A later persist inside the SAME turn must not push the due time out, or
    // the house seats would never come due at all.
    expect(await driver.arm(table.core, NOW + 2_000)).toBe(NOW + HOUSE_MOVE_DELAY_MS);
    expect(await driver.arm(table.core, NOW + 9_000)).toBe(NOW + HOUSE_MOVE_DELAY_MS);

    // The drive advances the turn and re-arms itself for the next house seat.
    const woke = NOW + HOUSE_MOVE_DELAY_MS;
    expect((await driver.run(table.core, woke)).nextDueAtMs).toBe(woke + HOUSE_RETRY_MS);
    expect(table.core.turnIndex).toBe(1);
    expect(storage.data.get(KEY_HOUSE_DUE)).toEqual({ at: woke + HOUSE_RETRY_MS, turn: 1 });
    expect(await driver.arm(table.core, NOW + 20_000)).toBe(woke + HOUSE_RETRY_MS);

    // Once disarmed, the next arm on this turn schedules the full delay again.
    await driver.disarm();
    expect(await driver.arm(table.core, NOW + 20_000)).toBe(NOW + 20_000 + HOUSE_MOVE_DELAY_MS);
  });

  it('the due time survives eviction: a fresh driver reads it back from storage', async () => {
    const table = makeTable(miniGame, ['house-ww-mock-01', 'real-agent']);
    const storage = new MockStorage();
    await new HouseDriver(storage, deps).arm(table.core, NOW);

    const reborn = new HouseDriver(storage, deps);
    expect(reborn.dueAtMs).toBeNull(); // nothing read yet
    expect(await reborn.load()).toBe(NOW + HOUSE_MOVE_DELAY_MS);
    expect(reborn.dueAtMs).toBe(NOW + HOUSE_MOVE_DELAY_MS);
  });

  it('two overlapping wakes drive the seat exactly ONCE', async () => {
    const table = makeTable(miniGame, ['house-ww-mock-01', 'real-agent']);
    let calls = 0;
    const driver = new HouseDriver(new MockStorage(), {
      keyring: KEYRING,
      adapterFor: (ctx) => ({
        kind: 'slow',
        agentId: ctx.agentId,
        async chooseMove(view: ViewObject) {
          calls += 1;
          await Promise.resolve();
          return submissionByIndex(view, 0);
        },
      }),
    });

    // Both alarms fire before either finishes — the promise chain must serialise
    // them, and the second must find the seat already resolved.
    const [a, b] = await Promise.all([driver.run(table.core, NOW), driver.run(table.core, NOW)]);

    expect(calls).toBe(1);
    expect(a.drove.length + b.drove.length).toBe(1);
    expect(table.core.turnIndex).toBe(1);
    expect(table.core.log.filter((e) => e.kind === 'move')).toHaveLength(1);
  });

  it('a real move landing mid-flight is not overwritten and costs no strike', async () => {
    // Simultaneous phase: both seats owe a move at turn 0.
    const table = makeTable(miniGame, ['house-ww-mock-01', 'real-agent'], 'game-house-simul');
    const simul = RoomCore.create(NOW, {
      gameId: 'game-house-simul',
      game: miniGame,
      variant: { simultaneous: true },
      seats: table.seats,
      division: 'open',
      rulesetVersion: '1.0.0',
      secretHex: SECRET,
      drandRound: DRAND_ROUND,
      drandRandomnessHex: DRAND,
      perMoveMs: 600_000,
      clockScale: 1,
    });
    const live: Table = { ...table, core: simul };

    const driver = new HouseDriver(new MockStorage(), {
      keyring: KEYRING,
      adapterFor: (ctx) => ({
        kind: 'racing',
        agentId: ctx.agentId,
        async chooseMove(view: ViewObject) {
          // The real entrant submits WHILE the adapter is thinking.
          submitReal(live, playerId(1), 0);
          await Promise.resolve();
          return submissionByIndex(view, 0);
        },
      }),
    });

    const out = await driver.run(simul, NOW);
    expect(out.drove).toHaveLength(1);
    expect(simul.strikes[playerId(0)] ?? 0).toBe(0);
    expect(simul.strikes[playerId(1)] ?? 0).toBe(0);
    expect(simul.log.filter((e) => e.kind === 'move')).toHaveLength(2);
  });

  it('an adapter that throws costs that seat its move and nothing else', async () => {
    const table = makeTable(miniGame, ['house-ww-mock-01', 'real-agent']);
    const errors: string[] = [];
    const driver = new HouseDriver(new MockStorage(), {
      keyring: KEYRING,
      adapterFor: (ctx) => ({
        kind: 'broken',
        agentId: ctx.agentId,
        chooseMove: () => Promise.reject(new Error('model unavailable')),
      }),
      onError: (kind) => errors.push(kind),
    });

    const out = await driver.run(table.core, NOW);
    expect(out.drove).toEqual([]);
    expect(out.nextDueAtMs).toBeNull(); // stand down; the deadline is the backstop
    expect(errors).toEqual(['house_move_failed']);
    expect(table.core.status).toBe('running');
    expect(table.core.turnIndex).toBe(0);
  });

  it('the default policy registry drives werewolf and NOTHING else (D-5)', () => {
    const ctx = { gameId: 'g', player: playerId(0), agentId: 'a', handle: 'house-ww-mock-01' };
    expect(defaultAdapterFor({ ...ctx, game: 'werewolf' })).not.toBeNull();
    for (const game of ['mini', 'octo', 'chess', 'go', 'islanders', 'landlord']) {
      expect(defaultAdapterFor({ ...ctx, game })).toBeNull();
    }
  });

  it('a game with no house policy is armed but never driven, and never loops', async () => {
    const table = makeTable(miniGame, ['house-ww-mock-01', 'real-agent']);
    const storage = new MockStorage();
    const driver = new HouseDriver(storage, { keyring: KEYRING }); // default registry

    await driver.arm(table.core, NOW);
    const out = await driver.run(table.core, NOW + HOUSE_MOVE_DELAY_MS);
    expect(out.drove).toEqual([]);
    expect(out.nextDueAtMs).toBeNull();
    expect(storage.data.has(KEY_HOUSE_DUE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Eight seats
// ---------------------------------------------------------------------------

describe('house driver on an 8-seat table', () => {
  const HANDLES = [
    'real-agent',
    'house-ww-mock-01',
    'house-ww-mock-02',
    'house-ww-mock-03',
    'house-ww-mock-04',
    'house-ww-mock-05',
    'house-ww-mock-06',
    'house-ww-mock-07',
  ];

  it('drains seven house seats three per wake, re-arming at 500 ms, and never touches the real seat', async () => {
    const table = makeTable(octoGame, HANDLES);
    const storage = new MockStorage();
    const driver = new HouseDriver(storage, { keyring: KEYRING, adapterFor: alwaysIndexZero });

    expect(pendingHouseSeats(table.core)).toHaveLength(7);
    expect(await driver.arm(table.core, NOW)).toBe(NOW + HOUSE_MOVE_DELAY_MS);

    const droveByWake: number[] = [];
    let due = NOW + HOUSE_MOVE_DELAY_MS;
    for (let wake = 0; wake < 5 && due !== null; wake++) {
      const out = await driver.run(table.core, due);
      droveByWake.push(out.drove.length);
      if (out.nextDueAtMs !== null) expect(out.nextDueAtMs).toBe(due + HOUSE_RETRY_MS);
      due = out.nextDueAtMs as number;
    }

    expect(HOUSE_MOVES_PER_WAKE).toBe(3);
    expect(droveByWake).toEqual([3, 3, 1]);
    expect(pendingHouseSeats(table.core)).toHaveLength(0);
    expect(storage.data.has(KEY_HOUSE_DUE)).toBe(false);

    // The real seat still owes its move; the driver never signed for it, and
    // `gather` is simultaneous so nothing has been APPLIED yet.
    expect(table.core.waitingFor()).toEqual([playerId(0)]);
    expect(table.core.log.filter((e) => e.kind === 'move')).toHaveLength(0);

    // The real seat closes the phase: eight moves land, none of them forced.
    submitReal(table, playerId(0), 0);
    expect(table.core.log.filter((e) => e.kind === 'move')).toHaveLength(8);
    for (const s of table.seats) expect(table.core.strikes[s.player] ?? 0).toBe(0);
  });

  it('every house seat moves exactly once per phase across repeated wakes', async () => {
    const table = makeTable(octoGame, HANDLES);
    const driver = new HouseDriver(new MockStorage(), { keyring: KEYRING, adapterFor: alwaysIndexZero });

    const seen: PlayerId[] = [];
    for (let wake = 0; wake < 6; wake++) {
      const out = await driver.run(table.core, NOW + wake * HOUSE_RETRY_MS);
      for (const mark of out.drove) seen.push(mark.player);
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen).not.toContain(playerId(0));
  });
});

// ---------------------------------------------------------------------------
// The werewolf house agent
// ---------------------------------------------------------------------------

const WW_HANDLES = WEREWOLF_HOUSE_ROSTER.slice(6, 14); // the eight `mock` handles

function werewolfTable(gameId = 'game-ww-house'): Table {
  return makeTable(werewolf as unknown as AnyGame, WW_HANDLES, gameId);
}

/** A view whose `public` records every property read on it. */
function recordingView(view: ViewObject): { view: ViewObject; touched: Set<string> } {
  const touched = new Set<string>();
  const target = view.public as unknown as Record<string, unknown>;
  const proxied = new Proxy(target, {
    get(t, prop, recv) {
      if (typeof prop === 'string') touched.add(prop);
      return Reflect.get(t, prop, recv) as unknown;
    },
  });
  return { view: { ...view, public: proxied as unknown as Json }, touched };
}

describe('werewolf house agent', () => {
  it('NEVER dereferences public.transcript — the allow-list is the safety property', async () => {
    const table = werewolfTable();
    const allTouched = new Set<string>();
    for (const seat of table.seats) {
      const { view, touched } = recordingView(table.core.viewFor(seat.player, NOW));
      const agent = createWerewolfHouseAgent(seat.agent_id, table.core.gameId);
      await agent.chooseMove(view);
      for (const k of touched) allTouched.add(k);
    }
    // It read the ledger...
    expect(allTouched.has('phase')).toBe(true);
    expect(allTouched.has('alive')).toBe(true);
    // ...and never the largest agent-authored surface in the game.
    expect(allTouched.has('transcript')).toBe(false);
    expect([...allTouched].sort()).toEqual(
      ['alive', 'claims', 'day', 'dead', 'edges', 'nights', 'phase', 'reports', 'vote_history'].sort(),
    );
  });

  it('never reads history, private_messages or board_text either', async () => {
    const table = werewolfTable();
    const seat = table.seats[0]!;
    const base = table.core.viewFor(seat.player, NOW);
    const poisoned: ViewObject = {
      ...base,
      // Anything the agent read from these would show up as a crash, because
      // there is nothing here of the shape it could use.
      history: null as unknown as ViewObject['history'],
      board_text: null as unknown as string,
      state_string: null as unknown as string,
      private_messages: null as unknown as ViewObject['private_messages'],
    };
    const agent = createWerewolfHouseAgent(seat.agent_id, table.core.gameId);
    await expect(agent.chooseMove(poisoned)).resolves.toBeDefined();
  });

  it('answers with a legal index and an utterance inside the phase cap, in every phase', async () => {
    const table = werewolfTable();
    const driver = new HouseDriver(new MockStorage(), { keyring: KEYRING });
    const phases = new Set<string>();

    for (let wake = 0; wake < 200 && table.core.status === 'running'; wake++) {
      for (const seat of table.core.waitingFor()) {
        const view = table.core.viewFor(seat, NOW);
        phases.add(view.phase);
        const agent = createWerewolfHouseAgent(`probe-${seat}`, table.core.gameId);
        const sub = await agent.chooseMove(view);
        const index = (sub.move as { index: number }).index;
        expect(view.legal_moves.some((e) => e.index === index)).toBe(true);
        if (sub.utterance !== undefined) {
          expect(sub.utterance.length).toBeLessThanOrEqual(view.speech!.limit);
          expect(sub.utterance.length).toBeGreaterThan(0);
        }
      }
      const out = await driver.run(table.core, NOW + wake * HOUSE_RETRY_MS);
      if (out.drove.length === 0) break;
    }

    expect(table.core.status).toBe('ended');
    expect([...phases].sort()).toEqual(['day_defense', 'day_talk', 'day_vote', 'night']);
  });

  it('an all-house werewolf table plays to a result with no rejection and no strike', async () => {
    const table = werewolfTable('game-ww-full');
    const rejected: string[] = [];
    const driver = new HouseDriver(new MockStorage(), {
      keyring: KEYRING,
      onError: (kind) => rejected.push(kind),
    });

    for (let wake = 0; wake < 400 && table.core.status === 'running'; wake++) {
      const out = await driver.run(table.core, NOW + wake * HOUSE_RETRY_MS);
      if (out.drove.length === 0) break;
    }

    expect(rejected).toEqual([]);
    expect(table.core.status).toBe('ended');
    expect(table.core.result).not.toBeNull();
    for (const seat of table.seats) expect(table.core.strikes[seat.player] ?? 0).toBe(0);
    // Words were actually spoken: a mute table would ship an empty transcript.
    const spoke = table.core.log.filter((e) => {
      const p = e.payload as unknown as { notation?: unknown };
      return typeof p.notation === 'string' && p.notation.includes('"');
    });
    expect(spoke.length).toBeGreaterThan(0);
  });

  it('is deterministic in (agent_id, game_id) and the silent tier is index 0, always', async () => {
    const table = werewolfTable();
    const seat = table.seats[0]!;
    const view = table.core.viewFor(seat.player, NOW);

    const a = await createWerewolfHouseAgent('a1', 'g1').chooseMove(view);
    const b = await createWerewolfHouseAgent('a1', 'g1').chooseMove(view);
    expect(b).toEqual(a);

    const silent = await createWerewolfHouseAgent('a1', 'g1', 'silent').chooseMove(view);
    expect(silent.move).toEqual({ index: 0 });
    expect(silent.utterance).toBeUndefined();
  });
});
