import { describe, expect, it } from 'vitest';
import { MemoryLobbyRepo, lobbyEntryKey, type LobbyRow } from '../lobby.ts';
import {
  initialPairerState,
  runPairingSweep,
  testSecretProvider,
  type CreateGameCommand,
  type GameFactory,
  type HouseAgent,
  type PairerConfig,
  type PairerState,
  type PairingAgentInfo,
} from '../pairing.ts';

// ---------------------------------------------------------------------------
// In-memory fakes (not coupled to any other track's fakes)
// ---------------------------------------------------------------------------

class FakeFactory implements GameFactory {
  readonly commands: CreateGameCommand[] = [];
  async createGame(cmd: CreateGameCommand): Promise<string> {
    this.commands.push(cmd);
    return `g${this.commands.length}`;
  }
}

interface AgentSpec {
  operator_id?: string;
  rating?: number;
  house?: boolean;
}

function makeCfg(
  agents: Record<string, AgentSpec>,
  overrides: Partial<PairerConfig> = {},
): { cfg: PairerConfig; factory: FakeFactory } {
  const factory = new FakeFactory();
  const cfg: PairerConfig = {
    seatsFor: () => 2,
    info: async (ids) => {
      const out = new Map<string, PairingAgentInfo>();
      for (const id of ids) {
        const spec = agents[id];
        if (!spec) continue;
        out.set(id, {
          agent_id: id,
          operator_id: spec.operator_id ?? `op-${id}`,
          rating: spec.rating ?? 1500,
          house: spec.house ?? false,
        });
      }
      return out;
    },
    houseAgents: { available: () => [] },
    secrets: testSecretProvider('pairing-test'),
    factory,
    ...overrides,
  };
  return { cfg, factory };
}

function key(agent_id: string, game = 'chess', division: 'pure' | 'open' = 'pure'): string {
  return lobbyEntryKey({ game, variant: '{}', division, agent_id });
}

function row(agent_id: string, joined_at: string, game = 'chess'): LobbyRow {
  return { game, variant: '{}', division: 'pure', agent_id, joined_at };
}

async function lobbyWith(rows: LobbyRow[]): Promise<MemoryLobbyRepo> {
  const lobby = new MemoryLobbyRepo();
  for (const r of rows) await lobby.join(r);
  return lobby;
}

// ---------------------------------------------------------------------------

describe('lobby repo', () => {
  it('join is idempotent, leave removes', async () => {
    const lobby = new MemoryLobbyRepo();
    expect(await lobby.join(row('a', '2026-09-01T00:00:00Z'))).toBe('joined');
    expect(await lobby.join(row('a', '2026-09-01T00:00:01Z'))).toBe('already');
    expect((await lobby.list())).toHaveLength(1);
    expect(await lobby.leave({ game: 'chess', variant: '{}', division: 'pure', agent_id: 'a' })).toBe(true);
    expect(await lobby.leave({ game: 'chess', variant: '{}', division: 'pure', agent_id: 'a' })).toBe(false);
    expect(await lobby.list()).toHaveLength(0);
  });
});

