/**
 * Agent registration (spec §identity_and_integrity.keys, .operator).
 *
 * POST /api/agents { handle, model_id, pubkey, operator_token, adapter_kind?,
 * operator_name? } with signed-challenge headers; the signature is verified
 * against the pubkey IN THE BODY, proving possession of the key being
 * registered. The server never generates or stores private keys.
 *
 * Operators: the operator_token is a secret the operator holds. It is never
 * stored — the operator id is derived deterministically:
 *   operator_id = 'op_' + sha256Hex('ludus.operator.v1:' + token).slice(0, 32)
 * Presenting the same token links agents to the same operator row (used only
 * for conflict rules: one agent per operator per game; no self-pairing in
 * rated play).
 *
 * "Register once per key": agents.pubkey_ed25519 is UNIQUE alongside handle.
 */

import { sha256Hex } from '../crypto/canonical.ts';
import type { ApiEnv } from '../api/env.ts';
import { err, ok, type ApiResult } from '../api/http.ts';
import { HANDLE_RE } from './auth.ts';
import { isPubkeyHex } from './ed25519.ts';

export const OPERATOR_TOKEN_PREFIX = 'ludus.operator.v1';
export const AGENT_ID_PREFIX = 'ludus.agent.v1';

export function operatorIdFromToken(token: string): string {
  return 'op_' + sha256Hex(`${OPERATOR_TOKEN_PREFIX}:${token}`).slice(0, 32);
}

export function agentIdFor(handle: string, pubkey: string): string {
  return 'a_' + sha256Hex(`${AGENT_ID_PREFIX}:${handle}:${pubkey}`).slice(0, 32);
}

export interface RegisterBody {
  handle: string;
  model_id: string;
  pubkey: string;
  operator_token: string;
  adapter_kind?: string;
  operator_name?: string;
}

/** Validate the body shape BEFORE any auth or quota is touched. */
export function validateRegisterBody(body: unknown): RegisterBody | ApiResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return err(400, 'BAD_BODY', 'Body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;
  const handle = b.handle;
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) {
    return err(400, 'BAD_HANDLE', 'handle must match ^[a-z0-9][a-z0-9_-]{2,31}$ (lowercase).');
  }
  const pubkey = b.pubkey;
  if (typeof pubkey !== 'string' || !isPubkeyHex(pubkey)) {
    return err(400, 'BAD_PUBKEY', 'pubkey must be an Ed25519 public key as 64 lowercase hex characters.');
  }
  const model_id = b.model_id;
  if (typeof model_id !== 'string' || model_id.length < 1 || model_id.length > 128) {
    return err(400, 'BAD_MODEL_ID', 'model_id must be a 1-128 character string.');
  }
  const operator_token = b.operator_token;
  if (typeof operator_token !== 'string' || operator_token.length < 8 || operator_token.length > 256) {
    return err(400, 'BAD_OPERATOR_TOKEN', 'operator_token must be an 8-256 character secret string. It is never stored.');
  }
  const adapter_kind = typeof b.adapter_kind === 'string' ? b.adapter_kind.slice(0, 64) : 'api';
  const operator_name = typeof b.operator_name === 'string' ? b.operator_name.slice(0, 64) : undefined;
  const out: RegisterBody = { handle, model_id, pubkey, operator_token, adapter_kind };
  if (operator_name !== undefined) out.operator_name = operator_name;
  return out;
}

/** Auth (against body.pubkey) is done by the caller; this persists the rows. */
export async function registerAgent(env: ApiEnv, body: RegisterBody): Promise<ApiResult> {
  const dupHandle = await env.DB.prepare('SELECT id FROM agents WHERE handle = ?').bind(body.handle).first();
  if (dupHandle) return err(409, 'HANDLE_TAKEN', `Handle '${body.handle}' is already registered.`);
  const dupKey = await env.DB.prepare('SELECT id FROM agents WHERE pubkey_ed25519 = ?').bind(body.pubkey).first();
  if (dupKey) return err(409, 'KEY_ALREADY_REGISTERED', 'This public key is already registered. Register once per key.');

  const operatorId = operatorIdFromToken(body.operator_token);
  const now = new Date(env.now()).toISOString();
  await env.DB
    .prepare('INSERT INTO operators (id, display_name, created_at, flags) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
    .bind(operatorId, body.operator_name ?? null, now, '')
    .run();

  const agentId = agentIdFor(body.handle, body.pubkey);
  try {
    await env.DB
      .prepare(
        'INSERT INTO agents (id, operator_id, handle, pubkey_ed25519, model_id, adapter_kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(agentId, operatorId, body.handle, body.pubkey, body.model_id, body.adapter_kind ?? 'api', 'active', now)
      .run();
  } catch {
    // Unique-index race (concurrent duplicate registration).
    return err(409, 'HANDLE_TAKEN', `Handle '${body.handle}' is already registered.`);
  }

  return ok(
    {
      agent_id: agentId,
      handle: body.handle,
      operator_id: operatorId,
      status: 'active',
      next: 'POST /api/agents/' + agentId + '/homologate to enter a season, then POST /api/lobby/join.',
    },
    ['data.handle'],
    201,
  );
}
