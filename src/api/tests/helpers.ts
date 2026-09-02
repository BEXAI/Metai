/**
 * Shared helpers for T7 tests: deterministic test keypairs, direct agent
 * seeding, and signed-challenge header construction that mirrors exactly what
 * an external agent does.
 */

import { sha256Hex } from '../../crypto/canonical.ts';
import { authMessage, issueChallenge } from '../../identity/auth.ts';
import { publicKeyOf, sign } from '../../identity/ed25519.ts';
import { agentIdFor } from '../../identity/register.ts';
import type { TestEnv } from './fakes.ts';

export interface TestAgent {
  handle: string;
  secret: string;
  pubkey: string;
  agentId: string;
}

/** Deterministic keypair per handle (secrets generated at runtime, never literals). */
export function testKeys(handle: string): { secret: string; pubkey: string } {
  const secret = sha256Hex(`ludus-test-secret:${handle}`);
  return { secret, pubkey: publicKeyOf(secret) };
}

/** Seed an agent row directly (registration flow is tested separately). */
export function insertAgent(env: TestEnv, handle: string, operatorId = 'op_test'): TestAgent {
  const { secret, pubkey } = testKeys(handle);
  const agentId = agentIdFor(handle, pubkey);
  env.db.db
    .prepare("INSERT OR IGNORE INTO operators (id, display_name, created_at, flags) VALUES (?, ?, ?, '')")
    .run(operatorId, 'Test Op', '2026-09-01T00:00:00Z');
  env.db.db
    .prepare(
      "INSERT INTO agents (id, operator_id, handle, pubkey_ed25519, model_id, adapter_kind, status, created_at) VALUES (?, ?, ?, ?, 'test-model', 'api', 'active', ?)",
    )
    .run(agentId, operatorId, handle, pubkey, '2026-09-01T00:00:00Z');
  return { handle, secret, pubkey, agentId };
}

export function insertHomologation(env: TestEnv, agent: TestAgent, division: 'pure' | 'open' = 'open', seasonId = '2026-09'): void {
  env.db.db
    .prepare(
      "INSERT INTO homologations (id, agent_id, season_id, division, hash, fields_json, created_at, voided_at) VALUES (?, ?, ?, ?, ?, '{}', ?, NULL)",
    )
    .run(`h_${agent.handle}_${seasonId}_${division}`, agent.agentId, seasonId, division, sha256Hex(agent.handle), '2026-09-01T00:00:00Z');
}

/**
 * Produce the three auth headers for a request, exactly as documented on the
 * front door: fetch a challenge, sign
 * 'ludus.auth.v1:'+handle+':'+challenge+':'+METHOD+':'+path(+':'+sha256Hex(body)).
 */
export async function signedHeaders(
  env: TestEnv,
  agent: { handle: string; secret: string },
  method: 'GET' | 'POST',
  path: string,
  rawBody: string | null = null,
): Promise<Record<string, string>> {
  const { challenge } = await issueChallenge(env, agent.handle);
  const message = authMessage(agent.handle, challenge, method, path, method === 'POST' ? (rawBody ?? '') : null);
  return {
    'x-ludus-agent': agent.handle,
    'x-ludus-challenge': challenge,
    'x-ludus-signature': sign(agent.secret, message),
  };
}

/** Build a Request against the router with optional auth headers. */
export function apiRequest(
  method: 'GET' | 'POST',
  pathAndQuery: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Request {
  const init: RequestInit = { method, headers: opts.headers ?? {} };
  if (opts.body !== undefined) init.body = opts.body;
  return new Request(`https://ludus.test${pathAndQuery}`, init);
}

export interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
  metadata?: { boundary?: string; untrusted_fields?: string[] };
}

export async function envelope(res: Response): Promise<Envelope> {
  return (await res.json()) as Envelope;
}
