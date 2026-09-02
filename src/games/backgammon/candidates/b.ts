/**
 * Candidate "b" — independent backgammon complete-turn enumerator.
 *
 * Written from the rules of backgammon alone (no reference to the incumbent
 * implementation). Self-contained: no imports.
 *
 * POSITION MODEL (fixed convention, mover's perspective):
 *   - points: length-24 array. points[i] is the SIGNED checker count on point
 *     i+1 as counted from the MOVER's perspective. The mover moves from higher
 *     points toward point 1 and bears off from points 1-6 (the mover's home
 *     board). Positive = mover's checkers, negative = opponent's checkers.
 *   - bar: [moverCheckersOnBar, opponentCheckersOnBar]
 *   - off: [moverCheckersBorneOff, opponentCheckersBorneOff]
 *
 * TURN MODEL:
 *   legalTurns(pos, dice) returns the complete set of maximal legal turns.
 *   Each turn is an ordered list of hops "from/to" where from ∈ 24..1 | 'bar'
 *   and to ∈ 24..1 | 'off' (all mover perspective). Doubles allow up to four
 *   hops. Hits are not annotated (no '*'): a hop landing on an opponent blot
 *   always hits it; the hit is implied by the position.
 *
 * RULES IMPLEMENTED:
 *   - Bar entry first: while the mover has any checker on the bar, the only
 *     legal hops are entries. A die d enters on point 25 - d.
 *   - A point holding 2+ opponent checkers is blocked. A point holding exactly
 *     one opponent checker (a blot) may be landed on; the blot is hit and sent
 *     to the opponent's bar.
 *   - Bearing off is legal only when all 15 of the mover's checkers are on
 *     points 1-6 or already off (none on the bar). A checker on point p bears
 *     off with an exact die (d === p), or with a larger die (d > p) only if no
 *     mover checker sits on any higher point p+1..6 (the "overshoot from the
 *     highest occupied point" rule). An overshoot while a higher point is
 *     occupied is ILLEGAL.
 *   - Maximality: the mover must play as many dice as can legally be played
 *     (both dice of a non-double when any ordering allows it; up to four of a
 *     double). If only one die of a non-double can be played and either die
 *     could individually be played, the LARGER die must be played.
 *   - Dance: if no die can be played at all, the result is [] (an empty list
 *     of turns — NOT [[]]). The caller interprets [] as "no legal turn; the
 *     mover forfeits the roll".
 *
 * OUTPUT CANONICALIZATION:
 *   - Turns are deduplicated by the MULTISET of their hops. Two orderings of
 *     the same multiset of hops always produce the identical resulting
 *     position (opponent blots never move during the mover's turn, so a blot
 *     on some point is hit iff any hop of the multiset lands there,
 *     independent of order). Turns whose hop multisets differ are kept
 *     distinct even if they happen to reach the same final position by
 *     different intermediate points (e.g. 24/23 23/20 vs 24/21 21/20), since
 *     they are distinct plays under backgammon rules (they can differ in
 *     hits on the intermediate point).
 *   - Within a turn, hops are listed in canonical order: descending from-point
 *     ('bar' = 25), ties broken by descending to-point ('off' = 0).
 *   - The list of turns is sorted by comparing turns hop-by-hop with the same
 *     (from descending, then to descending) ordering; i.e. turns that move
 *     from higher points sort first.
 */

export interface BgPos {
  points: number[];
  bar: [number, number];
  off: [number, number];
}

/** Pseudo from-point representing the bar in internal hop records. */
const BAR = 25;
/** Pseudo to-point representing borne-off in internal hop records. */
const OFF = 0;

interface Hop {
  from: number; // 1..24, or 25 for 'bar'
  to: number; // 1..24, or 0 for 'off'
  die: number; // die value that produced this hop
}

/** Mutable search state (mover perspective; opponent off count never changes). */
interface St {
  pts: number[]; // length 24, pts[p-1] = signed count on point p
  barM: number; // mover checkers on bar
  barO: number; // opponent checkers on bar (grows on hits)
  offM: number; // mover checkers borne off
}

function toState(pos: BgPos): St {
  if (pos.points.length !== 24) {
    throw new Error(`BgPos.points must have length 24, got ${pos.points.length}`);
  }
  return {
    pts: pos.points.slice(),
    barM: pos.bar[0],
    barO: pos.bar[1],
    offM: pos.off[0],
  };
}

function pointCount(s: St, p: number): number {
  const c = s.pts[p - 1];
  return c === undefined ? 0 : c;
}

/** True iff every mover checker is on points 1..6 or already borne off. */
function canBearOff(s: St): boolean {
  if (s.barM > 0) return false;
  for (let p = 7; p <= 24; p++) {
    if (pointCount(s, p) > 0) return false;
  }
  return true;
}

