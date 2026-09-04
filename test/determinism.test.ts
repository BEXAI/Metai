/**
 * Gate A2 (single-runtime half): the same seed and pick sequence must produce
 * an identical final state hash and move count on two independent runs, for
 * every non-stub game, at min and (where different) max player counts.
 * The cross-runtime half (Node vs workerd) reuses finalHashOfPlayout in stage 4.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/crypto/canonical.ts';
import { GAMES } from '../src/games/index.ts';
import werewolf from '../src/games/werewolf/index.ts';
import { finalHashOfPlayout } from '../src/kernel/playout.ts';
import { isStub } from '../src/kernel/stub.ts';
import { playWerewolf, wolvesOf } from './werewolf-playout.ts';

const SEEDS_PER_GAME = 3;

describe('determinism: identical seeds, identical final hashes', () => {
  for (const [id, game] of Object.entries(GAMES)) {
    if (isStub(game)) {
      console.warn(`[determinism] skipping '${id}' — stub, its build track has not landed yet`);
      it.skip(`${id}: skipped (stub)`, () => {});
      continue;
    }

    const playerCounts =
      game.meta.players.max > game.meta.players.min
        ? [game.meta.players.min, game.meta.players.max]
        : [game.meta.players.min];

    for (const players of playerCounts) {
      it(`${id} at ${players} players: two runs agree on hash and move count`, () => {
        for (let k = 0; k < SEEDS_PER_GAME; k++) {
          const seedHex = sha256Hex(`determinism:${id}:${players}:${k}`);
          const pickerHex = sha256Hex(`determinism-pick:${id}:${players}:${k}`);
          const a = finalHashOfPlayout(game, seedHex, pickerHex, players);
          const b = finalHashOfPlayout(game, seedHex, pickerHex, players);
          expect(b.hash).toBe(a.hash);
          expect(b.moves).toBe(a.moves);
          expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
        }
      });
    }
  }
});

/**
 * Werewolf needs more than the loop above gives it, for three reasons that are
 * all properties of this game specifically:
 *
 *  1. meta.players is { min: 8, max: 8 }, so the `max > min` branch never fires
 *     and werewolf gets ONE invocation where a ranged game gets two. This block
 *     restores the missing second family, with a wider seed sample: a deal is
 *     2 wolves of 8 and the terminal check has three branches, so three seeds
 *     can easily miss one entirely.
 *  2. It is the first game whose entire randomness surface is a single shuffle.
 *     Determinism here is not "the same PRNG replayed" but "nothing else ever
 *     asks the seed a question" — night kill ties break to the lowest-seat
 *     wolf, any lynch tie is no lynch, and the defender is a lowest-seat
 *     argmax. If someone later reaches for the seed to break one of those, the
 *     hashes would still agree run-to-run and the generic gate above would stay
 *     green; the draw-log assertion below is what catches it.
 *  3. The generic gate compares a hash to itself, which is only meaningful if
 *     different inputs produce different hashes. Werewolf has enough structure
 *     to say that out loud, so it does.
 */
describe('determinism: werewolf (min === max, so the generic loop runs one config)', () => {
  const FAMILIES = 12;
  const seedFor = (k: number): string => sha256Hex(`determinism:werewolf:extra:${k}`);

  it(`werewolf at 8 players: ${FAMILIES} more seed families agree, and differ from each other`, () => {
    const hashes = new Set<string>();
    for (let k = 0; k < FAMILIES; k++) {
      const seedHex = seedFor(k);
      const pickerHex = sha256Hex(`determinism-pick:werewolf:extra:${k}`);
      const a = finalHashOfPlayout(werewolf, seedHex, pickerHex, 8);
      const b = finalHashOfPlayout(werewolf, seedHex, pickerHex, 8);
      expect(b.hash).toBe(a.hash);
      expect(b.moves).toBe(a.moves);
      expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
      hashes.add(a.hash);
    }
    // NON-VACUITY. Without this the assertions above would be satisfied by a
    // game that ignores its seed and its picker and always plays the same way.
    expect(hashes.size).toBe(FAMILIES);
  });

  it('werewolf: the deal is a function of the SEED alone, never of the pick sequence', () => {
    const wolfPairs = new Set<string>();
    const wolfSeats = new Set<string>();
    for (let k = 0; k < FAMILIES; k++) {
      const seedHex = seedFor(k);
      const a = playWerewolf(seedHex, sha256Hex(`determinism-pick-a:${k}`));
      const b = playWerewolf(seedHex, sha256Hex(`determinism-pick-b:${k}`));
      // Same seed, different play: the two games diverge everywhere except the
      // deal, which is fixed before the first move.
      expect(b.roles).toEqual(a.roles);
      wolfPairs.add(wolvesOf(a).join(','));
      for (const w of wolvesOf(a)) wolfSeats.add(w);
    }
    // Roles are dealt by shuffling ROLE_MULTISET and are never keyed to the
    // seat index — which matters because the match-layer pairer shuffles seats
    // with a secret it holds at creation time, so a seat-keyed deal would be
    // known to the pairer before a card was dealt. The seeds here are fixed
    // strings, so these bounds are deterministic, not sampled; the measured
    // values are 10 distinct pairs and 7 distinct wolf seats.
    expect(wolfPairs.size).toBeGreaterThanOrEqual(8);
    expect(wolfSeats.size).toBeGreaterThanOrEqual(6);
  });

  it('werewolf: a whole game draws exactly seven ints, all from one deal shuffle', () => {
    for (let k = 0; k < FAMILIES; k++) {
      const w = playWerewolf(seedFor(k), sha256Hex(`determinism-pick-a:${k}`));
      // src/kernel/seed.ts:75-83 — shuffle() runs `for (i = n-1; i >= 1; i--)`,
      // so 8 items is SEVEN int() draws, not eight, with maxExclusive counting
      // down 8..2. Pinned with the citation so the number cannot be re-broken.
      expect(w.seedDraws.map((d) => d.arg)).toEqual([8, 7, 6, 5, 4, 3, 2]);
      expect(w.seedDraws.map((d) => d.kind)).toEqual(Array(7).fill('int'));
      expect([...new Set(w.seedDraws.map((d) => d.purpose))]).toEqual(['deal:roles']);
    }
  });
});
