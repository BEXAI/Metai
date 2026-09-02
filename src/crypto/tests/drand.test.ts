import { describe, expect, it } from 'vitest';
import {
  DRAND_API_BASE,
  QUICKNET_CHAIN_HASH,
  QUICKNET_GENESIS_UNIX_SECONDS,
  QUICKNET_PERIOD_SECONDS,
  getLatestRound,
  getRound,
  parseDrandRound,
  randomnessMatchesSignature,
  roundAt,
  roundTimeMs,
  type DrandFetch,
} from '../drand.ts';

/**
 * Real quicknet round 1, captured from api.drand.sh on 2026-09-02:
 *   GET /v2/chains/<quicknet>/rounds/1  -> { round, signature }
 * The v1 API independently published randomness
 * 1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a
 * for this round, which equals sha256(signature).
 */
const ROUND1 = {
  round: 1,
  signature:
    'b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b',
};
const ROUND1_RANDOMNESS = '1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a';

function cannedFetch(body: unknown, ok = true, status = 200): DrandFetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    return { ok, status, json: async () => body };
  }) as DrandFetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe('drand quicknet constants', () => {
  it('pins the quicknet chain parameters', () => {
    expect(QUICKNET_CHAIN_HASH).toBe('52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971');
    expect(QUICKNET_GENESIS_UNIX_SECONDS).toBe(1692803367);
    expect(QUICKNET_PERIOD_SECONDS).toBe(3);
  });
});

describe('roundAt / roundTimeMs', () => {
  const G = QUICKNET_GENESIS_UNIX_SECONDS * 1000;

  it('round 1 spans [genesis, genesis + 3s)', () => {
    expect(roundAt(G)).toBe(1);
    expect(roundAt(G + 1000)).toBe(1);
    expect(roundAt(G + 2999)).toBe(1);
    expect(roundAt(G + 3000)).toBe(2);
  });

  it('fixture rounds', () => {
    expect(roundAt(G + 3000 * 9)).toBe(10);
    expect(roundAt(G + 3000 * 9 + 2999)).toBe(10);
    // One day after genesis: 86400 / 3 = 28800 full periods -> round 28801.
    expect(roundAt(G + 86_400_000)).toBe(28_801);
    // 2026-09-01T00:00:00Z = 1788220800s -> floor((1788220800-1692803367)/3)+1
    expect(roundAt(1_788_220_800_000)).toBe(31_805_812);
  });

  it('clamps pre-genesis times to round 1', () => {
    expect(roundAt(0)).toBe(1);
    expect(roundAt(G - 1)).toBe(1);
  });

  it('roundTimeMs is the inverse anchor of roundAt', () => {
    expect(roundTimeMs(1)).toBe(G);
    expect(roundTimeMs(2)).toBe(G + 3000);
    for (const r of [1, 2, 1000, 31_805_812]) {
      expect(roundAt(roundTimeMs(r))).toBe(r);
      expect(roundAt(roundTimeMs(r) - 1)).toBe(Math.max(1, r - 1));
    }
  });

  it('rejects nonsense input', () => {
    expect(() => roundAt(Number.NaN)).toThrow();
    expect(() => roundTimeMs(0)).toThrow();
    expect(() => roundTimeMs(1.5)).toThrow();
  });
});

describe('parseDrandRound', () => {
  it('derives randomness = sha256(signature) from a real captured v2 response', () => {
    const r = parseDrandRound(ROUND1);
    expect(r.round).toBe(1);
    expect(r.signature).toBe(ROUND1.signature);
    expect(r.randomness).toBe(ROUND1_RANDOMNESS);
    expect(randomnessMatchesSignature(r)).toBe(true);
  });

  it('accepts a v1-style body with a matching randomness field', () => {
    const r = parseDrandRound({ ...ROUND1, randomness: ROUND1_RANDOMNESS });
    expect(r.randomness).toBe(ROUND1_RANDOMNESS);
  });

  it('rejects a v1-style body whose randomness contradicts the signature', () => {
    expect(() => parseDrandRound({ ...ROUND1, randomness: 'ff'.repeat(32) })).toThrow(/randomness/);
  });

  it('rejects malformed bodies', () => {
    expect(() => parseDrandRound(null)).toThrow();
    expect(() => parseDrandRound('hi')).toThrow();
    expect(() => parseDrandRound({})).toThrow();
    expect(() => parseDrandRound({ round: 0, signature: ROUND1.signature })).toThrow();
    expect(() => parseDrandRound({ round: 1.5, signature: ROUND1.signature })).toThrow();
    expect(() => parseDrandRound({ round: 1 })).toThrow();
    expect(() => parseDrandRound({ round: 1, signature: 'zz'.repeat(48) })).toThrow();
    expect(() => parseDrandRound({ round: 1, signature: ROUND1.signature.slice(0, 90) })).toThrow();
  });

  it('randomnessMatchesSignature is false on tampered data and never throws', () => {
    const good = parseDrandRound(ROUND1);
    expect(randomnessMatchesSignature({ ...good, randomness: 'a' + good.randomness.slice(1) })).toBe(false);
    expect(randomnessMatchesSignature({ ...good, signature: 'zz' })).toBe(false);
  });
});

describe('getRound / getLatestRound (offline fixtures)', () => {
  it('getRound hits the v2 chain URL and parses the canned response', async () => {
    const fetchFn = cannedFetch(ROUND1);
    const r = await getRound(fetchFn, 1);
    expect(fetchFn.calls).toEqual([`${DRAND_API_BASE}/v2/chains/${QUICKNET_CHAIN_HASH}/rounds/1`]);
    expect(r).toEqual({ round: 1, randomness: ROUND1_RANDOMNESS, signature: ROUND1.signature });
  });

  it('getLatestRound hits /rounds/latest', async () => {
    const latest = {
      round: 31_840_219,
      signature:
        'aa1ec10a7b4487cf0ac14aff44cd5ef638aef38fdc37b0ad76e4bac0f58b89a2b99c596cabe011c4d5c9032ac40b5c00',
    };
    const fetchFn = cannedFetch(latest);
    const r = await getLatestRound(fetchFn);
    expect(fetchFn.calls).toEqual([`${DRAND_API_BASE}/v2/chains/${QUICKNET_CHAIN_HASH}/rounds/latest`]);
    expect(r.round).toBe(latest.round);
    expect(randomnessMatchesSignature(r)).toBe(true);
  });

  it('rejects on HTTP errors and bad round arguments', async () => {
    await expect(getRound(cannedFetch({}, false, 404), 99)).rejects.toThrow(/HTTP 404/);
    await expect(getRound(cannedFetch(ROUND1), 0)).rejects.toThrow(/bad round/);
    await expect(getRound(cannedFetch(ROUND1), 1.5)).rejects.toThrow(/bad round/);
    await expect(getLatestRound(cannedFetch({ nope: true }))).rejects.toThrow();
  });
});
