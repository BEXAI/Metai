/**
 * RED TEAM red-team-randomness — attack 2: commitment binding.
 *
 * Make a reveal not match its commitment and see whether anything still
 * resolves. Bit-flips every field of a genuine room-produced replay and
 * asserts verifyReplay hard-fails on EACH (gate A8: "one changed byte in the
 * reveal fails verification"); re-seals the hash chain after tampering to
 * prove the deeper layers (signatures / recomputation / reveal matching)
 * catch what the chain alone would miss; feeds the ROOM mismatched
 * secret / commitment / final_seed via hydration; and checks the drand
 * recording path (src/crypto/drand.ts) against hostile bodies.
 *
 * Tests that FAIL today demonstrate exploitable holes.
 */

import { describe, expect, it } from 'vitest';
import { makeCommitment, deriveFinalSeed, verifyCommitment } from '../../src/crypto/commit.ts';
import {
  parseDrandRound,
  randomnessMatchesSignature,
  roundAt,
  roundTimeMs,
  getRound,
  type DrandFetch,
} from '../../src/crypto/drand.ts';
import { verifyChain } from '../../src/crypto/chain.ts';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { rehashLog } from '../../src/kernel/tests/fixture-game.ts';
import type { LogEntry, ReplayFile } from '../../src/kernel/replay.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { verifyReplay } from '../../src/kernel/verify.ts';
import type { AnyGame, Json, MoveSubmission } from '../../src/kernel/types.ts';
import { RoomCore, type RoomSnapshot } from '../../src/rooms/core.ts';
import { miniGame, miniGameNoDefault } from '../../src/rooms/tests/mini-game.ts';
import {
  DRAND,
  SECRET,
  T0,
  flipHex,
  makeCore,
  playCleanMiniGame,
  signedSub,
  snapshotCopy,
  submit,
} from './red-team-randomness-helpers.ts';

const games: Record<string, AnyGame> = { mini: miniGame };
const gamesNoDefault: Record<string, AnyGame> = { mini: miniGameNoDefault };

function failedNames(replay: ReplayFile, reg: Record<string, AnyGame> = games): string[] {
  return verifyReplay(replay, reg)
    .checks.filter((c) => !c.ok)
    .map((c) => c.name);
}

function cloneReplay(r: ReplayFile): ReplayFile {
  return structuredClone(r);
}

// ---------------------------------------------------------------------------
// Baselines: genuine room-produced replays must verify (otherwise the tamper
// tests below prove nothing).
// ---------------------------------------------------------------------------

