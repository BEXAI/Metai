/**
 * RED TEAM red-team-randomness — attacks 3 & 4: seed-stream integrity and bias.
 *
 * 3. Purpose collisions (games vs the room's reserved penalty purposes),
 *    counter reuse across snapshot/hydrate encode/decode, stream replay
 *    reproduction, and cross-game divergence.
 * 4. Rejection-sampling correctness at boundary maxExclusive values, an
 *    independent byte-for-byte reimplementation of the frozen algorithm, and
 *    loose chi-square sanity over 10k draws (gross bias only).
 *
 * All randomness is via createSeedStream over fixed hex seeds — no Date.now,
 * no Math.random.
 */

import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveFinalSeed } from '../../src/crypto/commit.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import type { SeedStream } from '../../src/kernel/types.ts';
import { RoomCore } from '../../src/rooms/core.ts';
import { miniGame } from '../../src/rooms/tests/mini-game.ts';
import {
  DRAND,
  SECRET,
  T0,
  makeCore,
  snapshotCopy,
  submit,
} from './red-team-randomness-helpers.ts';

const SEED = 'c3'.repeat(32);
const REPO = join(import.meta.dirname, '..', '..');

// ---------------------------------------------------------------------------
// Attack 3a: purpose-collision audit across every game and the room core.
// The room's frozen penalty policy draws `illegal:turn:N` / `timeout:turn:N`
// on the SAME stream a game draws from; a game using those tags would let a
// penalty draw be predicted from (or corrupt the recomputation of) a game
// draw. Reserved prefixes must never appear in game code.
// ---------------------------------------------------------------------------

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'tests' || name === 'node_modules') continue;
      out.push(...tsFilesUnder(p));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** Extracts literal purpose tags passed to seed .int/.die/.shuffle/.bytes calls. */
function purposeLiterals(source: string): string[] {
  const re = /\.(?:int|die|shuffle|bytes)\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  const out: string[] = [];
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    out.push(m[1]!.slice(1, -1));
  }
  return out;
}

describe('attack 3a: purpose-collision audit (grep of real draw sites)', () => {
  it('no game draws under the room-reserved penalty purposes (illegal:*, timeout:*)', () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(join(REPO, 'src', 'games'))) {
      for (const purpose of purposeLiterals(readFileSync(file, 'utf8'))) {
        if (/^(illegal|timeout):/.test(purpose)) {
          offenders.push(`${file}: '${purpose}'`);
        }
        expect(purpose.length, `${file}: empty purpose tag`).toBeGreaterThan(0);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the room core itself uses exactly the frozen penalty purposes and nothing else', () => {
    const purposes = purposeLiterals(readFileSync(join(REPO, 'src', 'rooms', 'core.ts'), 'utf8'));
    // hydrate() replays recorded draws via variables — literals here are the
    // penalty draws only, and they must match the frozen policy strings.
    const templates = purposes.map((p) => p.replace(/\$\{[^}]*\}/g, 'N'));
    expect(new Set(templates)).toEqual(new Set(['illegal:turn:N', 'timeout:turn:N']));
  });

  it('same purpose tag from two call sites cannot alias: the per-purpose counter separates them', () => {
    // Two logical draws sharing 'dice:turn:7' (e.g. d1 and d2 of one roll)
    // must produce independent values in a stable order — and a verifier
    // replaying the same sequence gets the same values.
    const a = createSeedStream(SEED);
    const d1 = a.die('dice:turn:7', 6);
    const d2 = a.die('dice:turn:7', 6);
    const b = createSeedStream(SEED);
    expect([b.die('dice:turn:7', 6), b.die('dice:turn:7', 6)]).toEqual([d1, d2]);
    // 100 same-purpose draws are not constant (counter actually advances).
    const s = createSeedStream(SEED);
    const seq = Array.from({ length: 100 }, () => s.int('dup', 1_000_000));
    expect(new Set(seq).size).toBeGreaterThan(90);
  });

  it('purpose strings are not ambiguous across counter concatenation (p#1 vs p, counter 1)', () => {
    // block input is `${purpose}#${counter}#${attempt}` — a hostile purpose
    // ending in '#0' could try to collide with (purpose, counter=0)'s block.
    const s1 = createSeedStream(SEED);
    const first = s1.int('p', 1_000_000); // purpose 'p', counter 0 -> 'p#0#0'
    const s2 = createSeedStream(SEED);
    const forged = s2.int('p#0', 1_000_000); // purpose 'p#0', counter 0 -> 'p#0#0#0'... must differ
    expect(forged).not.toBe(first);
    // And the dangerous true collision: purpose 'p#0' counter 0 vs purpose 'p'
    // counter 0 attempt... document: HMAC input 'p#0#0#0' vs 'p#0#0'. Distinct.
    const s3 = createSeedStream(SEED);
    s3.int('p', 1_000_000);
    const second = s3.int('p', 1_000_000); // 'p#1#0'
    const s4 = createSeedStream(SEED);
    const collide = s4.int('p#1', 1_000_000); // 'p#1#0#0'
    expect(collide).not.toBe(second);
  });
});