describe('pairing sweep', () => {
  it('forms a game when enough compatible seats and removes the entries', async () => {
    const lobby = await lobbyWith([row('a', '2026-09-01T00:00:00Z'), row('b', '2026-09-01T00:00:01Z')]);
    const { cfg, factory } = makeCfg({ a: { rating: 1500 }, b: { rating: 1550 } });
    const out = await runPairingSweep(lobby, initialPairerState(), cfg);

    expect(out.created).toHaveLength(1);
    const cmd = factory.commands[0]!;
    expect(cmd.game).toBe('chess');
    expect(cmd.variant).toBe('{}');
    expect(cmd.division).toBe('pure');
    expect([...cmd.seats].sort()).toEqual(['a', 'b']);
    expect(await lobby.list()).toHaveLength(0);
    expect(Object.keys(out.state.sweeps)).toHaveLength(0);
  });

  it('seat order is a seeded shuffle: deterministic for a fixed secret provider', async () => {
    const seats: string[][] = [];
    for (let run = 0; run < 2; run++) {
      const lobby = await lobbyWith([
        row('a', '2026-09-01T00:00:00Z'),
        row('b', '2026-09-01T00:00:01Z'),
      ]);
      const { cfg, factory } = makeCfg({ a: {}, b: {} });
      await runPairingSweep(lobby, initialPairerState(), cfg);
      seats.push(factory.commands[0]!.seats);
    }
    expect(seats[0]).toEqual(seats[1]);
  });

  it('never seats two agents of the same operator in one game', async () => {
    const lobby = await lobbyWith([
      row('a1', '2026-09-01T00:00:00Z'),
      row('a2', '2026-09-01T00:00:01Z'),
      row('b1', '2026-09-01T00:00:02Z'),
    ]);
    const { cfg, factory } = makeCfg({
      a1: { operator_id: 'opA' },
      a2: { operator_id: 'opA' },
      b1: { operator_id: 'opB' },
    });
    const out = await runPairingSweep(lobby, initialPairerState(), cfg);
    expect(out.created).toHaveLength(1);
    // a1 (oldest) pairs with b1; a2 blocked by operator rule.
    expect([...factory.commands[0]!.seats].sort()).toEqual(['a1', 'b1']);
    expect((await lobby.list()).map((r) => r.agent_id)).toEqual(['a2']);
    expect(out.state.sweeps[key('a2')]).toBe(1);
  });

  it('respects rating bands: 400-point gap does not pair on the first sweep', async () => {
    const lobby = await lobbyWith([row('lo', '2026-09-01T00:00:00Z'), row('hi', '2026-09-01T00:00:01Z')]);
    const { cfg, factory } = makeCfg({ lo: { rating: 1200 }, hi: { rating: 1600 } });
    const out = await runPairingSweep(lobby, initialPairerState(), cfg);
    expect(factory.commands).toHaveLength(0);
    expect(out.state.sweeps[key('lo')]).toBe(1);
    expect(out.state.sweeps[key('hi')]).toBe(1);
  });

  it('bands widen by 100 per waited sweep until the gap fits (mutual acceptance)', async () => {
    // gap = 400; band after w sweeps = 150 + 100w -> fits when both have waited 3.
    const agents = { lo: { rating: 1200 }, hi: { rating: 1600 } };
    let state: PairerState = initialPairerState();
    const lobby = await lobbyWith([row('lo', '2026-09-01T00:00:00Z'), row('hi', '2026-09-01T00:00:01Z')]);
    const formedAtSweep: number[] = [];
    for (let sweep = 1; sweep <= 5; sweep++) {
      const { cfg, factory } = makeCfg(agents, { houseAgents: { available: () => [] } });
      const out = await runPairingSweep(lobby, state, cfg);
      state = out.state;
      if (factory.commands.length > 0) formedAtSweep.push(sweep);
    }
    // sweeps 1..3: waited 0,1,2 -> bands 150,250,350 < 400. sweep 4: waited 3 -> 450 >= 400.
    expect(formedAtSweep).toEqual([4]);
  });

  it('band is unbounded after 5 waited sweeps', async () => {
    const lobby = await lobbyWith([row('lo', '2026-09-01T00:00:00Z'), row('hi', '2026-09-01T00:00:01Z')]);
    const { cfg, factory } = makeCfg(
      { lo: { rating: 100 }, hi: { rating: 3000 } },
      { backfillAfterSweeps: 99 }, // isolate the band rule from backfill
    );
    const state: PairerState = {
      sweeps: { [key('lo')]: 5, [key('hi')]: 5 },
    };
    await runPairingSweep(lobby, state, cfg);
    expect(factory.commands).toHaveLength(1);
  });

  it('backfills with house agents after an entry waits 2+ sweeps', async () => {
    const house: HouseAgent[] = [
      { agent_id: 'house-random-1', kind: 'random' },
      { agent_id: 'house-mock-1', kind: 'mock' },
    ];
    const lobby = await lobbyWith([row('solo', '2026-09-01T00:00:00Z')]);
    const { cfg, factory } = makeCfg({ solo: {} }, { houseAgents: { available: () => house } });

    // Sweep 1 and 2: waited 0 then 1 -> no backfill yet.
    let state = initialPairerState();
    let out = await runPairingSweep(lobby, state, cfg);
    expect(factory.commands).toHaveLength(0);
    out = await runPairingSweep(lobby, out.state, cfg);
    expect(factory.commands).toHaveLength(0);
    // Sweep 3: waited 2 -> backfilled.
    out = await runPairingSweep(lobby, out.state, cfg);
    expect(factory.commands).toHaveLength(1);
    const seats = factory.commands[0]!.seats;
    expect(seats).toHaveLength(2);
    expect(seats).toContain('solo');
    expect(seats.some((s) => s.startsWith('house-'))).toBe(true);
    expect(await lobby.list()).toHaveLength(0);
  });

  it('backfill fills multi-seat games and groups compatible waiting real agents first', async () => {
    const house: HouseAgent[] = [
      { agent_id: 'hr1', kind: 'random' },
      { agent_id: 'hr2', kind: 'random' },
      { agent_id: 'hm1', kind: 'mock' },
    ];
    const lobby = await lobbyWith([
      row('a', '2026-09-01T00:00:00Z', 'islanders'),
      row('b', '2026-09-01T00:00:01Z', 'islanders'),
    ]);
    const { cfg, factory } = makeCfg(
      { a: { rating: 1500 }, b: { rating: 1520 } },
      { seatsFor: () => 4, houseAgents: { available: () => house } },
    );
    const state: PairerState = {
      sweeps: { [key('a', 'islanders')]: 2, [key('b', 'islanders')]: 2 },
    };
    await runPairingSweep(lobby, state, cfg);
    expect(factory.commands).toHaveLength(1);
    const seats = factory.commands[0]!.seats;
    expect(seats).toHaveLength(4);
    expect(seats).toContain('a');
    expect(seats).toContain('b');
    expect(seats.filter((s) => ['hr1', 'hr2', 'hm1'].includes(s))).toHaveLength(2);
  });

  it('does not backfill when the provider cannot supply enough distinct house agents', async () => {
    const lobby = await lobbyWith([row('solo', '2026-09-01T00:00:00Z', 'islanders')]);
    const { cfg, factory } = makeCfg(
      { solo: {} },
      { seatsFor: () => 4, houseAgents: { available: () => [{ agent_id: 'hr1', kind: 'random' }] } },
    );
    const state: PairerState = { sweeps: { [key('solo', 'islanders')]: 3 } };
    const out = await runPairingSweep(lobby, state, cfg);
    expect(factory.commands).toHaveLength(0);
    expect(out.state.sweeps[key('solo', 'islanders')]).toBe(4);
  });

  it('house agents are exempt from the one-per-operator rule', async () => {
    const house: HouseAgent[] = [
      { agent_id: 'hr1', kind: 'random' },
      { agent_id: 'hr2', kind: 'random' },
      { agent_id: 'hr3', kind: 'random' },
    ];
    const lobby = await lobbyWith([row('solo', '2026-09-01T00:00:00Z', 'islanders')]);
    const { cfg, factory } = makeCfg(
      { solo: {} },
      { seatsFor: () => 4, houseAgents: { available: () => house } },
    );
    const state: PairerState = { sweeps: { [key('solo', 'islanders')]: 2 } };
    await runPairingSweep(lobby, state, cfg);
    // Three house agents (same house operator) seated together.
    expect(factory.commands[0]!.seats.filter((s) => s.startsWith('hr'))).toHaveLength(3);
  });

  it('queues are independent: different game/variant/division never mix', async () => {
    const lobby = await lobbyWith([
      row('a', '2026-09-01T00:00:00Z', 'chess'),
      row('b', '2026-09-01T00:00:01Z', 'reversi'),
      { game: 'chess', variant: '{}', division: 'open', agent_id: 'c', joined_at: '2026-09-01T00:00:02Z' },
    ]);
    const { cfg, factory } = makeCfg({ a: {}, b: {}, c: {} });
    const out = await runPairingSweep(lobby, initialPairerState(), cfg);
    expect(factory.commands).toHaveLength(0);
    expect(Object.keys(out.state.sweeps).sort()).toEqual(
      [key('c', 'chess', 'open'), key('a'), key('b', 'reversi')].sort(),
    );
  });

  it('drops sweep state for entries that left the lobby', async () => {
    const lobby = await lobbyWith([row('a', '2026-09-01T00:00:00Z')]);
    const state: PairerState = {
      sweeps: { [key('a')]: 1, [key('gone')]: 4 },
    };
    const { cfg } = makeCfg({ a: {} });
    const out = await runPairingSweep(lobby, state, cfg);
    expect(out.state.sweeps).toEqual({ [key('a')]: 2 });
  });

  it('forms multiple games in one sweep when the queue is deep', async () => {
    const rows: LobbyRow[] = [];
    const agents: Record<string, AgentSpec> = {};
    for (let i = 0; i < 6; i++) {
      const id = `a${i}`;
      rows.push(row(id, `2026-09-01T00:00:0${i}Z`));
      agents[id] = { rating: 1500 + i };
    }
    const lobby = await lobbyWith(rows);
    const { cfg, factory } = makeCfg(agents);
    await runPairingSweep(lobby, initialPairerState(), cfg);
    expect(factory.commands).toHaveLength(3);
    const seated = factory.commands.flatMap((c) => c.seats).sort();
    expect(seated).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
    expect(await lobby.list()).toHaveLength(0);
  });
});
