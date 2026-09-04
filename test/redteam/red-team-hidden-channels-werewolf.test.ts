/**
 * RED TEAM red-team-hidden-channels — werewolf (spec acceptance A10, plan §5).
 *
 * Three leaks that every existing gate missed, because every existing gate
 * looks at the same four surfaces (board_text, state_string, publicView,
 * privateView) and these three are somewhere else:
 *
 *  1. `state_hash` ON THE LIVE PUBLIC EVENT FEED. It is sha256 over the WHOLE
 *     state, roles included. The composition is published (2 wolves, seer,
 *     doctor, 4 villagers over 8 named seats = 840 deals) and every other
 *     opening field is a constant, so ONE hash from the unauthenticated
 *     GET /api/games/:id/events recovers the entire role map before a word is
 *     spoken. A substring probe can never see it — a digest matches no probe.
 *  2. `commentary` AT NIGHT. It rides in the same history row as the redacted
 *     `night` notation, is shipped to every seat by kernel/view.ts with no
 *     viewer filter, and is stamped onto the public spectator event. A wolf
 *     narrating its kill there publishes its PARTNER as well as itself.
 *  3. AN ENGLISH SENTENCE PARSING AS ANOTHER PHASE'S VERB. Not a disclosure
 *     leak but the same class of silent harm: "Sleep tight." scanned as the
 *     night verb `sleep`, which in a SIMULTANEOUS day phase is a strike plus a
 *     fabricated permanent ledger act the seat never wrote, with nothing in the
 *     agent's rejections list. Three sentences eliminated a seat for talking.
 *
 * Deterministic only: seeded SeedStreams, sha256-derived keys, explicit nowMs.
 */

import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../../src/crypto/canonical.ts';
import { signEd25519 } from '../../src/crypto/ed25519.ts';
import { publicKeyOf } from '../../src/identity/ed25519.ts';
import { hashState } from '../../src/kernel/hash.ts';
import { isRuleError, playerId, type AnyGame, type Json, type MoveSubmission, type PlayerId } from '../../src/kernel/types.ts';
import { moveSignMessage, RoomCore, type RoomSeat, type SubmitOk } from '../../src/rooms/core.ts';
import werewolf from '../../src/games/werewolf/index.ts';
import tictactoe from '../../src/games/tictactoe/index.ts';
import { NIGHT_NOTATION, parseWwMove } from '../../src/games/werewolf/notation.ts';
import { applyMove, createInitialState, type Seat, type WwState } from '../../src/games/werewolf/rules.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';

const SEATS: PlayerId[] = Array.from({ length: 8 }, (_, i) => playerId(i));
const SECRET = '5b'.repeat(32);
const DRAND = '2e'.repeat(32);
const NOW = 2_000_000;

interface TestSeat {
  seat: RoomSeat;
  secretKey: string;
}

function makeSeats(n: number, tag: string): TestSeat[] {
  return Array.from({ length: n }, (_, i) => {
    const secretKey = sha256Hex(`redteam-hidden-channels:${tag}:${i}`);
    return {
      seat: {
        player: playerId(i),
        agent_id: `agent-${i}`,
        handle: `agent${i}`,
        pubkey_ed25519: publicKeyOf(secretKey),
      },
      secretKey,
    };
  });
}

function makeRoom(tag: string, game: AnyGame = werewolf as unknown as AnyGame, n = 8): { core: RoomCore; seats: TestSeat[]; gameId: string } {
  const seats = makeSeats(n, tag);
  const gameId = `rt-hidden-${tag}`;
  const core = RoomCore.create(NOW, {
    gameId,
    game,
    variant: {},
    seats: seats.map((s) => s.seat),
    division: 'open',
    rulesetVersion: '1.0.0',
    secretHex: SECRET,
    drandRound: 777,
    drandRandomnessHex: DRAND,
    clockScale: 1,
  });
  return { core, seats, gameId };
}

function submit(
  core: RoomCore,
  gameId: string,
  seat: TestSeat,
  move: MoveSubmission['move'],
  nowMs: number,
  extra?: Partial<MoveSubmission>,
): SubmitOk {
  const submission: MoveSubmission = { game_id: gameId, turn_index: core.turnIndex, move, ...extra };
  const signature = signEd25519(seat.secretKey, moveSignMessage(gameId, core.turnIndex, submission));
  const res = core.submitMove(nowMs, seat.seat.agent_id, submission, signature);
  if (!res.ok) throw new Error(`submit rejected: ${res.code} ${res.message}`);
  return res;
}

function roomState(core: RoomCore): WwState {
  return core.snapshot().state as unknown as WwState;
}

/** Every spectator event as the unauthenticated feed would serve it. */
function feed(core: RoomCore): { type: string; data: Record<string, Json> }[] {
  return core.snapshot().events.map((e) => ({ type: e.type, data: e.data as Record<string, Json> }));
}

