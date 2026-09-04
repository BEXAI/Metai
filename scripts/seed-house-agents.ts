/**
 * Registers the house roster through the REAL public flow — the same signed
 * challenge, the same POST /api/agents, the same homologation an operator
 * files — so a house agent is not a privileged row that only exists because
 * someone ran an INSERT (plan §8.2).
 *
 *   HOUSE_SK_SEED=<the Worker secret> \
 *   LUDUS_BASE_URL=https://naibul.com \
 *   node --experimental-strip-types scripts/seed-house-agents.ts [--dry-run] [--game werewolf]
 *
 * IDEMPOTENT. Keys are derived, never generated (src/api/house.ts), so agent
 * ids are a pure function of (handle, pubkey) and re-running the script is a
 * no-op: an already-registered handle comes back 409 HANDLE_TAKEN /
 * KEY_ALREADY_REGISTERED and the script moves on to its homologations, which
 * are themselves idempotent for an unchanged hash.
 *
 * WHAT IT CREATES, STATED EXPLICITLY:
 *   - one `operators` row (all 24 share it — house agents are exempt from
 *     one-agent-per-operator, and backfill REQUIRES several of them in one
 *     game). The operator token is derived from HOUSE_SK_SEED unless
 *     HOUSE_OPERATOR_TOKEN is set, so a re-run lands on the same operator id.
 *   - 24 `agents` rows: 6 `house-ww-anthropic-*` + 18 `house-ww-mock-*`.
 *   - 48 `homologations` rows: BOTH divisions for each agent, in the CURRENT
 *     season. Homologation is keyed (agent, season, division) — there is no
 *     game column and the pairer never consults it — but a game recorded for
 *     an unhomologated seat is an audit hole, so they are filed anyway.
 *
 * It NEVER writes a private key anywhere. --dry-run prints the handles and the
 * derived PUBLIC keys and makes no request at all.
 */

import { sha256Hex } from '../src/crypto/canonical.ts';
import { authMessage } from '../src/identity/auth.ts';
import { agentIdFor } from '../src/identity/register.ts';
import { houseKeyringFromSeed, houseRosterHandles, type HouseKeyring } from '../src/api/house.ts';
import { seasonIdFor } from '../src/match/seasons.ts';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const GAME = ((): string => {
  const i = argv.indexOf('--game');
  return i >= 0 ? (argv[i + 1] ?? 'werewolf') : 'werewolf';
})();

const BASE_URL = (process.env.LUDUS_BASE_URL ?? 'https://naibul.com').replace(/\/$/, '');
const SEED = process.env.HOUSE_SK_SEED ?? '';
const DIVISIONS = ['pure', 'open'] as const;

/** Declared for the homologation hash; the house adapter is fully in-process. */
const MODEL_ID = 'ludus-house-werewolf-basic';
const ADAPTER_KIND = 'house';
const EMPTY_SHA256 = sha256Hex('');

interface Envelope {
  ok?: boolean;
  error?: { code?: string; message?: string };
  data?: Record<string, unknown>;
}

async function api(
  keyring: HouseKeyring,
  handle: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; envelope: Envelope }> {
  // 1. A fresh single-use challenge for this handle.
  const chRes = await fetch(`${BASE_URL}/api/auth/challenge?agent=${encodeURIComponent(handle)}`);
  const chEnv = (await chRes.json()) as Envelope;
  const challenge = chEnv.data?.challenge;
  if (typeof challenge !== 'string') {
    throw new Error(`challenge for ${handle} failed: ${chRes.status} ${JSON.stringify(chEnv)}`);
  }

  // 2. Sign 'ludus.auth.v1:<handle>:<challenge>:<METHOD>:<path>[:<sha256(body)>]'.
  const rawBody = body === undefined ? null : JSON.stringify(body);
  const signature = keyring.sign(handle, authMessage(handle, challenge, method, path, rawBody));

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'X-Ludus-Agent': handle,
      'X-Ludus-Challenge': challenge,
      'X-Ludus-Signature': signature,
    },
    body: rawBody,
  });
  return { status: res.status, envelope: (await res.json()) as Envelope };
}

async function seedOne(keyring: HouseKeyring, handle: string, operatorToken: string, seasonId: string): Promise<void> {
  const pubkey = keyring.publicKeyHex(handle);
  const agentId = agentIdFor(handle, pubkey);

  const reg = await api(keyring, handle, 'POST', '/api/agents', {
    handle,
    model_id: MODEL_ID,
    pubkey,
    operator_token: operatorToken,
    adapter_kind: ADAPTER_KIND,
    operator_name: 'Naibul house',
  });
  const code = reg.envelope.error?.code;
  if (reg.status === 201) {
    console.log(`  registered ${handle} -> ${agentId}`);
  } else if (code === 'HANDLE_TAKEN' || code === 'KEY_ALREADY_REGISTERED') {
    console.log(`  already registered ${handle} -> ${agentId}`);
  } else {
    throw new Error(`register ${handle} failed: ${reg.status} ${JSON.stringify(reg.envelope)}`);
  }

  for (const division of DIVISIONS) {
    const hom = await api(keyring, handle, 'POST', `/api/agents/${agentId}/homologate`, {
      season_id: seasonId,
      division,
      model_id: MODEL_ID,
      adapter_kind: ADAPTER_KIND,
      endpoint_url: null,
      system_prompt_sha256: EMPTY_SHA256,
      config_sha256: EMPTY_SHA256,
      tool_access: 'pure',
    });
    if (hom.status >= 400) {
      throw new Error(`homologate ${handle}/${division} failed: ${hom.status} ${JSON.stringify(hom.envelope)}`);
    }
    console.log(`  homologated ${handle} season=${seasonId} division=${division}`);
  }
}

async function main(): Promise<void> {
  const handles = houseRosterHandles(GAME);
  if (handles.length === 0) {
    console.error(`No house roster is declared for '${GAME}'. Nothing to seed.`);
    process.exitCode = 1;
    return;
  }

  const keyring = houseKeyringFromSeed(SEED);
  if (keyring === null) {
    console.error(
      'HOUSE_SK_SEED is not set (or is shorter than 32 characters). Refusing to seed: there is no\n' +
        'fallback key, by design — a baked-in seed would put every house identity in the repo.\n' +
        'Generate one with `openssl rand -hex 32`, store it with `wrangler secret put HOUSE_SK_SEED`,\n' +
        'and pass the SAME value here.',
    );
    process.exitCode = 1;
    return;
  }

  const seasonId = seasonIdFor(new Date());
  console.log(`house roster for '${GAME}': ${handles.length} agents, season ${seasonId}, base ${BASE_URL}`);

  if (DRY_RUN) {
    for (const handle of handles) {
      const pubkey = keyring.publicKeyHex(handle);
      console.log(`  ${handle}  pubkey=${pubkey}  agent_id=${agentIdFor(handle, pubkey)}`);
    }
    console.log('dry run: no request was made.');
    return;
  }

  const operatorToken = process.env.HOUSE_OPERATOR_TOKEN ?? sha256Hex(`ludus.house-operator.v1:${SEED}`);
  for (const handle of handles) {
    console.log(handle);
    await seedOne(keyring, handle, operatorToken, seasonId);
  }
  console.log(`done: ${handles.length} house agents registered and homologated for both divisions.`);
}

await main();
