/**
 * Ed25519 signing for Ludus (spec §identity_and_integrity.keys).
 *
 * Agents hold their own private keys and sign every move, resignation, draw
 * offer, and homologation; the server only ever sees public keys. The
 * generate/sign half of this module exists for tests and house agents.
 *
 * Uses the audited @noble/curves implementation only — pure JS, identical
 * output in Node and Cloudflare Workers (no node:crypto anywhere in src/).
 *
 * Conventions:
 *  - Keys and signatures travel as lowercase hex (32-byte keys, 64-byte sigs).
 *  - Messages are UTF-8 strings (the frozen `ludus.*.v1:` signing strings
 *    from src/kernel/replay.ts / src/crypto/checkpoint.ts).
 *  - verifyEd25519 NEVER throws: malformed input of any shape returns false.
 *  - Verification uses noble's default ZIP215 rules, which are deterministic
 *    and consistent across runtimes.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

const KEY_HEX_RE = /^[0-9a-f]{64}$/;
const SIG_HEX_RE = /^[0-9a-f]{128}$/;

export interface Keypair {
  publicKeyHex: string;
  secretKeyHex: string;
}

/** Fresh random keypair (CSPRNG via the runtime's crypto.getRandomValues). */
export function generateKeypair(): Keypair {
  const { secretKey, publicKey } = ed25519.keygen();
  return { publicKeyHex: bytesToHex(publicKey), secretKeyHex: bytesToHex(secretKey) };
}

/** Signs a UTF-8 message; returns the 64-byte signature as lowercase hex. Throws on a malformed key. */
export function signEd25519(secretKeyHex: string, message: string): string {
  if (typeof secretKeyHex !== 'string' || !KEY_HEX_RE.test(secretKeyHex)) {
    throw new Error('signEd25519: secret key must be 32 bytes of lowercase hex');
  }
  return bytesToHex(ed25519.sign(utf8ToBytes(message), secretKeyHex));
}

/**
 * Verifies a signature over a UTF-8 message. Returns false — never throws —
 * on malformed keys, malformed signatures, or any internal failure, so it is
 * safe to call directly on untrusted network input.
 */
export function verifyEd25519(pubkeyHex: string, message: string, signatureHex: string): boolean {
  if (typeof pubkeyHex !== 'string' || typeof message !== 'string' || typeof signatureHex !== 'string') {
    return false;
  }
  const pub = pubkeyHex.toLowerCase();
  const sig = signatureHex.toLowerCase();
  if (!KEY_HEX_RE.test(pub) || !SIG_HEX_RE.test(sig)) return false;
  try {
    return ed25519.verify(sig, utf8ToBytes(message), pub);
  } catch {
    return false;
  }
}
