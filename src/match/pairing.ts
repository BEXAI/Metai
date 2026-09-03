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
 *
 * PRODUCTION WIRING (stage-4 integration; interface contract in PLAN.md):
 * `cronTick(env)` at the bottom of this file is the entry point the 5-minute
 * cron hook (src/api/cron.ts) calls. It runs the sweep over the D1 lobby
 * table and creates each formed game for real: commit-reveal secret via the
 * SecretProvider, commitment via src/crypto/commit.ts, drand via
 * src/crypto/drand.ts, POST /create on the GAME_ROOM Durable Object, a
 * `games` row INSERT (status 'live', replay_r2_key 'replays/<id>.json'),
 * and the seated lobby rows deleted.
 */

import { bytesToHex } from '@noble/hashes/utils';
import { sha256Hex } from '../crypto/canonical.ts';
import { makeCommitment } from '../crypto/commit.ts';
import { getLatestRound, roundAt, type DrandFetch } from '../crypto/drand.ts';
import { createSeedStream } from '../kernel/seed.ts';
import { playerId, type Json } from '../kernel/types.ts';
import type { ApiEnv } from '../api/env.ts';
import {
  lobbyEntryKey,
  queueKey,
  type Division,
  type LobbyKey,
  type LobbyRepo,
  type LobbyRow,
} from './lobby.ts';
import { seasonBounds, seasonIdFor } from './seasons.ts';

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

// ---------------------------------------------------------------------------
// D1 wiring: LobbyRepo over the lobby table, GameFactory over the GameRoom
// Durable Object + games table, and the cron entry point.
// ---------------------------------------------------------------------------

/** Games-row constants (match what the API/e2e expect; see notes/integration-match.md). */
const RULESET_VERSION = '1.0.0';
const PAIRER_STATE_KEY = 'pairer:state';
/**
 * The recorded drand round is picked this many rounds (3 s each -> 5 min)
 * after "now": RoomCore.create enforces spec §identity_and_integrity
 * .randomness[1] (mixed round at or after the commitment time), so the round
 * number must not be in the past when the room derives the commitment.
 */
const DRAND_ROUND_MARGIN = 100;
const ZERO_RANDOMNESS = '0'.repeat(64);

/** D1-backed LobbyRepo (the lobby table is written by POST /api/lobby/join). */
export function d1LobbyRepo(env: ApiEnv): LobbyRepo {
  return {
    async join(row: LobbyRow): Promise<'joined' | 'already'> {
      const existing = await env.DB
        .prepare('SELECT agent_id FROM lobby WHERE game = ? AND variant = ? AND division = ? AND agent_id = ?')
        .bind(row.game, row.variant, row.division, row.agent_id)
        .first();
      if (existing) return 'already';
      await env.DB
        .prepare('INSERT INTO lobby (game, variant, division, agent_id, joined_at) VALUES (?, ?, ?, ?, ?)')
        .bind(row.game, row.variant, row.division, row.agent_id, row.joined_at)
        .run();
      return 'joined';
    },
    async leave(key: LobbyKey): Promise<boolean> {
      const existing = await env.DB
        .prepare('SELECT agent_id FROM lobby WHERE game = ? AND variant = ? AND division = ? AND agent_id = ?')
        .bind(key.game, key.variant, key.division, key.agent_id)
        .first();
      if (!existing) return false;
      await env.DB
        .prepare('DELETE FROM lobby WHERE game = ? AND variant = ? AND division = ? AND agent_id = ?')
        .bind(key.game, key.variant, key.division, key.agent_id)
        .run();
      return true;
    },
    async list(): Promise<LobbyRow[]> {
      const { results } = await env.DB
        .prepare('SELECT game, variant, division, agent_id, joined_at FROM lobby')
        .all<LobbyRow>();
      return results;
    },
    async remove(keys: readonly LobbyKey[]): Promise<void> {
      for (const key of keys) {
        await env.DB
          .prepare('DELETE FROM lobby WHERE game = ? AND variant = ? AND division = ? AND agent_id = ?')
          .bind(key.game, key.variant, key.division, key.agent_id)
          .run();
      }
    },
  };
}

/** Lobby variant key -> VariantConfig for the room ('standard'/opaque -> {}). */
export function variantConfigOf(variantKey: string): Json {
  if (variantKey.startsWith('{')) {
    try {
      const parsed = JSON.parse(variantKey) as Json;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
    } catch {
      /* opaque key */
    }
  }
  return {};
}

/** Idempotently opens the season row `now` falls in (games.season_id FK). */
async function ensureSeasonRow(env: ApiEnv, seasonId: string): Promise<void> {
  const { starts_at, ends_at } = seasonBounds(seasonId);
  await env.DB
    .prepare(
      "INSERT OR IGNORE INTO seasons (id, name, starts_at, ends_at, ruleset_versions_json, status) VALUES (?, ?, ?, ?, '{}', 'active')",
    )
    .bind(seasonId, `Season ${seasonId}`, starts_at, ends_at)
    .run();
}