// ---------------------------------------------------------------------------
// 1. state_hash must not ride the live public feed in a hidden game
// ---------------------------------------------------------------------------

describe('werewolf: the live spectator feed publishes no hash of the hidden state', () => {
  it('no move or timeout event carries state_hash, in any phase', () => {
    const { core, seats, gameId } = makeRoom('nohash');
    let now = NOW + 100;
    // A whole night plus a whole discussion round: the two shapes of the
    // simultaneous resolution path, both of which used to stamp the hash.
    for (const s of seats) submit(core, gameId, s, { index: 0 }, (now += 50));
    for (const s of seats) submit(core, gameId, s, { index: 0 }, (now += 50));
    expect(core.turnIndex).toBe(2);

    const events = feed(core);
    expect(events.some((e) => e.type === 'move')).toBe(true);
    for (const e of events) {
      expect(e.data['state_hash'], `${e.type} published state_hash`).toBeUndefined();
    }
  });

  it('the hash is still LOGGED on every entry, so the offline verifier is untouched', () => {
    const { core, seats, gameId } = makeRoom('loghash');
    let now = NOW + 100;
    for (const s of seats) submit(core, gameId, s, { index: 0 }, (now += 50));
    const moves = core.log.filter((e) => e.kind === 'move');
    expect(moves).toHaveLength(8);
    for (const m of moves) {
      expect(typeof (m.payload as Record<string, Json>)['state_hash']).toBe('string');
    }
    // And the last one really is the hash of the state the room now holds.
    const last = moves[moves.length - 1]!.payload as Record<string, Json>;
    expect(last['state_hash']).toBe(hashState(core.snapshot().state));
  });

  it('a PERFECT-information game still publishes state_hash (the gate is scoped, not global)', () => {
    const { core, seats, gameId } = makeRoom('perfect', tictactoe, 2);
    submit(core, gameId, seats[0]!, { index: 0 }, NOW + 100);
    const move = feed(core).find((e) => e.type === 'move')!;
    expect(typeof move.data['state_hash']).toBe('string');
  });

  it('the 840-deal brute force is what the gate closes: the hash separates every deal', () => {
    // The attack, in miniature. If the opening hash were published, an attacker
    // enumerates the deals consistent with the PUBLIC composition and keeps the
    // one whose hash matches — so the property that makes withholding necessary
    // is exactly that distinct deals hash differently. Pin it, so nobody ever
    // "fixes" this by hoping the hash is somehow blind to roles.
    const seed = createSeedStream(sha256Hex('redteam-hidden-channels:deal'));
    const base = createInitialState(seed, SEATS, {});
    const swapped: WwState = structuredClone(base);
    const wolf = SEATS.find((p) => base.roles[p as Seat] === 'werewolf')! as Seat;
    const villager = SEATS.find((p) => base.roles[p as Seat] === 'villager')! as Seat;
    swapped.roles[wolf] = 'villager';
    swapped.roles[villager] = 'werewolf';
    expect(hashState(swapped as unknown as Json)).not.toBe(hashState(base as unknown as Json));
    // …while the two states are indistinguishable on every public surface.
    expect(werewolf.renderText(swapped, null)).toBe(werewolf.renderText(base, null));
    expect(canonicalJson(werewolf.publicView(swapped))).toBe(canonicalJson(werewolf.publicView(base)));
  });
});

// ---------------------------------------------------------------------------
// 2. commentary is gated by the speech audience, not left beside the redaction
// ---------------------------------------------------------------------------

