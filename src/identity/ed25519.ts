/**
 * Thin Ed25519 wrapper over @noble/curves used by the identity layer.
 *
 * NOTE (integration): T2 is building src/crypto/ed25519.ts with this exact
 * documented signature — verify(pubHex, message, sigHex) / sign — per PLAN.md.
 * This local wrapper exists so T7 is self-contained while T2 lands
 * concurrently; at integration either file may win (they are behaviorally
 * identical: plain Ed25519 over UTF-8 message bytes, hex keys/sigs).
 */

import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

export function isPubkeyHex(x: string): boolean {
  return HEX_64.test(x);
}

/** Verify an Ed25519 signature (hex) over the UTF-8 bytes of `message`. */
export function verify(pubHex: string, message: string, sigHex: string): boolean {
  if (!HEX_64.test(pubHex) || !HEX_128.test(sigHex)) return false;
  try {
    return ed25519.verify(hexToBytes(sigHex), utf8ToBytes(message), hexToBytes(pubHex));
  } catch {
    return false;
  }
}

/** Sign (house use + tests only — external agents keep their own keys). */
export function sign(secretHex: string, message: string): string {
  return bytesToHex(ed25519.sign(utf8ToBytes(message), hexToBytes(secretHex)));
}

export function publicKeyOf(secretHex: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(secretHex)));
}
