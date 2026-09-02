/**
 * Glicko-2 rating system (Glickman, "Example of the Glicko-2 system",
 * http://www.glicko.net/glicko/glicko2.pdf), system constant tau = 0.5.
 *
 * One call to `rate()` = one rating period (Ludus closes them daily at
 * 00:00 UTC; see src/match/seasons.ts). All of a player's results in the
 * period go into a single call; opponents' ratings are their values at the
 * START of the period, per the paper.
 *
 * Multiplayer games rate by finishing position using pairwise decomposition:
 * each pair of finishers contributes one head-to-head result (better position
 * = win, equal position = 0.5), and all pairs land in the same period update.
 * `standingsFromResult` + `pairwiseResults` implement that decomposition.
 *
 * Gate A13: the worked example in Glickman's paper is a KAT in
 * src/match/tests/glicko2.test.ts.
 */

import { playerId, type GameResult } from '../kernel/types.ts';

/** Glicko-2 <-> Glicko-1 scale factor from the paper. */
const SCALE = 173.7178;
/** Convergence tolerance for the volatility iteration (paper's epsilon). */
const EPSILON = 1e-6;

/** System constant constraining volatility change per period (frozen for Ludus). */
export const GLICKO2_TAU = 0.5;

/** New agents start here (paper defaults). */
export const DEFAULT_GLICKO2: Glicko2Rating = { rating: 1500, rd: 350, vol: 0.06 };

/** RD never exceeds the unrated default. */
export const MAX_RD = 350;

/** An agent is provisional until it has this many rated games. */
export const PROVISIONAL_GAMES = 20;

export function isProvisional(gamesPlayed: number): boolean {
  return gamesPlayed < PROVISIONAL_GAMES;
}

export interface Glicko2Rating {
  /** Glicko-1 scale rating (1500 = default). */
  rating: number;
  /** Rating deviation on the Glicko-1 scale. */
  rd: number;
  /** Volatility sigma (Glicko-2 scale, ~0.06). */
  vol: number;
}

export interface Glicko2Result {
  opponentRating: number;
  opponentRd: number;
  /** 1 = win, 0.5 = draw/tie, 0 = loss. */
  score: number;
}

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function expectedScore(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/**
 * One rating-period update. With no results, only the RD grows
 * (step 6 of the paper: phi' = sqrt(phi^2 + sigma^2)), capped at MAX_RD.
 */
export function rate(
  player: Glicko2Rating,
  results: readonly Glicko2Result[],
  tau: number = GLICKO2_TAU,
): Glicko2Rating {
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.vol;

  if (results.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return { rating: player.rating, rd: Math.min(phiStar * SCALE, MAX_RD), vol: sigma };
  }

  // Step 3: estimated variance v; Step 4: estimated improvement delta.
  let vInv = 0;
  let deltaSum = 0; // sum of g(phi_j) * (s_j - E_j)
  for (const r of results) {
    if (r.score < 0 || r.score > 1) throw new Error(`glicko2: score out of range: ${r.score}`);
    const muJ = (r.opponentRating - 1500) / SCALE;
    const phiJ = r.opponentRd / SCALE;
    const gJ = g(phiJ);
    const eJ = expectedScore(mu, muJ, phiJ);
    vInv += gJ * gJ * eJ * (1 - eJ);
    deltaSum += gJ * (r.score - eJ);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // Step 5: new volatility via the Illinois-method iteration from the paper.
  const a = Math.log(sigma * sigma);
  const tau2 = tau * tau;
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const phi2v = phi * phi + v;
    return (ex * (delta * delta - phi2v - ex)) / (2 * (phi2v + ex) * (phi2v + ex)) - (x - a) / tau2;
  };

  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > EPSILON) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  const sigmaPrime = Math.exp(A / 2);

  // Steps 6-8: new RD and rating.
  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = mu + phiPrime * phiPrime * deltaSum;

  return {
    rating: 1500 + SCALE * muPrime,
    rd: Math.min(SCALE * phiPrime, MAX_RD),
    vol: sigmaPrime,
  };
}

// ---------------------------------------------------------------------------
// Multiplayer pairwise decomposition
// ---------------------------------------------------------------------------

export interface Standing {
  agent_id: string;
  /** Rating at the START of the rating period. */
  rating: Glicko2Rating;
  /** 1 = best. Equal position = tie for that pair. Gaps are irrelevant (ordinal). */
  position: number;
}

/**
 * Decomposes one finished multiplayer game into head-to-head results:
 * every pair of players contributes exactly one result to each member
 * (better position = 1, tie = 0.5, worse = 0). A two-player game reduces to
 * the ordinary single result. Returned map: agent_id -> results from this game.
 */
export function pairwiseResults(standings: readonly Standing[]): Map<string, Glicko2Result[]> {
  const out = new Map<string, Glicko2Result[]>();
  for (const s of standings) out.set(s.agent_id, []);
  for (let i = 0; i < standings.length; i++) {
    const si = standings[i]!;
    for (let j = i + 1; j < standings.length; j++) {
      const sj = standings[j]!;
      const scoreI = si.position < sj.position ? 1 : si.position === sj.position ? 0.5 : 0;
      out.get(si.agent_id)!.push({
        opponentRating: sj.rating.rating,
        opponentRd: sj.rating.rd,
        score: scoreI,
      });
      out.get(sj.agent_id)!.push({
        opponentRating: si.rating.rating,
        opponentRd: si.rating.rd,
        score: 1 - scoreI,
      });
    }
  }
  return out;
}

/**
 * Finishing positions from a kernel GameResult for the agents seated in order
 * (seat i = playerId(i) = agent seatAgents[i]).
 *
 *  - result.scores present: rank by score descending, competition ranking
 *    (equal scores share a position).
 *  - draw with no scores: everybody ties.
 *  - otherwise: winners position 1, everyone else position 2.
 */
export function standingsFromResult(
  seatAgents: readonly string[],
  result: GameResult,
): { agent_id: string; position: number }[] {
  const n = seatAgents.length;
  const scores = result.scores;
  if (scores && Object.keys(scores).length > 0) {
    // Winners outrank non-winners regardless of score: a decisive result with
    // flat scores (e.g. a forfeit win where every score is 0) must not rate as
    // a draw. Within the same winner/non-winner class, rank by score.
    const winners = new Set(result.draw ? [] : result.winners);
    const rows = seatAgents.map((agent_id, seat) => ({
      agent_id,
      win: winners.has(playerId(seat)) ? 1 : 0,
      score: scores[playerId(seat)] ?? Number.NEGATIVE_INFINITY,
    }));
    const beats = (a: (typeof rows)[number], b: (typeof rows)[number]): boolean =>
      a.win !== b.win ? a.win > b.win : a.score > b.score;
    const positions = new Map<string, number>();
    for (const row of rows) {
      // Competition ranking: position = 1 + number of players strictly ahead.
      let better = 0;
      for (const other of rows) if (beats(other, row)) better++;
      positions.set(row.agent_id, better + 1);
    }
    return seatAgents.map((agent_id) => ({ agent_id, position: positions.get(agent_id)! }));
  }
  if (result.draw) {
    return seatAgents.map((agent_id) => ({ agent_id, position: 1 }));
  }
  const winners = new Set<string>();
  for (const p of result.winners) {
    const seat = Number(p.slice(1));
    if (seat >= 0 && seat < n) winners.add(seatAgents[seat]!);
  }
  return seatAgents.map((agent_id) => ({ agent_id, position: winners.has(agent_id) ? 1 : 2 }));
}
