/**
 * RED TEAM red-team-liveness — attack family 3: starve a lobby.
 *
 * Targets src/match/lobby.ts + src/match/pairing.ts + the lobby API
 * (spec §matchmaking_and_ratings.lobbies/house_agents/quotas):
 *   - join/leave churn: no duplicate rows, leave spends nothing, every
 *     successful join spends exactly one;
 *   - a lone agent must be house-backfilled once it has waited 2 sweeps
 *     (frozen policy: backfillAfterSweeps = 2, i.e. the 3rd sweep at latest);
 *   - two agents of one operator must NEVER be paired together, and with
 *     house backfill they must both still get games;
 *   - rating-band isolation cannot permanently starve an outlier: bands
 *     widen every sweep and are unbounded after 5 waited sweeps.
 *
 * The pairer fakes mirror src/match/tests/pairing.test.ts idioms (that file
 * does not export them). Deterministic secrets via testSecretProvider.
 */

import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../../src/api/router.ts';
import { utcDay } from '../../src/api/quota.ts';
import { makeTestEnv, type TestEnv } from '../../src/api/tests/fakes.ts';
import { apiRequest, envelope, insertAgent, insertHomologation, signedHeaders, type TestAgent } from '../../src/api/tests/helpers.ts';
import { MemoryLobbyRepo, lobbyEntryKey, type LobbyRow } from '../../src/match/lobby.ts';
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
} from '../../src/match/pairing.ts';

// ---------------------------------------------------------------------------
// Pairer fakes
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
    secrets: testSecretProvider('redteam-liveness-lobby'),
    factory,
    ...overrides,
  };
  return { cfg, factory };
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
// API-level churn helpers (reuse T7 test idioms)
// ---------------------------------------------------------------------------

async function lobbyPost(env: TestEnv, agent: TestAgent, op: 'join' | 'leave', body: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify(body);
  const path = `/api/lobby/${op}`;
  const headers = { ...(await signedHeaders(env, agent, 'POST', path, raw)), 'content-type': 'application/json' };
  return handleApiRequest(env, apiRequest('POST', path, { headers, body: raw }));
}

function joinsSpent(env: TestEnv, agent: TestAgent): number {
  const r = env.db.db.prepare('SELECT joins FROM quotas WHERE agent_id = ? AND day = ?').get(agent.agentId, utcDay(env.clock.ms)) as
    | { joins: number }
    | undefined;
  return r ? Number(r.joins) : 0;
}

function lobbyRows(env: TestEnv): { agent_id: string }[] {
  return env.db.db.prepare('SELECT agent_id FROM lobby').all() as { agent_id: string }[];
}

// ---------------------------------------------------------------------------
// 1. Join / leave / rejoin churn
// ---------------------------------------------------------------------------