/** All legal single hops for one die in the given state. */
function singleHops(s: St, die: number): Hop[] {
  const hops: Hop[] = [];
  if (s.barM > 0) {
    // Bar entry only: die d enters on point 25 - d.
    const entry = 25 - die;
    if (pointCount(s, entry) >= -1) hops.push({ from: BAR, to: entry, die });
    return hops;
  }
  const bearing = canBearOff(s);
  for (let p = 24; p >= 1; p--) {
    if (pointCount(s, p) <= 0) continue;
    const dest = p - die;
    if (dest >= 1) {
      // Normal move: destination must not hold 2+ opponent checkers.
      if (pointCount(s, dest) >= -1) hops.push({ from: p, to: dest, die });
    } else if (bearing) {
      if (dest === 0) {
        // Exact bear-off.
        hops.push({ from: p, to: OFF, die });
      } else {
        // Overshoot (die > p): legal only if no mover checker on a higher point.
        let higherOccupied = false;
        for (let q = p + 1; q <= 6; q++) {
          if (pointCount(s, q) > 0) {
            higherOccupied = true;
            break;
          }
        }
        if (!higherOccupied) hops.push({ from: p, to: OFF, die });
      }
    }
  }
  return hops;
}

/** Apply a hop to a copy of the state (handles hits). */
function applyHop(s: St, h: Hop): St {
  const n: St = { pts: s.pts.slice(), barM: s.barM, barO: s.barO, offM: s.offM };
  if (h.from === BAR) {
    n.barM -= 1;
  } else {
    const c = n.pts[h.from - 1];
    n.pts[h.from - 1] = (c === undefined ? 0 : c) - 1;
  }
  if (h.to === OFF) {
    n.offM += 1;
  } else {
    const c = n.pts[h.to - 1];
    if (c === -1) {
      // Hit: opponent blot goes to the opponent's bar.
      n.pts[h.to - 1] = 1;
      n.barO += 1;
    } else {
      n.pts[h.to - 1] = (c === undefined ? 0 : c) + 1;
    }
  }
  return n;
}

/**
 * Depth-first enumeration of hop sequences for a fixed die order.
 * Records every terminal sequence, including partial ones (stuck early) and
 * the empty sequence when the first die has no legal hop; maximality is
 * enforced by the caller via a max-length filter.
 */
function enumerateSequences(start: St, dieOrder: number[]): Hop[][] {
  const out: Hop[][] = [];
  const acc: Hop[] = [];
  const rec = (s: St, i: number): void => {
    if (i >= dieOrder.length) {
      out.push(acc.slice());
      return;
    }
    const d = dieOrder[i];
    if (d === undefined) {
      out.push(acc.slice());
      return;
    }
    const hops = singleHops(s, d);
    if (hops.length === 0) {
      out.push(acc.slice());
      return;
    }
    for (const h of hops) {
      acc.push(h);
      rec(applyHop(s, h), i + 1);
      acc.pop();
    }
  };
  rec(start, 0);
  return out;
}

/** Canonical hop comparator: descending from, then descending to. */
function cmpHop(a: Hop, b: Hop): number {
  if (a.from !== b.from) return b.from - a.from;
  return b.to - a.to;
}

/** Turn comparator: element-wise cmpHop (all kept turns have equal length). */
function cmpTurn(a: Hop[], b: Hop[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ha = a[i];
    const hb = b[i];
    if (ha === undefined || hb === undefined) break;
    const c = cmpHop(ha, hb);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function hopToString(h: Hop): string {
  const from = h.from === BAR ? 'bar' : String(h.from);
  const to = h.to === OFF ? 'off' : String(h.to);
  return `${from}/${to}`;
}

/**
 * Enumerate every maximal legal turn for the mover.
 * Returns [] when the mover cannot play at all (dance / fully blocked).
 */
export function legalTurns(pos: BgPos, dice: [number, number]): string[][] {
  const [d1, d2] = dice;
  if (!Number.isInteger(d1) || !Number.isInteger(d2) || d1 < 1 || d1 > 6 || d2 < 1 || d2 > 6) {
    throw new Error(`invalid dice: [${d1}, ${d2}]`);
  }
  const start = toState(pos);

  const seqs: Hop[][] = [];
  if (d1 === d2) {
    seqs.push(...enumerateSequences(start, [d1, d1, d1, d1]));
  } else {
    seqs.push(...enumerateSequences(start, [d1, d2]));
    seqs.push(...enumerateSequences(start, [d2, d1]));
  }

  let maxLen = 0;
  for (const s of seqs) if (s.length > maxLen) maxLen = s.length;
  if (maxLen === 0) return []; // dance: no die playable

  let kept = seqs.filter((s) => s.length === maxLen);

  // Larger-die rule: with a non-double, when only one die can be played but
  // either die individually has a legal play, the larger die must be used.
  if (d1 !== d2 && maxLen === 1) {
    const hi = Math.max(d1, d2);
    const hiOnly = kept.filter((s) => s[0] !== undefined && s[0].die === hi);
    if (hiOnly.length > 0) kept = hiOnly;
  }

  // Dedup by multiset of hops (canonical order makes the multiset a key);
  // the die value is intentionally excluded from the key because the same
  // hop reached via a different die yields the identical resulting position
  // (only possible for bear-off overshoots).
  const byKey = new Map<string, Hop[]>();
  for (const s of kept) {
    const canonical = s.slice().sort(cmpHop);
    const key = canonical.map(hopToString).join(',');
    if (!byKey.has(key)) byKey.set(key, canonical);
  }

  const turns = [...byKey.values()].sort(cmpTurn);
  return turns.map((t) => t.map(hopToString));
}
