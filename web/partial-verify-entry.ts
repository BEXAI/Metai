// Fallback bundled into web/public/verify-entry.js by web/build.sh ONLY when
// the full web/verify-entry.ts fails to bundle (because src/kernel/verify.ts
// and/or the game modules it needs aren't built yet). This checks the one
// thing that never depends on any other track: the log hash chain, using the
// frozen algorithm documented at the top of src/kernel/replay.ts. It does not
// recompute game state, dice rolls, or shuffles — the UI must show this as a
// "partial verify".

import { canonicalJson, sha256Hex } from '../src/crypto/canonical.ts';
import { GENESIS_PREV, LOG_HASH_PREFIX } from '../src/kernel/replay.ts';
import type { Json } from '../src/kernel/types.ts';

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

interface LogEntryLike {
  seq: number;
  kind: string;
  payload: Json;
  prev_hash: string;
  hash: string;
}

function computeEntryHash(gameId: string, seq: number, prevHash: string, kind: string, payload: Json): string {
  const body = canonicalJson({ kind, payload } as Json);
  return sha256Hex(`${LOG_HASH_PREFIX}:${gameId}:${seq}:${prevHash}:${body}`);
}

function verifyHashChain(replay: { game_id?: string; game?: string; log?: LogEntryLike[] }): { ok: boolean; checks: CheckResult[] } {
  const checks: CheckResult[] = [];
  const log = Array.isArray(replay?.log) ? replay.log : [];
  const gameId = String(replay?.game_id ?? replay?.game ?? '');
  let prevHash = GENESIS_PREV;
  let chainOk = true;

  for (const entry of log) {
    const expectedHash = computeEntryHash(gameId, entry.seq, prevHash, entry.kind, entry.payload);
    const prevMatches = entry.prev_hash === prevHash;
    const hashMatches = entry.hash === expectedHash;
    if (!prevMatches || !hashMatches) {
      chainOk = false;
      checks.push({
        name: `log[seq=${entry.seq}] hash chain`,
        ok: false,
        detail: !prevMatches ? 'prev_hash does not chain from the previous entry' : 'hash does not match the recomputed value',
      });
    }
    prevHash = entry.hash;
  }

  checks.unshift({ name: 'hash chain (all log entries)', ok: chainOk, detail: `${log.length} entries checked` });
  checks.push({
    name: 'game-state recomputation',
    ok: false,
    detail: 'skipped: src/kernel/verify.ts and/or game rule modules were not available when web/build.sh last ran (partial verify) — re-run web/build.sh after integration',
  });

  return { ok: chainOk, checks };
}

const globalScope = globalThis as unknown as {
  ludusVerify?: (replay: unknown) => unknown;
  ludusVerifyPartial?: boolean;
};

globalScope.ludusVerify = (replay: unknown) => verifyHashChain(replay as Parameters<typeof verifyHashChain>[0]);
globalScope.ludusVerifyPartial = true;
