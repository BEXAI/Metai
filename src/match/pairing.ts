/**
 * The pairer (spec §matchmaking_and_ratings.lobbies, §identity_and_integrity
 * collusion: "Random pairing within rating bands; one agent per operator per
 * game"). Runs as a sweep (cron / alarm): forms games out of lobby queues and
 * emits create-game commands through a GameFactory.
 *
 * Policy (frozen for this build):
 *  - Rating band: a candidate accepts opponents within ±(150 + 100 * sweeps
 *    it has already waited); after 5 waited sweeps the band is unbounded.
 *    Two candidates are compatible when EACH accepts the other (mutual band).
 *  - One agent per operator per game. House agents are exempt (they share the
 *    house operator, and backfill / house-vs-house exhibition games require
 *    several of them in one game); the exemption is public in the docs.
 *  - Seat order is a seeded shuffle: each formed game draws a fresh 32-byte
 *    secret from the injectable SecretProvider, seed = sha256(secret bytes),
 *    seed purposes 'pairing:seats' (seat shuffle) and 'pairing:house'
 *    (house-agent pick). This secret is match-layer only — the game's own
 *    commit-reveal secret is drawn by the room/Worker, not here.
 *  - House backfill: an entry that has already waited 2+ sweeps gets its game
 *    filled with house agents (random baseline always present; mock/anthropic
 *    only when the HouseAgentProvider lists them).
 *
 * The pairer is deterministic given the lobby contents, PairerState, and the
 * SecretProvider — tests inject a fixed-seed provider.
 */

import { sha256Hex } from '../crypto/canonical.ts';
import { createSeedStream } from '../kernel/seed.ts';
import {
  lobbyEntryKey,
  queueKey,
  type Division,
  type LobbyKey,
  type LobbyRepo,
  type LobbyRow,
} from './lobby.ts';

// ---------------------------------------------------------------------------
// Injectable collaborators
// ---------------------------------------------------------------------------

export interface SecretProvider {
  /** 32 fresh random bytes. */
  secret(): Uint8Array;
}

/** Production provider: crypto.getRandomValues. */
export class CryptoSecretProvider implements SecretProvider {
  secret(): Uint8Array {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return b;
  }
}

/** Deterministic provider for tests: sha256 chain over a label. */
export function testSecretProvider(label: string): SecretProvider {
  let counter = 0;
  return {
    secret(): Uint8Array {
      const hex = sha256Hex(`test-secret:${label}:${counter++}`);
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return out;
    },
  };
}

export type HouseAgentKind = 'random' | 'mock' | 'anthropic';

export interface HouseAgent {
  agent_id: string;
  kind: HouseAgentKind;
}

export interface HouseAgentProvider {
  /**
   * Distinct house agents currently available for backfill. Must always
   * include at least the random-baseline agents so no lobby starves
   * (spec §matchmaking_and_ratings.house_agents); mock/anthropic appear per
   * availability (no ANTHROPIC_API_KEY => no anthropic entries).
   */
  available(): HouseAgent[];
}

export interface PairingAgentInfo {
  agent_id: string;
  operator_id: string;
  /** Current rating in this game/variant/division (DEFAULT 1500 when unrated). */
  rating: number;
  /** House agents are exempt from the one-per-operator rule. */
  house: boolean;
}

/** The create-game command (spec shape: { game, variant, division, seats }). */
export interface CreateGameCommand {
  game: string;
  /** Opaque variant key as stored in the lobby (see lobby.ts). */
  variant: string;
  division: Division;
  /** Agent ids in seat order (seat i -> playerId(i)). */
  seats: string[];
}

/**
 * Room creation goes through this interface. T7/T6 implement it against the
 * GameRoom Durable Object; tests use an in-memory fake. Returns the game id.
 */
export interface GameFactory {
  createGame(cmd: CreateGameCommand): Promise<string>;
}

export interface PairerConfig {
  /** Seats a game of this queue needs (from game meta / variant). */
  seatsFor(game: string, variant: string): number;
  /** Rating + operator lookup for lobby candidates. */
  info(agentIds: readonly string[], queue: { game: string; variant: string; division: Division }): Promise<Map<string, PairingAgentInfo>>;
  houseAgents: HouseAgentProvider;
  secrets: SecretProvider;
  factory: GameFactory;
  /** Band tuning (defaults are the frozen policy above). */
  baseBand?: number;
  bandStep?: number;
  unboundedAfterSweeps?: number;
  backfillAfterSweeps?: number;
}

const DEFAULTS = {
  baseBand: 150,
  bandStep: 100,
  unboundedAfterSweeps: 5,
  backfillAfterSweeps: 2,
} as const;

// ---------------------------------------------------------------------------
// Pairer state (serializable — lives in the scheduling DO / cron storage)
// ---------------------------------------------------------------------------

export interface PairerState {
  /** lobbyEntryKey -> completed sweeps this entry has waited unmatched. */
  sweeps: Record<string, number>;
}

export function initialPairerState(): PairerState {
  return { sweeps: {} };
}