interface SeatAgentRow {
  id: string;
  handle: string;
  pubkey_ed25519: string;
}

export interface D1FactoryOptions {
  secrets: SecretProvider;
  /** Outbound drand fetch; default globalThis.fetch. */
  drandFetch?: DrandFetch;
  seasonId: string;
}

/**
 * The production GameFactory: draws the game's commit-reveal secret from the
 * injectable SecretProvider, computes the commitment (src/crypto/commit.ts),
 * fetches the latest drand quicknet randomness (recording a docket entry and
 * falling back to zero randomness when the network is unavailable — local
 * dev has no network guarantees), POSTs /create on the GAME_ROOM stub with
 * the full CreateRoomParams the room expects, and INSERTs the games row.
 */
export function d1GameFactory(env: ApiEnv, opts: D1FactoryOptions): GameFactory {
  const drandFetch: DrandFetch = opts.drandFetch ?? ((url) => fetch(url));
  return {
    async createGame(cmd: CreateGameCommand): Promise<string> {
      const gameId = `game_${bytesToHex(opts.secrets.secret()).slice(0, 16)}`;

      const seats: Json[] = [];
      for (let i = 0; i < cmd.seats.length; i++) {
        const agentId = cmd.seats[i]!;
        const row = await env.DB
          .prepare('SELECT id, handle, pubkey_ed25519 FROM agents WHERE id = ?')
          .bind(agentId)
          .first<SeatAgentRow>();
        if (!row) throw new Error(`pairer: seat agent '${agentId}' is not in the agents table`);
        seats.push({ player: playerId(i), agent_id: row.id, handle: row.handle, pubkey_ed25519: row.pubkey_ed25519 });
      }

      // Commit-reveal secret + commitment (spec §identity_and_integrity.randomness).
      const secretHex = bytesToHex(opts.secrets.secret());
      const commitment = makeCommitment(gameId, secretHex);

      // drand: the recorded round is DRAND_ROUND_MARGIN rounds after now so
      // the room's at-or-after-commitment check holds; the mixed randomness
      // is the latest quicknet output when reachable, else zero randomness
      // with a public docket entry (the commit-reveal secret alone still
      // makes final_seed unpredictable to the players).
      const nowMs = env.now();
      const drandRound = roundAt(nowMs) + DRAND_ROUND_MARGIN;
      let drandRandomness = ZERO_RANDOMNESS;
      try {
        const latest = await getLatestRound(drandFetch);
        drandRandomness = latest.randomness;
      } catch (e) {
        await env.DB
          .prepare("INSERT INTO docket (kind, subject_json, reason, disposition, created_at) VALUES (?, ?, ?, 'noted', ?)")
          .bind(
            'drand_unavailable',
            JSON.stringify({ game_id: gameId, drand_round: drandRound }),
            `drand quicknet unreachable at game creation; zero randomness mixed (${e instanceof Error ? e.message : String(e)})`,
            new Date(nowMs).toISOString(),
          )
          .run();
      }

      const variant = variantConfigOf(cmd.variant);
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));
      const createRes = await stub.fetch('https://room/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          game_id: gameId,
          game: cmd.game,
          seats,
          variant,
          division: cmd.division,
          ruleset_version: RULESET_VERSION,
          secret_hex: secretHex,
          drand_round: drandRound,
          drand_randomness: drandRandomness,
          // Test-only clock override (never set in production); otherwise the
          // room uses its generous per-game default (src/rooms/core.ts).
          ...(env.perMoveMsOverride ? { per_move_ms: env.perMoveMsOverride } : {}),
        }),
      });
      if (createRes.status !== 201) {
        throw new Error(`room /create for ${cmd.game} failed: ${createRes.status} ${await createRes.text()}`);
      }
      const summary = (await createRes.json()) as { commitment?: string; drand_round?: number };

      await ensureSeasonRow(env, opts.seasonId);
      await env.DB
        .prepare(
          `INSERT INTO games (id, game, variant, division, season_id, status, commitment, drand_round,
             reveal_secret, seats_json, ruleset_version, started_at, replay_r2_key)
           VALUES (?, ?, ?, ?, ?, 'live', ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .bind(
          gameId,
          cmd.game,
          JSON.stringify(variant),
          cmd.division,
          opts.seasonId,
          summary.commitment ?? commitment,
          summary.drand_round ?? drandRound,
          JSON.stringify(seats),
          RULESET_VERSION,
          new Date(nowMs).toISOString(),
          `replays/${gameId}.json`,
        )
        .run();
      // Record the lobby queue key for the ratings scope (src/match/ratings.ts).
      // TTL-bounded: this is only needed between game creation and the rating
      // that runs at game end, so a key per game must not live forever. 30 days
      // is far longer than any game (turn limits cap them at hours) and keeps
      // the namespace from growing without bound. ratings.ts already documents
      // and implements a fallback for a missing key.
      await env.CACHE.put(`vkey:${gameId}`, cmd.variant, { expirationTtl: 30 * 24 * 60 * 60 });
      return gameId;
    },
  };
}

function houseKindOf(handle: string): HouseAgentKind {
  if (handle.includes('anthropic')) return 'anthropic';
  if (handle.includes('mock')) return 'mock';
  return 'random';
}

/**
 * House agents registered for backfill: active agents whose handle starts
 * with 'house-' (the public convention; they register and homologate like
 * everyone else). 'anthropic' entries are excluded here — the narrow ApiEnv
 * carries no ANTHROPIC_API_KEY, so only random/mock house agents backfill.
 */
async function loadHouseAgents(env: ApiEnv): Promise<HouseAgent[]> {
  const { results } = await env.DB
    .prepare("SELECT id, handle FROM agents WHERE status = 'active' AND handle LIKE 'house-%' ORDER BY handle")
    .all<{ id: string; handle: string }>();
  return results
    .map((r) => ({ agent_id: r.id, kind: houseKindOf(r.handle) }))
    .filter((h) => h.kind !== 'anthropic');
}

export interface CronTickOptions {
  /** Injectable for tests; default CryptoSecretProvider (crypto.getRandomValues). */
  secrets?: SecretProvider;
  /** Injectable for tests; default globalThis.fetch. */
  drandFetch?: DrandFetch;
}

// One tick at a time per isolate: overlapping cron fires (or a test-forced
// tick racing the scheduled one) must not double-create games from the same
// lobby snapshot.
let tickChain: Promise<unknown> = Promise.resolve();

function serializedTick<T>(fn: () => Promise<T>): Promise<T> {
  const next = tickChain.then(fn, fn);
  tickChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * The cron hook (INTERFACE CONTRACT, PLAN stage-4): one pairing sweep over
 * the D1 lobby. src/api/cron.ts calls this every 5 minutes. PairerState
 * (per-entry waited-sweep counts) persists in KV under 'pairer:state'.
 */
export async function cronTick(env: ApiEnv, opts: CronTickOptions = {}): Promise<{ paired: number }> {
  return serializedTick(async () => {
    const seasonId = seasonIdFor(new Date(env.now()));
    const lobby = d1LobbyRepo(env);

    let state = initialPairerState();
    let stateBefore = '';
    try {
      const raw = await env.CACHE.get(PAIRER_STATE_KEY);
      if (raw) {
        stateBefore = raw;
        const parsed = JSON.parse(raw) as PairerState;
        if (parsed && typeof parsed === 'object' && parsed.sweeps) state = parsed;
      }
    } catch {
      /* fresh state */
    }

    const house = await loadHouseAgents(env);
    const secrets = opts.secrets ?? new CryptoSecretProvider();
    const factoryOpts: D1FactoryOptions = { secrets, seasonId };
    if (opts.drandFetch) factoryOpts.drandFetch = opts.drandFetch;

    const outcome = await runPairingSweep(lobby, state, {
      seatsFor(game: string): number {
        return env.games[game]?.meta.players.min ?? 2;
      },
      async info(
        agentIds: readonly string[],
        queue: { game: string; variant: string; division: Division },
      ): Promise<Map<string, PairingAgentInfo>> {
        const out = new Map<string, PairingAgentInfo>();
        for (const id of agentIds) {
          const agent = await env.DB
            .prepare('SELECT id, operator_id, handle FROM agents WHERE id = ?')
            .bind(id)
            .first<{ id: string; operator_id: string; handle: string }>();
          if (!agent) continue;
          const rating = await env.DB
            .prepare('SELECT rating FROM ratings WHERE agent_id = ? AND game = ? AND variant = ? AND division = ? AND season_id = ?')
            .bind(id, queue.game, queue.variant, queue.division, seasonId)
            .first<{ rating: number }>();
          out.set(id, {
            agent_id: id,
            operator_id: agent.operator_id,
            rating: rating ? Number(rating.rating) : 1500,
            house: agent.handle.startsWith('house-'),
          });
        }
        return out;
      },
      houseAgents: { available: () => house },
      secrets,
      factory: d1GameFactory(env, factoryOpts),
    });

    // Write ONLY when the sweep counters actually changed. cronTick runs on
    // every lobby join as well as every 5 minutes, and the overwhelming
    // majority of those ticks find an empty (or unchanged) lobby and produce
    // identical state. Writing unconditionally spent a KV write per join —
    // the same class of quota burn that took auth down once already, since KV
    // allows ~1,000 writes/day on the free plan.
    const stateAfter = JSON.stringify(outcome.state);
    if (stateAfter !== stateBefore) {
      await env.CACHE.put(PAIRER_STATE_KEY, stateAfter);
    }
    return { paired: outcome.created.length };
  });
}
