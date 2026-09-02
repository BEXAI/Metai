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

function challengeKey(handle: string, challenge: string): string {
  return `chal:${handle}:${challenge}`;
}

export async function issueChallenge(
  env: ApiEnv,
  handle: string,
): Promise<{ challenge: string; expires: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const challenge = bytesToHex(bytes);
  const expMs = env.now() + CHALLENGE_TTL_SECONDS * 1000;
  await env.CACHE.put(challengeKey(handle, challenge), JSON.stringify({ exp: expMs }), {
    expirationTtl: CHALLENGE_TTL_SECONDS,
  });
  return { challenge, expires: new Date(expMs).toISOString() };
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

async function logAuthFailure(env: ApiEnv, handle: string, reason: string): Promise<void> {
  console.warn(`auth rejected: handle=${handle} reason=${reason}`);
  try {
    const key = `authfail:${handle}`;
    const cur = Number((await env.CACHE.get(key)) ?? '0');
    await env.CACHE.put(key, String(cur + 1), { expirationTtl: 86_400 });
  } catch {
    /* metrics are best-effort */
  }
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

  const key = challengeKey(handle, challenge);
  const stored = await env.CACHE.get(key);
  if (stored === null) {
    await logAuthFailure(env, handle, 'challenge_unknown_or_spent');
    return { ok: false, res: err(401, 'CHALLENGE_SPENT', 'Challenge unknown, already used, or expired. Challenges are single-use; fetch a new one.') };
  }
  let exp = 0;
  try {
    exp = Number((JSON.parse(stored) as { exp?: unknown }).exp ?? 0);
  } catch {
    exp = 0;
  }
  if (env.now() > exp) {
    await env.CACHE.delete(key);
    await logAuthFailure(env, handle, 'challenge_expired');
    return { ok: false, res: err(401, 'CHALLENGE_EXPIRED', 'Challenge expired (5-minute lifetime). Fetch a new one.') };
  }

  const message = authMessage(handle, challenge, req.method, req.path, req.method === 'POST' ? (req.rawBody ?? '') : null);
  if (!pubkey || !verify(pubkey, message, signature)) {
    await logAuthFailure(env, handle, 'bad_signature');
    return { ok: false, res: err(401, 'SIG_INVALID', 'Ed25519 signature did not verify for this handle, challenge, method, path and body.') };
  }

  // Single use: burn the challenge only after a successful verification.
  await env.CACHE.delete(key);

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