// ---------------------------------------------------------------------------
// Attack 3b: counter reuse across encode/decode (snapshot -> JSON -> hydrate).
// ---------------------------------------------------------------------------

describe('attack 3b: snapshot/hydrate cannot rewind or replay the stream', () => {
  it('a JSON round-trip mid-game continues the stream exactly like an unbroken room', () => {
    const gameId = 'rt-rand-seed-1';
    const control = makeCore(gameId);
    const roundTrip = makeCore(gameId);
    let now = T0 + 100;

    // Two identical rooms play the same two moves.
    for (const { core, seats } of [control, roundTrip]) {
      submit(core, gameId, seats[0]!, 'a', now + 500);
      submit(core, gameId, seats[1]!, 'b', now + 1000);
    }
    now += 1000;

    // One is serialized to plain JSON and rehydrated (the DO persistence path).
    const resumed = RoomCore.hydrate(miniGame, snapshotCopy(roundTrip.core));

    // Both finish the game with identical submissions at identical times.
    for (const [core, seats] of [
      [control.core, control.seats],
      [resumed, roundTrip.seats],
    ] as const) {
      submit(core, gameId, seats[0]!, 'a', now + 100);
      submit(core, gameId, seats[1]!, 'a', now + 200);
      submit(core, gameId, seats[0]!, 'a', now + 300);
      expect(core.status).toBe('ended');
    }

    // Same draws, same log hashes, same replay — no counter was reused or skipped.
    expect(JSON.stringify(resumed.replayFile())).toBe(JSON.stringify(control.core.replayFile()));
  });

  it('hydrating the same snapshot twice yields identical continuations (no hidden stream state)', () => {
    const gameId = 'rt-rand-seed-2';
    const { core, seats } = makeCore(gameId);
    submit(core, gameId, seats[0]!, 'a', T0 + 100);
    const snapJson = JSON.stringify(core.snapshot());

    const finish = (r: RoomCore): string => {
      submit(r, gameId, seats[1]!, 'b', T0 + 200);
      submit(r, gameId, seats[0]!, 'a', T0 + 300);
      submit(r, gameId, seats[1]!, 'b', T0 + 400);
      submit(r, gameId, seats[0]!, 'a', T0 + 500);
      return JSON.stringify(r.replayFile());
    };
    const r1 = finish(RoomCore.hydrate(miniGame, JSON.parse(snapJson)));
    const r2 = finish(RoomCore.hydrate(miniGame, JSON.parse(snapJson)));
    expect(r1).toBe(r2);
  });
});

// ---------------------------------------------------------------------------
// Attack 3c: stream replay and cross-game separation.
// ---------------------------------------------------------------------------

