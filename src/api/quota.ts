/**
 * Daily quotas (spec §matchmaking_and_ratings.quotas):
 *   - register once per key (enforced by unique index, src/identity/register.ts)
 *   - per agent per UTC day: 50 game joins
 *   - per agent: 20 concurrent games
 *   - a REJECTED request never spends a quota: handlers validate everything,
 *     THEN check the quota, THEN perform the action, THEN spend
 *     (check-then-spend after validation).
 *
 * Join counts live in the quotas table (agent_id, day) — counting lobby rows
 * would forget joins once the pairer drains the lobby. Concurrent games are
 * counted live from the games table (seats_json carries agent ids).
 */

import type { ApiEnv } from './env.ts';

export const DAILY_JOINS = 50;
export const CONCURRENT_GAMES = 20;

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export async function joinsUsedToday(env: ApiEnv, agentId: string): Promise<number> {
  const row = await env.DB
    .prepare('SELECT joins FROM quotas WHERE agent_id = ? AND day = ?')
    .bind(agentId, utcDay(env.now()))
    .first<{ joins: number }>();
  return row ? Number(row.joins) : 0;
}

export async function concurrentGames(env: ApiEnv, agentId: string): Promise<number> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'live' AND seats_json LIKE ?")
    .bind(`%"${agentId}"%`)
    .first<{ n: number }>();
  return row ? Number(row.n) : 0;
}

export type QuotaCheck = { ok: true } | { ok: false; code: string; message: string };

/** Read-only check — spends nothing. */
export async function checkJoinQuota(env: ApiEnv, agentId: string): Promise<QuotaCheck> {
  const joins = await joinsUsedToday(env, agentId);
  if (joins >= DAILY_JOINS) {
    return { ok: false, code: 'QUOTA_JOINS', message: `Daily join quota reached (${DAILY_JOINS} per UTC day). It resets at 00:00 UTC.` };
  }
  const live = await concurrentGames(env, agentId);
  if (live >= CONCURRENT_GAMES) {
    return { ok: false, code: 'QUOTA_CONCURRENT', message: `Concurrent game limit reached (${CONCURRENT_GAMES}). Finish a game first.` };
  }
  return { ok: true };
}

/** Called only AFTER the join has actually succeeded. */
export async function spendJoin(env: ApiEnv, agentId: string): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO quotas (agent_id, day, joins) VALUES (?, ?, 1)
       ON CONFLICT(agent_id, day) DO UPDATE SET joins = joins + 1`,
    )
    .bind(agentId, utcDay(env.now()))
    .run();
}
