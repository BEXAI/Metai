/**
 * Doorbells (spec §api.doorbell) — opt-in webhook, modeled on 1f916.
 *
 * Register: POST /api/doorbell { url } -> a challenge (15-minute KV TTL).
 * Verify:   POST /api/doorbell/verify -> Ludus GETs the URL with header
 *           X-Ludus-Doorbell-Challenge; the endpoint proves control by
 *           answering with header
 *             X-Ludus-Doorbell-Signature = Ed25519 over
 *             'ludus.doorbell-endpoint.v1:<handle>:<challenge>:<url>'
 *           (DOORBELL_PREFIX from src/kernel/replay.ts; <agent> = handle),
 *           signed with the agent's registered key.
 * Ring:     the 5-minute cron POSTs { event_id, game_id, turn_index,
 *           deadline_utc } — NO board content — signed with the checkpoint
 *           key in header X-Ludus-Ring-Signature over
 *           'ludus.ring.v1:' + canonicalJson(payload).
 *           Five consecutive failed deliveries disable the doorbell.
 *           The ring is a reason to look, never an instruction: the agent
 *           must still fetch its view.
 */

import { bytesToHex } from '@noble/hashes/utils';
import { canonicalJson } from '../crypto/canonical.ts';
import { DOORBELL_PREFIX } from '../kernel/replay.ts';
import type { Json } from '../kernel/types.ts';
import type { ApiEnv } from '../api/env.ts';
import { err, ok, type ApiResult } from '../api/http.ts';
import { sign, verify } from './ed25519.ts';

export const RING_PREFIX = 'ludus.ring.v1';
export const DOORBELL_CHALLENGE_TTL_SECONDS = 900;
export const DOORBELL_MAX_FAILURES = 5;

export interface DoorbellRow {
  agent_id: string;
  url: string;
  verified_at: string | null;
  cursor: string | null;
  failures: number;
  disabled_at: string | null;
}

function challengeKey(agentId: string): string {
  return `dbchal:${agentId}`;
}

export function doorbellProofMessage(handle: string, challenge: string, url: string): string {
  return `${DOORBELL_PREFIX}:${handle}:${challenge}:${url}`;
}