describe('attack 3c: replaying a stream reproduces it; a different game_id diverges', () => {
  it('fresh stream + same purposes reproduces every kind of draw', () => {
    const run = (s: SeedStream) => ({
      ints: Array.from({ length: 30 }, (_, i) => s.int(`dice:turn:${i % 5}`, 6)),
      shuffle: s.shuffle('shuffle:deck', [...Array(52).keys()]),
      bytes: Buffer.from(s.bytes('layout', 64)).toString('hex'),
      draws: JSON.stringify(s.draws()),
    });
    expect(run(createSeedStream(SEED))).toEqual(run(createSeedStream(SEED)));
  });

  it('a second game with a different game_id shares NO randomness (same secret, same drand)', () => {
    const seedA = deriveFinalSeed('game-A', SECRET, DRAND);
    const seedB = deriveFinalSeed('game-B', SECRET, DRAND);
    expect(seedA).not.toBe(seedB);

    const a = createSeedStream(seedA);
    const b = createSeedStream(seedB);
    const rollsA = Array.from({ length: 48 }, (_, i) => a.die(`dice:turn:${i}`, 6));
    const rollsB = Array.from({ length: 48 }, (_, i) => b.die(`dice:turn:${i}`, 6));
    expect(rollsA).not.toEqual(rollsB);
    expect(a.shuffle('shuffle:deck', [...Array(52).keys()])).not.toEqual(
      b.shuffle('shuffle:deck', [...Array(52).keys()]),
    );
  });

  it('interleaving other purposes does not shift a purpose\'s own sequence', () => {
    const lone = createSeedStream(SEED);
    const seqLone = Array.from({ length: 20 }, () => lone.int('target', 1_000_000));
    const mixed = createSeedStream(SEED);
    const seqMixed: number[] = [];
    for (let i = 0; i < 20; i++) {
      mixed.die(`noise:${i}`, 6);
      seqMixed.push(mixed.int('target', 1_000_000));
      mixed.bytes(`noise:${i}`, 8);
    }
    expect(seqMixed).toEqual(seqLone);
  });
});

// ---------------------------------------------------------------------------
// Attack 4a: boundary maxExclusive values.
// ---------------------------------------------------------------------------

