/**
 * Append-only hash-chained game log (spec §identity_and_integrity.game_log).
 *
 * The chain rule is frozen in src/kernel/replay.ts:
 *   GENESIS_PREV = '0' * 64
 *   entry.hash = sha256Hex('ludus.log.v1:' + game_id + ':' + seq + ':'
 *                  + prev_hash + ':' + canonicalJson({ kind, payload }))
 *
 * Note what the hash covers: seq, prev_hash, kind, payload. `signature` and
 * `created_at` are metadata OUTSIDE the chain — move authenticity is enforced
 * separately by verifying the Ed25519 signature over the frozen move message
 * ('ludus.move.v1:...'), which commits to the move body. Tampering with a
 * signature therefore fails signature verification, not chain verification.
 *
 * Rooms (T6) append entries; the offline verifier (T1), the API (T7), and the
 * browser verifier (T9) recompute the same chain from the same constants.
 */

import { GENESIS_PREV, LOG_HASH_PREFIX, type LogEntry, type LogKind } from '../kernel/replay.ts';
import type { Json } from '../kernel/types.ts';
import { canonicalJson, sha256Hex } from './canonical.ts';

/** The frozen per-entry hash. */
export function entryHash(gameId: string, seq: number, prevHash: string, kind: LogKind, payload: Json): string {
  if (!Number.isInteger(seq) || seq < 0) throw new Error(`entryHash: bad seq ${seq}`);
  return sha256Hex(`${LOG_HASH_PREFIX}:${gameId}:${seq}:${prevHash}:${canonicalJson({ kind, payload })}`);
}

/**
 * Builds the next entry for the log: seq = log.length, prev_hash = hash of the
 * last entry (or GENESIS_PREV for the first). Pure — the input log is not
 * mutated; the caller appends the returned entry itself.
 */
export function appendEntry(
  gameId: string,
  log: readonly LogEntry[],
  kind: LogKind,
  payload: Json,
  signature: string | null,
  createdAt: string,
): LogEntry {
  const seq = log.length;
  const last = log[seq - 1];
  const prev_hash = last === undefined ? GENESIS_PREV : last.hash;
  return {
    seq,
    kind,
    payload,
    prev_hash,
    hash: entryHash(gameId, seq, prev_hash, kind, payload),
    signature,
    created_at: createdAt,
  };
}

/**
 * Recomputes the whole chain. On the first bad entry returns
 * { ok: false, badSeq } where badSeq is the position (0-based) at which
 * verification failed — a wrong seq number, a broken prev link, or a hash
 * that does not match the recomputation. An empty log is valid.
 */
export function verifyChain(gameId: string, log: readonly LogEntry[]): { ok: boolean; badSeq?: number } {
  let prev = GENESIS_PREV;
  for (let i = 0; i < log.length; i++) {
    const e = log[i]!;
    if (
      e.seq !== i ||
      e.prev_hash !== prev ||
      e.hash !== entryHash(gameId, i, prev, e.kind, e.payload)
    ) {
      return { ok: false, badSeq: i };
    }
    prev = e.hash;
  }
  return { ok: true };
}
