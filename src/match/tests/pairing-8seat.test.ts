/**
 * Eight-seat pairing and the house roster (plan §8.1, §8.2).
 *
 * The four bugs eight seats expose, each with its own block:
 *  1. roster leakage into every other queue (D-5),
 *  2. cross-table duplication inside one sweep,
 *  3. invisible starvation,
 *  4. unbounded house concurrency.
 *
 * A lone werewolf entrant needs SEVEN distinct house agents, so every one of
 * these is the difference between a table forming and a queue that waits
 * forever with nothing recorded.
 */

import { describe, expect, it } from 'vitest';
import { MemoryLobbyRepo, lobbyEntryKey, type LobbyRow } from '../lobby.ts';
import {
  eligibleHouseAgents,
  houseAgentsFromRows,
  runPairingSweep,
  testSecretProvider,
  type CreateGameCommand,
  type GameFactory,
  type HouseAgent,
  type PairerConfig,
  type PairerState,
  type PairingAgentInfo,
} from '../pairing.ts';
import { WEREWOLF_HOUSE_ROSTER } from '../../api/house.ts';

const SEATS = 8;

class FakeFactory implements GameFactory {
  readonly commands: CreateGameCommand[] = [];
  async createGame(cmd: CreateGameCommand): Promise<string> {
    this.commands.push(cmd);
    return `g${this.commands.length}`;
  }
}

/** The 18 `mock` handles are the pool that actually backfills (anthropic is dropped). */
const WW_MOCK = WEREWOLF_HOUSE_ROSTER.filter((h) => h.includes('mock'));

function wwPool(count = 8, load = 0): HouseAgent[] {
  return WW_MOCK.slice(0, count).map((h) => ({ agent_id: h, kind: 'mock' as const, roster: 'ww', load }));
}

function generalPool(count = 8): HouseAgent[] {
  return Array.from({ length: count }, (_, i) => ({
    agent_id: `house-random-${i}`,
    kind: 'random' as const,
    roster: null,
    load: 0,
  }));
}

function makeCfg(
  realAgents: readonly string[],
  overrides: Partial<PairerConfig> = {},
): { cfg: PairerConfig; factory: FakeFactory } {
  const factory = new FakeFactory();
  const cfg: PairerConfig = {
    seatsFor: () => SEATS,
    // eslint-disable-next-line @typescript-eslint/require-await
    info: async (ids) => {
      const out = new Map<string, PairingAgentInfo>();
      for (const id of ids) {
        if (!realAgents.includes(id)) continue;
        out.set(id, { agent_id: id, operator_id: `op-${id}`, rating: 1500, house: false });
      }
      return out;
    },
    houseAgents: { available: () => [] },
    secrets: testSecretProvider('pairing-8seat'),
    factory,
    ...overrides,
  };
  return { cfg, factory };
}

function row(agent_id: string, joined_at: string, game = 'werewolf', division: 'pure' | 'open' = 'pure'): LobbyRow {
  return { game, variant: '{}', division, agent_id, joined_at };
}

function key(agent_id: string, game = 'werewolf', division: 'pure' | 'open' = 'pure'): string {
  return lobbyEntryKey({ game, variant: '{}', division, agent_id });
}

async function lobbyWith(rows: LobbyRow[]): Promise<MemoryLobbyRepo> {
  const lobby = new MemoryLobbyRepo();
  for (const r of rows) await lobby.join(r);
  return lobby;
}

// ---------------------------------------------------------------------------

