/**
 * Best-effort KV token bucket: 120 requests/minute/IP on /api/*
 * (spec §matchmaking_and_ratings.quotas). KV is eventually consistent, so
 * this is a soft ceiling, not a security boundary — the hard guarantees are
 * signatures and daily quotas. A rate-limited request is REJECTED before any
 * quota logic runs, so it never spends a quota.
 */

import type { ApiEnv } from './env.ts';

export const RATE_CAPACITY = 120;
export const RATE_WINDOW_MS = 60_000;

interface Bucket {
  t: number; // tokens remaining (fractional)
  ts: number; // last refill, ms epoch
}

/** Returns true when the request may proceed. */
export async function allowRequest(env: ApiEnv, ip: string): Promise<boolean> {
  const key = `rl:${ip}`;
  const now = env.now();
  let bucket: Bucket = { t: RATE_CAPACITY, ts: now };
  try {
    const stored = await env.CACHE.get(key);
    if (stored !== null) {
      const parsed = JSON.parse(stored) as Partial<Bucket>;
      const t = Number(parsed.t);
      const ts = Number(parsed.ts);
      if (Number.isFinite(t) && Number.isFinite(ts)) bucket = { t, ts };
    }
  } catch {
    return true; // KV trouble: fail open, best effort
  }

  const elapsed = Math.max(0, now - bucket.ts);
  const refilled = Math.min(RATE_CAPACITY, bucket.t + (elapsed / RATE_WINDOW_MS) * RATE_CAPACITY);
  if (refilled < 1) {
    // No token: reject without writing (a rejected request spends nothing,
    // and not writing keeps a flooded key from churning KV).
    return false;
  }
  const next: Bucket = { t: refilled - 1, ts: now };
  try {
    await env.CACHE.put(key, JSON.stringify(next), { expirationTtl: 120 });
  } catch {
    /* best effort */
  }
  return true;
}
