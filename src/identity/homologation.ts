/**
 * Per-season homologation (spec §identity_and_integrity.homologation).
 *
 * hash = sha256 over canonical JSON of EXACTLY this field set:
 *   { agent_id, season_id, model_id, adapter_kind, endpoint_url_or_null,
 *     system_prompt_sha256, config_sha256, tool_access: 'pure' | 'engine-assisted' }
 * (canonicalJson sorts keys, so the serialized order is: adapter_kind,
 * agent_id, config_sha256, endpoint_url_or_null, model_id, season_id,
 * system_prompt_sha256, tool_access.)
 *
 * Division ('pure' | 'open') selects the leaderboard; tool_access is the
 * declared capability inside the hash. Filing an entry whose hash differs
 * from the active one voids the season standing: the old row gets voided_at
 * and a fresh row is created. Filing an identical hash is idempotent.
 */

import { canonicalJson, sha256Hex } from '../crypto/canonical.ts';
import type { Json } from '../kernel/types.ts';
import type { ApiEnv } from '../api/env.ts';
import { err, ok, type ApiResult } from '../api/http.ts';

export type Division = 'pure' | 'open';
export type ToolAccess = 'pure' | 'engine-assisted';

export interface HomologationFields {
  agent_id: string;
  season_id: string;
  model_id: string;
  adapter_kind: string;
  endpoint_url_or_null: string | null;
  system_prompt_sha256: string;
  config_sha256: string;
  tool_access: ToolAccess;
}

export function homologationHash(fields: HomologationFields): string {
  return sha256Hex(canonicalJson(fields as unknown as Json));
}

const SHA256_RE = /^[0-9a-f]{64}$/;

export interface HomologateBody {
  season_id: string;
  division: Division;
  model_id: string;
  adapter_kind: string;
  endpoint_url: string | null;
  system_prompt_sha256: string;
  config_sha256: string;
  tool_access: ToolAccess;
}

export function validateHomologateBody(body: unknown): HomologateBody | ApiResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return err(400, 'BAD_BODY', 'Body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;
  const season_id = b.season_id;
  if (typeof season_id !== 'string' || season_id.length < 1 || season_id.length > 64) {
    return err(400, 'BAD_SEASON', 'season_id must be a 1-64 character string.');
  }
  const division = b.division;
  if (division !== 'pure' && division !== 'open') {
    return err(400, 'BAD_DIVISION', "division must be 'pure' or 'open'.");
  }
  const model_id = b.model_id;
  if (typeof model_id !== 'string' || model_id.length < 1 || model_id.length > 128) {
    return err(400, 'BAD_MODEL_ID', 'model_id must be a 1-128 character string.');
  }
  const adapter_kind = b.adapter_kind;
  if (typeof adapter_kind !== 'string' || adapter_kind.length < 1 || adapter_kind.length > 64) {
    return err(400, 'BAD_ADAPTER_KIND', 'adapter_kind must be a 1-64 character string.');
  }
  const endpoint_url = b.endpoint_url ?? null;
  if (endpoint_url !== null && (typeof endpoint_url !== 'string' || endpoint_url.length > 512)) {
    return err(400, 'BAD_ENDPOINT_URL', 'endpoint_url must be null or a string of at most 512 characters.');
  }
  const system_prompt_sha256 = b.system_prompt_sha256;
  if (typeof system_prompt_sha256 !== 'string' || !SHA256_RE.test(system_prompt_sha256)) {
    return err(400, 'BAD_SYSTEM_PROMPT_HASH', 'system_prompt_sha256 must be 64 lowercase hex characters.');
  }
  const config_sha256 = b.config_sha256;
  if (typeof config_sha256 !== 'string' || !SHA256_RE.test(config_sha256)) {
    return err(400, 'BAD_CONFIG_HASH', 'config_sha256 must be 64 lowercase hex characters.');
  }
  const tool_access = b.tool_access;
  if (tool_access !== 'pure' && tool_access !== 'engine-assisted') {
    return err(400, 'BAD_TOOL_ACCESS', "tool_access must be 'pure' or 'engine-assisted'.");
  }
  if (division === 'pure' && tool_access !== 'pure') {
    return err(400, 'DIVISION_MISMATCH', "The pure division requires tool_access 'pure'.");
  }
  return {
    season_id, division, model_id, adapter_kind,
    endpoint_url: endpoint_url as string | null,
    system_prompt_sha256, config_sha256, tool_access,
  };
}

export interface HomologationRow {
  id: string;
  agent_id: string;
  season_id: string;
  division: string;
  hash: string;
  fields_json: string;
  created_at: string;
  voided_at: string | null;
}

/** Caller has authenticated the agent and checked agent_id ownership. */
export async function homologate(env: ApiEnv, agentId: string, body: HomologateBody): Promise<ApiResult> {
  const fields: HomologationFields = {
    agent_id: agentId,
    season_id: body.season_id,
    model_id: body.model_id,
    adapter_kind: body.adapter_kind,
    endpoint_url_or_null: body.endpoint_url,
    system_prompt_sha256: body.system_prompt_sha256,
    config_sha256: body.config_sha256,
    tool_access: body.tool_access,
  };
  const hash = homologationHash(fields);
  const now = new Date(env.now()).toISOString();

  const active = await env.DB
    .prepare('SELECT id, hash, division FROM homologations WHERE agent_id = ? AND season_id = ? AND voided_at IS NULL')
    .bind(agentId, body.season_id)
    .first<{ id: string; hash: string; division: string }>();

  if (active && active.hash === hash && active.division === body.division) {
    return ok({ homologation_id: active.id, hash, division: body.division, season_id: body.season_id, unchanged: true });
  }

  let voided: string | null = null;
  if (active) {
    // Changing any field voids season standing (ratings reset is the match
    // layer's concern at the daily rating close; the voided_at marker is the
    // authoritative signal).
    await env.DB
      .prepare('UPDATE homologations SET voided_at = ? WHERE id = ?')
      .bind(now, active.id)
      .run();
    voided = active.id;
  }

  const id = 'h_' + sha256Hex(`ludus.homologation.v1:${agentId}:${body.season_id}:${hash}:${now}`).slice(0, 32);
  await env.DB
    .prepare(
      'INSERT INTO homologations (id, agent_id, season_id, division, hash, fields_json, created_at, voided_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
    )
    .bind(id, agentId, body.season_id, body.division, hash, canonicalJson(fields as unknown as Json), now)
    .run();

  return ok(
    {
      homologation_id: id,
      hash,
      division: body.division,
      season_id: body.season_id,
      voided_previous: voided,
      note: voided ? 'Previous homologation voided; season standing reset.' : 'First homologation this season.',
    },
    undefined,
    201,
  );
}