describe('werewolf: night commentary never reaches a shared surface', () => {
  it('a wolf narrating its kill in commentary publishes nothing to anybody', () => {
    const { core, seats, gameId } = makeRoom('commentary');
    const st = roomState(core);
    const wolfSeat = seats.find((s) => st.roles[s.seat.player as Seat] === 'werewolf')!;
    const aside = 'COMMENTARY-PROBE-WOLF we take p1 tonight, partner';

    let now = NOW + 100;
    submit(core, gameId, wolfSeat, { index: 0 }, (now += 50), { commentary: aside });
    for (const s of seats) {
      if (s === wolfSeat) continue;
      submit(core, gameId, s, { index: 0 }, (now += 50));
    }
    expect(core.turnIndex).toBe(1);

    // The history row exists, still carries the redacted notation, and carries
    // no commentary — for ANY viewer, including the author.
    const row = core.snapshot().history.find((h) => h.player === wolfSeat.seat.player)!;
    expect(row.notation).toBe(NIGHT_NOTATION);
    expect(row.commentary).toBeUndefined();

    for (const s of seats) {
      const view = core.viewFor(s.seat.player, now + 1_000);
      expect(canonicalJson(view as unknown as Json), `${s.seat.player} view`).not.toContain('COMMENTARY-PROBE-WOLF');
    }
    for (const e of feed(core)) {
      expect(canonicalJson(e.data), `${e.type} event`).not.toContain('COMMENTARY-PROBE-WOLF');
    }
    // It is still in the SIGNED submission in the log, which is what the seat
    // actually sent and is withheld until the game has ended.
    expect(canonicalJson(core.log as unknown as Json)).toContain('COMMENTARY-PROBE-WOLF');
  });

  it('day commentary is unaffected — the gate is the audience, not the game', () => {
    const { core, seats, gameId } = makeRoom('day-commentary');
    let now = NOW + 100;
    for (const s of seats) submit(core, gameId, s, { index: 0 }, (now += 50));
    expect(roomState(core).phase).toBe('day_talk');

    const aside = 'COMMENTARY-PROBE-DAY watch p3 squirm';
    submit(core, gameId, seats[0]!, { index: 0 }, (now += 50), { commentary: aside });
    for (const s of seats.slice(1)) submit(core, gameId, s, { index: 0 }, (now += 50));

    const row = core.snapshot().history.find((h) => h.player === 'p0' && h.turnIndex === 1)!;
    expect(row.commentary).toBe(aside);
    expect(feed(core).some((e) => e.data['commentary'] === aside)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. The verb table is phase-scoped: prose is never an act
// ---------------------------------------------------------------------------

describe('werewolf: an English sentence is speech, never another phase\'s move', () => {
  const PROSE = [
    'Sleep tight.',
    'night everyone, see you tomorrow',
    'kill the p3 wagon, it is a trap',
    'guard your claims, p5 flipped twice',
    'peek at p2 tonight if you are the seer',
    'stay_in this wagon',
    'vote p3',
  ];

  it('every one of these parses to `say` in a discussion phase and apply() accepts it', () => {
    const seed = createSeedStream(sha256Hex('redteam-hidden-channels:prose'));
    let s = createInitialState(seed, SEATS, {});
    // Sleep the whole table into day_talk.
    for (const p of SEATS) {
      const r = applyMove(s, p as Seat, parseWwMove(NIGHT_NOTATION, s, p), seed);
      if (isRuleError(r)) throw new Error(`night abstain rejected: ${r.message}`);
      s = r.state;
    }
    expect(s.phase).toBe('day_talk');

    for (const line of PROSE) {
      const move = parseWwMove(line, s, 'p0');
      expect(move.t, `'${line}' did not become speech`).toBe('say');
      expect(isRuleError(applyMove(s, 'p0', move, seed)), `'${line}' was rejected`).toBe(false);
    }
  });

  it('a real discussion sentence costs no strike and writes no ledger act in a SIMULTANEOUS phase', () => {
    const { core, seats, gameId } = makeRoom('prose-room');
    let now = NOW + 100;
    for (const s of seats) submit(core, gameId, s, { index: 0 }, (now += 50));
    expect(roomState(core).phase).toBe('day_talk');

    const held = submit(core, gameId, seats[0]!, 'Sleep tight.', (now += 50));
    expect(held.applied).toBe(false);
    for (const s of seats.slice(1)) submit(core, gameId, s, { index: 0 }, (now += 50));

    expect(core.strikes['p0'] ?? 0).toBe(0);
    const st = roomState(core);
    expect(st.edges.filter((e) => e.from === 'p0')).toEqual([]);
    expect(st.claims.filter((c) => c.speaker === 'p0')).toEqual([]);
    expect(st.reports.filter((r) => r.speaker === 'p0')).toEqual([]);
    const row = core.snapshot().history.find((h) => h.player === 'p0' && h.turnIndex === 1)!;
    expect(row.notation).toBe('say "Sleep tight."');
  });

  it('argument errors are untouched: they are in-phase and still reach apply()', () => {
    const seed = createSeedStream(sha256Hex('redteam-hidden-channels:args'));
    let s = createInitialState(seed, SEATS, {});
    for (const p of SEATS) {
      const r = applyMove(s, p as Seat, parseWwMove(NIGHT_NOTATION, s, p), seed);
      if (isRuleError(r)) throw new Error(`night abstain rejected: ${r.message}`);
      s = r.state;
    }
    for (const [input, code] of [
      ['claim(wizard)', 'bad_role'],
      ['report(p1,wizard)', 'bad_verdict'],
      ['accuse(p99)', 'bad_target'],
    ] as const) {
      const out = applyMove(s, 'p0', parseWwMove(input, s, 'p0'), seed);
      expect(isRuleError(out), `'${input}' should be a RuleError`).toBe(true);
      expect((out as { code: string }).code, input).toBe(code);
    }
  });

  it('the redacted night constant still round-trips to the canonical abstain', () => {
    const seed = createSeedStream(sha256Hex('redteam-hidden-channels:roundtrip'));
    const s = createInitialState(seed, SEATS, {});
    for (const p of SEATS) {
      const move = parseWwMove(NIGHT_NOTATION, s, p);
      expect(move.t === 'sleep' || move.t === 'stay_in').toBe(true);
      expect(werewolf.moveToNotation(move, s)).toBe(NIGHT_NOTATION);
    }
  });
});
