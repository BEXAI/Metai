/**
 * Per-game Glicko-2 application (spec §matchmaking_and_ratings.ratings,
 * gate A13 wiring). One finalized game -> one idempotent ratings update.
 *
 * INTERFACE CONTRACT (frozen, PLAN stage-4 integration):
 *   applyGameRatings(env, gameId) — called by the room finalize path (T6)
 *   AFTER the games row has been persisted with status='ended' and
 *   result_json set. Also safe to call from any sweep/cron: it skips games
 *   that are not ended and games that were already rated.
 *
 * Idempotency: the applier first claims `rated_games(game_id)` with
 * INSERT OR IGNORE (schema.sql, T8 addition). Zero changed rows = another
 * caller already applied this game -> return without touching ratings. This
 * gives at-most-once semantics even under a concurrent cron + finalize race.
 *
 * Decomposition: multiplayer games rate by finishing position using pairwise
 * decomposition (standingsFromResult + pairwiseResults); a 2-player game
 * reduces to the ordinary single result. TEAM games take the team-aggregate
 * path instead (decomposeGame below). Opponents enter at their current
 * stored rating (per-game application; the daily closeRatingPeriod batching
 * in seasons.ts remains available for offline recomputation).
 *
 * Rating scope key: (game, variant, division, season). `variant` is the
 * opaque lobby queue key. The pairer records it in KV as 'vkey:<game_id>'
 * when it creates the game; when the KV entry is gone the key is re-derived
 * from the games row's variant config: empty config -> 'standard', else
 * canonicalJson(config) (the encoding lobby.ts recommends).
 *
 * NOTE ON THE ./seasons.ts CYCLE: seasons.ts imports decomposeGame and
 * isProvisionalFor from here, and this module imports seasonIdFor from there.
 * Both directions are referenced only inside function bodies, never at module
 * evaluation time, so the ESM cycle is inert. The decomposition deliberately
 * lives in ONE place: an offline rebuild through closeRatingPeriod that
 * branched differently from the per-game applier would silently diverge from
 * the live ratings.
 */

import { canonicalJson } from '../crypto/canonical.ts';
import { playerId, type GameResult, type Json } from '../kernel/types.ts';
import type { ApiEnv } from '../api/env.ts';
import {
  DEFAULT_GLICKO2,
  PROVISIONAL_GAMES,
  pairwiseResults,
  rate,
  standingsFromResult,
  type Glicko2Rating,
  type Glicko2Result,
  type Standing,
} from './glicko2.ts';
import { seasonIdFor } from './seasons.ts';

// ---------------------------------------------------------------------------
// Row shapes (subset of schema.sql the applier touches)
// ---------------------------------------------------------------------------

interface GamesRowLite {
  id: string;
  game: string;
  variant: string | null;
  division: string | null;
  season_id: string | null;
  status: string;
  seats_json: string | null;
  result_json: string | null;
}