export interface SweepOutcome {
  created: { game_id: string; command: CreateGameCommand }[];
  state: PairerState;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

interface Candidate {
  row: LobbyRow;
  info: PairingAgentInfo;
  sweeps: number;
  band: number;
}

function compatible(a: Candidate, b: Candidate): boolean {
  const gap = Math.abs(a.info.rating - b.info.rating);
  return gap <= a.band && gap <= b.band;
}

function operatorClash(group: readonly Candidate[], next: Candidate): boolean {
  if (next.info.house) return false;
  return group.some((g) => !g.info.house && g.info.operator_id === next.info.operator_id);
}

/**
 * One pairing sweep over every queue. Matched entries are removed from the
 * lobby; unmatched entries have their sweep count incremented in the returned
 * state (stale state keys for entries no longer in the lobby are dropped).
 */
export async function runPairingSweep(
  lobby: LobbyRepo,
  state: PairerState,
  cfg: PairerConfig,
): Promise<SweepOutcome> {
  const baseBand = cfg.baseBand ?? DEFAULTS.baseBand;
  const bandStep = cfg.bandStep ?? DEFAULTS.bandStep;
  const unboundedAfter = cfg.unboundedAfterSweeps ?? DEFAULTS.unboundedAfterSweeps;
  const backfillAfter = cfg.backfillAfterSweeps ?? DEFAULTS.backfillAfterSweeps;

  const rows = await lobby.list();

  // Group by queue.
  const queues = new Map<string, LobbyRow[]>();
  for (const row of rows) {
    const qk = queueKey(row);
    const q = queues.get(qk);
    if (q) q.push(row);
    else queues.set(qk, [row]);
  }

  const created: { game_id: string; command: CreateGameCommand }[] = [];
  const matchedKeys: LobbyKey[] = [];
  const nextSweeps: Record<string, number> = {};

  // Deterministic queue order.
  const queueKeys = [...queues.keys()].sort();
  for (const qk of queueKeys) {
    const queueRows = queues.get(qk)!;
    const first = queueRows[0]!;
    const queue = { game: first.game, variant: first.variant, division: first.division };
    const seats = cfg.seatsFor(queue.game, queue.variant);
    if (!Number.isInteger(seats) || seats < 2) {
      throw new Error(`pairer: seatsFor(${queue.game}) must be an integer >= 2, got ${seats}`);
    }

    const infoMap = await cfg.info(queueRows.map((r) => r.agent_id), queue);
    const candidates: Candidate[] = [];
    for (const row of queueRows) {
      const info = infoMap.get(row.agent_id);
      if (!info) continue; // unknown agent: leave in lobby untouched, no sweep credit
      const sweeps = state.sweeps[lobbyEntryKey(row)] ?? 0;
      const band = sweeps >= unboundedAfter ? Number.POSITIVE_INFINITY : baseBand + bandStep * sweeps;
      candidates.push({ row, info, sweeps, band });
    }
    // FIFO: oldest joined first; agent_id tiebreak for determinism.
    candidates.sort((a, b) =>
      a.row.joined_at < b.row.joined_at ? -1 : a.row.joined_at > b.row.joined_at ? 1 :
      a.row.agent_id < b.row.agent_id ? -1 : 1,
    );

    const unmatched = new Set(candidates);

    const formGame = async (group: Candidate[], houseFill: HouseAgent[]): Promise<void> => {
      const secret = cfg.secrets.secret();
      const seed = createSeedStream(sha256Hex(secret));
      const seatAgents = seed.shuffle('pairing:seats', [
        ...group.map((c) => c.row.agent_id),
        ...houseFill.map((h) => h.agent_id),
      ]);
      const command: CreateGameCommand = {
        game: queue.game,
        variant: queue.variant,
        division: queue.division,
        seats: seatAgents,
      };
      const game_id = await cfg.factory.createGame(command);
      created.push({ game_id, command });
      for (const c of group) {
        unmatched.delete(c);
        matchedKeys.push({ ...queue, agent_id: c.row.agent_id });
      }
    };

    // Pass 1: full games from real candidates, oldest anchor first.
    for (const anchor of candidates) {
      if (!unmatched.has(anchor)) continue;
      const group: Candidate[] = [anchor];
      for (const other of candidates) {
        if (group.length >= seats) break;
        if (other === anchor || !unmatched.has(other)) continue;
        if (!group.every((m) => compatible(m, other))) continue;
        if (operatorClash(group, other)) continue;
        group.push(other);
      }
      if (group.length === seats) await formGame(group, []);
    }

    // Pass 2: house backfill for entries that already waited backfillAfter+ sweeps.
    for (const anchor of candidates) {
      if (!unmatched.has(anchor) || anchor.sweeps < backfillAfter) continue;
      const group: Candidate[] = [anchor];
      for (const other of candidates) {
        if (group.length >= seats) break;
        if (other === anchor || !unmatched.has(other)) continue;
        if (!group.every((m) => compatible(m, other))) continue;
        if (operatorClash(group, other)) continue;
        group.push(other);
      }
      const need = seats - group.length;
      if (need > 0) {
        const pool = cfg.houseAgents.available();
        if (pool.length < need) continue; // provider must list enough distinct agents
        const secret = cfg.secrets.secret();
        const seed = createSeedStream(sha256Hex(secret));
        const fill = seed.shuffle('pairing:house', pool).slice(0, need);
        await formGame(group, fill);
      } else {
        await formGame(group, []);
      }
    }

    // Remaining entries wait one more sweep.
    for (const c of unmatched) {
      nextSweeps[lobbyEntryKey(c.row)] = c.sweeps + 1;
    }
  }

  await lobby.remove(matchedKeys);
  return { created, state: { sweeps: nextSweeps } };
}
