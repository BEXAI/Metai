import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSeedStream } from '../../kernel/seed.ts';
import { deriveFinalSeed, generateSecretHex, makeCommitment, verifyCommitment } from '../commit.ts';

const GAME = 'game-123e4567';
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const RAND = '1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a';

/** Independent recomputation via node:crypto (tests only run in Node). */
function sha256HexNode(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

describe('commit/reveal (gate A8)', () => {
  it('generateSecretHex draws 32 fresh bytes of lowercase hex', () => {
    const s = generateSecretHex();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSecretHex()).not.toBe(s);
  });

  it('makeCommitment uses the exact frozen prefix string', () => {
    expect(makeCommitment(GAME, SECRET)).toBe(sha256HexNode(`ludus.commit.v1:${GAME}:${SECRET}`));
  });

  it('deriveFinalSeed uses the exact frozen prefix string', () => {
    expect(deriveFinalSeed(GAME, SECRET, RAND)).toBe(
      sha256HexNode(`ludus.seed.v1:${GAME}:${SECRET}:${RAND}`),
    );
  });

  it('verifyCommitment round-trips', () => {
    const c = makeCommitment(GAME, SECRET);
    expect(verifyCommitment(GAME, SECRET, c)).toBe(true);
  });

  it('one changed byte in the revealed secret fails verification', () => {
    const c = makeCommitment(GAME, SECRET);
    for (const i of [0, 17, 63]) {
      const flipped = SECRET.slice(0, i) + (SECRET[i] === '0' ? '1' : '0') + SECRET.slice(i + 1);
      expect(verifyCommitment(GAME, flipped, c)).toBe(false);
    }
  });

  it('one changed byte in the commitment fails verification', () => {
    const c = makeCommitment(GAME, SECRET);
    const flipped = (c[0] === '0' ? '1' : '0') + c.slice(1);
    expect(verifyCommitment(GAME, SECRET, flipped)).toBe(false);
  });

  it('a different game id fails verification', () => {
    const c = makeCommitment(GAME, SECRET);
    expect(verifyCommitment('other-game', SECRET, c)).toBe(false);
  });

  it('any input change produces a different final seed', () => {
    const base = deriveFinalSeed(GAME, SECRET, RAND);
    const flip = (s: string) => (s[0] === '0' ? '1' : '0') + s.slice(1);
    const flippedSecret = flip(SECRET);
    const flippedRand = flip(RAND);
    expect(deriveFinalSeed('other-game', SECRET, RAND)).not.toBe(base);
    expect(deriveFinalSeed(GAME, flippedSecret, RAND)).not.toBe(base);
    expect(deriveFinalSeed(GAME, SECRET, flippedRand)).not.toBe(base);
  });

  it('final seed feeds createSeedStream and draws deterministically', () => {
    const seedHex = deriveFinalSeed(GAME, SECRET, RAND);
    expect(seedHex).toMatch(/^[0-9a-f]{64}$/);
    const a = createSeedStream(seedHex);
    const b = createSeedStream(seedHex);
    expect(a.die('dice:turn:1', 6)).toBe(b.die('dice:turn:1', 6));
    expect(a.shuffle('shuffle:deck', [1, 2, 3, 4, 5])).toEqual(b.shuffle('shuffle:deck', [1, 2, 3, 4, 5]));
  });

  it('throws loudly on malformed secrets and randomness', () => {
    expect(() => makeCommitment(GAME, 'short')).toThrow();
    expect(() => makeCommitment(GAME, SECRET.toUpperCase())).toThrow();
    expect(() => makeCommitment('', SECRET)).toThrow();
    expect(() => deriveFinalSeed(GAME, SECRET, 'nothex')).toThrow();
    expect(() => deriveFinalSeed(GAME, SECRET, RAND + 'ab')).toThrow();
  });

  it('verifyCommitment returns false (never throws) on malformed input', () => {
    expect(() => verifyCommitment(GAME, 'garbage', 'garbage')).not.toThrow();
    expect(verifyCommitment(GAME, 'garbage', makeCommitment(GAME, SECRET))).toBe(false);
    expect(verifyCommitment('', SECRET, makeCommitment(GAME, SECRET))).toBe(false);
  });
});