describe('8-seat werewolf tables', () => {
  it('a lone entrant is backfilled to exactly eight seats with seven house agents', async () => {
    const lobby = await lobbyWith([row('solo', '2026-09-01T00:00:00Z')]);
    const { cfg, factory } = makeCfg(['solo'], { houseAgents: { available: () => wwPool(10) } });
    const state: PairerState = { sweeps: { [key('solo')]: 2 } };

    const out = await runPairingSweep(lobby, state, cfg);

    expect(out.created).toHaveLength(1);
    const seats = factory.commands[0]!.seats;
    expect(seats).toHaveLength(SEATS);
    expect(seats).toContain('solo');
    expect(seats.filter((s) => s.startsWith('house-ww-'))).toHaveLength(7);
    expect(new Set(seats).size).toBe(SEATS);
    expect(await lobby.list()).toHaveLength(0);
    expect(out.starved).toEqual([]);
  });

  it('two real entrants share one table rather than forming two starved ones', async () => {
    const lobby = await lobbyWith([
      row('a', '2026-09-01T00:00:00Z'),
      row('b', '2026-09-01T00:00:01Z'),
    ]);
    const { cfg, factory } = makeCfg(['a', 'b'], { houseAgents: { available: () => wwPool(10) } });
    const state: PairerState = { sweeps: { [key('a')]: 2, [key('b')]: 2 } };

    await runPairingSweep(lobby, state, cfg);

    expect(factory.commands).toHaveLength(1);
    const seats = factory.commands[0]!.seats;
    expect(seats).toHaveLength(SEATS);
    expect(seats).toContain('a');
    expect(seats).toContain('b');
    expect(seats.filter((s) => s.startsWith('house-ww-'))).toHaveLength(6);
  });
});

describe('bug 1: the roster never leaks into another queue (D-5)', () => {
  it('werewolf house agents are invisible to a chess queue', () => {
    const pool = [...wwPool(10), ...generalPool(3)];
    const forChess = eligibleHouseAgents(pool, 'chess');
    expect(forChess.map((h) => h.agent_id).every((id) => id.startsWith('house-random-'))).toBe(true);
    expect(forChess).toHaveLength(3);
  });

  it('the general pool is invisible to werewolf: `random` must never take a seat there', () => {
    const pool = [...wwPool(10), ...generalPool(3)];
    const forWerewolf = eligibleHouseAgents(pool, 'werewolf');
    expect(forWerewolf.map((h) => h.agent_id).every((id) => id.startsWith('house-ww-'))).toBe(true);
    expect(forWerewolf).toHaveLength(10);
  });

  it('seeding 24 werewolf handles does not switch backfill on for a 2-seat queue', async () => {
    const lobby = await lobbyWith([row('solo', '2026-09-01T00:00:00Z', 'chess')]);
    const { cfg, factory } = makeCfg(['solo'], {
      seatsFor: () => 2,
      houseAgents: { available: () => wwPool(18) },
    });
    const state: PairerState = { sweeps: { [key('solo', 'chess')]: 3 } };

    const out = await runPairingSweep(lobby, state, cfg);

    expect(factory.commands).toHaveLength(0);
    expect(await lobby.list()).toHaveLength(1);
    expect(out.starved).toEqual([
      { game: 'chess', variant: '{}', division: 'pure', need: 1, available: 0 },
    ]);
  });

  it('house rows: anthropic is dropped, and rostered rows vanish when the keys are absent', () => {
    const rows = [
      { id: 'a1', handle: 'house-ww-anthropic-01' },
      { id: 'a2', handle: 'house-ww-mock-01', live_games: 2 },
      { id: 'a3', handle: 'house-random-1' },
    ];
    const keyed = houseAgentsFromRows(rows, { keysConfigured: true });
    expect(keyed).toEqual([
      { agent_id: 'a2', kind: 'mock', roster: 'ww', load: 2 },
      { agent_id: 'a3', kind: 'random', roster: null, load: 0 },
    ]);

    // No HOUSE_SK_SEED: seating a rostered agent would form a table whose house
    // seats could never sign, so the whole roster disappears.
    expect(houseAgentsFromRows(rows, { keysConfigured: false })).toEqual([
      { agent_id: 'a3', kind: 'random', roster: null, load: 0 },
    ]);
  });

  it('unkeyed: a lone werewolf entrant forms no table at all and the starvation is recorded', async () => {
    const rows = WW_MOCK.map((h, i) => ({ id: `id-${i}`, handle: h }));
    const pool = houseAgentsFromRows(rows, { keysConfigured: false });
    const lobby = await lobbyWith([row('solo', '2026-09-01T00:00:00Z')]);
    const { cfg, factory } = makeCfg(['solo'], { houseAgents: { available: () => pool } });

    const out = await runPairingSweep(lobby, { sweeps: { [key('solo')]: 3 } }, cfg);

    expect(factory.commands).toHaveLength(0);
    expect(out.starved).toEqual([
      { game: 'werewolf', variant: '{}', division: 'pure', need: 7, available: 0 },
    ]);
    expect(out.state.sweeps[key('solo')]).toBe(4);
  });
});

