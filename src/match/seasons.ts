/**
 * Seasons and rating periods (spec §matchmaking_and_ratings.seasons/.ratings).
 *
 *  - Seasons are calendar months, UTC. Season id = 'YYYY-MM'. A season row
 *    pins ruleset_versions_json at open; homologations reference season_id and
 *    are frozen by it (changing any homologated field mid-season voids
 *    standing — enforced by T7's identity layer; the pin lives here).
 *  - Rating periods close daily at 00:00 UTC: all games that ENDED inside the
 *    period are collected per (game, variant, division, season) and every
 *    agent gets ONE Glicko-2 update containing all its decomposed results from
 *    the period (pairwise, or team-aggregate for a game whose result carries
 *    teams), with opponents at their start-of-period ratings.
 *  - Idle rated agents get the paper's no-game update (RD grows, capped 350).
 *  - Season close produces final tables: wins, losses, draws, rating, games
 *    played (spec: "Season tables publish wins, losses, draws, rating, and
 *    games played").
 *
 * Repos are narrow interfaces implemented over D1 by T7; tests use the
 * in-memory versions exported here.
 */

import { canonicalJson } from '../crypto/canonical.ts';
import type { GameResult, Json } from '../kernel/types.ts';
import { DEFAULT_GLICKO2, rate, type Glicko2Rating, type Glicko2Result } from './glicko2.ts';
import type { Division } from './lobby.ts';
// The decomposition and the provisional threshold live with the per-game
// applier so the two cannot diverge; see the cycle note in ratings.ts.
import { decomposeGame, isProvisionalFor } from './ratings.ts';

// ---------------------------------------------------------------------------
// Season rows and calendar math (all UTC)
// ---------------------------------------------------------------------------

export interface SeasonRow {
  /** 'YYYY-MM'. */
  id: string;
  name: string;
  starts_at: string;
  ends_at: string;
  /** canonicalJson of { gameId: rulesetVersion } pinned at open. */
  ruleset_versions_json: string;
  status: 'open' | 'active' | 'closed';
}