interface RatingRowLite {
  rating: number;
  rd: number;
  volatility: number;
  games_played: number;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export interface SeatRow {
  player: string;
  agent_id: string;
  /** '' when the pairer wrote no handle; only house detection reads it. */
  handle: string;
}

/**
 * Seats in seat order (p0, p1, ...) from a games row's seats_json. The pairer
 * writes { player, agent_id, handle, pubkey_ed25519 } per seat, so the handle
 * is available here without widening anything — which is what the real-seat
 * gate in applyGameRatings needs.
 */
export function seatRowsOf(seatsJson: string | null): SeatRow[] {
  if (typeof seatsJson !== 'string' || seatsJson === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(seatsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seats: SeatRow[] = [];
  for (const s of parsed) {
    if (isRecord(s) && typeof s.player === 'string' && typeof s.agent_id === 'string') {
      seats.push({
        player: s.player,
        agent_id: s.agent_id,
        handle: typeof s.handle === 'string' ? s.handle : '',
      });
    }
  }
  seats.sort((a, b) => Number(a.player.slice(1)) - Number(b.player.slice(1)));
  return seats;
}

/** Seat agents in seat order (p0, p1, ...) from a games row's seats_json. */
export function seatAgentsOf(seatsJson: string | null): string[] {
  return seatRowsOf(seatsJson).map((s) => s.agent_id);
}

function parseResult(resultJson: string | null): GameResult | null {
  if (typeof resultJson !== 'string' || resultJson === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.winners) || typeof parsed.draw !== 'boolean') return null;
  return parsed as unknown as GameResult;
}

/**
 * Rating scope key for a games row's variant column. The pairer's KV record
 * ('vkey:<game_id>' — the exact lobby queue key) wins; this is the fallback.
 */
export function variantKeyOf(variantColumn: string | null): string {
  if (typeof variantColumn !== 'string' || variantColumn === '') return 'standard';
  let parsed: unknown;
  try {
    parsed = JSON.parse(variantColumn);
  } catch {
    // Non-JSON opaque key stored verbatim.
    return variantColumn;
  }
  if (isRecord(parsed)) {
    return Object.keys(parsed).length === 0 ? 'standard' : canonicalJson(parsed as Json);
  }
  return variantColumn;
}

/** D1 run() and node:sqlite run() report changed rows in different shapes. */
function changesOf(runResult: unknown): number | null {
  if (!isRecord(runResult)) return null;
  const meta = runResult.meta;
  if (isRecord(meta) && typeof meta.changes === 'number') return meta.changes;
  if (typeof runResult.changes === 'number') return runResult.changes;
  if (typeof runResult.changes === 'bigint') return Number(runResult.changes);
  return null;
}

// ---------------------------------------------------------------------------
// Per-game rating policy
// ---------------------------------------------------------------------------

/** House agents are exempt from operator rules and must not be rateable prey. */
export const HOUSE_HANDLE_PREFIX = 'house-';

export function isHouseHandle(handle: string): boolean {
  return handle.startsWith(HOUSE_HANDLE_PREFIX);
}

/**
 * Minimum REAL (non-house) seats before a game's ratings are applied at all
 * (decision D-14). Werewolf backfills a lone entrant with seven house agents
 * pinned near 1500; rating that is a farming vector, and below half real
 * seats the outcome is dominated by house behaviour anyway. Such a game is
 * still recorded, still replayable, still tallied in season W/L/D — it is
 * claimed in rated_games with outcome 'exhibition' and no rating moves.
 *
 * Absent = 0 = every game rates, which is exactly what the twelve pre-werewolf
 * games do today.
 */
export const MIN_RATED_REAL_SEATS: Readonly<Record<string, number>> = { werewolf: 4 };

export function minRatedRealSeats(game: string): number {
  return MIN_RATED_REAL_SEATS[game] ?? 0;
}

/**
 * Games needing a higher provisional bar than glicko2's PROVISIONAL_GAMES.
 * Werewolf role is a seeded deal, provably uncorrelated with the agent, so it
 * is unbiased over many games — but in the short run wolf and villager have
 * radically different base win rates, which inflates estimator variance. The
 * fix is the threshold, not a role term in the model (a role-split `variant`
 * would miss every pairer band lookup and silently disable rating-band
 * matchmaking).
 */
export const PROVISIONAL_GAMES_BY_GAME: Readonly<Record<string, number>> = { werewolf: 40 };

export function provisionalGamesFor(game: string): number {
  return PROVISIONAL_GAMES_BY_GAME[game] ?? PROVISIONAL_GAMES;
}

/** Game-aware provisional check — glicko2's isProvisional hard-codes 20. */
export function isProvisionalFor(gamesPlayed: number, game: string): boolean {
  return gamesPlayed < provisionalGamesFor(game);
}

// ---------------------------------------------------------------------------
// Team-aggregate decomposition
// ---------------------------------------------------------------------------

export interface TeamStanding extends Standing {
  team: string;
}

/**
 * ONE Glicko-2 result per player, against the AGGREGATE of the opposing team.
 * Same-team pairs contribute nothing — they were never observed, and the
 * pairwise path's fabricated 0.5s would shrink RD on a non-observation (v
 * sums over results, and phi' falls as v falls).
 *
 *   opponentRating = arithmetic mean of opposing ratings
 *   opponentRd     = sqrt(mean of squared opposing RDs)   <- RMS, because RD
 *                    enters only through g(phi) and E(mu,muJ,phiJ); averaging
 *                    linearly would let one high-RD opponent vanish.
 *   score          = 1 team won / 0.5 draw / 0 lost
 *
 * Deliberately NOT scaled by team size: each player played ONE game, so each
 * gets ONE result. That is the whole point — one werewolf game moves a rating
 * as hard as one chess game, so RD, volatility and the provisional threshold
 * keep their meaning at 8 seats.
 *
 * `degenerate` (a decisive result whose winners span several teams, or none)
 * is reachable, not dead code: forfeit, resignation and draw-by-agreement all
 * build their GameResult inline without consulting isTerminal, and endGame
 * stamps teamsOf onto them (E13), so they arrive here with teams and with
 * winner sets the game module never chose. Rate them as a draw.
 */
export function teamAggregateResults(
  standings: readonly TeamStanding[],
  winningTeams: ReadonlySet<string>,
  draw: boolean,
): Map<string, Glicko2Result[]> {
  const out = new Map<string, Glicko2Result[]>();
  const degenerate = !draw && winningTeams.size !== 1;
  for (const s of standings) {
    const opps = standings.filter((o) => o.team !== s.team);
    if (opps.length === 0) {
      // Everyone on one team: nothing was observed.
      out.set(s.agent_id, []);
      continue;
    }
    let sumR = 0;
    let sumRd2 = 0;
    for (const o of opps) {
      sumR += o.rating.rating;
      sumRd2 += o.rating.rd ** 2;
    }
    const score = draw || degenerate ? 0.5 : winningTeams.has(s.team) ? 1 : 0;
    out.set(s.agent_id, [
      { opponentRating: sumR / opps.length, opponentRd: Math.sqrt(sumRd2 / opps.length), score },
    ]);
  }
  return out;
}

/**
 * agent_id -> team for a finished game, or null when the result carries no
 * usable team map. Every seat must have a non-empty team or the pairwise path
 * is the honest answer: a partial map would rate some seats against an
 * aggregate and leave others unmodelled.
 */
function teamsByAgent(seatAgents: readonly string[], result: GameResult): Map<string, string> | null {
  const teams = result.teams;
  if (!teams) return null;
  const out = new Map<string, string>();
  for (let seat = 0; seat < seatAgents.length; seat++) {
    const team = teams[playerId(seat)];
    if (typeof team !== 'string' || team === '') return null;
    out.set(seatAgents[seat]!, team);
  }
  return out;
}

/**
 * The single branch point for "how does this game become Glicko-2 results".
 * No teams -> the pairwise decomposition, byte-identical to what the twelve
 * pre-werewolf games have always produced. Teams -> team-aggregate.
 *
 * Used by BOTH appliers (applyGameRatings here, closeRatingPeriod in
 * seasons.ts) so a nightly offline rebuild cannot diverge from what was
 * applied live.
 */
export function decomposeGame(
  seatAgents: readonly string[],
  result: GameResult,
  ratingOf: (agentId: string) => Glicko2Rating,
): Map<string, Glicko2Result[]> {
  const positions = standingsFromResult(seatAgents, result);
  const teams = teamsByAgent(seatAgents, result);
  if (teams === null) {
    const standings: Standing[] = positions.map((p) => ({ ...p, rating: ratingOf(p.agent_id) }));
    return pairwiseResults(standings);
  }
  const standings: TeamStanding[] = positions.map((p) => ({
    ...p,
    rating: ratingOf(p.agent_id),
    team: teams.get(p.agent_id)!,
  }));
  const winningTeams = new Set<string>();
  if (!result.draw) {
    for (let seat = 0; seat < seatAgents.length; seat++) {
      if (!result.winners.includes(playerId(seat))) continue;
      const team = teams.get(seatAgents[seat]!);
      if (team !== undefined) winningTeams.add(team);
    }
  }
  return teamAggregateResults(standings, winningTeams, result.draw);
}

// ---------------------------------------------------------------------------
// The applier
// ---------------------------------------------------------------------------

async function currentRating(
  env: ApiEnv,
  agentId: string,
  scope: { game: string; variant: string; division: string; season_id: string },
): Promise<{ rating: Glicko2Rating; games_played: number }> {
  const row = await env.DB
    .prepare(
      'SELECT rating, rd, volatility, games_played FROM ratings WHERE agent_id = ? AND game = ? AND variant = ? AND division = ? AND season_id = ?',
    )
    .bind(agentId, scope.game, scope.variant, scope.division, scope.season_id)
    .first<RatingRowLite>();
  if (!row) return { rating: { ...DEFAULT_GLICKO2 }, games_played: 0 };
  return {
    rating: { rating: Number(row.rating), rd: Number(row.rd), vol: Number(row.volatility) },
    games_played: Number(row.games_played),
  };
}

// ---------------------------------------------------------------------------
// Degrading when migrations/0002 has not been applied
// ---------------------------------------------------------------------------

/**
 * A DATABASE IS schema.sql PLUS EVERY MIGRATION (migrations/apply.ts), but
 * nothing in the deploy path ENFORCES that, and the failure mode of getting it
 * wrong here is silent and total.
 *
 * `rated_games.outcome`, `game_teams` and `games.house_seats` arrive in
 * migrations/0002_werewolf_platform.sql. Against a database built from
 * schema.sql alone, the three-column claim below throws `no column named
 * outcome` — and the claim is the FIRST statement, so no rated_games row is
 * written, room.ts:658 catches the throw into one `room_ratings_failure` log
 * line, finalize still reports success, and nothing ever retries: there is no
 * ratings step in the cron and applyGameRatings runs exactly once per game.
 * Every game in all thirteen games would finish finalized, replayable and
 * PERMANENTLY unrated, visible only as a log line nobody is watching.
 *
 * So the two 0002-dependent statements degrade instead of dying: rating still
 * happens, and the shortfall is raised in the docket, which is an operational
 * surface (GET /api/docket) rather than a console line. Once-per-isolate, so a
 * missing migration cannot turn into a per-game write amplifier.
 */
let notedMissing0002 = false;

/** True for the D1/SQLite error that means "0002 has not been applied here". */
function isMissingMigrationError(e: unknown, column: string): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return msg.includes('no such column') || msg.includes('no column named') || msg.includes(`no such table: ${column}`);
}

async function note0002Missing(env: ApiEnv, gameId: string, detail: string): Promise<void> {
  if (notedMissing0002) return;
  notedMissing0002 = true;
  try {
    await env.DB
      .prepare("INSERT INTO docket (kind, subject_json, reason, disposition, created_at) VALUES (?, ?, ?, 'noted', ?)")
      .bind(
        'schema_gap',
        canonicalJson({ game_id: gameId, migration: '0002_werewolf_platform.sql' } as unknown as Json),
        `${detail} — apply migrations/0002_werewolf_platform.sql to this database (see docs/RUNBOOK.md, "Local D1" / "Staging deploy")`,
        new Date(env.now()).toISOString(),
      )
      .run();
  } catch {
    /* the docket is best-effort: never fail a rating over an audit row */
  }
}

/**
 * The at-most-once claim. Returns true when THIS call won it.
 * Falls back to the pre-0002 two-column shape rather than losing the rating;
 * the row then keeps `outcome`'s DEFAULT once the column is added, which is the
 * value a rated game would have written anyway.
 */
async function claimRatedGame(env: ApiEnv, gameId: string, nowIso: string, outcome: string): Promise<boolean> {
  try {
    const claim = await env.DB
      .prepare('INSERT OR IGNORE INTO rated_games (game_id, rated_at, outcome) VALUES (?, ?, ?)')
      .bind(gameId, nowIso, outcome)
      .run();
    return changesOf(claim) !== 0;
  } catch (e) {
    if (!isMissingMigrationError(e, 'rated_games')) throw e;
    await note0002Missing(env, gameId, `rated_games.outcome is missing, so '${outcome}' could not be recorded`);
    const claim = await env.DB
      .prepare('INSERT OR IGNORE INTO rated_games (game_id, rated_at) VALUES (?, ?)')
      .bind(gameId, nowIso)
      .run();
    return changesOf(claim) !== 0;
  }
}

/**
 * Records which side each seat was on, from the GameResult.teams that endGame
 * stamped via Game.teamsOf. Team, not role: the finalize path sees only the
 * ReplayFile and has no revealed role map. Called once per game, under the
 * rated_games claim, so INSERT OR IGNORE never overwrites an audit row.
 *
 * Presentation and audit only (its own migration says so), so a database
 * without `game_teams` costs the sides, never the rating.
 */
async function recordTeams(
  env: ApiEnv,
  gameId: string,
  seats: readonly SeatRow[],
  result: GameResult,
): Promise<void> {
  const teams = result.teams;
  if (!teams) return;
  const winners = new Set(result.draw ? [] : result.winners);
  for (const s of seats) {
    const team = teams[s.player];
    if (typeof team !== 'string' || team === '') continue;
    try {
      await env.DB
        .prepare('INSERT OR IGNORE INTO game_teams (game_id, player, agent_id, team, won) VALUES (?, ?, ?, ?, ?)')
        .bind(gameId, s.player, s.agent_id, team, winners.has(s.player) ? 1 : 0)
        .run();
    } catch (e) {
      if (!isMissingMigrationError(e, 'game_teams')) throw e;
      await note0002Missing(env, gameId, 'game_teams is missing, so the sides were not recorded');
      return;
    }
  }
}

/**
 * Applies Glicko-2 for one finalized game. Idempotent (see module header):
 *  - no games row, not ended, or no usable result/seats -> no-op
 *  - already rated (rated_games marker) -> no-op
 *  - otherwise: claim the marker ONCE with the right outcome, stamp
 *    game_teams, and — for a 'rated' outcome — upsert one ratings row per
 *    seat from the decomposed update with games_played incremented by one.
 *
 * Order matters: the real-seat count happens BEFORE the claim. An earlier
 * design claimed first and then tried to mark the game 'exhibition'; because
 * the claim is INSERT OR IGNORE, that second statement changes nothing, the
 * row keeps outcome DEFAULT 'rated', and the audit trail the migration exists
 * for is silently false.
 */
export async function applyGameRatings(env: ApiEnv, gameId: string): Promise<void> {
  const row = await env.DB
    .prepare('SELECT id, game, variant, division, season_id, status, seats_json, result_json FROM games WHERE id = ?')
    .bind(gameId)
    .first<GamesRowLite>();
  if (!row || row.status !== 'ended') return;
  const result = parseResult(row.result_json);
  const seats = seatRowsOf(row.seats_json);
  const seatAgents = seats.map((s) => s.agent_id);
  if (!result || seatAgents.length < 2) return;

  // Fast-path skip, then claim (INSERT OR IGNORE): at-most-once application.
  const already = await env.DB.prepare('SELECT game_id FROM rated_games WHERE game_id = ?').bind(gameId).first();
  if (already) return;
  // Count real seats first; the claim below carries the answer. A seat with no
  // recorded handle counts as real — an unverifiable seat must not be treated
  // as house, and for every game with no minimum this is a no-op anyway.
  const realSeats = seats.filter((s) => !isHouseHandle(s.handle)).length;
  const rated = realSeats >= minRatedRealSeats(row.game);
  const nowIso = new Date(env.now()).toISOString();
  const won = await claimRatedGame(env, gameId, nowIso, rated ? 'rated' : 'exhibition');
  if (!won) return; // lost a race: someone else is applying

  // Teams are stamped for every claimed game, exhibition included: /watch and
  // the season tables want the sides even when no rating moved.
  await recordTeams(env, gameId, seats, result);
  if (!rated) return;

  const vkeyCached = await env.CACHE.get(`vkey:${gameId}`);
  const scope = {
    game: row.game,
    variant: vkeyCached ?? variantKeyOf(row.variant),
    division: row.division === 'pure' ? 'pure' : 'open',
    season_id: row.season_id ?? seasonIdFor(new Date(env.now())),
  };

  const current = new Map<string, { rating: Glicko2Rating; games_played: number }>();
  for (const agentId of seatAgents) {
    current.set(agentId, await currentRating(env, agentId, scope));
  }
  const results = decomposeGame(seatAgents, result, (agentId) => current.get(agentId)!.rating);

  for (const agentId of seatAgents) {
    const prev = current.get(agentId)!;
    const next = rate(prev.rating, results.get(agentId) ?? []);
    await env.DB
      .prepare(
        `INSERT INTO ratings (agent_id, game, variant, division, season_id, rating, rd, volatility, games_played, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, game, variant, division, season_id)
         DO UPDATE SET rating = excluded.rating, rd = excluded.rd, volatility = excluded.volatility,
                       games_played = excluded.games_played, updated_at = excluded.updated_at`,
      )
      .bind(
        agentId,
        scope.game,
        scope.variant,
        scope.division,
        scope.season_id,
        next.rating,
        next.rd,
        next.vol,
        prev.games_played + 1,
        nowIso,
      )
      .run();
  }
}
