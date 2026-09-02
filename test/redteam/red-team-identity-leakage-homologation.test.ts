/**
 * RED TEAM red-team-identity-leakage — attack family 4: homologation
 * (spec §identity_and_integrity.homologation, acceptance A9).
 *
 * Attacks: change model_id / system_prompt hash / tool_access after
 * homologating WITHOUT a new hash + voided standing; check the hash formula
 * covers EXACTLY the spec field set under canonical JSON ordering; try to
 * collide two different field sets into one hash; homologate someone else's
 * agent; keep playing a division whose homologation was voided.
 */

import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../../src/crypto/canonical.ts';
import type { Json } from '../../src/kernel/types.ts';
import { homologationHash, type HomologationFields } from '../../src/identity/homologation.ts';
import { handleApiRequest } from '../../src/api/router.ts';
import { makeTestEnv, type TestEnv } from '../../src/api/tests/fakes.ts';
import { apiRequest, envelope, insertAgent, signedHeaders, type TestAgent } from '../../src/api/tests/helpers.ts';

const SYS_HASH = sha256Hex('system prompt v1');
const CFG_HASH = sha256Hex('config v1');

function homBody(overrides: Record<string, Json> = {}): Record<string, Json> {
  return {
    season_id: 's2026-09',
    division: 'open',
    model_id: 'model-x-1',
    adapter_kind: 'api',
    endpoint_url: null,
    system_prompt_sha256: SYS_HASH,
    config_sha256: CFG_HASH,
    tool_access: 'engine-assisted',
    ...overrides,
  };
}

async function postSigned(env: TestEnv, agent: TestAgent, path: string, body: Record<string, Json>, rawOverride?: string) {
  const raw = rawOverride ?? JSON.stringify(body);
  const headers = await signedHeaders(env, agent, 'POST', path, raw);
  return handleApiRequest(env, apiRequest('POST', path, { headers: { ...headers, 'content-type': 'application/json' }, body: raw }));
}

async function homologateOk(env: TestEnv, agent: TestAgent, body: Record<string, Json>) {
  const res = await postSigned(env, agent, `/api/agents/${agent.agentId}/homologate`, body);
  const e = await envelope(res);
  expect(e.ok, JSON.stringify(e.error ?? {})).toBe(true);
  return { status: res.status, data: e.data as Record<string, unknown> };
}

interface HomRow {
  id: string;
  agent_id: string;
  season_id: string;
  division: string;
  hash: string;
  fields_json: string;
  voided_at: string | null;
}

function rowsFor(env: TestEnv, agentId: string): HomRow[] {
  return env.db.db
    .prepare('SELECT id, agent_id, season_id, division, hash, fields_json, voided_at FROM homologations WHERE agent_id = ? ORDER BY created_at, id')
    .all(agentId) as unknown as HomRow[];
}

// ---------------------------------------------------------------------------
// 1. The hash formula: exactly the spec field set, canonical ordering
// ---------------------------------------------------------------------------