describe('lobby churn via the API', () => {
  it('join→dup→leave→leave→rejoin: no duplicate rows, leave spends nothing, each successful join spends one', { timeout: 600_000 }, async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'churner');
    insertHomologation(env, agent, 'open');
    const body = { game: 'toy', variant: 'standard', division: 'open' };

    // Join: one row, one spend.
    expect((await lobbyPost(env, agent, 'join', body)).status).toBe(201);
    expect(lobbyRows(env)).toHaveLength(1);
    expect(joinsSpent(env, agent)).toBe(1);

    // Duplicate join: rejected, no second row, nothing spent.
    const dup = await lobbyPost(env, agent, 'join', body);
    expect(dup.status).toBe(409);
    expect((await envelope(dup)).error?.code).toBe('ALREADY_IN_LOBBY');
    expect(lobbyRows(env)).toHaveLength(1);
    expect(joinsSpent(env, agent)).toBe(1);

    // Leave: row gone, quota untouched (no refund, no charge).
    expect((await lobbyPost(env, agent, 'leave', body)).status).toBe(200);
    expect(lobbyRows(env)).toHaveLength(0);
    expect(joinsSpent(env, agent)).toBe(1);

    // Leaving again: 404, still nothing spent.
    expect((await lobbyPost(env, agent, 'leave', body)).status).toBe(404);
    expect(joinsSpent(env, agent)).toBe(1);

    // Rejoin: a fresh join, spends one more (churn cannot mint free joins).
    expect((await lobbyPost(env, agent, 'join', body)).status).toBe(201);
    expect(lobbyRows(env)).toHaveLength(1);
    expect(joinsSpent(env, agent)).toBe(2);

    // 20 more churn cycles never create duplicate rows.
    for (let i = 0; i < 20; i++) {
      await lobbyPost(env, agent, 'leave', body);
      await lobbyPost(env, agent, 'join', body);
      expect(lobbyRows(env)).toHaveLength(1);
    }
    expect(joinsSpent(env, agent)).toBe(22);
  });

  it('MemoryLobbyRepo churn: rejoin after leave is a fresh row, double-join stays idempotent', async () => {
    const lobby = new MemoryLobbyRepo();
    const key = { game: 'chess', variant: '{}', division: 'pure' as const, agent_id: 'a' };
    expect(await lobby.join(row('a', '2026-09-01T00:00:00Z'))).toBe('joined');
    expect(await lobby.join(row('a', '2026-09-01T00:00:05Z'))).toBe('already');
    expect(await lobby.list()).toHaveLength(1);
    expect(await lobby.leave(key)).toBe(true);
    expect(await lobby.leave(key)).toBe(false);
    expect(await lobby.join(row('a', '2026-09-01T00:00:10Z'))).toBe('joined');
    expect(await lobby.list()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Lone agent: house backfill must arrive after 2 waited sweeps
// ---------------------------------------------------------------------------

describe('house backfill rescues a lone agent', () => {
  it('no game on sweeps 1-2, a house-filled game on sweep 3 — never later', { timeout: 600_000 }, async () => {
    const house: HouseAgent[] = [
      { agent_id: 'house-random-1', kind: 'random' },
      { agent_id: 'house-random-2', kind: 'random' },
    ];
    const lobby = await lobbyWith([row('solo', '2026-09-01T00:00:00Z')]);
    const { cfg, factory } = makeCfg({ solo: {} }, { houseAgents: { available: () => house } });

    let state: PairerState = initialPairerState();
    const gamesAtSweep: number[] = [];
    for (let sweep = 1; sweep <= 3; sweep++) {
      const out = await runPairingSweep(lobby, state, cfg);
      state = out.state;
      gamesAtSweep.push(factory.commands.length);
    }
    // Waited 0, then 1 -> nothing; waited 2 -> backfilled. That is the bound.
    expect(gamesAtSweep).toEqual([0, 0, 1]);
    const seats = factory.commands[0]!.seats;
    expect(seats).toHaveLength(2);
    expect(seats).toContain('solo');
    expect(seats.some((s) => s.startsWith('house-'))).toBe(true);
    expect(await lobby.list()).toHaveLength(0); // matched entry removed
    expect(state.sweeps[lobbyEntryKey({ game: 'chess', variant: '{}', division: 'pure', agent_id: 'solo' })]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Operator conflict: never paired together, both still get games
// ---------------------------------------------------------------------------

describe('operator-conflict lobby (two agents, one operator)', () => {
  it('they are never seated together across sweeps, and house backfill gives BOTH a game by sweep 3', { timeout: 600_000 }, async () => {
    const house: HouseAgent[] = [
      { agent_id: 'house-random-1', kind: 'random' },
      { agent_id: 'house-random-2', kind: 'random' },
    ];
    const lobby = await lobbyWith([
      row('twin-a', '2026-09-01T00:00:00Z'),
      row('twin-b', '2026-09-01T00:00:01Z'),
    ]);
    const { cfg, factory } = makeCfg(
      {
        'twin-a': { operator_id: 'op-shared', rating: 1500 },
        'twin-b': { operator_id: 'op-shared', rating: 1500 },
      },
      { houseAgents: { available: () => house } },
    );

    let state: PairerState = initialPairerState();
    for (let sweep = 1; sweep <= 3; sweep++) {
      const out = await runPairingSweep(lobby, state, cfg);
      state = out.state;
      // INVARIANT after every sweep: no created game seats both twins.
      for (const cmd of factory.commands) {
        const both = cmd.seats.includes('twin-a') && cmd.seats.includes('twin-b');
        expect(both, `sweep ${sweep} paired two agents of one operator: ${JSON.stringify(cmd.seats)}`).toBe(false);
      }
    }

    // By sweep 3 (waited 2) both twins are in (separate) house-filled games.
    expect(factory.commands).toHaveLength(2);
    const seatedTwins = factory.commands.flatMap((c) => c.seats.filter((s) => s.startsWith('twin-')));
    expect(seatedTwins.sort()).toEqual(['twin-a', 'twin-b']);
    for (const cmd of factory.commands) {
      expect(cmd.seats.filter((s) => s.startsWith('house-'))).toHaveLength(1);
    }
    expect(await lobby.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Rating-band isolation cannot starve an outlier forever
// ---------------------------------------------------------------------------

describe('rating outlier starvation', () => {
  it('a 2900-point gap pairs on sweep 6 via the unbounded band (no house help)', { timeout: 600_000 }, async () => {
    // Band = 150 + 100*waited, unbounded once waited >= 5. A bounded band
    // would need 28 sweeps for a 2900 gap; the unbounded rule must cut in
    // first. House backfill is disabled to isolate the band rule.
    const lobby = await lobbyWith([row('newbie', '2026-09-01T00:00:00Z'), row('goliath', '2026-09-01T00:00:01Z')]);
    const { cfg, factory } = makeCfg(
      { newbie: { rating: 100 }, goliath: { rating: 3000 } },
      { backfillAfterSweeps: 99 },
    );

    let state: PairerState = initialPairerState();
    const formedAtSweep: number[] = [];
    for (let sweep = 1; sweep <= 6; sweep++) {
      const before = factory.commands.length;
      const out = await runPairingSweep(lobby, state, cfg);
      state = out.state;
      if (factory.commands.length > before) formedAtSweep.push(sweep);
    }
    expect(formedAtSweep).toEqual([6]);
    expect([...factory.commands[0]!.seats].sort()).toEqual(['goliath', 'newbie']);
    expect(await lobby.list()).toHaveLength(0);
  });

  it('with house agents available the outlier is rescued earlier, on sweep 3', { timeout: 600_000 }, async () => {
    const house: HouseAgent[] = [
      { agent_id: 'house-random-1', kind: 'random' },
      { agent_id: 'house-random-2', kind: 'random' },
    ];
    const lobby = await lobbyWith([row('newbie', '2026-09-01T00:00:00Z'), row('goliath', '2026-09-01T00:00:01Z')]);
    const { cfg, factory } = makeCfg(
      { newbie: { rating: 100 }, goliath: { rating: 3000 } },
      { houseAgents: { available: () => house } },
    );

    let state: PairerState = initialPairerState();
    for (let sweep = 1; sweep <= 3; sweep++) {
      const out = await runPairingSweep(lobby, state, cfg);
      state = out.state;
    }
    // Both outliers get separate house games; they are still not band-compatible.
    expect(factory.commands).toHaveLength(2);
    for (const cmd of factory.commands) {
      expect(cmd.seats.some((s) => s.startsWith('house-'))).toBe(true);
      expect(cmd.seats.includes('newbie') && cmd.seats.includes('goliath')).toBe(false);
    }
    expect(await lobby.list()).toHaveLength(0);
  });
});
