/**
 * RFC 6962 Merkle trees and signed checkpoints
 * (spec §identity_and_integrity.game_log, §architecture.scheduling).
 *
 * Every 5 minutes the cron computes the RFC 6962 Merkle root over all log
 * entry hashes and signs a checkpoint with the house key; once a day a witness
 * snapshot goes to a public GitHub repo. Anyone holding a log entry plus an
 * inclusion proof can verify it against a published, signed root.
 *
 * Construction (RFC 6962 §2.1, identical to Certificate Transparency):
 *   MTH([])        = SHA-256('')
 *   leaf hash      = SHA-256(0x00 || leaf)
 *   node hash      = SHA-256(0x01 || left || right)
 *   MTH(D[n])      = node(MTH(D[0:k]), MTH(D[k:n])), k = largest pow2 < n
 * Inclusion-proof verification follows RFC 9162 §2.1.3.2.
 *
 * Checkpoint signing string (frozen):
 *   'ludus.checkpoint.v1:' + treeSize + ':' + rootHex + ':' + timestamp
 */

import { sha256 } from '@noble/hashes/sha2';
import { concatBytes } from '@noble/hashes/utils';
import { signEd25519, verifyEd25519 } from './ed25519.ts';

export const CHECKPOINT_PREFIX = 'ludus.checkpoint.v1';

const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);

/** SHA-256(0x00 || leaf) — RFC 6962 leaf hash. */
export function leafHash(leaf: Uint8Array): Uint8Array {
  return sha256(concatBytes(LEAF_PREFIX, leaf));
}

/** SHA-256(0x01 || left || right) — RFC 6962 interior-node hash. */
export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(concatBytes(NODE_PREFIX, left, right));
}

/** Largest power of two strictly less than n (n >= 2). */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function subtreeRoot(leaves: readonly Uint8Array[], lo: number, hi: number): Uint8Array {
  const n = hi - lo;
  if (n === 0) return sha256(new Uint8Array(0));
  if (n === 1) return leafHash(leaves[lo]!);
  const k = splitPoint(n);
  return nodeHash(subtreeRoot(leaves, lo, lo + k), subtreeRoot(leaves, lo + k, hi));
}

/** RFC 6962 Merkle tree head over the ordered leaves. MTH([]) = SHA-256(''). */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  return subtreeRoot(leaves, 0, leaves.length);
}

function auditPath(leaves: readonly Uint8Array[], lo: number, hi: number, index: number): Uint8Array[] {
  const n = hi - lo;
  if (n === 1) return [];
  const k = splitPoint(n);
  if (index < k) {
    return [...auditPath(leaves, lo, lo + k, index), subtreeRoot(leaves, lo + k, hi)];
  }
  return [...auditPath(leaves, lo + k, hi, index - k), subtreeRoot(leaves, lo, lo + k)];
}

/** RFC 6962 §2.1.1 audit path for leaves[index], ordered leaf-to-root. */
export function inclusionProof(leaves: readonly Uint8Array[], index: number): Uint8Array[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error(`inclusionProof: index ${index} out of range for ${leaves.length} leaves`);
  }
  return auditPath(leaves, 0, leaves.length, index);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Verifies that `leaf` (raw leaf bytes, hashed here with the 0x00 prefix) is
 * at `index` in the tree of `treeSize` leaves whose head is `root`, using an
 * RFC 6962 audit path. Never throws; returns false on any malformed input.
 * Algorithm: RFC 9162 §2.1.3.2.
 */
export function verifyInclusion(
  leaf: Uint8Array,
  index: number,
  treeSize: number,
  proof: readonly Uint8Array[],
  root: Uint8Array,
): boolean {
  if (!Number.isInteger(index) || !Number.isInteger(treeSize)) return false;
  if (index < 0 || treeSize < 1 || index >= treeSize) return false;
  let fn = index;
  let sn = treeSize - 1;
  let r = leafHash(leaf);
  for (const p of proof) {
    if (sn === 0) return false; // proof longer than the path to the root
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1) === 0) {
        while (fn !== 0 && (fn & 1) === 0) {
          fn >>>= 1;
          sn >>>= 1;
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>>= 1;
    sn >>>= 1;
  }
  return sn === 0 && bytesEqual(r, root);
}

/** The exact string a checkpoint signature covers. */
export function checkpointMessage(treeSize: number, rootHex: string, timestamp: string): string {
  return `${CHECKPOINT_PREFIX}:${treeSize}:${rootHex}:${timestamp}`;
}

/** Signs 'ludus.checkpoint.v1:' + treeSize + ':' + rootHex + ':' + timestamp with the house key. */
export function signCheckpoint(secretKeyHex: string, treeSize: number, rootHex: string, timestamp: string): string {
  if (!Number.isInteger(treeSize) || treeSize < 0) {
    throw new Error(`signCheckpoint: bad treeSize ${treeSize}`);
  }
  return signEd25519(secretKeyHex, checkpointMessage(treeSize, rootHex, timestamp));
}

/** Verifies a checkpoint signature. Never throws; false on any malformed input. */
export function verifyCheckpoint(
  pubkeyHex: string,
  treeSize: number,
  rootHex: string,
  timestamp: string,
  signatureHex: string,
): boolean {
  if (!Number.isInteger(treeSize) || treeSize < 0) return false;
  return verifyEd25519(pubkeyHex, checkpointMessage(treeSize, rootHex, timestamp), signatureHex);
}
