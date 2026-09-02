/**
 * RED TEAM red-team-randomness — attack 1: predict a dice roll or shuffle
 * from PUBLISHED data before the reveal.
 *
 * Enumerates every surface a player or spectator sees pre-reveal — log
 * entries, spectator events, publicStateSummary, per-player views, submit
 * results — and asserts the DEFENDED behavior (spec
 * §identity_and_integrity.randomness + .spectator_reveal, gate A8): nothing
 * published before the reveal entry lets anyone compute a future draw.
 *
 * A test that FAILS today demonstrates an exploitable hole.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { deriveFinalSeed } from '../../src/crypto/commit.ts';
import { GAMES } from '../../src/games/index.ts';
import { SEED_PREFIX } from '../../src/kernel/replay.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { playerId, type Json } from '../../src/kernel/types.ts';
import type { SpectatorEvent, SubmitOk } from '../../src/rooms/core.ts';
import {
  DRAND,
  DRAND_ROUND,
  SECRET,
  T0,
  makeCore,
  playCleanMiniGame,
  scanString,
  submit,
} from './red-team-randomness-helpers.ts';

const P0 = playerId(0);
const P1 = playerId(1);

describe('attack 1a: pre-reveal surfaces never contain the secret or final_seed', () => {
  it('mid-game log, events, summary, views, and submit results are clean; replay is withheld', () => {
    const gameId = 'rt-rand-pred-1';
    const { core, seats } = makeCore(gameId);
    const finalSeed = deriveFinalSeed(gameId, SECRET, DRAND);

    // Play 3 of 5 moves — the game is still running, nothing is revealed yet.
    let now = T0 + 100;
    const submitResults: Json[] = [];
    for (let i = 0; i < 3; i++) {
      const res = submit(core, gameId, seats[i % 2]!, 'a', (now += 500));
      expect(res.ok).toBe(true);
      submitResults.push(res as unknown as Json);
    }
    expect(core.status).toBe('running');

    // Everything a player or spectator can pull out of the room pre-reveal.
    const surfaces = scanString({
      log: core.log as unknown as Json,
      events: core.eventsSince(0) as unknown as Json,
      summary: core.publicStateSummary(),
      viewP0: core.viewFor(P0, now) as unknown as Json,
      viewP1: core.viewFor(P1, now) as unknown as Json,
      submitResults,
    });

    expect(surfaces).not.toContain(SECRET);
    expect(surfaces).not.toContain(finalSeed);

    // The replay (which contains the reveal) must not exist while running.
    expect(core.replayFile()).toBeNull();
  });

  it('the commitment is logged before the first move; reveal only after end (A8 ordering)', () => {
    const gameId = 'rt-rand-pred-2';
    const { core } = playCleanMiniGame(gameId);

    // Log ordering: commitment first, then start; end second-to-last; reveal last.
    expect(core.log[0]!.kind).toBe('commitment');
    expect(core.log[1]!.kind).toBe('start');
    expect(core.log[core.log.length - 2]!.kind).toBe('end');
    expect(core.log[core.log.length - 1]!.kind).toBe('reveal');

    // No log entry BEFORE the reveal carries the secret or the final seed.
    const finalSeed = deriveFinalSeed(gameId, SECRET, DRAND);
    const preReveal = core.log.slice(0, -1);
    const preRevealStr = scanString(preReveal as unknown as Json);
    expect(preRevealStr).not.toContain(SECRET);
    expect(preRevealStr).not.toContain(finalSeed);

    // Spectator stream: the 'reveal' event exists, and only strictly after 'end'.
    const events = core.eventsSince(0);
    const endSeq = events.find((e) => e.type === 'end')?.seq;
    const revealSeq = events.find((e) => e.type === 'reveal')?.seq;
    expect(endSeq).toBeDefined();
    expect(revealSeq).toBeDefined();
    expect(revealSeq!).toBeGreaterThan(endSeq!);
    for (const e of events) {
      if (e.seq < endSeq!) {
        expect(scanString(e as unknown as Json)).not.toContain(SECRET);
        expect(scanString(e as unknown as Json)).not.toContain(finalSeed);
      }
    }
  });
});

describe('attack 1b: initial-state draws (shuffles, layouts) stay out of mid-game logs', () => {
  it('mini: the setup draw appears in replay.seed_draws but in NO log entry payload', () => {
    const gameId = 'rt-rand-pred-3';
    const { core } = playCleanMiniGame(gameId);
    const replay = core.replayFile()!;

    // Ground truth: the very first seeded draw is the initial-state layout.
    expect(replay.seed_draws[0]!.purpose).toBe('setup:layout');

    // No log entry (they are all published as they happen) may carry it.
    for (const e of replay.log) {
      const p = e.payload as { draws?: { purpose: string }[] };
      for (const d of p?.draws ?? []) {
        expect(d.purpose).not.toBe('setup:layout');
        expect(d.purpose.startsWith('shuffle:')).toBe(false);
      }
    }
  });

  it('landlord: deck shuffles happen at create but no log entry or event records those draws', () => {
    const landlord = GAMES['landlord']!;
    const gameId = 'rt-rand-pred-4';
    const { core } = makeCore(gameId, { game: landlord });

    // The stream really did shuffle two decks during initialState.
    const drawn = (core.snapshot().seedDraws ?? []).map((d) => d.purpose);
    expect(drawn).toContain('shuffle:deckA');
    expect(drawn).toContain('shuffle:deckB');

    // Published surfaces at this point: only commitment + start entries, no draws.
    for (const e of core.log) {
      const p = e.payload as { draws?: unknown };
      expect(p?.draws ?? undefined).toBeUndefined();
    }
    const evStr = scanString(core.eventsSince(0) as unknown as Json);
    expect(evStr).not.toContain('shuffle:deckA');
    expect(evStr).not.toContain('shuffle:deckB');
  });
});

describe('attack 1c: a seated player must not be able to read hidden shuffle output from their view', () => {
  it('islanders: the shuffled saga deck order is not recoverable from any player view pre-reveal', () => {
    const islanders = GAMES['islanders']!;
    const gameId = 'rt-rand-pred-5';
    const { core } = makeCore(gameId, { game: islanders, nSeats: 3 });

    // Oracle (trusted internal access, NOT published): the true hidden deck order.
    const trueDeck = (JSON.parse(JSON.stringify(core.snapshot().state)) as { deck: string[] }).deck;
    expect(trueDeck.length).toBeGreaterThan(20); // 25-card saga deck

    for (const p of [playerId(0), playerId(1), playerId(2)]) {
      const view = core.viewFor(p, T0 + 100);
      const viewStr = scanString(view as unknown as Json);

      // ATTACK: JSON.parse(view.state_string).deck currently hands every seated
      // agent the full future deck order — every future card draw is known.
      const parsed = JSON.parse(view.state_string) as { deck?: string[] };
      expect(parsed.deck ?? null).not.toEqual(trueDeck);

      // And the ordered deck sequence must not appear anywhere in the view.
      const orderedNeedle = JSON.stringify(trueDeck).slice(1, -1);
      expect(viewStr.replaceAll('\\"', '"')).not.toContain(orderedNeedle);
    }
  });

  it('landlord: the shuffled deckA/deckB orders are not recoverable from any player view pre-reveal', () => {
    const landlord = GAMES['landlord']!;
    const gameId = 'rt-rand-pred-6';
    const { core } = makeCore(gameId, { game: landlord });

    const st = JSON.parse(JSON.stringify(core.snapshot().state)) as { deckA: string[]; deckB: string[] };
    expect(st.deckA.length).toBeGreaterThan(3);
    expect(st.deckB.length).toBeGreaterThan(3);

    for (const p of [P0, P1]) {
      const view = core.viewFor(p, T0 + 100);
      const parsed = JSON.parse(view.state_string) as { deckA?: string[]; deckB?: string[] };
      // ATTACK: full future card order of both decks is in state_string today.
      expect(parsed.deckA ?? null).not.toEqual(st.deckA);
      expect(parsed.deckB ?? null).not.toEqual(st.deckB);

      const viewStr = scanString(view as unknown as Json).replaceAll('\\"', '"');
      expect(viewStr).not.toContain(JSON.stringify(st.deckA).slice(1, -1));
      expect(viewStr).not.toContain(JSON.stringify(st.deckB).slice(1, -1));
    }
  });

  it('spectator surfaces (events, public summary) do NOT leak the deck order', () => {
    const islanders = GAMES['islanders']!;
    const landlord = GAMES['landlord']!;

    const isl = makeCore('rt-rand-pred-7', { game: islanders, nSeats: 3 });
    const islDeck = (JSON.parse(JSON.stringify(isl.core.snapshot().state)) as { deck: string[] }).deck;
    const islSpectator = scanString({
      events: isl.core.eventsSince(0) as unknown as Json,
      summary: isl.core.publicStateSummary(),
    }).replaceAll('\\"', '"');
    expect(islSpectator).not.toContain(JSON.stringify(islDeck).slice(1, -1));

    const ll = makeCore('rt-rand-pred-8', { game: landlord });
    const llState = JSON.parse(JSON.stringify(ll.core.snapshot().state)) as { deckA: string[] };
    const llSpectator = scanString({
      events: ll.core.eventsSince(0) as unknown as Json,
      summary: ll.core.publicStateSummary(),
    }).replaceAll('\\"', '"');
    expect(llSpectator).not.toContain(JSON.stringify(llState.deckA).slice(1, -1));
  });
});

describe('attack 1d: published pre-reveal values cannot regenerate the dice sequence', () => {
  it('no seed derivable from (commitment, drand_round, drand_randomness, game_id) reproduces the rolls', () => {
    const gameId = 'rt-rand-pred-9';
    const { core } = playCleanMiniGame(gameId);
    const replay = core.replayFile()!;

    // What actually happened (oracle from the post-game replay): the setup
    // layout draw + one d6 int draw per applied move.
    const actual = replay.seed_draws.map((d) => ({ purpose: d.purpose, arg: d.arg, result: d.result }));
    expect(actual.length).toBe(6); // setup:layout + 5 rolls

    // Everything published pre-reveal that a predictor could key a stream on.
    // (drand randomness is public worldwide the moment the round is emitted.)
    const commitment = replay.commitment;
    const candidates = [
      commitment,
      DRAND,
      sha256Hex(commitment),
      sha256Hex(`${commitment}:${DRAND}`),
      sha256Hex(`${gameId}:${DRAND}`),
      sha256Hex(`${SEED_PREFIX}:${gameId}::${DRAND}`),
      sha256Hex(`${gameId}:${DRAND_ROUND}`),
      sha256Hex(String(DRAND_ROUND)),
    ];

    for (const key of candidates) {
      const s = createSeedStream(key);
      const predicted = actual.map((d) => ({
        purpose: d.purpose,
        arg: d.arg,
        result: s.int(d.purpose, d.arg as number),
      }));
      expect(predicted, `candidate seed ${key.slice(0, 12)}… must NOT reproduce the draws`).not.toEqual(actual);
    }
  });

  it('draws recorded in a move payload only describe randomness already consumed by that move', () => {
    const gameId = 'rt-rand-pred-10';
    const { core, seats } = makeCore(gameId);
    let now = T0 + 100;

    for (let i = 0; i < 3; i++) {
      const res = submit(core, gameId, seats[i % 2]!, 'a', (now += 500)) as SubmitOk;
      expect(res.ok).toBe(true);

      // The move entry that was just published:
      const moveEntries = core.log.filter((e) => e.kind === 'move');
      const entry = moveEntries[moveEntries.length - 1]!;
      const p = entry.payload as { draws: { purpose: string; result: number }[] };

      // Every draw it carries is the roll performed BY this applied move —
      // whose outcome is simultaneously public in the event stream.
      expect(p.draws.length).toBe(1);
      expect(p.draws[0]!.purpose).toBe(`roll:turn:${i}`);
      const moveEvent = res.events.find((e: SpectatorEvent) => e.type === 'move')!;
      const pub = (moveEvent.data as { public: { last_roll: number } }).public;
      expect(pub.last_roll).toBe(p.draws[0]!.result + 1); // die = int + 1, already public
    }
  });
});
