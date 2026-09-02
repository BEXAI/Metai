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
 * reduces to the ordinary single result. Opponents enter at their current
 * stored rating (per-game application; the daily closeRatingPeriod batching
 * in seasons.ts remains available for offline recomputation).
 *
 * Rating scope key: (game, variant, division, season). `variant` is the
 * opaque lobby queue key. The pairer records it in KV as 'vkey:<game_id>'
 * when it creates the game; when the KV entry is gone the key is re-derived
 * from the games row's variant config: empty config -> 'standard', else
 * canonicalJson(config) (the encoding lobby.ts recommends).
 */

import { canonicalJson } from '../crypto/canonical.ts';
import type { GameResult, Json } from '../kernel/types.ts';
import type { ApiEnv } from '../api/env.ts';
import {
  DEFAULT_GLICKO2,
  pairwiseResults,
  rate,
  standingsFromResult,
  type Glicko2Rating,
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

/** Seat agents in seat order (p0, p1, ...) from a games row's seats_json. */
export function seatAgentsOf(seatsJson: string | null): string[] {
  if (typeof seatsJson !== 'string' || seatsJson === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(seatsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seats: { player: string; agent_id: string }[] = [];
  for (const s of parsed) {
    if (isRecord(s) && typeof s.player === 'string' && typeof s.agent_id === 'string') {
      seats.push({ player: s.player, agent_id: s.agent_id });
    }
  }
  seats.sort((a, b) => Number(a.player.slice(1)) - Number(b.player.slice(1)));
  return seats.map((s) => s.agent_id);
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

/**
 * Applies Glicko-2 for one finalized game. Idempotent (see module header):
 *  - no games row, not ended, or no usable result/seats -> no-op
 *  - already rated (rated_games marker) -> no-op
 *  - otherwise: claim the marker, then upsert one ratings row per seat with
 *    the pairwise-decomposed update and games_played incremented by one.
 */
export async function applyGameRatings(env: ApiEnv, gameId: string): Promise<void> {
  const row = await env.DB
    .prepare('SELECT id, game, variant, division, season_id, status, seats_json, result_json FROM games WHERE id = ?')
    .bind(gameId)
    .first<GamesRowLite>();
  if (!row || row.status !== 'ended') return;
  const result = parseResult(row.result_json);
  const seatAgents = seatAgentsOf(row.seats_json);
  if (!result || seatAgents.length < 2) return;

  // Fast-path skip, then claim (INSERT OR IGNORE): at-most-once application.
  const already = await env.DB.prepare('SELECT game_id FROM rated_games WHERE game_id = ?').bind(gameId).first();
  if (already) return;
  const nowIso = new Date(env.now()).toISOString();
  const claim = await env.DB
    .prepare('INSERT OR IGNORE INTO rated_games (game_id, rated_at) VALUES (?, ?)')
    .bind(gameId, nowIso)
    .run();
  if (changesOf(claim) === 0) return; // lost a race: someone else is applying

  const vkeyCached = await env.CACHE.get(`vkey:${gameId}`);
  const scope = {
    game: row.game,
    variant: vkeyCached ?? variantKeyOf(row.variant),
    division: row.division === 'pure' ? 'pure' : 'open',
    season_id: row.season_id ?? seasonIdFor(new Date(env.now())),
  };

  const positions = standingsFromResult(seatAgents, result);
  const current = new Map<string, { rating: Glicko2Rating; games_played: number }>();
  for (const agentId of seatAgents) {
    current.set(agentId, await currentRating(env, agentId, scope));
  }
  const standings: Standing[] = positions.map((p) => ({
    agent_id: p.agent_id,
    position: p.position,
    rating: current.get(p.agent_id)!.rating,
  }));
  const results = pairwiseResults(standings);

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
