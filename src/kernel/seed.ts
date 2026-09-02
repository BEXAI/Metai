/**
 * Deterministic seeded randomness (spec §game_kernel_contract.seed_stream).
 *
 * Algorithm (fixed forever; the offline verifier recomputes it byte for byte):
 *   key   = finalSeed (32 bytes, hex-decoded)
 *   Every call to int()/bytes() takes the next per-purpose counter c (from 0).
 *   block(purpose, c, attempt) = HMAC-SHA256(key, utf8(`${purpose}#${c}#${attempt}`))
 *
 *   int(purpose, max):    for attempt = 0, 1, ...: v = first 8 bytes of
 *                         block(...) as big-endian uint64; accept v % max
 *                         when v < 2^64 - (2^64 % max)  (rejection sampling).
 *   die(purpose, sides):  int(purpose, sides) + 1.
 *   bytes(purpose, n):    concat block(purpose, c, 0), block(purpose, c, 1), ...
 *                         truncated to n bytes.
 *   shuffle(purpose, a):  Fisher–Yates over a copy: for i = n-1 .. 1,
 *                         j = int(purpose, i + 1), swap a[i], a[j]
 *                         (each int() advances the purpose counter as usual).
 *
 * Pure JS via @noble/hashes; identical output in Node and Cloudflare Workers.
 */

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import type { SeedDraw, SeedStream } from './types.ts';

const U64 = 1n << 64n;

class SeedStreamImpl implements SeedStream {
  private readonly key: Uint8Array;
  private readonly counters = new Map<string, number>();
  private readonly drawLog: SeedDraw[] = [];

  constructor(finalSeedHex: string) {
    if (!/^[0-9a-f]{64}$/.test(finalSeedHex)) {
      throw new Error('final seed must be 32 bytes of lowercase hex');
    }
    this.key = hexToBytes(finalSeedHex);
  }

  private next(purpose: string): number {
    const c = this.counters.get(purpose) ?? 0;
    this.counters.set(purpose, c + 1);
    return c;
  }

  private block(purpose: string, counter: number, attempt: number): Uint8Array {
    return hmac(sha256, this.key, utf8ToBytes(`${purpose}#${counter}#${attempt}`));
  }

  int(purpose: string, maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x1_0000_0000) {
      throw new Error(`int(): maxExclusive out of range: ${maxExclusive}`);
    }
    const max = BigInt(maxExclusive);
    const threshold = U64 - (U64 % max);
    const counter = this.next(purpose);
    for (let attempt = 0; ; attempt++) {
      const b = this.block(purpose, counter, attempt);
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[i]!);
      if (v < threshold) {
        const result = Number(v % max);
        this.drawLog.push({ purpose, counter, kind: 'int', arg: maxExclusive, result });
        return result;
      }
    }
  }

  die(purpose: string, sides: number): number {
    return this.int(purpose, sides) + 1;
  }

  shuffle<T>(purpose: string, items: readonly T[]): T[] {
    const a = items.slice();
    for (let i = a.length - 1; i >= 1; i--) {
      const j = this.int(purpose, i + 1);
      const tmp = a[i]!;
      a[i] = a[j]!;
      a[j] = tmp;
    }
    return a;
  }

  bytes(purpose: string, n: number): Uint8Array {
    if (!Number.isInteger(n) || n <= 0 || n > 1_048_576) {
      throw new Error(`bytes(): length out of range: ${n}`);
    }
    const counter = this.next(purpose);
    const out = new Uint8Array(n);
    for (let attempt = 0, filled = 0; filled < n; attempt++) {
      const b = this.block(purpose, counter, attempt);
      const take = Math.min(32, n - filled);
      out.set(b.subarray(0, take), filled);
      filled += take;
    }
    this.drawLog.push({ purpose, counter, kind: 'bytes', arg: n, result: bytesToHex(out) });
    return out;
  }

  draws(): readonly SeedDraw[] {
    return this.drawLog;
  }
}

export function createSeedStream(finalSeedHex: string): SeedStream {
  return new SeedStreamImpl(finalSeedHex);
}
