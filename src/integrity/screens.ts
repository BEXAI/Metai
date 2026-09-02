/**
 * Collusion screens (spec §identity_and_integrity.collusion): statistical
 * flags for soft-play, written to the docket with disposition 'watching'.
 * Adjudication is manual and public — these screens never act on their own.
 *
 * Two screens, both deliberately simple and their limits documented:
 *
 * 1. Resignation in a clearly-won position. There is no game-agnostic
 *    "winning" oracle, so the proxy is: the resigner's FINAL SCORE sits at or
 *    above the 90th percentile of all final scores observed in finished games
 *    of the same (game, variant). Only games whose results carry scores
 *    participate; games without score tables (chess, hex, ...) are SKIPPED —
 *    a chess soft-resignation needs an engine eval and is out of scope for
 *    this build. A minimum pool of 20 scores is required before anything is
 *    flagged, and the pool includes the suspect games themselves (small-N
 *    bias toward not flagging — acceptable for 'watching').
 *
 * 2. Systematic trade bias (trading games): net value repeatedly flowing
 *    between agents of the SAME OPERATOR PAIR across games. Value is whatever
 *    the caller reports per trade (rooms report card-count or pip value; no
 *    market model here). A pair is flagged when, across >= 3 distinct games,
 *    |net transfer| >= 15 AND the imbalance |net|/gross >= 0.5 — the ratio
 *    keeps high-volume but balanced trading partners from being flagged on
 *    net alone. Same-operator trades (house vs house) are ignored.
 *
 * Known limits (honest by design): no significance testing, no positional
 * eval, score percentile conflates "winning" with "scored high historically",
 * trade value trusts the reporter's unit. Thresholds are exported constants.
 */

import { hashJson } from '../crypto/canonical.ts';
import type { GameResult, Json, PlayerId } from '../kernel/types.ts';
import { playerId } from '../kernel/types.ts';
import type { DocketEntry, DocketRepo } from './docket.ts';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ScreenSeat {
  player: PlayerId;
  agent_id: string;
  operator_id: string;
}

export interface ScreenGame {
  game_id: string;
  game: string;
  variant: string;
  division: string;
  seats: ScreenSeat[];
  result: GameResult;
  /** Set when the game ended by resignation; who resigned. */
  resigned_player: PlayerId | null;
}

export interface TradeRecord {
  game_id: string;
  from_agent: string;
  to_agent: string;
  from_operator: string;
  to_operator: string;
  /** Net value of this trade from `from` to `to` in the reporter's unit (>= 0). */
  value: number;
}

export interface IntegrityFlag {
  kind: 'screen:resign_won_position' | 'screen:trade_bias';
  subject: Json;
  reason: string;
}

// ---------------------------------------------------------------------------
// Screen 1: resignation while holding a top-decile final score
// ---------------------------------------------------------------------------

export const RESIGN_SCREEN_PERCENTILE = 0.9;
export const RESIGN_SCREEN_MIN_SAMPLES = 20;