describe('attack 4a: rejection sampling boundaries', () => {
  it('rejects out-of-domain maxExclusive (0, negatives, floats, NaN, >2^32)', () => {
    const s = createSeedStream(SEED);
    for (const bad of [0, -1, -6, 1.5, NaN, Infinity, 2 ** 32 + 1, 2 ** 53]) {
      expect(() => s.int('x', bad), `maxExclusive ${bad} must throw`).toThrow();
    }
    expect(() => s.die('x', 0)).toThrow();
    expect(() => s.bytes('x', 0)).toThrow();
    expect(() => s.bytes('x', -1)).toThrow();
    expect(() => s.bytes('x', 1_048_577)).toThrow(); // DoS bound
  });

  it('maxExclusive = 2^32 (the ceiling) is accepted, in range, and exercises high values', () => {
    const s = createSeedStream(SEED);
    const M = 2 ** 32;
    let sawHigh = false;
    for (let i = 0; i < 512; i++) {
      const v = s.int('ceil', M);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(M);
      if (v >= M / 2) sawHigh = true;
    }
    expect(sawHigh).toBe(true); // P(miss) = 2^-512
  });

  it('values adjacent to the ceiling (2^32 - 1, 2^31 + 1) stay in range', () => {
    const s = createSeedStream(SEED);
    for (const M of [2 ** 32 - 1, 2 ** 31 + 1, 2 ** 31, 3]) {
      for (let i = 0; i < 200; i++) {
        const v = s.int(`adj:${M}`, M);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(M);
      }
    }
  });

  it('maxExclusive = 1 always returns 0 and still advances the counter', () => {
    const s = createSeedStream(SEED);
    for (let i = 0; i < 50; i++) expect(s.int('one', 1)).toBe(0);
    expect(s.draws().length).toBe(50);
    expect(s.draws()[49]!.counter).toBe(49);
    expect(s.die('d1', 1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Attack 4b: independent reimplementation of the frozen algorithm.
// A biased or drifted implementation (e.g. modulo without rejection) would
// disagree with the documented HMAC construction on rejection-heavy ranges.
// ---------------------------------------------------------------------------

function refBlock(keyHex: string, purpose: string, counter: number, attempt: number): Buffer {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(`${purpose}#${counter}#${attempt}`).digest();
}

function refInt(keyHex: string, purpose: string, counter: number, maxExclusive: number): number {
  const U64 = 1n << 64n;
  const max = BigInt(maxExclusive);
  const threshold = U64 - (U64 % max);
  for (let attempt = 0; ; attempt++) {
    const b = refBlock(keyHex, purpose, counter, attempt);
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[i]!);
    if (v < threshold) return Number(v % max);
  }
}

describe('attack 4b: byte-for-byte agreement with an independent node:crypto reimplementation', () => {
  it('int() matches on rejection-heavy and boundary ranges', () => {
    const s = createSeedStream(SEED);
    const maxes = [1, 2, 3, 6, 7, 52, 1000, 2 ** 31 + 1, 2 ** 32 - 1, 2 ** 32];
    const counters = new Map<string, number>();
    for (let i = 0; i < 200; i++) {
      const M = maxes[i % maxes.length]!;
      const purpose = `ref:${M}`;
      const c = counters.get(purpose) ?? 0;
      counters.set(purpose, c + 1);
      expect(s.int(purpose, M), `draw ${i} purpose ${purpose}`).toBe(refInt(SEED, purpose, c, M));
    }
  });

  it('shuffle() is exactly the documented Fisher-Yates over sequential int() draws', () => {
    const s = createSeedStream(SEED);
    const got = s.shuffle('deck', [...Array(52).keys()]);
    const ref = [...Array(52).keys()];
    for (let i = 51, c = 0; i >= 1; i--, c++) {
      const j = refInt(SEED, 'deck', c, i + 1);
      const tmp = ref[i]!;
      ref[i] = ref[j]!;
      ref[j] = tmp;
    }
    expect(got).toEqual(ref);
  });

  it('bytes() is exactly the concatenated attempt blocks', () => {
    const s = createSeedStream(SEED);
    const got = Buffer.from(s.bytes('blob', 70)).toString('hex');
    const ref = Buffer.concat([refBlock(SEED, 'blob', 0, 0), refBlock(SEED, 'blob', 0, 1), refBlock(SEED, 'blob', 0, 2)])
      .subarray(0, 70)
      .toString('hex');
    expect(got).toBe(ref);
  });
});

// ---------------------------------------------------------------------------
// Attack 4c: chi-square-ish sanity over 10k draws (loose bounds, gross bias
// only — thresholds are ~p<1e-6 so a healthy generator never trips them).
// ---------------------------------------------------------------------------

function chiSquare(observed: number[], expectedEach: number): number {
  return observed.reduce((acc, o) => acc + ((o - expectedEach) ** 2) / expectedEach, 0);
}

describe('attack 4c: gross-bias screens', () => {
  it('d6 over 10k draws is roughly uniform (chi-square, 5 dof, bound 45)', { timeout: 600_000 }, () => {
    const s = createSeedStream(SEED);
    const bins = new Array<number>(6).fill(0);
    for (let i = 0; i < 10_000; i++) bins[s.int('bias:d6', 6)]!++;
    expect(chiSquare(bins, 10_000 / 6)).toBeLessThan(45);
  });

  it('int(7) over 10k draws is roughly uniform (6 dof, bound 50)', { timeout: 600_000 }, () => {
    const s = createSeedStream(SEED);
    const bins = new Array<number>(7).fill(0);
    for (let i = 0; i < 10_000; i++) bins[s.int('bias:7', 7)]!++;
    expect(chiSquare(bins, 10_000 / 7)).toBeLessThan(50);
  });

  it('3-element shuffles hit all 6 permutations uniformly over 6k shuffles (5 dof, bound 45)', { timeout: 600_000 }, () => {
    const s = createSeedStream(SEED);
    const counts = new Map<string, number>();
    for (let i = 0; i < 6_000; i++) {
      const k = s.shuffle('bias:perm', [0, 1, 2]).join('');
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    expect(chiSquare([...counts.values()], 1_000)).toBeLessThan(45);
  });

  it('int(2^32) mean and top-bit are centered (no truncation/sign bias at the ceiling)', { timeout: 600_000 }, () => {
    const s = createSeedStream(SEED);
    const M = 2 ** 32;
    let sum = 0;
    let top = 0;
    const N = 4_096;
    for (let i = 0; i < N; i++) {
      const v = s.int('bias:ceil', M);
      sum += v / M;
      if (v >= M / 2) top++;
    }
    expect(sum / N).toBeGreaterThan(0.47);
    expect(sum / N).toBeLessThan(0.53);
    expect(top / N).toBeGreaterThan(0.46);
    expect(top / N).toBeLessThan(0.54);
  });

  it('worst-case rejection range 2^31+1 shows no low/high half bias', { timeout: 600_000 }, () => {
    // U64 % (2^31+1) is huge (~50% of draws rejected) — a broken rejection
    // threshold would visibly skew the halves.
    const s = createSeedStream(SEED);
    const M = 2 ** 31 + 1;
    const N = 4_096;
    let low = 0;
    for (let i = 0; i < N; i++) {
      if (s.int('bias:rej', M) < 2 ** 30) low++;
    }
    expect(low / N).toBeGreaterThan(0.46);
    expect(low / N).toBeLessThan(0.54);
  });
});
