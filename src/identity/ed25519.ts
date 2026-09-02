/**
 * Identity-layer Ed25519 helpers.
 *
 * The signing/verification primitives are the single canonical implementation
 * in src/crypto/ed25519.ts — this module re-exports them under the identity
 * names (`verify`, `sign`, `publicKeyOf`) used across src/identity/* and the
 * test suite, and adds the pure `isPubkeyHex` predicate. It intentionally does
 * NOT wrap @noble itself, so there is exactly one Ed25519 implementation.
 *
 * Behaviour: keys and signatures are lowercase hex; verify never throws and
 * returns false on any malformed input; sign/publicKeyOf throw on a malformed
 * secret key. (See src/crypto/ed25519.ts for the full contract.)
 */

export { verifyEd25519 as verify, signEd25519 as sign, publicKeyOf } from '../crypto/ed25519.ts';

const HEX_64 = /^[0-9a-f]{64}$/;

/** True for a canonical 32-byte public key: exactly 64 lowercase hex chars. */
export function isPubkeyHex(x: string): boolean {
  return HEX_64.test(x);
}
