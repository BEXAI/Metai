/**
 * Canonical JSON and hashing. Everything that is hashed, signed, or
 * hash-chained in Ludus goes through canonicalJson(): object keys sorted by
 * UTF-16 code units, no whitespace, arrays in order, numbers serialized by
 * JSON.stringify (deterministic in every V8 runtime we target). Non-finite
 * numbers and undefined are rejected loudly rather than silently mangled.
 */

import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { Json } from '../kernel/types.ts';

export function canonicalJson(value: Json): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalJson(v as Json)).join(',')}]`;
      }
      const keys = Object.keys(value).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = (value as { [key: string]: Json })[k];
        if (v === undefined) continue; // absent, not null
        parts.push(`${JSON.stringify(k)}:${canonicalJson(v)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));
}

/** sha256 over canonical JSON — the one way anything JSON is hashed in Ludus. */
export function hashJson(value: Json): string {
  return sha256Hex(canonicalJson(value));
}
