/**
 * In-isolate token bucket: 120 requests/minute/IP on /api/*
 * (spec §matchmaking_and_ratings.quotas).
 *
 * WHY NOT KV. This used to persist buckets in Workers KV, which meant ONE KV
 * WRITE PER ALLOWED REQUEST. The free plan allows ~1,000 KV writes/day, so a
 * single agent polling /api/pulse every 15s (5,760 requests/day, the cadence
 * the playbook itself recommends) exhausted the daily quota roughly six times
 * over. Once exhausted every KV write failed — including auth-challenge
 * issuance — which took authentication down completely
 * ("KV put() limit exceeded for the day"). A rate limiter must never be able
 * to break authentication.
 *
 * The trade is deliberate and small: buckets now live in isolate memory, so
 * the ceiling is per-isolate rather than global. That was ALREADY a soft
 * ceiling — KV is eventually consistent, and this module has always been
 * best-effort with signatures and daily quotas as the real guarantees. In
 * exchange we get zero quota consumption and one less network round-trip on
 * every single request. If a hard global limit is ever needed, Cloudflare's
 * own WAF rate-limiting rules are the right tool, not application state.
 */

import type { ApiEnv } from './env.ts';

export const RATE_CAPACITY = 120;
export const RATE_WINDOW_MS = 60_000;

/** Cap on tracked IPs so a spray of source addresses cannot grow memory without bound. */
const MAX_TRACKED_IPS = 10_000;

interface Bucket {
  /** Tokens remaining (fractional). */
  t: number;
  /** Last refill, ms epoch. */
  ts: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Drop entries that have fully refilled: a full bucket is indistinguishable
 * from an absent one, so evicting it is lossless.
 */
function evictIfNeeded(now: number): void {
  if (buckets.size <= MAX_TRACKED_IPS) return;
  for (const [ip, b] of buckets) {
    const refilled = b.t + ((now - b.ts) / RATE_WINDOW_MS) * RATE_CAPACITY;
    if (refilled >= RATE_CAPACITY) buckets.delete(ip);
  }
  // Still oversized (a genuine flood from many live IPs): drop oldest-first.
  if (buckets.size > MAX_TRACKED_IPS) {
    const excess = buckets.size - MAX_TRACKED_IPS;
    let dropped = 0;
    for (const ip of buckets.keys()) {
      buckets.delete(ip);
      if (++dropped >= excess) break;
    }
  }
}

/** Test-only: clear all buckets so each test starts from a known state. */
export function resetRateLimiter(): void {
  buckets.clear();
}

/** Returns true when the request may proceed. Never throws. */
export async function allowRequest(env: ApiEnv, ip: string): Promise<boolean> {
  const now = env.now();
  const stored = buckets.get(ip);
  const bucket: Bucket = stored ?? { t: RATE_CAPACITY, ts: now };

  const elapsed = Math.max(0, now - bucket.ts);
  const refilled = Math.min(RATE_CAPACITY, bucket.t + (elapsed / RATE_WINDOW_MS) * RATE_CAPACITY);
  if (refilled < 1) {
    // No token: reject without recording anything, so a flooded IP cannot
    // extend its own lockout and a rejected request spends nothing.
    return false;
  }
  buckets.set(ip, { t: refilled - 1, ts: now });
  evictIfNeeded(now);
  return true;
}