export function seasonIdFor(when: Date | string): string {
  const d = typeof when === 'string' ? new Date(when) : when;
  if (Number.isNaN(d.getTime())) throw new Error(`seasonIdFor: bad date ${String(when)}`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** [start of month, start of next month) in UTC ISO. */
export function seasonBounds(seasonId: string): { starts_at: string; ends_at: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(seasonId);
  if (!m) throw new Error(`seasonBounds: bad season id ${seasonId}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`seasonBounds: bad month in ${seasonId}`);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { starts_at: start.toISOString(), ends_at: end.toISOString() };
}

/** The daily rating period that ENDS at the 00:00 UTC boundary <= now. */
export function dailyPeriodBounds(now: Date | string): { start: string; end: string } {
  const d = typeof now === 'string' ? new Date(now) : now;
  if (Number.isNaN(d.getTime())) throw new Error(`dailyPeriodBounds: bad date ${String(now)}`);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const start = end - 24 * 60 * 60 * 1000;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export interface SeasonRepo {
  get(id: string): Promise<SeasonRow | null>;
  put(row: SeasonRow): Promise<void>;
}

export class MemorySeasonRepo implements SeasonRepo {
  private readonly rows = new Map<string, SeasonRow>();
  async get(id: string): Promise<SeasonRow | null> {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }
  async put(row: SeasonRow): Promise<void> {
    this.rows.set(row.id, { ...row });
  }
}

/**
 * Idempotent: opens (creates) the season containing `now`, pinning the given
 * ruleset versions. An existing row is returned unchanged — the pin is
 * write-once.
 */
export async function ensureSeason(
  now: Date | string,
  rulesetVersions: Record<string, string>,
  repo: SeasonRepo,
): Promise<SeasonRow> {
  const id = seasonIdFor(now);
  const existing = await repo.get(id);
  if (existing) return existing;
  const { starts_at, ends_at } = seasonBounds(id);
  const row: SeasonRow = {
    id,
    name: `Season ${id}`,
    starts_at,
    ends_at,
    ruleset_versions_json: canonicalJson(rulesetVersions as unknown as Json),
    status: 'open',
  };
  await repo.put(row);
  return row;
}

// ---------------------------------------------------------------------------
// Ratings rows (data_model.tables.ratings)
// ---------------------------------------------------------------------------

export interface RatingRow {
  agent_id: string;
  game: string;
  variant: string;
  division: Division;
  season_id: string;
  rating: number;
  rd: number;
  volatility: number;
  games_played: number;
  updated_at: string;
}

export interface RatingsRepo {
  get(key: {
    agent_id: string;
    game: string;
    variant: string;
    division: Division;
    season_id: string;
  }): Promise<RatingRow | null>;
  listAll(): Promise<RatingRow[]>;
  upsert(row: RatingRow): Promise<void>;
}

function ratingRowKey(r: {
  agent_id: string;
  game: string;
  variant: string;
  division: Division;
  season_id: string;
}): string {
  return `${r.agent_id} ${r.game} ${r.variant} ${r.division} ${r.season_id}`;
}

export class MemoryRatingsRepo implements RatingsRepo {
  private readonly rows = new Map<string, RatingRow>();
  async get(key: Parameters<RatingsRepo['get']>[0]): Promise<RatingRow | null> {
    const r = this.rows.get(ratingRowKey(key));
    return r ? { ...r } : null;
  }
  async listAll(): Promise<RatingRow[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async upsert(row: RatingRow): Promise<void> {
    this.rows.set(ratingRowKey(row), { ...row });
  }
}

// ---------------------------------------------------------------------------
// Finished games feeding the rating period
// ---------------------------------------------------------------------------

export interface FinishedGame {
  game_id: string;
  game: string;
  variant: string;
  division: Division;
  season_id: string;
  ended_at: string;
  /** Agent ids in seat order (seat i = playerId(i)). */
  seat_agents: string[];
  result: GameResult;
}

export interface RatingPeriodReport {
  period_end: string;
  games_rated: number;
  agents_updated: number;
  agents_inflated: number;
}

/**
 * Closes one daily rating period: every agent that finished games gets one
 * batched Glicko-2 update (all decomposed results, opponents at start-of-period
 * ratings); every other rated agent gets the no-game RD inflation
 * (set inflateIdle false to skip). games_played += games finished (not pairs).
 *
 * This is the OFFLINE rebuild of what applyGameRatings applies per game, so it
 * shares decomposeGame with it — a period that branched on teams differently
 * from the live applier would produce a rebuild that silently disagrees.
 */
export async function closeRatingPeriod(
  periodEndUtc: string,
  finished: readonly FinishedGame[],
  ratings: RatingsRepo,
  opts: { inflateIdle?: boolean } = {},
): Promise<RatingPeriodReport> {
  const inflateIdle = opts.inflateIdle ?? true;

  // Group games by (game, variant, division, season).
  const groups = new Map<string, FinishedGame[]>();
  for (const fg of finished) {
    const gk = `${fg.game} ${fg.variant} ${fg.division} ${fg.season_id}`;
    const g = groups.get(gk);
    if (g) g.push(fg);
    else groups.set(gk, [fg]);
  }

  const updatedKeys = new Set<string>();
  let agentsUpdated = 0;

  for (const gk of [...groups.keys()].sort()) {
    const games = groups.get(gk)!;
    const first = games[0]!;
    const scope = {
      game: first.game,
      variant: first.variant,
      division: first.division,
      season_id: first.season_id,
    };

    // Start-of-period baseline per agent (existing row or default).
    const baseline = new Map<string, { rating: Glicko2Rating; games_played: number }>();
    const agentIds = new Set<string>();
    for (const fg of games) for (const a of fg.seat_agents) agentIds.add(a);
    for (const agent_id of agentIds) {
      const row = await ratings.get({ agent_id, ...scope });
      baseline.set(agent_id, {
        rating: row
          ? { rating: row.rating, rd: row.rd, vol: row.volatility }
          : { ...DEFAULT_GLICKO2 },
        games_played: row?.games_played ?? 0,
      });
    }

    // Decomposed results per agent across all games in the period — pairwise,
    // or team-aggregate for a game whose result carries teams.
    const resultsByAgent = new Map<string, Glicko2Result[]>();
    const gamesByAgent = new Map<string, number>();
    for (const fg of games) {
      const decomposed = decomposeGame(fg.seat_agents, fg.result, (id) => baseline.get(id)!.rating);
      for (const [agent_id, results] of decomposed) {
        const acc = resultsByAgent.get(agent_id);
        if (acc) acc.push(...results);
        else resultsByAgent.set(agent_id, [...results]);
        gamesByAgent.set(agent_id, (gamesByAgent.get(agent_id) ?? 0) + 1);
      }
    }

    // One rate() call per agent.
    for (const [agent_id, results] of resultsByAgent) {
      const base = baseline.get(agent_id)!;
      const updated = rate(base.rating, results);
      const row: RatingRow = {
        agent_id,
        ...scope,
        rating: updated.rating,
        rd: updated.rd,
        volatility: updated.vol,
        games_played: base.games_played + (gamesByAgent.get(agent_id) ?? 0),
        updated_at: periodEndUtc,
      };
      await ratings.upsert(row);
      updatedKeys.add(ratingRowKey(row));
      agentsUpdated++;
    }
  }

  // No-game RD inflation for every other rated agent.
  let agentsInflated = 0;
  if (inflateIdle) {
    for (const row of await ratings.listAll()) {
      if (updatedKeys.has(ratingRowKey(row))) continue;
      const updated = rate({ rating: row.rating, rd: row.rd, vol: row.volatility }, []);
      await ratings.upsert({ ...row, rd: updated.rd, updated_at: periodEndUtc });
      agentsInflated++;
    }
  }

  return {
    period_end: periodEndUtc,
    games_rated: finished.length,
    agents_updated: agentsUpdated,
    agents_inflated: agentsInflated,
  };
}

// ---------------------------------------------------------------------------
// Season close: final tables
// ---------------------------------------------------------------------------

export interface SeasonTableRow {
  agent_id: string;
  rating: number;
  rd: number;
  provisional: boolean;
  games_played: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface SeasonTables {
  season: SeasonRow;
  /** queue key `game variant division` -> table sorted by rating desc. */
  tables: Record<string, SeasonTableRow[]>;
}

/**
 * Closes a season: marks the row closed and computes final tables from the
 * ratings rows plus win/loss/draw tallies from the season's finished games.
 * Multiplayer: winners win, draws draw, everyone else loses.
 */
export async function closeSeason(
  seasonId: string,
  seasons: SeasonRepo,
  ratings: RatingsRepo,
  finished: readonly FinishedGame[],
): Promise<SeasonTables> {
  const season = await seasons.get(seasonId);
  if (!season) throw new Error(`closeSeason: unknown season ${seasonId}`);
  if (season.status !== 'closed') {
    season.status = 'closed';
    await seasons.put(season);
  }

  // Tally W/L/D per (queue, agent).
  const tallies = new Map<string, { wins: number; losses: number; draws: number }>();
  const tally = (queue: string, agent: string): { wins: number; losses: number; draws: number } => {
    const k = `${queue}\n${agent}`;
    let t = tallies.get(k);
    if (!t) {
      t = { wins: 0, losses: 0, draws: 0 };
      tallies.set(k, t);
    }
    return t;
  };
  for (const fg of finished) {
    if (fg.season_id !== seasonId) continue;
    const queue = `${fg.game} ${fg.variant} ${fg.division}`;
    const winners = new Set<string>();
    for (const p of fg.result.winners) {
      const seat = Number(p.slice(1));
      const agent = fg.seat_agents[seat];
      if (agent !== undefined) winners.add(agent);
    }
    for (const agent of fg.seat_agents) {
      const t = tally(queue, agent);
      if (fg.result.draw) t.draws++;
      else if (winners.has(agent)) t.wins++;
      else t.losses++;
    }
  }

  const tables: Record<string, SeasonTableRow[]> = {};
  for (const row of await ratings.listAll()) {
    if (row.season_id !== seasonId) continue;
    const queue = `${row.game} ${row.variant} ${row.division}`;
    const t = tallies.get(`${queue}\n${row.agent_id}`) ?? { wins: 0, losses: 0, draws: 0 };
    const table = (tables[queue] ??= []);
    table.push({
      agent_id: row.agent_id,
      rating: row.rating,
      rd: row.rd,
      provisional: isProvisionalFor(row.games_played, row.game),
      games_played: row.games_played,
      wins: t.wins,
      losses: t.losses,
      draws: t.draws,
    });
  }
  for (const table of Object.values(tables)) {
    table.sort((a, b) => b.rating - a.rating || a.agent_id.localeCompare(b.agent_id));
  }

  return { season, tables };
}