describe('bug 2: no house agent is seated twice by one sweep', () => {
  it('two anchors backfilled in the same sweep draw disjoint house seats', async () => {
    const lobby = await lobbyWith([
      row('solo1', '2026-09-01T00:00:00Z'),
      // A second werewolf queue (same roster, different division) so the two
      // anchors cannot be grouped into one table.
      row('solo2', '2026-09-01T00:00:01Z', 'werewolf', 'open'),
    ]);
    const { cfg, factory } = makeCfg(['solo1', 'solo2'], { houseAgents: { available: () => wwPool(18) } });
    const state: PairerState = {
      sweeps: { [key('solo1')]: 2, [key('solo2', 'werewolf', 'open')]: 2 },
    };

    await runPairingSweep(lobby, state, { ...cfg, houseConcurrency: 99 });

    expect(factory.commands).toHaveLength(2);
    const [first, second] = factory.commands.map((c) => c.seats.filter((s) => s.startsWith('house-ww-')));
    expect(first).toHaveLength(7);
    expect(second).toHaveLength(7);
    expect(first!.filter((s) => second!.includes(s))).toEqual([]);
  });
});

describe('bug 3+4: least-loaded fill under a concurrency cap', () => {
  it('picks the least-loaded agents, not a random slice', async () => {
    // 8 agents; the two most loaded must be the two left out.
    const pool: HouseAgent[] = WW_MOCK.slice(0, 9).map((h, i) => ({
      agent_id: h,
      kind: 'mock',
      roster: 'ww',
      load: i >= 7 ? 1 : 0,
    }));
    const lobby = await lobbyWith([row('solo', '2026-09-01T00:00:00Z')]);
    const { cfg, factory } = makeCfg(['solo'], { houseAgents: { available: () => pool }, houseConcurrency: 9 });

    await runPairingSweep(lobby, { sweeps: { [key('solo')]: 2 } }, cfg);

    const seated = factory.commands[0]!.seats.filter((s) => s.startsWith('house-ww-')).sort();
    expect(seated).toEqual(WW_MOCK.slice(0, 7).slice().sort());
  });

  it('an agent at the concurrency cap is not eligible at all', () => {
    const pool: HouseAgent[] = [
      { agent_id: 'h1', kind: 'mock', roster: 'ww', load: 2 },
      { agent_id: 'h2', kind: 'mock', roster: 'ww', load: 1 },
      { agent_id: 'h3', kind: 'mock', roster: 'ww', load: 0 },
    ];
    expect(eligibleHouseAgents(pool, 'werewolf', { concurrency: 2 }).map((h) => h.agent_id)).toEqual(['h2', 'h3']);
    // Seats handed out earlier in the same sweep count towards the cap.
    const inSweep = new Map([['h2', 1]]);
    expect(eligibleHouseAgents(pool, 'werewolf', { concurrency: 2, inSweep }).map((h) => h.agent_id)).toEqual(['h3']);
  });

  it('the cap can starve a second table in the same sweep, and it is recorded', async () => {
    // 7 agents at load 1 with a cap of 2: enough for one table, not two.
    const pool: HouseAgent[] = WW_MOCK.slice(0, 7).map((h) => ({
      agent_id: h,
      kind: 'mock',
      roster: 'ww',
      load: 1,
    }));
    const lobby = await lobbyWith([
      row('solo1', '2026-09-01T00:00:00Z'),
      row('solo2', '2026-09-01T00:00:01Z', 'werewolf', 'open'),
    ]);
    const { cfg, factory } = makeCfg(['solo1', 'solo2'], { houseAgents: { available: () => pool } });
    const state: PairerState = {
      sweeps: { [key('solo1')]: 2, [key('solo2', 'werewolf', 'open')]: 2 },
    };

    const out = await runPairingSweep(lobby, state, cfg);

    // Queues are swept in sorted key order, so 'open' forms and 'pure' starves.
    expect(factory.commands).toHaveLength(1);
    expect(out.starved).toEqual([
      { game: 'werewolf', variant: '{}', division: 'pure', need: 7, available: 0 },
    ]);
  });
});
