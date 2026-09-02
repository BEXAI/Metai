import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateKeypair, signEd25519, verifyEd25519 } from '../ed25519.ts';
import {
  checkpointMessage,
  inclusionProof,
  leafHash,
  merkleRoot,
  nodeHash,
  signCheckpoint,
  verifyCheckpoint,
  verifyInclusion,
} from '../checkpoint.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Independent RFC 6962 recomputation using node:crypto directly. */
const H = (...parts: Uint8Array[]) =>
  new Uint8Array(createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest());
const LEAF = Uint8Array.of(0x00);
const NODE = Uint8Array.of(0x01);
const iLeaf = (l: Uint8Array) => H(LEAF, l);
const iNode = (a: Uint8Array, b: Uint8Array) => H(NODE, a, b);

/** The certificate-transparency reference test leaves (Go library test vectors). */
const CT_LEAVES = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'].map(
  (h) => new Uint8Array(Buffer.from(h, 'hex')),
);

describe('RFC 6962 Merkle tree', () => {
  it('empty tree root is sha256 of the empty string', () => {
    expect(hex(merkleRoot([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('known-answer roots for 1/2/3-leaf trees (independently computed)', () => {
    const [l0, l1, l2] = CT_LEAVES as [Uint8Array, Uint8Array, Uint8Array];
    // 1 leaf: sha256(0x00 || l0)
    expect(hex(merkleRoot([l0]))).toBe(hex(iLeaf(l0)));
    expect(hex(merkleRoot([l0]))).toBe('6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d');
    // 2 leaves: sha256(0x01 || leaf(l0) || leaf(l1))
    expect(hex(merkleRoot([l0, l1]))).toBe(hex(iNode(iLeaf(l0), iLeaf(l1))));
    expect(hex(merkleRoot([l0, l1]))).toBe('fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125');
    // 3 leaves: split k=2 -> sha256(0x01 || MTH(l0,l1) || leaf(l2))
    expect(hex(merkleRoot([l0, l1, l2]))).toBe(hex(iNode(iNode(iLeaf(l0), iLeaf(l1)), iLeaf(l2))));
    expect(hex(merkleRoot([l0, l1, l2]))).toBe('aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77');
  });

  it('known-answer roots for the 4/7/8-leaf CT reference trees', () => {
    expect(hex(merkleRoot(CT_LEAVES.slice(0, 4)))).toBe(
      'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
    );
    expect(hex(merkleRoot(CT_LEAVES.slice(0, 7)))).toBe(
      'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
    );
    expect(hex(merkleRoot(CT_LEAVES))).toBe('5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328');
  });

  it('exported leafHash/nodeHash use the 0x00/0x01 domain-separation prefixes', () => {
    const l = new Uint8Array([1, 2, 3]);
    expect(hex(leafHash(l))).toBe(hex(iLeaf(l)));
    const a = leafHash(l);
    const b = leafHash(new Uint8Array([9]));
    expect(hex(nodeHash(a, b))).toBe(hex(iNode(a, b)));
    // Domain separation: a leaf equal to (0x01 || a || b) must not hash like a node.
    const fakeNodeLeaf = new Uint8Array([0x01, ...a, ...b]);
    expect(hex(H(fakeNodeLeaf))).not.toBe(hex(leafHash(fakeNodeLeaf)));
  });

  it('inclusion proofs verify for every leaf of trees of size 1..8', () => {
    for (let n = 1; n <= CT_LEAVES.length; n++) {
      const leaves = CT_LEAVES.slice(0, n);
      const root = merkleRoot(leaves);
      for (let i = 0; i < n; i++) {
        const proof = inclusionProof(leaves, i);
        expect(verifyInclusion(leaves[i]!, i, n, proof, root), `leaf ${i} of ${n}`).toBe(true);
      }
    }
  });

  it('inclusion proof fails for wrong leaf, wrong index, wrong size, wrong root, altered proof', () => {
    const leaves = CT_LEAVES.slice(0, 5);
    const root = merkleRoot(leaves);
    const proof = inclusionProof(leaves, 2);
    expect(verifyInclusion(leaves[3]!, 2, 5, proof, root)).toBe(false);
    expect(verifyInclusion(leaves[2]!, 3, 5, proof, root)).toBe(false);
    // Wrong claimed sizes that change the path shape fail. (Some inflated
    // sizes — 6..8 here — verify under the RFC 9162 algorithm; size binding
    // comes from the SIGNED checkpoint (treeSize, root), not the proof alone.
    // Verified against an independent Python implementation of RFC 9162.)
    expect(verifyInclusion(leaves[2]!, 2, 4, proof, root)).toBe(false);
    expect(verifyInclusion(leaves[2]!, 2, 9, proof, root)).toBe(false);
    expect(verifyInclusion(leaves[2]!, 2, 5, proof, merkleRoot(leaves.slice(0, 4)))).toBe(false);
    expect(verifyInclusion(leaves[2]!, 2, 5, proof.slice(1), root)).toBe(false);
    expect(verifyInclusion(leaves[2]!, 2, 5, [...proof, leafHash(leaves[0]!)], root)).toBe(false);
    const flipped = proof.map((p, i) => (i === 0 ? p.map((b, j) => (j === 0 ? b ^ 1 : b)) : p)) as Uint8Array[];
    expect(verifyInclusion(leaves[2]!, 2, 5, flipped, root)).toBe(false);
    // Malformed numeric input returns false, never throws.
    expect(verifyInclusion(leaves[2]!, -1, 5, proof, root)).toBe(false);
    expect(verifyInclusion(leaves[2]!, 5, 5, proof, root)).toBe(false);
    expect(verifyInclusion(leaves[2]!, 2.5, 5, proof, root)).toBe(false);
    expect(verifyInclusion(leaves[2]!, 0, 0, [], root)).toBe(false);
  });

  it('single-leaf tree: empty proof verifies, and only against its own root', () => {
    const l = CT_LEAVES[1]!;
    expect(verifyInclusion(l, 0, 1, [], merkleRoot([l]))).toBe(true);
    expect(verifyInclusion(l, 0, 1, [], merkleRoot([CT_LEAVES[2]!]))).toBe(false);
  });

  it('inclusionProof throws on an out-of-range index', () => {
    expect(() => inclusionProof(CT_LEAVES.slice(0, 3), 3)).toThrow();
    expect(() => inclusionProof([], 0)).toThrow();
    expect(() => inclusionProof(CT_LEAVES, -1)).toThrow();
  });
});

describe('signed checkpoints', () => {
  const ROOT = '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328';
  const TS = '2026-09-02T00:05:00Z';

  it('signs over the exact frozen checkpoint string', () => {
    const kp = generateKeypair();
    const sig = signCheckpoint(kp.secretKeyHex, 8, ROOT, TS);
    expect(checkpointMessage(8, ROOT, TS)).toBe(`ludus.checkpoint.v1:8:${ROOT}:${TS}`);
    expect(verifyEd25519(kp.publicKeyHex, `ludus.checkpoint.v1:8:${ROOT}:${TS}`, sig)).toBe(true);
    expect(sig).toBe(signEd25519(kp.secretKeyHex, `ludus.checkpoint.v1:8:${ROOT}:${TS}`));
  });

  it('verifyCheckpoint round-trips and rejects any altered field', () => {
    const kp = generateKeypair();
    const sig = signCheckpoint(kp.secretKeyHex, 8, ROOT, TS);
    expect(verifyCheckpoint(kp.publicKeyHex, 8, ROOT, TS, sig)).toBe(true);
    expect(verifyCheckpoint(kp.publicKeyHex, 9, ROOT, TS, sig)).toBe(false);
    expect(verifyCheckpoint(kp.publicKeyHex, 8, ROOT.replace('5', '6'), TS, sig)).toBe(false);
    expect(verifyCheckpoint(kp.publicKeyHex, 8, ROOT, '2026-09-02T00:10:00Z', sig)).toBe(false);
    expect(verifyCheckpoint(generateKeypair().publicKeyHex, 8, ROOT, TS, sig)).toBe(false);
    expect(verifyCheckpoint(kp.publicKeyHex, 8, ROOT, TS, 'zz')).toBe(false);
    expect(verifyCheckpoint(kp.publicKeyHex, -1, ROOT, TS, sig)).toBe(false);
  });

  it('signCheckpoint rejects a bad tree size', () => {
    const kp = generateKeypair();
    expect(() => signCheckpoint(kp.secretKeyHex, -1, ROOT, TS)).toThrow();
    expect(() => signCheckpoint(kp.secretKeyHex, 1.5, ROOT, TS)).toThrow();
  });
});
