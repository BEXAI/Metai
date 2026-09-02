/**
 * RED TEAM red-team-identity-leakage — attack family 3 (rooms):
 * read another agent's private view or deck order LIVE, straight from the
 * room's own outputs (viewFor, spectator events, publicStateSummary,
 * replayFile). Every test asserts the DEFENDED behavior the spec demands
 * (identity_and_integrity.spectator_reveal, data_model.rules, acceptance
 * A10): a test that fails today demonstrates an exploitable hole.
 *
 * This file turns the games' own `secretProbes` idea against ROOM outputs —
 * not just the game-level views the A10 harness already checks. The key
 * attack surface: buildView ships `state_string = game.encodeState(state)`,
 * and for hidden-information games the encoded state is the FULL state.
 *
 * All keys/seeds deterministic (sha256-derived). No Date.now / Math.random.
 */

import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../../src/crypto/canonical.ts';
import { signEd25519 } from '../../src/crypto/ed25519.ts';
import { publicKeyOf } from '../../src/identity/ed25519.ts';
import {
  playerId,
  type AnyGame,
  type Json,
  type MoveSubmission,
  type PlayerId,
  type VariantConfig,
  type ViewObject,
} from '../../src/kernel/types.ts';
import {
  moveSignMessage,
  RoomCore,
  type RoomSeat,
  type RoomSnapshot,
  type SpectatorEvent,
  type SubmitReject,
} from '../../src/rooms/core.ts';
import { miniGame, secretProbe } from '../../src/rooms/tests/mini-game.ts';
import landlordGame, { secretProbes as landlordProbes } from '../../src/games/landlord/index.ts';
import islandersGame, { secretProbes as islandersProbes } from '../../src/games/islanders/index.ts';
import type { IslState } from '../../src/games/islanders/rules.ts';
import { craft, give } from '../../src/games/islanders/tests/helpers.ts';

const SECRET = '31'.repeat(32); // commit-reveal secret handed to the room
const DRAND = 'ce'.repeat(32);
const NOW = 2_000_000;

interface Seat {
  seat: RoomSeat;
  secretKey: string;
}

function makeSeat(i: number): Seat {
  const secretKey = sha256Hex(`redteam-identity-leakage-room:seat:${i}`);
  return {
    seat: {
      player: playerId(i),
      agent_id: `agent-${i}`,
      handle: `agent${i}`,
      pubkey_ed25519: publicKeyOf(secretKey),
    },
    secretKey,
  };
}

function makeCore(
  game: AnyGame,
  gameId: string,
  nSeats: number,
  variant: VariantConfig = {},
): { core: RoomCore; seats: Seat[] } {
  const seats = Array.from({ length: nSeats }, (_, i) => makeSeat(i));
  const core = RoomCore.create(NOW, {
    gameId,
    game,
    variant,
    seats: seats.map((s) => s.seat),
    division: 'open',
    rulesetVersion: '1.0.0',
    secretHex: SECRET,
    drandRound: 4242,
    drandRandomnessHex: DRAND,
    perMoveMs: 60_000,
    clockScale: 1,
  });
  return { core, seats };
}

/** Sign a move submission exactly as a real agent would. */
function signedSub(
  gameId: string,
  seat: Seat,
  turnIndex: number,
  move: MoveSubmission['move'],
  extra?: Partial<MoveSubmission>,
): { submission: MoveSubmission; signature: string } {
  const submission: MoveSubmission = { game_id: gameId, turn_index: turnIndex, move, ...extra };
  const signature = signEd25519(seat.secretKey, moveSignMessage(gameId, turnIndex, submission));
  return { submission, signature };
}

/**
 * Everything a seated agent actually receives in its view, flattened for
 * probe scanning WITHOUT double-escaping: state_string and board_text are
 * scanned raw (they are raw strings on the wire), the JSON parts canonically.
 */
function flatView(view: ViewObject): string {
  return [
    view.board_text,
    view.state_string,
    canonicalJson(view.public),
    canonicalJson(view.private),
    canonicalJson(view.legal_moves as unknown as Json),
    canonicalJson(view.history as unknown as Json),
    view.rules_card,
    view.phase,
  ].join('\n');
}