describe('baseline: genuine room-produced replays verify end to end', () => {
  it('clean 5-move mini game: every named check passes', () => {
    const { core } = playCleanMiniGame('rt-rand-bind-0');
    const replay = core.replayFile()!;
    const report = verifyReplay(replay, games);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('timeout path (no defaultMove, seeded random legal move) verifies (frozen purpose timeout:turn:N)', () => {
    const gameId = 'rt-rand-bind-t';
    const { core, seats } = makeCore(gameId, { game: miniGameNoDefault, perMoveMs: 1000 });
    let now = T0;
    const t = core.timeout((now += 2000)); // p0 misses the deadline
    expect(t.fired).toBe(true);
    for (let i = 1; i < 5; i++) {
      const res = submit(core, gameId, seats[i % 2]!, 'a', (now += 100));
      expect(res.ok).toBe(true);
    }
    expect(core.status).toBe('ended');
    const report = verifyReplay(core.replayFile()!, gamesNoDefault);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Attack 2a: bit-flip every field of a valid replay — each must hard-fail.
// ---------------------------------------------------------------------------

describe('attack 2a: one changed byte anywhere fails verification', () => {
  const base = playCleanMiniGame('rt-rand-bind-1').core.replayFile()!;

  const mutations: [string, (r: ReplayFile) => void][] = [
    ['commitment', (r) => void (r.commitment = flipHex(r.commitment))],
    ['drand_randomness', (r) => void (r.drand_randomness = flipHex(r.drand_randomness))],
    ['reveal_secret', (r) => void (r.reveal_secret = flipHex(r.reveal_secret))],
    ['final_seed', (r) => void (r.final_seed = flipHex(r.final_seed))],
    ['drand_round', (r) => void (r.drand_round = r.drand_round + 1)],
    [
      'move payload byte (submission.move)',
      (r) => {
        const e = r.log.find((x) => x.kind === 'move')!;
        (e.payload as { submission: { move: string } }).submission.move = 'b'; // was 'a'
      },
    ],
    [
      'logged notation',
      (r) => {
        const e = r.log.find((x) => x.kind === 'move')!;
        (e.payload as { notation: string }).notation = 'b';
      },
    ],
    [
      'entry hash',
      (r) => {
        r.log[2]!.hash = flipHex(r.log[2]!.hash);
      },
    ],
    [
      'prev_hash link',
      (r) => {
        r.log[3]!.prev_hash = flipHex(r.log[3]!.prev_hash);
      },
    ],
    [
      'move signature bit-flip',
      (r) => {
        const e = r.log.find((x) => x.kind === 'move')!;
        e.signature = flipHex(e.signature!);
      },
    ],
    [
      'move signature stripped',
      (r) => {
        const e = r.log.find((x) => x.kind === 'move')!;
        e.signature = null;
      },
    ],
    [
      'signature transplanted from another move',
      (r) => {
        const moves = r.log.filter((x) => x.kind === 'move');
        moves[0]!.signature = moves[1]!.signature;
      },
    ],
    [
      'initial_state tampered',
      (r) => {
        (r.initial_state as { layout: number }).layout = ((r.initial_state as { layout: number }).layout + 1) % 4;
      },
    ],
    [
      'seed_draws result tampered',
      (r) => {
        const d = r.seed_draws[0]!;
        d.result = ((d.result as number) + 1) % (d.arg as number);
      },
    ],
    [
      'result winners flipped',
      (r) => {
        r.result = { ...r.result, winners: ['p1'] };
        const end = r.log.find((x) => x.kind === 'end')!;
        (end.payload as { result: { winners: string[] } }).result.winners = ['p1'];
      },
    ],
    [
      'reveal payload secret flipped',
      (r) => {
        const e = r.log.find((x) => x.kind === 'reveal')!;
        const p = e.payload as { reveal_secret: string };
        p.reveal_secret = flipHex(p.reveal_secret);
      },
    ],
    ['reveal entry dropped', (r) => void r.log.pop()],
    [
      'move entries reordered',
      (r) => {
        const i = r.log.findIndex((x) => x.kind === 'move');
        const tmp = r.log[i]!;
        r.log[i] = r.log[i + 1]!;
        r.log[i + 1] = tmp;
      },
    ],
  ];

  for (const [name, mutate] of mutations) {
    it(`rejects: ${name}`, () => {
      const r = cloneReplay(base);
      mutate(r);
      const report = verifyReplay(r, games);
      expect(report.ok, `verification must fail after tampering with ${name}`).toBe(false);
    });
  }

  it('sanity: the untampered clone still verifies (mutations above are the only cause of failure)', () => {
    expect(verifyReplay(cloneReplay(base), games).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Attack 2b: re-seal the hash chain after tampering — deeper layers must
// still catch it (chain consistency alone is not integrity).
// ---------------------------------------------------------------------------

describe('attack 2b: chain-resealed tampering is caught by signatures/recomputation/reveal checks', () => {
  const base = playCleanMiniGame('rt-rand-bind-2').core.replayFile()!;

  it('resealed submission tamper: hash_chain passes but signatures/recomputation fail', () => {
    const r = cloneReplay(base);
    const e = r.log.find((x) => x.kind === 'move')!;
    (e.payload as { submission: { move: string } }).submission.move = 'b';
    rehashLog(r);
    const report = verifyReplay(r, games);
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(report.ok).toBe(false);
    expect(failed).not.toContain('hash_chain'); // the chain was re-sealed…
    expect(failed.some((n) => n === 'signatures' || n === 'recomputation')).toBe(true); // …but the crypto still catches it
  });

  it('resealed notation tamper is caught by recomputation', () => {
    const r = cloneReplay(base);
    const e = r.log.find((x) => x.kind === 'move')!;
    (e.payload as { notation: string }).notation = 'b';
    rehashLog(r);
    const failed = failedNames(r);
    expect(failed).toContain('recomputation');
  });

  it('resealed reveal-payload tamper is caught by reveal_after_end', () => {
    const r = cloneReplay(base);
    const e = r.log.find((x) => x.kind === 'reveal')!;
    (e.payload as { reveal_secret: string }).reveal_secret = flipHex(
      (e.payload as { reveal_secret: string }).reveal_secret,
    );
    rehashLog(r);
    const failed = failedNames(r);
    expect(failed).toContain('reveal_after_end');
  });

  it('a mismatched (commitment, reveal_secret) pair never verifies even if everything else is re-derived', () => {
    const r = cloneReplay(base);
    // Adversary invents a fresh secret and re-derives final_seed consistently,
    // but cannot forge the preimage of the ORIGINAL published commitment.
    const fakeSecret = sha256Hex('rt-rand-bind: forged secret');
    r.reveal_secret = fakeSecret;
    r.final_seed = deriveFinalSeed(r.game_id, fakeSecret, r.drand_randomness);
    const reveal = r.log.find((x) => x.kind === 'reveal')!;
    const p = reveal.payload as { reveal_secret: string; final_seed: string };
    p.reveal_secret = fakeSecret;
    p.final_seed = r.final_seed;
    rehashLog(r);
    const failed = failedNames(r);
    expect(failed).toContain('commitment');
    expect(verifyCommitment(r.game_id, fakeSecret, r.commitment)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Attack 2c: feed the ROOM a mismatched secret/commitment/final_seed.
// Spec: every path must hard-fail. RoomCore.create derives both values from
// the secret (unforgeable there); hydration is the mismatch door.
// ---------------------------------------------------------------------------

describe('attack 2c: hydration must hard-fail on secret/commitment/final_seed mismatch', () => {
  function midGameSnapshot(gameId: string): RoomSnapshot {
    const { core, seats } = makeCore(gameId);
    let now = T0 + 100;
    submit(core, gameId, seats[0]!, 'a', (now += 500));
    submit(core, gameId, seats[1]!, 'b', (now += 500));
    return snapshotCopy(core);
  }

  it('rejects a snapshot whose secret does not re-derive the commitment', () => {
    const snap = midGameSnapshot('rt-rand-bind-h1');
    snap.secret = flipHex(snap.secret);
    // Defended behavior: the room must refuse to resume a session whose
    // commit-reveal binding is broken (it would otherwise finish the game and
    // publish a replay that can never verify).
    expect(() => RoomCore.hydrate(miniGame, snap)).toThrow();
  });

  it('rejects a snapshot whose commitment field was swapped', () => {
    const snap = midGameSnapshot('rt-rand-bind-h2');
    snap.commitment = makeCommitment(snap.game_id, flipHex(SECRET, 63));
    expect(() => RoomCore.hydrate(miniGame, snap)).toThrow();
  });

  it('rejects a fully self-consistent reforge of drand_randomness + final_seed + seedDraws', () => {
    const snap = midGameSnapshot('rt-rand-bind-h3');
    // Storage-level adversary swaps the drand randomness mid-game and
    // recomputes final_seed AND the recorded draw log so the hydration
    // fast-forward check passes. Only re-deriving final_seed from
    // (game_id, secret, drand_randomness) — or re-checking the logged draws —
    // can catch this; a room that accepts it resolves the game on randomness
    // that no longer matches its own published log entries.
    const forgedDrand = flipHex(DRAND);
    const forgedSeed = deriveFinalSeed(snap.game_id, flipHex(snap.secret), forgedDrand);
    const stream = createSeedStream(forgedSeed);
    snap.drand_randomness = forgedDrand;
    snap.final_seed = forgedSeed;
    snap.seedDraws = snap.seedDraws.map((d) =>
      d.kind === 'int'
        ? { ...d, result: stream.int(d.purpose, d.arg) }
        : { ...d, result: Buffer.from(stream.bytes(d.purpose, d.arg)).toString('hex') },
    );
    expect(() => RoomCore.hydrate(miniGame, snap)).toThrow();
  });

  it('DEFENDED: rejects a snapshot whose recorded draws do not replay under final_seed', () => {
    const snap = midGameSnapshot('rt-rand-bind-h4');
    const d = snap.seedDraws.find((x) => x.kind === 'int')!;
    (d as { result: number }).result = ((d.result as number) + 1) % (d.arg as number);
    expect(() => RoomCore.hydrate(miniGame, snap)).toThrow(/seed draw mismatch/);
  });

  it('DEFENDED: create refuses malformed secrets (uppercase, short, non-hex)', () => {
    for (const bad of ['5A'.repeat(32), 'ab'.repeat(31), 'zz'.repeat(32), '']) {
      expect(() => makeCore(`rt-rand-bind-h5-${bad.length}`, { secretHex: bad })).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Attack 2d: the room must not accept randomness that was already public
// before the commitment (spec: "a drand quicknet round at or after the
// commitment time" — otherwise the house can grind the secret against a
// known final_seed, and created_at is not offline-verifiable).
// ---------------------------------------------------------------------------

describe('attack 2d: stale drand rounds (randomness public before commit) must be refused', () => {
  it('create rejects a round whose emission time is far before the commitment time', () => {
    const round = 1_000_000;
    const staleNow = roundTimeMs(round) + 10 * 60_000; // committed 10 minutes AFTER the round went public
    expect(() =>
      makeCore('rt-rand-bind-d1', { nowMs: staleNow, drandRound: round }),
    ).toThrow();
  });

  it('DEFENDED (regression): a round at-or-after the commitment time is accepted', () => {
    const round = 1_000_000;
    const okNow = roundTimeMs(round) - 30_000; // round becomes public 30s after commit
    const { core } = makeCore('rt-rand-bind-d2', { nowMs: okNow, drandRound: round });
    expect(core.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// Attack 2e (A8): a game containing a FORCED seeded move must still produce a
// verifiable replay — "verify-replay recomputes every dice roll" includes the
// illegal:turn:N penalty draw.
// ---------------------------------------------------------------------------

describe('attack 2e: forced-move (third illegal attempt) replays must verify', () => {
  it('three illegal attempts force a seeded legal move; the replay must pass verifyReplay', () => {
    const gameId = 'rt-rand-bind-f1';
    const { core, seats } = makeCore(gameId);
    let now = T0 + 100;

    // Turn 0: p0 sends the same unparseable move three times.
    for (let k = 0; k < 3; k++) {
      const { submission, signature } = signedSub(gameId, seats[0]!, 0, 'zzz');
      const res = core.submitMove((now += 100), seats[0]!.seat.agent_id, submission, signature);
      if (k < 2) expect(res.ok).toBe(false);
      else expect(res.ok).toBe(true); // forced random legal move applied + strike
    }
    expect(core.strikes['p0']).toBe(1);

    // Finish the game legally.
    for (let i = 1; i < 5; i++) {
      const res = submit(core, gameId, seats[i % 2]!, 'a', (now += 100));
      expect(res.ok).toBe(true);
    }
    expect(core.status).toBe('ended');
    const replay = core.replayFile()!;

    // The layers that already work must keep working…
    expect(verifyChain(gameId, replay.log as LogEntry[]).ok).toBe(true);
    const report = verifyReplay(replay, games);
    const byName = new Map(report.checks.map((c) => [c.name, c]));
    expect(byName.get('hash_chain')!.ok).toBe(true);
    expect(byName.get('signatures')!.ok).toBe(true);
    expect(byName.get('commitment')!.ok).toBe(true);
    expect(byName.get('final_seed')!.ok).toBe(true);

    // …and the whole replay must verify: the forced draw (purpose
    // illegal:turn:0) is part of the game's randomness audit. Today the room
    // logs the REJECTED submission under kind 'move' while the verifier
    // re-resolves the move from that submission, so an honest game fails A8.
    expect(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok))).toBe(true);
  });

  it("a game played with the kernel '#N' index fallback must verify (rooms accept it, so must the verifier)", () => {
    const gameId = 'rt-rand-bind-f2';
    const { core, seats } = makeCore(gameId);
    let now = T0 + 100;
    // '#0' is the documented kernel-level fallback (legal_moves[0]); the room
    // resolves it in resolveMove (src/rooms/core.ts) and logs the submission
    // verbatim. The offline verifier must re-resolve it the same way.
    const moves: MoveSubmission['move'][] = ['#0', 'a', '#1', 'b', '#0'];
    for (let i = 0; i < 5; i++) {
      const res = submit(core, gameId, seats[i % 2]!, moves[i]!, (now += 100));
      expect(res.ok, JSON.stringify(res)).toBe(true);
    }
    expect(core.status).toBe('ended');
    const report = verifyReplay(core.replayFile()!, games);
    expect(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Attack 2f: hostile drand bodies (src/crypto/drand.ts).
// ---------------------------------------------------------------------------

describe('attack 2f: drand recording path rejects inconsistent/hostile bodies', () => {
  const SIG = 'ab'.repeat(48); // well-formed 48-byte G1 signature hex
  const GOOD = { round: 7, signature: SIG };

  it('accepts a v2 body and derives randomness = sha256(signature)', () => {
    const r = parseDrandRound(GOOD);
    expect(r.round).toBe(7);
    expect(r.randomness).toBe(sha256Hex(Buffer.from(SIG, 'hex')));
    expect(randomnessMatchesSignature(r)).toBe(true);
  });

  it('rejects a body whose claimed randomness does not equal sha256(signature)', () => {
    expect(() => parseDrandRound({ ...GOOD, randomness: flipHex(sha256Hex(Buffer.from(SIG, 'hex'))) })).toThrow(
      /randomness/,
    );
  });

  it('rejects malformed rounds and signatures', () => {
    expect(() => parseDrandRound(null)).toThrow();
    expect(() => parseDrandRound([])).toThrow();
    expect(() => parseDrandRound({ round: 0, signature: SIG })).toThrow();
    expect(() => parseDrandRound({ round: 1.5, signature: SIG })).toThrow();
    expect(() => parseDrandRound({ round: 7, signature: SIG.toUpperCase() })).toThrow();
    expect(() => parseDrandRound({ round: 7, signature: SIG.slice(2) })).toThrow();
    expect(() => parseDrandRound({ round: 7, signature: 42 })).toThrow();
  });

  it('randomnessMatchesSignature is false after a single flipped byte on either side', () => {
    const r = parseDrandRound(GOOD);
    expect(randomnessMatchesSignature({ ...r, randomness: flipHex(r.randomness) })).toBe(false);
    expect(randomnessMatchesSignature({ ...r, signature: flipHex(r.signature) })).toBe(false);
  });

  it('roundAt/roundTimeMs agree and clamp pre-genesis times to round 1', () => {
    for (const round of [1, 2, 1000, 123_456_789]) {
      expect(roundAt(roundTimeMs(round))).toBe(round);
      expect(roundAt(roundTimeMs(round) + 2_999)).toBe(round);
      expect(roundAt(roundTimeMs(round) + 3_000)).toBe(round + 1);
    }
    expect(roundAt(0)).toBe(1);
  });

  it('getRound refuses HTTP failures and validates the body (injected fetch, no network)', async () => {
    const fail: DrandFetch = () => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
    await expect(getRound(fail, 7)).rejects.toThrow(/502/);
    const bad: DrandFetch = () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ round: 7, signature: 'xy' }) });
    await expect(getRound(bad, 7)).rejects.toThrow();
    await expect(getRound(fail, 0)).rejects.toThrow(/bad round/);
  });
});

// ---------------------------------------------------------------------------
// Attack 2g: commit prefix domain separation.
// ---------------------------------------------------------------------------

describe('attack 2g: commitment and seed derivations are domain-separated and format-strict', () => {
  it('commitment != final seed for identical inputs (prefix separation)', () => {
    expect(makeCommitment('g1', SECRET)).not.toBe(deriveFinalSeed('g1', SECRET, DRAND));
  });

  it('game_id separates commitments and seeds (no cross-game replay of randomness)', () => {
    expect(makeCommitment('g1', SECRET)).not.toBe(makeCommitment('g2', SECRET));
    expect(deriveFinalSeed('g1', SECRET, DRAND)).not.toBe(deriveFinalSeed('g2', SECRET, DRAND));
  });

  it('verifyCommitment returns false (never throws) on garbage and on any mismatch', () => {
    const c = makeCommitment('g1', SECRET);
    expect(verifyCommitment('g1', SECRET, c)).toBe(true);
    expect(verifyCommitment('g1', flipHex(SECRET), c)).toBe(false);
    expect(verifyCommitment('g2', SECRET, c)).toBe(false);
    expect(verifyCommitment('g1', SECRET, flipHex(c))).toBe(false);
    expect(verifyCommitment('g1', 'not-hex', c)).toBe(false);
    expect(verifyCommitment('', SECRET, c)).toBe(false);
    expect(verifyCommitment('g1', SECRET.toUpperCase(), c)).toBe(false);
  });

  it('deriveFinalSeed rejects malformed drand randomness', () => {
    expect(() => deriveFinalSeed('g1', SECRET, 'ab'.repeat(31))).toThrow();
    expect(() => deriveFinalSeed('g1', SECRET, DRAND.toUpperCase())).toThrow();
    expect(() => deriveFinalSeed('', SECRET, DRAND)).toThrow();
  });
});
