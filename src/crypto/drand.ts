/**
 * drand quicknet client (spec §identity_and_integrity.randomness).
 *
 * Ludus mixes a public drand quicknet round into every game's final seed so
 * the house cannot choose its own randomness. The round number is recorded in
 * the log; anyone can re-fetch that round from api.drand.sh (or any other
 * drand relay) and confirm the recorded randomness.
 *
 * quicknet chain parameters (fixed):
 *   chain hash   52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
 *   genesis time 1692803367 (unix seconds), period 3s
 *   scheme       bls-unchained-g1-rfc9380; randomness = sha256(signature)
 *
 * The v2 HTTP API returns { round, signature } only; randomness is derived
 * here as sha256(signature), which matches what the v1 API publishes.
 *
 * OUT OF SCOPE (recorded in notes/T2-crypto.md): BLS verification of the
 * drand signature against the quicknet group public key. We record round,
 * signature, and randomness; the sha256(signature) -> randomness link is
 * checked offline, and the signature itself is independently checkable
 * against api.drand.sh or any drand client. No BLS code runs in Ludus.
 *
 * `fetchFn` is injected (globalThis.fetch in production, a canned stub in
 * tests) so this module stays pure and testable offline.
 */

import { hexToBytes } from '@noble/hashes/utils';
import { sha256Hex } from './canonical.ts';

export const QUICKNET_CHAIN_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
export const QUICKNET_GENESIS_UNIX_SECONDS = 1692803367;
export const QUICKNET_PERIOD_SECONDS = 3;
export const DRAND_API_BASE = 'https://api.drand.sh';

export interface DrandRound {
  round: number;
  /** sha256 of the BLS signature, lowercase hex (32 bytes) — what games mix into final_seed. */
  randomness: string;
  /** BLS12-381 G1 signature, lowercase hex (48 bytes) — recorded, not BLS-verified here. */
  signature: string;
}

/** Structural subset of the Fetch API — globalThis.fetch satisfies it. */
export type DrandFetch = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * The quicknet round available at wall-clock time `timeMs` (unix ms).
 * Round r becomes available at genesis + (r-1) * period; round 1 at genesis.
 * Times before genesis clamp to round 1.
 */
export function roundAt(timeMs: number): number {
  if (!Number.isFinite(timeMs)) throw new Error(`roundAt: bad time ${timeMs}`);
  const elapsed = Math.floor(timeMs / 1000) - QUICKNET_GENESIS_UNIX_SECONDS;
  if (elapsed < 0) return 1;
  return Math.floor(elapsed / QUICKNET_PERIOD_SECONDS) + 1;
}

/** Unix ms at which `round` becomes available (inverse of roundAt). */
export function roundTimeMs(round: number): number {
  if (!Number.isInteger(round) || round < 1) throw new Error(`roundTimeMs: bad round ${round}`);
  return (QUICKNET_GENESIS_UNIX_SECONDS + (round - 1) * QUICKNET_PERIOD_SECONDS) * 1000;
}

/**
 * Parses and validates a drand round body (v2 shape { round, signature } or
 * v1 shape with an explicit randomness field). Derives randomness as
 * sha256(signature); if the body carries its own randomness it must match.
 * Throws with a precise reason on any malformed or inconsistent body.
 */
export function parseDrandRound(body: unknown): DrandRound {
  if (typeof body !== 'object' || body === null) {
    throw new Error('drand: response body is not an object');
  }
  const b = body as { round?: unknown; signature?: unknown; randomness?: unknown };
  if (!Number.isInteger(b.round) || (b.round as number) < 1) {
    throw new Error(`drand: bad round number ${String(b.round)}`);
  }
  if (typeof b.signature !== 'string' || !/^[0-9a-f]{96}$/.test(b.signature)) {
    throw new Error('drand: signature must be 48 bytes of lowercase hex');
  }
  const randomness = sha256Hex(hexToBytes(b.signature));
  if (b.randomness !== undefined) {
    if (b.randomness !== randomness) {
      throw new Error('drand: reported randomness does not equal sha256(signature)');
    }
  }
  return { round: b.round as number, randomness, signature: b.signature };
}

/** True iff round.randomness === sha256(round.signature) — the offline-checkable link. */
export function randomnessMatchesSignature(round: DrandRound): boolean {
  try {
    return /^[0-9a-f]{96}$/.test(round.signature) && sha256Hex(hexToBytes(round.signature)) === round.randomness;
  } catch {
    return false;
  }
}

async function requestRound(fetchFn: DrandFetch, url: string): Promise<DrandRound> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`drand: HTTP ${res.status} from ${url}`);
  return parseDrandRound(await res.json());
}

/** Fetches one quicknet round by number from the drand v2 API. */
export function getRound(fetchFn: DrandFetch, round: number): Promise<DrandRound> {
  if (!Number.isInteger(round) || round < 1) {
    return Promise.reject(new Error(`drand: bad round ${round}`));
  }
  return requestRound(fetchFn, `${DRAND_API_BASE}/v2/chains/${QUICKNET_CHAIN_HASH}/rounds/${round}`);
}

/** Fetches the latest available quicknet round from the drand v2 API. */
export function getLatestRound(fetchFn: DrandFetch): Promise<DrandRound> {
  return requestRound(fetchFn, `${DRAND_API_BASE}/v2/chains/${QUICKNET_CHAIN_HASH}/rounds/latest`);
}