describe('homologation hash formula', () => {
  it('matches sha256(canonicalJson) over EXACTLY the eight spec fields, sorted', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'hasher');
    await homologateOk(env, agent, homBody());

    const [row] = rowsFor(env, agent.agentId);
    expect(row).toBeDefined();

    // Hand-built canonical serialization of the spec field set — sorted key
    // order, no whitespace, null (not '' or 'null') for the missing endpoint.
    const expectCanonical =
      `{"adapter_kind":"api","agent_id":"${agent.agentId}","config_sha256":"${CFG_HASH}",` +
      `"endpoint_url_or_null":null,"model_id":"model-x-1","season_id":"s2026-09",` +
      `"system_prompt_sha256":"${SYS_HASH}","tool_access":"engine-assisted"}`;
    expect(row!.fields_json).toBe(expectCanonical);
    expect(row!.hash).toBe(sha256Hex(expectCanonical));

    // The exported hash function agrees (offline verifiers recompute it).
    const fields: HomologationFields = {
      agent_id: agent.agentId,
      season_id: 's2026-09',
      model_id: 'model-x-1',
      adapter_kind: 'api',
      endpoint_url_or_null: null,
      system_prompt_sha256: SYS_HASH,
      config_sha256: CFG_HASH,
      tool_access: 'engine-assisted',
    };
    expect(homologationHash(fields)).toBe(row!.hash);
  });

  it('body key order and unknown extra fields cannot perturb the hash', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'orderer');
    const first = await homologateOk(env, agent, homBody());

    // Same fields, scrambled insertion order + junk fields smuggled in.
    const scrambled: Record<string, Json> = {
      tool_access: 'engine-assisted',
      config_sha256: CFG_HASH,
      evil_extra_field: 'ignore-me',
      season_id: 's2026-09',
      adapter_kind: 'api',
      division: 'open',
      system_prompt_sha256: SYS_HASH,
      model_id: 'model-x-1',
      endpoint_url: null,
      nested: { agent_id: 'someone-else' },
    };
    const second = await homologateOk(env, agent, scrambled);
    expect(second.data.hash).toBe(first.data.hash);
    expect(second.data.unchanged).toBe(true); // idempotent, nothing voided
    expect(rowsFor(env, agent.agentId)).toHaveLength(1);
    expect(rowsFor(env, agent.agentId)[0]!.voided_at).toBeNull();
    // The junk never reaches the published field set.
    expect(rowsFor(env, agent.agentId)[0]!.fields_json).not.toContain('evil_extra_field');
  });

  it('distinct field sets never collide: boundary shifts, null-vs-"null", swapped hashes', () => {
    const base: HomologationFields = {
      agent_id: 'a_1',
      season_id: 's1',
      model_id: 'm',
      adapter_kind: 'api',
      endpoint_url_or_null: null,
      system_prompt_sha256: SYS_HASH,
      config_sha256: CFG_HASH,
      tool_access: 'pure',
    };
    const variants: HomologationFields[] = [
      // Value-boundary shift across adjacent fields (classic concat collision).
      { ...base, model_id: 'm:api', adapter_kind: '' as string },
      { ...base, model_id: 'm"', adapter_kind: 'api' },
      // null vs the four-letter string "null".
      { ...base, endpoint_url_or_null: 'null' },
      // Swapping the two content hashes must change the homologation hash.
      { ...base, system_prompt_sha256: CFG_HASH, config_sha256: SYS_HASH },
      // Season/agent boundary shift.
      { ...base, agent_id: 'a_1s', season_id: '1' },
      // tool_access is inside the hash (a pure agent can't silently go engine-assisted).
      { ...base, tool_access: 'engine-assisted' },
    ];
    const hashes = new Set([homologationHash(base)]);
    for (const v of variants) {
      const h = homologationHash(v);
      expect(hashes.has(h), `field set ${canonicalJson(v as unknown as Json)} collided`).toBe(false);
      hashes.add(h);
    }
    expect(hashes.size).toBe(variants.length + 1);
  });
});

// ---------------------------------------------------------------------------
// 2. Changing homologated fields mid-season: new hash + voided standing
// ---------------------------------------------------------------------------