function flatEvents(events: readonly SpectatorEvent[]): string {
  return canonicalJson(events as unknown as Json);
}

function landlordDeckProbes(core: RoomCore): string[] {
  // secretProbes(state) for landlord derives from the CURRENT hidden decks.
  return landlordProbes(core.snapshot().state, playerId(0)).filter((p) => p.length >= 3);
}

/** Drive one full submission for the (single) player to move. */
function playNext(core: RoomCore, seats: Seat[], atMs: number): void {
  const movers = core.playersToMoveNow();
  for (const player of movers) {
    const seat = seats.find((s) => s.seat.player === player)!;
    const { submission, signature } = signedSub(core.gameId, seat, core.turnIndex, { index: 0 });
    const r = core.submitMove(atMs, seat.seat.agent_id, submission, signature);
    if (!r.ok) {
      throw new Error(`playNext: room rejected legal index-0 move for ${player}: ${(r as SubmitReject).message}`);
    }
    if (core.status !== 'running') return;
  }
}

// ---------------------------------------------------------------------------
// 1. Mini fixture game: another player's hidden data in a live room view
// ---------------------------------------------------------------------------

describe('room viewFor: cross-player hidden data (mini fixture)', () => {
  it("p0's live view never contains p1's secret, and vice versa", () => {
    const { core } = makeCore(miniGame, 'leak-mini-view', 2);
    const v0 = core.viewFor(playerId(0), NOW + 100);
    const v1 = core.viewFor(playerId(1), NOW + 100);

    // Own secret in own view is allowed (that IS the private view)...
    expect(canonicalJson(v0.private)).toContain(secretProbe(playerId(0)));
    expect(canonicalJson(v1.private)).toContain(secretProbe(playerId(1)));

    // ...but nothing in the FULL view object served to p0 may carry p1's
    // secret. This includes state_string (spec view_object: canonical compact
    // state; acceptance A10: no private view contains another player's hidden
    // data).
    expect(flatView(v0)).not.toContain(secretProbe(playerId(1)));
    expect(flatView(v1)).not.toContain(secretProbe(playerId(0)));
  });

  it('no spectator event or public summary carries either secret before the game ends', () => {
    const { core, seats } = makeCore(miniGame, 'leak-mini-spec', 2);
    for (let step = 0; step < 4 && core.status === 'running'; step++) {
      playNext(core, seats, NOW + 100 * (step + 1));
      const publicStuff = flatEvents(core.eventsSince(0)) + '\n' + canonicalJson(core.publicStateSummary());
      if (core.status === 'running') {
        expect(publicStuff).not.toContain(secretProbe(playerId(0)));
        expect(publicStuff).not.toContain(secretProbe(playerId(1)));
      }
    }
  });

  it('the commit-reveal secret and final_seed never appear in any live output', () => {
    const { core, seats } = makeCore(miniGame, 'leak-mini-reveal', 2);
    const finalSeed = core.snapshot().final_seed;
    for (let step = 0; step < 3 && core.status === 'running'; step++) {
      const live =
        flatEvents(core.eventsSince(0)) +
        '\n' +
        canonicalJson(core.publicStateSummary()) +
        '\n' +
        flatView(core.viewFor(core.playersToMoveNow()[0] ?? playerId(0), NOW + 100)) +
        '\n' +
        canonicalJson(core.log as unknown as Json);
      expect(live).not.toContain(SECRET);
      expect(live).not.toContain(finalSeed);
      playNext(core, seats, NOW + 100 * (step + 1));
    }
  });

  it('replayFile is null while running; reveal appears only after the end event', () => {
    const { core, seats } = makeCore(miniGame, 'leak-mini-replay', 2);
    expect(core.replayFile()).toBeNull();

    let step = 0;
    while (core.status === 'running' && step < 10) {
      expect(core.replayFile()).toBeNull(); // never available mid-game
      playNext(core, seats, NOW + 100 * (step + 1));
      step++;
    }
    expect(core.status).toBe('ended');

    // Post-end: the replay exists and carries the reveal (spec: hidden info
    // appears only in the replay after the game ends).
    const replay = core.replayFile()!;
    expect(replay.reveal_secret).toBe(SECRET);

    // Event ordering: every event before 'end' is free of the secret.
    const events = core.eventsSince(0);
    const endIdx = events.findIndex((e) => e.type === 'end');
    expect(endIdx).toBeGreaterThan(0);
    const preEnd = flatEvents(events.slice(0, endIdx));
    expect(preEnd).not.toContain(SECRET);
    // The reveal event itself comes after 'end' and is the sanctioned channel.
    const revealIdx = events.findIndex((e) => e.type === 'reveal');
    expect(revealIdx).toBeGreaterThan(endIdx);
  });
});