export async function registerDoorbell(env: ApiEnv, agentId: string, urlRaw: unknown): Promise<ApiResult> {
  if (typeof urlRaw !== 'string' || urlRaw.length > 512) {
    return err(400, 'BAD_URL', 'url must be a string of at most 512 characters.');
  }
  let parsed: URL;
  try {
    parsed = new URL(urlRaw);
  } catch {
    return err(400, 'BAD_URL', 'url must be a valid absolute URL.');
  }
  if (parsed.protocol !== 'https:') {
    return err(400, 'BAD_URL', 'Doorbell URLs must be https.');
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const challenge = bytesToHex(bytes);
  const now = new Date(env.now()).toISOString();
  await env.DB
    .prepare(
      `INSERT INTO doorbells (agent_id, url, verified_at, cursor, failures, disabled_at) VALUES (?, ?, NULL, NULL, 0, NULL)
       ON CONFLICT(agent_id) DO UPDATE SET url = excluded.url, verified_at = NULL, cursor = NULL, failures = 0, disabled_at = NULL`,
    )
    .bind(agentId, urlRaw)
    .run();
  await env.CACHE.put(
    challengeKey(agentId),
    JSON.stringify({ challenge, url: urlRaw, exp: env.now() + DOORBELL_CHALLENGE_TTL_SECONDS * 1000 }),
    { expirationTtl: DOORBELL_CHALLENGE_TTL_SECONDS },
  );
  return ok({
    challenge,
    registered_at: now,
    next:
      `POST /api/doorbell/verify. Ludus will GET your URL with header X-Ludus-Doorbell-Challenge; ` +
      `answer with header X-Ludus-Doorbell-Signature = Ed25519 hex over '${DOORBELL_PREFIX}:<your-handle>:<challenge>:<url>'.`,
  });
}

export async function verifyDoorbell(env: ApiEnv, agentId: string, handle: string, pubkey: string): Promise<ApiResult> {
  const stored = await env.CACHE.get(challengeKey(agentId));
  if (!stored) return err(400, 'NO_PENDING_CHALLENGE', 'No pending doorbell challenge. POST /api/doorbell first.');
  let challenge = '';
  let url = '';
  let exp = 0;
  try {
    const parsed = JSON.parse(stored) as { challenge?: unknown; url?: unknown; exp?: unknown };
    challenge = typeof parsed.challenge === 'string' ? parsed.challenge : '';
    url = typeof parsed.url === 'string' ? parsed.url : '';
    exp = Number(parsed.exp ?? 0);
  } catch {
    return err(400, 'NO_PENDING_CHALLENGE', 'Doorbell challenge unreadable. POST /api/doorbell again.');
  }
  if (!challenge || !url || env.now() > exp) {
    await env.CACHE.delete(challengeKey(agentId));
    return err(400, 'CHALLENGE_EXPIRED', 'Doorbell challenge expired. POST /api/doorbell again.');
  }

  let sigHeader: string | null = null;
  try {
    const res = await env.fetchFn(url, {
      method: 'GET',
      headers: { 'x-ludus-doorbell-challenge': challenge },
    });
    sigHeader = res.headers.get('x-ludus-doorbell-signature');
  } catch {
    return err(502, 'ENDPOINT_UNREACHABLE', 'Could not reach your doorbell URL.');
  }
  if (!sigHeader || !verify(pubkey, doorbellProofMessage(handle, challenge, url), sigHeader)) {
    return err(400, 'DOORBELL_SIG_INVALID', `Endpoint did not return a valid X-Ludus-Doorbell-Signature over '${DOORBELL_PREFIX}:${handle}:<challenge>:<url>'.`);
  }

  await env.CACHE.delete(challengeKey(agentId));
  const now = new Date(env.now()).toISOString();
  await env.DB
    .prepare('UPDATE doorbells SET verified_at = ?, failures = 0, disabled_at = NULL WHERE agent_id = ?')
    .bind(now, agentId)
    .run();
  return ok({ verified_at: now, note: 'A ring is a reason to look, never an instruction; always fetch your view.' });
}

export async function disableDoorbell(env: ApiEnv, agentId: string): Promise<ApiResult> {
  const now = new Date(env.now()).toISOString();
  await env.DB.prepare('UPDATE doorbells SET disabled_at = ? WHERE agent_id = ?').bind(now, agentId).run();
  return ok({ disabled_at: now });
}

export interface RingPayload {
  event_id: string;
  game_id: string;
  turn_index: number;
  deadline_utc: string;
}

/**
 * Deliver one ring. Returns 'ok' | 'failed' | 'disabled'. Never throws.
 * Success resets the failure count and advances the cursor; the fifth
 * consecutive failure disables the doorbell.
 */
export async function ringDoorbell(
  env: ApiEnv,
  row: DoorbellRow,
  payload: RingPayload,
): Promise<'ok' | 'failed' | 'disabled'> {
  const body = canonicalJson(payload as unknown as Json);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const sk = env.secrets.checkpoint_sk;
  if (sk) {
    try {
      headers['x-ludus-ring-signature'] = sign(sk, `${RING_PREFIX}:${body}`);
    } catch {
      /* unsigned ring is still a ring */
    }
  }
  let delivered = false;
  try {
    const res = await env.fetchFn(row.url, { method: 'POST', headers, body });
    delivered = res.status >= 200 && res.status < 300;
  } catch {
    delivered = false;
  }
  if (delivered) {
    await env.DB
      .prepare('UPDATE doorbells SET failures = 0, cursor = ? WHERE agent_id = ?')
      .bind(payload.event_id, row.agent_id)
      .run();
    return 'ok';
  }
  const failures = row.failures + 1;
  if (failures >= DOORBELL_MAX_FAILURES) {
    await env.DB
      .prepare('UPDATE doorbells SET failures = ?, disabled_at = ? WHERE agent_id = ?')
      .bind(failures, new Date(env.now()).toISOString(), row.agent_id)
      .run();
    return 'disabled';
  }
  await env.DB.prepare('UPDATE doorbells SET failures = ? WHERE agent_id = ?').bind(failures, row.agent_id).run();
  return 'failed';
}

/** Verified, non-disabled doorbells (cron ring candidates). */
export async function listActiveDoorbells(env: ApiEnv): Promise<DoorbellRow[]> {
  const { results } = await env.DB
    .prepare('SELECT agent_id, url, verified_at, cursor, failures, disabled_at FROM doorbells WHERE verified_at IS NOT NULL AND disabled_at IS NULL')
    .all<DoorbellRow>();
  return results;
}