export function screenResignations(
  games: readonly ScreenGame[],
  opts: { percentile?: number; minSamples?: number } = {},
): IntegrityFlag[] {
  const percentile = opts.percentile ?? RESIGN_SCREEN_PERCENTILE;
  const minSamples = opts.minSamples ?? RESIGN_SCREEN_MIN_SAMPLES;

  // Pool final scores per (game, variant).
  const pools = new Map<string, number[]>();
  const poolKey = (g: ScreenGame): string => `${g.game} ${g.variant}`;
  for (const g of games) {
    const scores = g.result.scores;
    if (!scores) continue;
    const pool = pools.get(poolKey(g)) ?? [];
    for (const seat of g.seats) {
      const s = scores[seat.player];
      if (typeof s === 'number' && Number.isFinite(s)) pool.push(s);
    }
    pools.set(poolKey(g), pool);
  }
  for (const pool of pools.values()) pool.sort((a, b) => a - b);

  const flags: IntegrityFlag[] = [];
  for (const g of games) {
    if (g.resigned_player === null) continue;
    const scores = g.result.scores;
    if (!scores) continue; // no score table for this game type: skip (documented limit)
    const pool = pools.get(poolKey(g));
    if (!pool || pool.length < minSamples) continue;
    const seat = g.seats.find((s) => s.player === g.resigned_player);
    if (!seat) continue;
    const own = scores[seat.player];
    if (typeof own !== 'number' || !Number.isFinite(own)) continue;
    let atOrBelow = 0;
    for (const s of pool) if (s <= own) atOrBelow++;
    const rank = atOrBelow / pool.length;
    if (rank >= percentile) {
      flags.push({
        kind: 'screen:resign_won_position',
        subject: {
          agent_id: seat.agent_id,
          operator_id: seat.operator_id,
          game_id: g.game_id,
          game: g.game,
          variant: g.variant,
          score: own,
          percentile_rank: Math.round(rank * 1000) / 1000,
          pool_size: pool.length,
        },
        reason:
          `agent ${seat.agent_id} resigned game ${g.game_id} holding a final score of ${own}, ` +
          `at the ${Math.round(rank * 100)}th percentile of ${pool.length} recorded final scores ` +
          `for ${g.game}/${g.variant}`,
      });
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Screen 2: systematic trade bias between one operator pair
// ---------------------------------------------------------------------------

export const TRADE_SCREEN_MIN_NET = 15;
export const TRADE_SCREEN_MIN_GAMES = 3;
export const TRADE_SCREEN_MIN_IMBALANCE = 0.5;

export function screenTradeBias(
  trades: readonly TradeRecord[],
  opts: { minNet?: number; minGames?: number; minImbalance?: number } = {},
): IntegrityFlag[] {
  const minNet = opts.minNet ?? TRADE_SCREEN_MIN_NET;
  const minGames = opts.minGames ?? TRADE_SCREEN_MIN_GAMES;
  const minImbalance = opts.minImbalance ?? TRADE_SCREEN_MIN_IMBALANCE;

  interface PairAgg {
    opA: string; // lexicographically smaller operator
    opB: string;
    net: number; // positive = value flowed A -> B
    gross: number;
    games: Set<string>;
  }
  const pairs = new Map<string, PairAgg>();

  for (const t of trades) {
    if (!(t.value >= 0) || !Number.isFinite(t.value)) {
      throw new Error(`screenTradeBias: trade value must be a finite number >= 0, got ${t.value}`);
    }
    if (t.from_operator === t.to_operator) continue; // same operator (house): ignore
    const [opA, opB] =
      t.from_operator < t.to_operator
        ? [t.from_operator, t.to_operator]
        : [t.to_operator, t.from_operator];
    const key = `${opA} ${opB}`;
    let agg = pairs.get(key);
    if (!agg) {
      agg = { opA, opB, net: 0, gross: 0, games: new Set() };
      pairs.set(key, agg);
    }
    agg.net += t.from_operator === opA ? t.value : -t.value;
    agg.gross += t.value;
    agg.games.add(t.game_id);
  }

  const flags: IntegrityFlag[] = [];
  for (const key of [...pairs.keys()].sort()) {
    const agg = pairs.get(key)!;
    const absNet = Math.abs(agg.net);
    if (agg.games.size < minGames || absNet < minNet || agg.gross === 0) continue;
    const imbalance = absNet / agg.gross;
    if (imbalance < minImbalance) continue;
    const [beneficiary, donor] = agg.net > 0 ? [agg.opB, agg.opA] : [agg.opA, agg.opB];
    flags.push({
      kind: 'screen:trade_bias',
      subject: {
        operator_pair: [agg.opA, agg.opB],
        donor_operator: donor,
        beneficiary_operator: beneficiary,
        net_value: absNet,
        gross_value: agg.gross,
        imbalance: Math.round(imbalance * 1000) / 1000,
        games: [...agg.games].sort(),
      },
      reason:
        `net value ${absNet} (of ${agg.gross} gross, imbalance ${Math.round(imbalance * 100)}%) ` +
        `flowed from operator ${donor} to operator ${beneficiary} across ` +
        `${agg.games.size} games`,
    });
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Filing flags on the docket (disposition 'watching'), deduplicated
// ---------------------------------------------------------------------------

/**
 * Appends each flag to the docket with disposition 'watching'. A flag whose
 * (kind, subject hash) already exists on the docket is skipped, so repeated
 * cron sweeps do not spam duplicates. Subject rows carry `subject_sha256` for
 * that purpose.
 */
export async function fileFlags(
  flags: readonly IntegrityFlag[],
  docket: DocketRepo,
  now?: string,
): Promise<DocketEntry[]> {
  const existing = await docket.list();
  const seen = new Set<string>();
  for (const e of existing) {
    const subj = e.subject_json;
    if (subj !== null && typeof subj === 'object' && !Array.isArray(subj)) {
      const h = (subj as { [k: string]: Json }).subject_sha256;
      if (typeof h === 'string') seen.add(`${e.kind} ${h}`);
    }
  }

  const filed: DocketEntry[] = [];
  for (const flag of flags) {
    const h = hashJson(flag.subject);
    const dedupe = `${flag.kind} ${h}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const subject_json: Json =
      flag.subject !== null && typeof flag.subject === 'object' && !Array.isArray(flag.subject)
        ? { ...(flag.subject as { [k: string]: Json }), subject_sha256: h }
        : { subject: flag.subject, subject_sha256: h };
    filed.push(
      await docket.append({
        kind: flag.kind,
        subject_json,
        reason: flag.reason,
        disposition: 'watching',
        ...(now !== undefined ? { created_at: now } : {}),
      }),
    );
  }
  return filed;
}

/** Convenience: seat helper for tests and rooms building ScreenGame rows. */
export function screenSeat(seat: number, agent_id: string, operator_id: string): ScreenSeat {
  return { player: playerId(seat), agent_id, operator_id };
}
