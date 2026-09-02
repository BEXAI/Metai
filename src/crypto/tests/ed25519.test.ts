import { describe, expect, it } from 'vitest';
import { generateKeypair, signEd25519, verifyEd25519 } from '../ed25519.ts';

describe('ed25519', () => {
  it('generates well-formed keypairs', () => {
    const kp = generateKeypair();
    expect(kp.secretKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    const kp2 = generateKeypair();
    expect(kp2.secretKeyHex).not.toBe(kp.secretKeyHex);
  });

  it('sign/verify round-trips', () => {
    const kp = generateKeypair();
    const msg = 'ludus.move.v1:g1:7:abc123';
    const sig = signEd25519(kp.secretKeyHex, msg);
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyEd25519(kp.publicKeyHex, msg, sig)).toBe(true);
  });

  it('matches the RFC 8032 TEST 1 vector (empty message)', () => {
    const secret = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
    const pub = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
    const expected =
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
    expect(signEd25519(secret, '')).toBe(expected);
    expect(verifyEd25519(pub, '', expected)).toBe(true);
  });

  it('rejects the wrong key', () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const sig = signEd25519(a.secretKeyHex, 'hello');
    expect(verifyEd25519(b.publicKeyHex, 'hello', sig)).toBe(false);
  });

  it('rejects the wrong message', () => {
    const kp = generateKeypair();
    const sig = signEd25519(kp.secretKeyHex, 'hello');
    expect(verifyEd25519(kp.publicKeyHex, 'hello!', sig)).toBe(false);
    expect(verifyEd25519(kp.publicKeyHex, '', sig)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const kp = generateKeypair();
    const sig = signEd25519(kp.secretKeyHex, 'hello');
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === '0' ? '1' : '0') + s.slice(i + 1);
    expect(verifyEd25519(kp.publicKeyHex, 'hello', flip(sig, 0))).toBe(false);
    expect(verifyEd25519(kp.publicKeyHex, 'hello', flip(sig, 127))).toBe(false);
  });

  it('returns false (never throws) on malformed input', () => {
    const kp = generateKeypair();
    const sig = signEd25519(kp.secretKeyHex, 'm');
    const cases: [string, string, string][] = [
      ['', 'm', sig], // empty pubkey
      ['zz'.repeat(32), 'm', sig], // non-hex pubkey
      [kp.publicKeyHex.slice(0, 62), 'm', sig], // short pubkey
      [kp.publicKeyHex + 'ab', 'm', sig], // long pubkey
      [kp.publicKeyHex, 'm', ''], // empty sig
      [kp.publicKeyHex, 'm', 'zz'.repeat(64)], // non-hex sig
      [kp.publicKeyHex, 'm', sig.slice(0, 100)], // short sig
      [kp.publicKeyHex, 'm', sig + 'aa'], // long sig
      ['ff'.repeat(32), 'm', 'ff'.repeat(64)], // pubkey not on curve
    ];
    for (const [pub, msg, s] of cases) {
      expect(() => verifyEd25519(pub, msg, s)).not.toThrow();
      expect(verifyEd25519(pub, msg, s)).toBe(false);
    }
    // Non-string junk (untrusted network input) must not throw either.
    expect(verifyEd25519(null as unknown as string, 'm', sig)).toBe(false);
    expect(verifyEd25519(kp.publicKeyHex, 'm', 42 as unknown as string)).toBe(false);
  });

  it('signEd25519 throws loudly on a malformed secret key', () => {
    expect(() => signEd25519('nothex', 'm')).toThrow();
    expect(() => signEd25519('ab'.repeat(31), 'm')).toThrow();
  });

  it('accepts uppercase hex on verify (normalized)', () => {
    const kp = generateKeypair();
    const sig = signEd25519(kp.secretKeyHex, 'case');
    expect(verifyEd25519(kp.publicKeyHex.toUpperCase(), 'case', sig.toUpperCase())).toBe(true);
  });
});
