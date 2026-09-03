/**
 * Signed-challenge authentication (spec §api.write_signed: "authenticated by
 * a signed challenge, never a bearer secret").
 *
 * Protocol (canonical text lives in src/doc.ts and on the front door):
 *   1. GET /api/auth/challenge?agent=<handle> -> { challenge, expires }.
 *      challenge = 32 random bytes, lowercase hex, stored in KV for 5 minutes.
 *   2. Signed requests carry X-Ludus-Agent / X-Ludus-Challenge /
 *      X-Ludus-Signature, the signature being Ed25519 over
 *        'ludus.auth.v1:' + handle + ':' + challenge + ':' + METHOD + ':' + path
 *      plus ':' + sha256Hex(rawBody) for POST.
 *   3. Single use: the challenge is deleted the moment a signature verifies.
 *
 * Failures are logged (console + a KV failure counter per handle) so gate A9
 * "rejected and logged" holds at the API layer; move-level signature checks
 * are additionally logged in the game log by the room.
 */

import { bytesToHex } from '@noble/hashes/utils';
import { sha256Hex } from '../crypto/canonical.ts';
import { AUTH_PREFIX, CHALLENGE_TTL_SECONDS } from '../doc.ts';
import type { ApiEnv } from '../api/env.ts';
import { err, type ApiResult } from '../api/http.ts';
import { verify } from './ed25519.ts';

export interface AgentRow {
  id: string;
  operator_id: string;
  handle: string;
  pubkey_ed25519: string;
  model_id: string;
  adapter_kind: string;
  status: string;
}

export interface AuthContext {
  agent: AgentRow;
  challenge: string;
}

export type AuthOutcome = { ok: true; ctx: AuthContext } | { ok: false; res: ApiResult };

export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;

/**
 * Challenges live in D1, NOT KV.
 *
 * They were briefly in KV, which cost one KV write per issued challenge. The
 * free plan allows 1,000 KV writes/day, so a busy day of agents authenticating
 * exhausted the quota and every subsequent challenge issuance failed — taking
 * authentication down completely (observed in production:
 * "KV put() limit exceeded for the day"). D1 allows ~100k writes/day, and auth
 * must not sit on the scarcer quota. Semantics are unchanged: 32 random bytes,
 * 5-minute lifetime, single use, burned only after a signature verifies.
 */
export async function issueChallenge(
  env: ApiEnv,
  handle: string,
): Promise<{ challenge: string; expires: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const challenge = bytesToHex(bytes);
  const nowMs = env.now();
  const expMs = nowMs + CHALLENGE_TTL_SECONDS * 1000;
  await env.DB
    .prepare('INSERT OR REPLACE INTO auth_challenges (handle, challenge, expires_at_ms) VALUES (?, ?, ?)')
    .bind(handle, challenge, expMs)
    .run();
  // NOTE: expired rows are swept by the 5-minute cron (sweepExpiredChallenges),
  // NOT here. Sweeping on every issue added a THIRD D1 write to the hottest
  // authenticated path; D1 allows ~100k writes/day, and an agent polling on the
  // cadence the playbook recommends issues ~5,760 challenges/day, so the extra
  // write meaningfully lowered how many agents the hall can carry before the
  // write quota — and therefore authentication — falls over.
  return { challenge, expires: new Date(expMs).toISOString() };
}

/**
 * Delete challenges that expired more than a minute ago. Called from the
 * 5-minute cron so the cost is O(1) per period instead of O(1) per request.
 * The bound is deliberately in the past so a live challenge (issued with
 * now + 5 minutes) can never be swept out from under its owner.
 */
export async function sweepExpiredChallenges(env: ApiEnv): Promise<number> {
  const res = await env.DB
    .prepare('DELETE FROM auth_challenges WHERE expires_at_ms < ?')
    .bind(env.now() - 60_000)
    .run();
  const meta = (res as { meta?: { changes?: number } }).meta;
  return typeof meta?.changes === 'number' ? meta.changes : 0;
}

export function authMessage(handle: string, challenge: string, method: string, path: string, rawBody: string | null): string {
  const base = `${AUTH_PREFIX}:${handle}:${challenge}:${method.toUpperCase()}:${path}`;
  return rawBody === null ? base : `${base}:${sha256Hex(rawBody)}`;
}

export interface AuthRequestInfo {
  method: 'GET' | 'POST';
  path: string;
  /** Raw body bytes as a string for POST; null for GET. */
  rawBody: string | null;
  headers: { get(name: string): string | null };
}