// ---------------------------------------------------------------------------
// 2. Landlord: the hidden deck order in ROOM outputs
// ---------------------------------------------------------------------------

describe('room outputs: landlord deck order (hidden from players AND spectators)', () => {
  const landlord = landlordGame as unknown as AnyGame;

  it("no seat's live view contains the event-deck order", () => {
    const { core } = makeCore(landlord, 'leak-landlord-view', 3);
    const probes = landlordDeckProbes(core);
    expect(probes.length).toBeGreaterThanOrEqual(2); // probes are live

    for (const p of [playerId(0), playerId(1), playerId(2)]) {
      const flat = flatView(core.viewFor(p, NOW + 100));
      for (const probe of probes) {
        expect(flat, `deck-order probe must not reach ${p}'s live view`).not.toContain(probe);
      }
    }
  });

  it('no spectator event or public summary contains the deck order across live play', () => {
    const { core, seats } = makeCore(landlord, 'leak-landlord-spec', 3);
    for (let step = 0; step < 8 && core.status === 'running'; step++) {
      playNext(core, seats, NOW + 1_000 * (step + 1));
      const probes = landlordDeckProbes(core); // decks shrink as cards draw
      const publicStuff = flatEvents(core.eventsSince(0)) + '\n' + canonicalJson(core.publicStateSummary());
      for (const probe of probes) {
        expect(publicStuff, `deck-order probe leaked to spectators at step ${step}`).not.toContain(probe);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Islanders: another player's hand and unplayed saga cards
// ---------------------------------------------------------------------------

describe('room outputs: islanders hands and saga cards', () => {
  const islanders = islandersGame as unknown as AnyGame;

  /** A live 3-seat islanders room whose state has real hidden material. */
  function hydratedRoom(): { core: RoomCore; state: IslState } {
    const { core } = makeCore(islanders, 'leak-islanders', 3);
    const snap = structuredClone(core.snapshot()) as RoomSnapshot;
    const state = craft(3);
    give(state, 'p0', { palm: 2, taro: 1 });
    state.progress['p0'] = ['warrior', 'landmark'];
    snap.state = state as unknown as Json;
    return { core: RoomCore.hydrate(islanders, snap), state };
  }

  it("p1's and p2's live views never contain p0's hand or saga cards", () => {
    const { core, state } = hydratedRoom();
    const probes = islandersProbes(state, playerId(0)).filter((p) => p.length >= 3);
    expect(probes.length).toBeGreaterThanOrEqual(3); // hand line + raw fragments + cards line

    // Sanity: p0's own view legitimately shows its own hand.
    const own = flatView(core.viewFor(playerId(0), NOW + 100));
    expect(probes.some((p) => own.includes(p))).toBe(true);

    for (const other of [playerId(1), playerId(2)]) {
      const flat = flatView(core.viewFor(other, NOW + 100));
      for (const probe of probes) {
        expect(flat, `p0's hidden data must not reach ${other}'s live view`).not.toContain(probe);
      }
    }
  });

  it("spectator events and public summary never contain p0's hand or saga cards", () => {
    const { core, state } = hydratedRoom();
    const probes = islandersProbes(state, playerId(0)).filter((p) => p.length >= 3);
    const publicStuff = flatEvents(core.eventsSince(0)) + '\n' + canonicalJson(core.publicStateSummary());
    for (const probe of probes) {
      expect(publicStuff).not.toContain(probe);
    }
  });
});