describe('changing homologated fields voids season standing', () => {
  const changes: { name: string; patch: Record<string, Json> }[] = [
    { name: 'model_id', patch: { model_id: 'model-x-2-secret-upgrade' } },
    { name: 'system_prompt_sha256', patch: { system_prompt_sha256: sha256Hex('system prompt v2') } },
    { name: 'tool_access', patch: { tool_access: 'pure' } },
    { name: 'config_sha256', patch: { config_sha256: sha256Hex('config v2') } },
    { name: 'endpoint_url', patch: { endpoint_url: 'https://evil.example/engine' } },
  ];

  for (const c of changes) {
    it(`changing ${c.name} voids the previous entry and produces a NEW hash`, async () => {
      const env = makeTestEnv();
      const agent = insertAgent(env, 'changer');
      const first = await homologateOk(env, agent, homBody());
      const second = await homologateOk(env, agent, homBody(c.patch));

      expect(second.status).toBe(201);
      expect(second.data.hash).not.toBe(first.data.hash);
      expect(second.data.voided_previous).toBe(first.data.homologation_id);

      const rows = rowsFor(env, agent.agentId);
      expect(rows).toHaveLength(2);
      const oldRow = rows.find((r) => r.id === first.data.homologation_id)!;
      const newRow = rows.find((r) => r.id === second.data.homologation_id)!;
      expect(oldRow.voided_at, 'previous standing must be voided').not.toBeNull();
      expect(newRow.voided_at).toBeNull();
      expect(newRow.hash).not.toBe(oldRow.hash);
    });
  }

  it('flipping the division (same fields) also voids: no dual-division standing on one entry', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'divflip');
    const first = await homologateOk(env, agent, homBody({ division: 'open' }));
    // Pure division demands tool_access pure; the field change is inherent.
    const second = await homologateOk(env, agent, homBody({ division: 'pure', tool_access: 'pure' }));
    expect(second.data.voided_previous).toBe(first.data.homologation_id);
    const rows = rowsFor(env, agent.agentId);
    expect(rows.filter((r) => r.voided_at === null)).toHaveLength(1);
    expect(rows.filter((r) => r.voided_at === null)[0]!.division).toBe('pure');
  });

  it("the pure division cannot be entered with tool_access 'engine-assisted'", async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'sneak');
    const res = await postSigned(env, agent, `/api/agents/${agent.agentId}/homologate`, homBody({ division: 'pure', tool_access: 'engine-assisted' }));
    expect(res.status).toBe(400);
    expect((await envelope(res)).error?.code).toBe('DIVISION_MISMATCH');
    expect(rowsFor(env, agent.agentId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Ownership and the voided-standing play gate
// ---------------------------------------------------------------------------

describe('homologation ownership and lobby gating', () => {
  it("you cannot homologate ANOTHER agent's id, even fully authenticated", async () => {
    const env = makeTestEnv();
    const alice = insertAgent(env, 'alice');
    const bob = insertAgent(env, 'bob', 'op_other');
    const res = await postSigned(env, alice, `/api/agents/${bob.agentId}/homologate`, homBody());
    expect(res.status).toBe(403);
    expect((await envelope(res)).error?.code).toBe('NOT_YOUR_AGENT');
    expect(rowsFor(env, bob.agentId)).toHaveLength(0);
    expect(rowsFor(env, alice.agentId)).toHaveLength(0);
  });

  it('a voided division homologation no longer admits rated play in that division', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'player');
    await homologateOk(env, agent, homBody({ division: 'open' }));

    // Sanity: the open lobby admits the homologated agent.
    const join1 = await postSigned(env, agent, '/api/lobby/join', { game: 'toy', variant: 'standard', division: 'open' });
    expect(join1.status).toBe(201);
    await postSigned(env, agent, '/api/lobby/leave', { game: 'toy', variant: 'standard', division: 'open' });

    // Mid-season switch to the pure division voids the open standing...
    await homologateOk(env, agent, homBody({ division: 'pure', tool_access: 'pure' }));

    // ...and the OPEN lobby must now refuse (the old entry is voided).
    const join2 = await postSigned(env, agent, '/api/lobby/join', { game: 'toy', variant: 'standard', division: 'open' });
    expect(join2.status).toBe(403);
    expect((await envelope(join2)).error?.code).toBe('NOT_HOMOLOGATED');
  });

  it('an agent with NO homologation at all cannot join any rated lobby', async () => {
    const env = makeTestEnv();
    const agent = insertAgent(env, 'unfiled');
    for (const division of ['open', 'pure'] as const) {
      const res = await postSigned(env, agent, '/api/lobby/join', { game: 'toy', variant: 'standard', division });
      expect(res.status, division).toBe(403);
      expect((await envelope(res)).error?.code, division).toBe('NOT_HOMOLOGATED');
    }
  });
});