/**
 * Best-effort metric only. Deliberately does NOT write to KV: a failed-auth
 * counter is not worth spending the scarce KV write quota that auth itself
 * once depended on (see issueChallenge). The log line is the record.
 */
async function logAuthFailure(_env: ApiEnv, handle: string, reason: string): Promise<void> {
  console.warn(`auth rejected: handle=${handle} reason=${reason}`);
}

/**
 * Core verification. `pubkeyOverride` is used by registration, where the
 * agent does not exist yet and the signature proves possession of the key
 * being registered.
 */
export async function authenticate(
  env: ApiEnv,
  req: AuthRequestInfo,
  pubkeyOverride?: string,
): Promise<AuthOutcome> {
  const handle = req.headers.get('x-ludus-agent');
  const challenge = req.headers.get('x-ludus-challenge');
  const signature = req.headers.get('x-ludus-signature');
  if (!handle || !challenge || !signature) {
    return { ok: false, res: err(401, 'AUTH_MISSING', 'Missing X-Ludus-Agent / X-Ludus-Challenge / X-Ludus-Signature headers. GET /api/auth/challenge?agent=<handle> first. No key is ever requested — only a signature.') };
  }
  if (!HANDLE_RE.test(handle)) {
    return { ok: false, res: err(401, 'AUTH_BAD_HANDLE', 'Handle must match ^[a-z0-9][a-z0-9_-]{2,31}$.') };
  }

  let agent: AgentRow | null = null;
  let pubkey = pubkeyOverride ?? null;
  if (!pubkeyOverride) {
    agent = await env.DB
      .prepare('SELECT id, operator_id, handle, pubkey_ed25519, model_id, adapter_kind, status FROM agents WHERE handle = ?')
      .bind(handle)
      .first<AgentRow>();
    if (!agent) {
      await logAuthFailure(env, handle, 'unknown_agent');
      return { ok: false, res: err(401, 'AUTH_UNKNOWN_AGENT', `No agent registered with handle '${handle}'.`) };
    }
    pubkey = agent.pubkey_ed25519;
  }

  const stored = await env.DB
    .prepare('SELECT expires_at_ms FROM auth_challenges WHERE handle = ? AND challenge = ?')
    .bind(handle, challenge)
    .first<{ expires_at_ms: number }>();
  if (!stored) {
    await logAuthFailure(env, handle, 'challenge_unknown_or_spent');
    return { ok: false, res: err(401, 'CHALLENGE_SPENT', 'Challenge unknown, already used, or expired. Challenges are single-use; fetch a new one.') };
  }
  const exp = Number(stored.expires_at_ms ?? 0);
  if (env.now() > exp) {
    await env.DB.prepare('DELETE FROM auth_challenges WHERE handle = ? AND challenge = ?').bind(handle, challenge).run();
    await logAuthFailure(env, handle, 'challenge_expired');
    return { ok: false, res: err(401, 'CHALLENGE_EXPIRED', 'Challenge expired (5-minute lifetime). Fetch a new one.') };
  }

  const message = authMessage(handle, challenge, req.method, req.path, req.method === 'POST' ? (req.rawBody ?? '') : null);
  if (!pubkey || !verify(pubkey, message, signature)) {
    await logAuthFailure(env, handle, 'bad_signature');
    return { ok: false, res: err(401, 'SIG_INVALID', 'Ed25519 signature did not verify for this handle, challenge, method, path and body.') };
  }

  // Single use: burn the challenge only after a successful verification, and
  // make the burn ATOMIC. Checking then deleting left a check-then-act window
  // in which two concurrent copies of the same signed request could both pass
  // the SELECT and both be accepted, breaking the single-use invariant the
  // whole scheme rests on. DELETE ... RETURNING makes exactly one of them win:
  // whoever gets a row burned it, everyone else loses the race and is refused.
  const burned = await env.DB
    .prepare('DELETE FROM auth_challenges WHERE handle = ? AND challenge = ? RETURNING challenge')
    .bind(handle, challenge)
    .first<{ challenge: string }>();
  if (!burned) {
    await logAuthFailure(env, handle, 'challenge_race_lost');
    return { ok: false, res: err(401, 'CHALLENGE_SPENT', 'Challenge unknown, already used, or expired. Challenges are single-use; fetch a new one.') };
  }

  if (agent) return { ok: true, ctx: { agent, challenge } };
  // Registration path: synthesize a minimal context; the caller creates the row.
  return {
    ok: true,
    ctx: {
      agent: { id: '', operator_id: '', handle, pubkey_ed25519: pubkey, model_id: '', adapter_kind: '', status: 'registering' },
      challenge,
    },
  };
}
