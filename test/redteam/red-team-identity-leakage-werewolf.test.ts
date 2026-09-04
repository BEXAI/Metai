/**
 * RED TEAM red-team-identity-leakage — attack family 3 (rooms), werewolf:
 * read another seat's ROLE live, straight from the room's own outputs
 * (viewFor, spectator events, publicStateSummary, history, replayFile).
 *
 * Werewolf is the first game in the hall whose entire product is a secret that
 * every seat is actively trying to extract, so this file is the one that must
 * never be weakened. Every test asserts the DEFENDED behaviour the plan demands
 * (§5 view/leakage rules, acceptance A10): a test that fails here demonstrates
 * an exploitable hole, not a style disagreement.
 *
 * WHY THIS FILE EXISTS AT ALL, given gate A10 already runs runLeakageCheck:
 * kernel/leakage.ts:78-85 builds its views with `history: []` and
 * `rulesCard: ''`, and never touches a spectator event, a public state summary
 * or a room log. The two channels werewolf actually depends on — the redacted
 * night notation that lands in `history[].notation` and in the public `move`
 * event — are structurally invisible to that harness. So is anything a
 * substring probe cannot express (a count, a boolean, a sort order), which is
 * why the permutation section below carries as much weight as the probe scan.
 *
 * The scans deliberately go beyond the room-private file's `flatView`, which
 * omits `to_move` and `private_messages`. `to_move` is the channel that would
 * publish the power-role seat set on night 1 if the night movers were ever
 * narrowed to the seats with a night action, and `private_messages` is where
 * the pack's whispers ride; a scan that skipped either would be a tautology.
 *
 * All keys/seeds deterministic (sha256-derived). No Date.now / Math.random.
 */

import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../../src/crypto/canonical.ts';
import { signEd25519 } from '../../src/crypto/ed25519.ts';
import { publicKeyOf } from '../../src/identity/ed25519.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import {
  playerId,
  type AnyGame,
  type Json,
  type MoveSubmission,
  type PlayerId,
  type SeedStream,
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
import werewolfGame, { RULES_CARD, secretProbes } from '../../src/games/werewolf/index.ts';
import { ROLES_CANON, VERDICTS_CANON, type Phase, type Role } from '../../src/games/werewolf/board.ts';
import {
  isTerminal,
  legalMoves,
  livingSeats,
  playersToMove,
  type Seat,
  type WwMove,
  type WwState,
} from '../../src/games/werewolf/rules.ts';
import { publicOf, renderText } from '../../src/games/werewolf/render.ts';
import { NIGHT_NOTATION, wwMoveSummary, wwMoveToNotation } from '../../src/games/werewolf/notation.ts';

const werewolf = werewolfGame as unknown as AnyGame;

const SECRET = '5b'.repeat(32); // commit-reveal secret handed to the room
const DRAND = 'a7'.repeat(32);
const NOW = 3_000_000;
const SEATS = 8;

/** All eight seat ids, ascending. */
const ALL: Seat[] = Array.from({ length: SEATS }, (_, i) => playerId(i));

interface Seat_ {
  seat: RoomSeat;
  secretKey: string;
}

function makeSeat(i: number): Seat_ {
  const secretKey = sha256Hex(`redteam-identity-leakage-werewolf:seat:${i}`);
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

function makeCore(gameId: string, game: AnyGame = werewolf): { core: RoomCore; seats: Seat_[] } {
  const seats = Array.from({ length: SEATS }, (_, i) => makeSeat(i));
  const core = RoomCore.create(NOW, {
    gameId,
    game,
    variant: {},
    seats: seats.map((s) => s.seat),
    division: 'open',
    rulesetVersion: '1.0.0',
    secretHex: SECRET,
    drandRound: 5150,
    drandRandomnessHex: DRAND,
    perMoveMs: 60_000,
    clockScale: 1,
    rulesCard: RULES_CARD,
  });
  return { core, seats };
}

/** Sign a move submission exactly as a real agent would. */
function signedSub(
  gameId: string,
  seat: Seat_,
  turnIndex: number,
  move: MoveSubmission['move'],
  extra?: Partial<MoveSubmission>,
): { submission: MoveSubmission; signature: string } {
  const submission: MoveSubmission = { game_id: gameId, turn_index: turnIndex, move, ...extra };
  const signature = signEd25519(seat.secretKey, moveSignMessage(gameId, turnIndex, submission));
  return { submission, signature };
}

/**
 * Everything a seated agent actually receives, flattened for probe scanning
 * WITHOUT double-escaping: board_text and state_string are raw strings on the
 * wire and are scanned raw; the JSON parts canonically.
 *
 * `to_move` and `private_messages` are scanned here and are NOT in the
 * room-private file's flatView. Without them the two newest leak channels in
 * the hall would be unscanned and this file would pass vacuously.
 */
function flatView(view: ViewObject): string {
  return [
    view.board_text,
    view.state_string,
    canonicalJson(view.public),
    canonicalJson(view.private),
    canonicalJson(view.legal_moves as unknown as Json),
    canonicalJson(view.history as unknown as Json),
    canonicalJson(view.to_move as unknown as Json),
    canonicalJson((view.private_messages ?? []) as unknown as Json),
    canonicalJson((view.speech ?? null) as unknown as Json),
    view.rules_card,
    view.phase,
  ].join('\n');
}

function flatEvents(events: readonly SpectatorEvent[]): string {
  return canonicalJson(events as unknown as Json);
}

function stateOf(core: RoomCore): WwState {
  return core.snapshot().state as unknown as WwState;
}

/** Probes for `p`, filtered to the harness's own minimum useful length. */
function probesFor(s: WwState, p: Seat): string[] {
  return secretProbes(s, p).filter((x) => x.length >= 6);
}

// ---------------------------------------------------------------------------
// A deterministic 8-seat driver that actually plays the game
// ---------------------------------------------------------------------------

/**
 * Night text is UNIQUE PER SEAT PER DAY and carries no role word, so it can be
 * tracked as a private-text probe on its own: a wolf's whisper may reach its
 * packmate and nobody else, and a villager's note may reach nobody at all.
 */
function nightToken(p: Seat, day: number): string {
  return `NIGHTNOTE-${p.toUpperCase()}-D${day}-QZX`;
}
function dayToken(p: Seat, day: number, round: number): string {
  return `DAYWORD-${p.toUpperCase()}-D${day}R${round}-QZX`;
}

interface DriveLog {
  /** turn index -> the phase the state was in when that turn opened. */
  turnPhase: Map<number, Phase>;
  /** One snapshot per turn boundary, for the permutation section. */
  snapshots: RoomSnapshot[];
  /** Every (seat, token) pair of night text actually submitted. */
  nightTokens: { seat: Seat; token: string }[];
  turns: number;
  phasesSeen: Set<Phase>;
}

/**
 * Plays a whole game with a seeded, information-RICH policy: index 0 (the null
 * act) is avoided wherever a real choice exists, so the wolves always kill, the
 * seer always checks, the doctor always guards and every ballot is cast. The
 * first mover of each discussion round 0 is forced onto an accusation so the
 * one-mover `day_defense` phase is exercised on every day rather than by luck.
 *
 * `onTurn` runs once per turn boundary, i.e. once per applied resolution, which
 * is every state the room ever rests in.
 */
function driveGame(
  core: RoomCore,
  seats: Seat_[],
  tag: string,
  onTurn: (core: RoomCore) => void,
): DriveLog {
  const sd: SeedStream = createSeedStream(sha256Hex(`redteam-ww-policy:${tag}`));
  const log: DriveLog = {
    turnPhase: new Map(),
    snapshots: [],
    nightTokens: [],
    turns: 0,
    phasesSeen: new Set(),
  };

  let ms = NOW + 1_000;
  let guard = 0;
  while (core.status === 'running' && guard++ < 400) {
    const st = stateOf(core);
    const phase = st.phase;
    const turn = core.turnIndex;
    log.turnPhase.set(turn, phase);
    log.phasesSeen.add(phase);
    log.snapshots.push(structuredClone(core.snapshot()) as RoomSnapshot);

    const movers = core.playersToMoveNow();
    expect(movers.length, `a running room must always have a mover (turn ${turn})`).toBeGreaterThan(0);

    for (let m = 0; m < movers.length; m++) {
      const player = movers[m]!;
      const seat = seats.find((s) => s.seat.player === player)!;
      const legal = legalMoves(stateOf(core), player);
      expect(legal.length, `${player} is to move but has no legal move`).toBeGreaterThan(0);

      let index: number;
      if (phase === 'day_talk' && st.round === 0 && m === 0) {
        index = 1; // accuse(lowest other living seat): guarantees a defence phase
      } else if (legal.length === 1) {
        index = 0;
      } else {
        index = 1 + sd.int(`pick:${tag}`, legal.length - 1);
      }

      const utterance =
        phase === 'night'
          ? nightToken(player, st.day)
          : dayToken(player, st.day, st.round);
      if (phase === 'night') log.nightTokens.push({ seat: player, token: utterance });

      ms += 250;
      const { submission, signature } = signedSub(core.gameId, seat, core.turnIndex, { index }, { utterance });
      const r = core.submitMove(ms, seat.seat.agent_id, submission, signature);
      if (!r.ok) {
        throw new Error(`drive: room rejected a legal move for ${player}: ${(r as SubmitReject).message}`);
      }
      if (core.status !== 'running') break;
    }

    log.turns++;
    onTurn(core);
  }
  return log;
}

// ---------------------------------------------------------------------------
// 0. The probes themselves must be capable of firing
// ---------------------------------------------------------------------------

describe('werewolf secretProbes: not vacuous', () => {
  it('every living seat yields probes that WOULD catch a raw state dump', () => {
    const { core } = makeCore('ww-probe-selftest');
    const s = stateOf(core);
    const raw = canonicalJson(s as unknown as Json);
    const dossierMutant = ALL.map((p) => `  ${p} ${s.roles[p]!.toUpperCase()}  alive`).join('\n');

    for (const p of ALL) {
      const probes = probesFor(s, p);
      // roles-map fragment, viewStateString `you` shape, dossier row shape.
      expect(probes.length, `${p} must have at least three probe encodings`).toBeGreaterThanOrEqual(3);
      expect(raw, `${p}'s roles-map probe must fire on a raw state dump`).toContain(`"${p}":"${s.roles[p]}"`);
      expect(
        probes.some((x) => dossierMutant.includes(x)),
        `${p} must have a probe that fires on a dossier row printing its role`,
      ).toBe(true);
    }
  });

  it('probes go quiet only for a REVEALED dead seat or a terminal state', () => {
    const { core, seats } = makeCore('ww-probe-quiet');
    driveGame(core, seats, 'quiet', () => {});
    const s = stateOf(core);
    expect(isTerminal(s)).not.toBeNull();
    // Terminal: the reveal is legal, so every probe set is empty by design.
    for (const p of ALL) expect(secretProbes(s, p)).toEqual([]);
    // Every dead seat's role is public, and every death path reveals — which
    // is what keeps public.wolves_remaining derivable rather than leaky.
    for (const p of ALL) {
      if (s.alive[p] === true) continue;
      expect(s.revealed[p], `${p} died without a revealed role`).toBe(s.roles[p]);
    }
  });
});

// ---------------------------------------------------------------------------
// 1. A real 8-seat room: no role reaches another seat, in any phase
// ---------------------------------------------------------------------------

describe('werewolf room: no role leaks to another seat, every phase, every role', () => {
  it('no seat probe appears in any OTHER seat view, spectator event or public summary', () => {
    const { core, seats } = makeCore('ww-live-leak');

    let checkedStates = 0;
    let checkedPairs = 0;
    const rolesScanned = new Set<Role>();

    const scan = (c: RoomCore): void => {
      const s = stateOf(c);
      const running = c.status === 'running';
      for (const p of ALL) if (s.alive[p] === true) rolesScanned.add(s.roles[p]!);
      const views = new Map<Seat, string>();
      for (const v of ALL) views.set(v, flatView(c.viewFor(v, NOW)));
      const publicStuff = flatEvents(c.eventsSince(0)) + '\n' + canonicalJson(c.publicStateSummary());
      checkedStates++;

      for (const q of ALL) {
        const probes = probesFor(s, q);
        if (probes.length === 0) continue;
        // Sanity: the owner's own view legitimately carries at least one of them.
        expect(
          probes.some((x) => views.get(q)!.includes(x)),
          `${q} must be able to read its OWN file (probe set would be vacuous otherwise)`,
        ).toBe(true);

        for (const v of ALL) {
          if (v === q) continue;
          checkedPairs++;
          for (const probe of probes) {
            expect(
              views.get(v)!,
              `${q}'s hidden material reached ${v}'s live view in phase ${s.phase} (probe ${JSON.stringify(probe)})`,
            ).not.toContain(probe);
          }
        }
        if (running) {
          for (const probe of probes) {
            expect(
              publicStuff,
              `${q}'s hidden material reached spectators in phase ${s.phase} (probe ${JSON.stringify(probe)})`,
            ).not.toContain(probe);
          }
        }
      }
    };

    scan(core);
    const log = driveGame(core, seats, 'live-leak', scan);

    expect(core.status).toBe('ended');
    // Coverage: the scan must have run over every phase the game has, and over
    // enough states that "no leak found" is a statement about the game.
    expect(log.phasesSeen.has('night')).toBe(true);
    expect(log.phasesSeen.has('day_talk')).toBe(true);
    expect(log.phasesSeen.has('day_defense')).toBe(true);
    expect(log.phasesSeen.has('day_vote')).toBe(true);
    expect(checkedStates).toBeGreaterThan(10);
    expect(checkedPairs).toBeGreaterThan(200);
    // "every role" has to be a fact about the corpus, not an assumption: a
    // deal that never seated a doctor would leave the doctor's guard-ledger
    // probe family unexercised and this test quietly narrower than its name.
    expect([...rolesScanned].sort()).toEqual([...ROLES_CANON].sort());
  });

  it('a DEAD seat gets no ghost omniscience', () => {
    const { core, seats } = makeCore('ww-ghost');
    let sawDead = 0;
    driveGame(core, seats, 'ghost', (c) => {
      const s = stateOf(c);
      if (c.status !== 'running') return;
      for (const v of ALL) {
        if (s.alive[v] === true) continue;
        sawDead++;
        const flat = flatView(c.viewFor(v, NOW));
        for (const q of ALL) {
          if (q === v) continue;
          for (const probe of probesFor(s, q)) {
            expect(flat, `dead ${v} read ${q}'s role`).not.toContain(probe);
          }
        }
      }
    });
    expect(sawDead, 'the drive must actually kill somebody for this test to mean anything').toBeGreaterThan(0);
  });

  it('the harness is not vacuous: a publicView that dumps state.roles IS caught', () => {
    // Negative control. Without this, a green scan above has demonstrated
    // nothing — it could be scanning a string that never contained a role.
    const leaky: AnyGame = {
      ...werewolf,
      publicView(state: Json): Json {
        const st = state as unknown as WwState;
        return { ...(publicOf(st) as unknown as Record<string, Json>), roles: st.roles as unknown as Json };
      },
    };
    const { core } = makeCore('ww-mutant-public', leaky);
    const s = stateOf(core);
    const flat = flatView(core.viewFor(playerId(0), NOW));
    const caught = ALL.filter((q) => q !== playerId(0)).some((q) =>
      probesFor(s, q).some((probe) => flat.includes(probe)),
    );
    expect(caught, 'a roles-dumping publicView must trip the probe scan').toBe(true);
  });

  it('the harness is not vacuous: a dossier row naming a living seat IS caught', () => {
    const leaky: AnyGame = {
      ...werewolf,
      renderText(state: Json, viewer: PlayerId | null): string {
        const st = state as unknown as WwState;
        const extra = st.players.map((p) => `  ${p} ${st.roles[p]!.toUpperCase()}  alive`).join('\n');
        return renderText(st, viewer) + '\n' + extra;
      },
    };
    const { core } = makeCore('ww-mutant-dossier', leaky);
    const s = stateOf(core);
    const flat = flatView(core.viewFor(playerId(0), NOW));
    const caught = ALL.filter((q) => q !== playerId(0)).some((q) =>
      probesFor(s, q).some((probe) => flat.includes(probe)),
    );
    expect(caught, 'a dossier row printing another seat role must trip the probe scan').toBe(true);
  });

  it('the harness is not vacuous: a privateView carrying the roles map IS caught', () => {
    const leaky: AnyGame = {
      ...werewolf,
      privateView(state: Json, viewer: PlayerId): Json {
        const st = state as unknown as WwState;
        return { you: viewer, table: st.roles as unknown as Json };
      },
    };
    const { core } = makeCore('ww-mutant-private', leaky);
    const s = stateOf(core);
    const flat = flatView(core.viewFor(playerId(0), NOW));
    const caught = ALL.filter((q) => q !== playerId(0)).some((q) =>
      probesFor(s, q).some((probe) => flat.includes(probe)),
    );
    expect(caught, 'a privateView dumping the whole table must trip the probe scan').toBe(true);
  });

  it('the harness is not vacuous: a viewStateString `you` block for all eight IS caught', () => {
    // The `"seat":"pN","role":"role"` probe is written against
    // viewStateString's HAND-ORDERED JSON.stringify. canonicalJson sorts keys,
    // so that encoding can only ever appear on this one surface — which is
    // exactly why the probe set is multi-encoding rather than a single
    // fragment. This control pins the coupling: if the `you` block is ever
    // reordered, the probe silently stops firing and this test goes red first.
    const leaky: AnyGame = {
      ...werewolf,
      viewStateString(state: Json): string {
        const st = state as unknown as WwState;
        return JSON.stringify({
          table: st.players.map((p) => ({ seat: p, role: st.roles[p]! })),
        });
      },
    };
    const { core } = makeCore('ww-mutant-statestring', leaky);
    const s = stateOf(core);
    const flat = flatView(core.viewFor(playerId(0), NOW));
    for (const q of ALL) {
      if (q === playerId(0)) continue;
      expect(
        probesFor(s, q).some((probe) => flat.includes(probe)),
        `a viewStateString dumping the table must trip ${q}'s probe set`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The night redaction: every night move notates as the constant `night`
// ---------------------------------------------------------------------------

describe('werewolf night redaction: the notation is the constant', () => {
  it('every legal night move of every role notates as exactly "night"', () => {
    const { core } = makeCore('ww-night-notation');
    const s = stateOf(core);
    expect(s.phase).toBe('night');

    const notations = new Set<string>();
    let byRole = 0;
    for (const p of ALL) {
      const legal = legalMoves(s, p) as WwMove[];
      expect(legal.length).toBeGreaterThan(0);
      byRole++;
      for (const m of legal) notations.add(wwMoveToNotation(m));
    }
    expect(byRole).toBe(SEATS);
    expect([...notations]).toEqual([NIGHT_NOTATION]);
    expect(NIGHT_NOTATION).toBe('night');

    // The constant carries zero bits: no seat token, no role literal, no verdict.
    expect(/\bp\d+\b/.test(NIGHT_NOTATION)).toBe(false);
    for (const r of ROLES_CANON) expect(NIGHT_NOTATION).not.toContain(r);
    for (const v of VERDICTS_CANON) expect(NIGHT_NOTATION).not.toContain(v);
  });

  it('night text rides in the move but NEVER in the notation', () => {
    // The redaction has to survive the speech channel, or the whole design
    // leaks the moment an agent whispers.
    const { core } = makeCore('ww-night-notation-text');
    const s = stateOf(core);
    for (const p of ALL) {
      for (const m of legalMoves(s, p) as WwMove[]) {
        const spoken = { ...m, text: 'we take p6 tonight, I am the seer' } as WwMove;
        expect(wwMoveToNotation(spoken)).toBe(NIGHT_NOTATION);
      }
    }
  });

  it('night summaries name no role and no verdict (L6a)', () => {
    // moveSummary renders OUTSIDE the prompt fence and gate A10 cannot catch a
    // role-naming summary (leakage.ts does a plain substring test, and
    // "KILL p3 (villager)" matches no probe), so it is asserted directly here.
    const { core } = makeCore('ww-night-summary');
    const s = stateOf(core);
    let checked = 0;
    for (const p of ALL) {
      for (const m of legalMoves(s, p) as WwMove[]) {
        const summary = wwMoveSummary(m, s);
        checked++;
        for (const r of ROLES_CANON) {
          expect(summary.toLowerCase(), `night summary named the role ${r}`).not.toContain(r);
        }
        for (const v of VERDICTS_CANON) {
          expect(summary.toLowerCase(), `night summary named the verdict ${v}`).not.toContain(v);
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('a summary that names a target role is caught by L6a (negative control)', () => {
    const { core } = makeCore('ww-night-summary-mutant');
    const s = stateOf(core);
    const leakySummary = (m: WwMove): string => {
      const t = (m as { target?: string }).target;
      return t === undefined ? wwMoveSummary(m, s) : `${wwMoveSummary(m, s)} (${s.roles[t]})`;
    };
    const offending = ALL.flatMap((p) => legalMoves(s, p) as WwMove[])
      .map(leakySummary)
      .filter((x) => ROLES_CANON.some((r) => x.toLowerCase().includes(r)));
    expect(offending.length, 'the L6a rule must reject a role-naming summary').toBeGreaterThan(0);
  });

  it('in a live room every night history row and every night move event is "night"', () => {
    const { core, seats } = makeCore('ww-night-history');
    const log = driveGame(core, seats, 'night-history', () => {});

    const nightTurns = new Set(
      [...log.turnPhase.entries()].filter(([, p]) => p === 'night').map(([t]) => t),
    );
    expect(nightTurns.size, 'the drive must have played at least two nights').toBeGreaterThanOrEqual(2);

    const history = core.snapshot().history;
    let nightRows = 0;
    for (const h of history) {
      if (!nightTurns.has(h.turnIndex)) continue;
      nightRows++;
      expect(h.notation, `history row for ${h.player} leaked a night action`).toBe(NIGHT_NOTATION);
    }
    expect(nightRows, 'no night history rows were produced').toBeGreaterThanOrEqual(2 * 5);

    // The public spectator feed carries the same constant, verbatim.
    let nightEvents = 0;
    for (const e of core.eventsSince(0)) {
      if (e.type !== 'move' && e.type !== 'timeout') continue;
      const d = e.data as Record<string, Json>;
      const turn = d['turn_index'];
      if (typeof turn !== 'number' || !nightTurns.has(turn)) continue;
      nightEvents++;
      expect(d['notation'], 'a spectator move event leaked a night action').toBe(NIGHT_NOTATION);
    }
    expect(nightEvents).toBeGreaterThanOrEqual(2 * 5);

    // No night notation anywhere may name a verb, a seat or a role.
    const nightNotations = new Set(
      history.filter((h) => nightTurns.has(h.turnIndex)).map((h) => h.notation),
    );
    expect([...nightNotations]).toEqual([NIGHT_NOTATION]);
    for (const verb of ['kill', 'peek', 'guard', 'sleep', 'stay_in']) {
      expect([...nightNotations].join(' ')).not.toContain(verb);
    }
  });

  it('an unredacted night notation IS caught in the live room (negative control)', () => {
    // The headline claim of this file is that the night history and the public
    // `move` event carry zero bits. Without this control that claim rests on a
    // scan that has only ever seen compliant data. A game identical to werewolf
    // except that its night moves notate literally must be caught by the very
    // same predicate — and the leak it produces is the real one: `kill(p6)` in
    // a row every villager and every spectator reads.
    const leakyNotation: AnyGame = {
      ...werewolf,
      moveToNotation(move: Json): string {
        const m = move as unknown as WwMove;
        const t = (m as { target?: string }).target;
        switch (m.t) {
          case 'kill':
          case 'peek':
          case 'guard':
            return `${m.t}(${t})`;
          case 'stay_in':
          case 'sleep':
            return m.t;
          default:
            return wwMoveToNotation(m);
        }
      },
    };

    const nightRowsAreRedacted = (c: RoomCore, nightTurns: Set<number>): boolean =>
      c
        .snapshot()
        .history.filter((h) => nightTurns.has(h.turnIndex))
        .every((h) => h.notation === NIGHT_NOTATION);

    const clean = makeCore('ww-notation-clean');
    const cleanLog = driveGame(clean.core, clean.seats, 'notation-clean', () => {});
    const cleanNights = new Set(
      [...cleanLog.turnPhase.entries()].filter(([, p]) => p === 'night').map(([t]) => t),
    );
    expect(nightRowsAreRedacted(clean.core, cleanNights)).toBe(true);

    const leaky = makeCore('ww-notation-leaky', leakyNotation);
    const leakyLog = driveGame(leaky.core, leaky.seats, 'notation-leaky', () => {});
    const leakyNights = new Set(
      [...leakyLog.turnPhase.entries()].filter(([, p]) => p === 'night').map(([t]) => t),
    );
    expect(leakyNights.size).toBeGreaterThanOrEqual(1);
    expect(
      nightRowsAreRedacted(leaky.core, leakyNights),
      'the night-redaction predicate must reject a literal night notation',
    ).toBe(false);

    // ...and the leak really does reach a seat that must not have it: the
    // wolves' target lands in every other seat's fenced history.
    const anyOtherSeatView = flatView(leaky.core.viewFor(playerId(0), NOW));
    const leakedRow = leaky.core
      .snapshot()
      .history.find((h) => leakyNights.has(h.turnIndex) && /^(kill|peek|guard)\(/.test(h.notation));
    expect(leakedRow, 'the control game must actually have produced a literal night notation').toBeDefined();
    expect(flatEvents(leaky.core.eventsSince(0))).toContain(leakedRow!.notation);
    expect(anyOtherSeatView.length).toBeGreaterThan(0);
  });

  it('the widened history window shows WHO acted, never WHAT — for every seat', () => {
    // meta.historyWindow = 60 exists so an agent can see a whole cycle. That
    // widening is exactly what would turn a leaky night notation from a
    // one-turn slip into a permanent public record, so it is asserted here.
    expect(werewolfGame.meta.historyWindow).toBe(60);

    const { core, seats } = makeCore('ww-history-window');
    const nightTurnsSeen: number[] = [];
    driveGame(core, seats, 'history-window', (c) => {
      const rows = c.viewFor(playerId(3), NOW).history;
      // A cycle is 33 rows; the window must be wide enough to matter.
      expect(rows.length).toBeLessThanOrEqual(60);
      for (const h of rows) {
        if (h.notation !== NIGHT_NOTATION) continue;
        nightTurnsSeen.push(h.turnIndex);
      }
    });

    expect(nightTurnsSeen.length, 'the window never carried a night row').toBeGreaterThan(8);

    // Per night turn: one row per living seat, all identical, so the rows say
    // exactly what public.acted_this_night already says and nothing more.
    const byTurn = new Map<number, Set<PlayerId>>();
    for (const h of core.snapshot().history) {
      if (h.notation !== NIGHT_NOTATION) continue;
      (byTurn.get(h.turnIndex) ?? byTurn.set(h.turnIndex, new Set()).get(h.turnIndex)!).add(h.player);
    }
    for (const [turn, players] of byTurn) {
      const rows = core.snapshot().history.filter((h) => h.turnIndex === turn);
      expect(rows.every((h) => h.notation === NIGHT_NOTATION)).toBe(true);
      expect(players.size, `night turn ${turn} did not have one row per acting seat`).toBe(rows.length);
    }
  });

  it('to_move at night is EVERY living seat, and a narrowed one is caught', () => {
    // The reason every villager submits a pointless `sleep`: buildView ships
    // to_move to every seat and publicStateSummary publishes players_to_move,
    // so night movers narrowed to {wolves, seer, doctor} would publish the
    // power-role seat set on night 1.
    const nightMoversAreEveryLivingSeat = (g: AnyGame, s: WwState): boolean => {
      if (s.phase !== 'night') return true;
      const movers = g.playersToMove(s as unknown as Json);
      const living = livingSeats(s);
      return movers.length === living.length && living.every((p) => movers.includes(p));
    };

    const { core, seats } = makeCore('ww-to-move');
    let nights = 0;
    const checkNight = (c: RoomCore): void => {
      const s = stateOf(c);
      if (s.phase !== 'night' || c.status !== 'running') return;
      nights++;
      expect(nightMoversAreEveryLivingSeat(werewolf, s), 'night to_move narrowed to the power roles').toBe(true);
      const summary = c.publicStateSummary() as Record<string, Json>;
      expect(summary['players_to_move']).toEqual(livingSeats(s));
      // to_move is shipped to every seated player, not just the mover, so the
      // per-seat view has to say the same thing.
      for (const v of ALL) expect(c.viewFor(v, NOW).to_move).toEqual(livingSeats(s));
    };
    checkNight(core); // night 1 — the state driveGame's onTurn hook never sees
    driveGame(core, seats, 'to-move', checkNight);
    expect(nights).toBeGreaterThanOrEqual(3);

    // NEGATIVE CONTROL: a fixture where only the seats with a night action move
    // must be REJECTED by the same predicate, or the assertion above is a
    // tautology that would survive the leak it exists to prevent.
    const leakyToMove: AnyGame = {
      ...werewolf,
      playersToMove(state: Json): PlayerId[] {
        const s = state as unknown as WwState;
        if (s.phase !== 'night') return playersToMove(s);
        return livingSeats(s).filter((p) => s.roles[p] !== 'villager' && s.nightActs[p] === undefined);
      },
    };
    const fresh = stateOf(makeCore('ww-to-move-control').core);
    expect(nightMoversAreEveryLivingSeat(werewolf, fresh)).toBe(true);
    expect(nightMoversAreEveryLivingSeat(leakyToMove, fresh)).toBe(false);
  });

  it('no public surface ever publishes a legal-move count (L2)', () => {
    // legal_moves cardinality is a bare role oracle at night: 7 wolf / 8 seer /
    // 9 doctor / 1 villager. It is per-viewer by construction; nothing public
    // may restate it. Scanned STRUCTURALLY, by key, not by substring: the
    // dossier's NOW block legitimately contains the engine-authored phrase
    // "your own legal_moves summary", which is prose about the viewer's own
    // view and carries no count. A published count would additionally break
    // P1 below, since it would change under a role permutation.
    const { core, seats } = makeCore('ww-legal-count');
    const offending = (v: Json): string[] => {
      const found: string[] = [];
      const walk = (x: Json): void => {
        if (Array.isArray(x)) {
          for (const y of x) walk(y);
          return;
        }
        if (typeof x === 'object' && x !== null) {
          for (const [k, y] of Object.entries(x)) {
            if (/legal/i.test(k)) found.push(k);
            walk(y as Json);
          }
        }
      };
      walk(v);
      return found;
    };
    driveGame(core, seats, 'legal-count', (c) => {
      expect(offending(c.publicStateSummary())).toEqual([]);
    });
    expect(offending(core.eventsSince(0) as unknown as Json)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Private text: night notes and pack whispers
// ---------------------------------------------------------------------------

describe('werewolf private text: night notes and the pack channel', () => {
  it("a seat's night words reach only that seat, and a wolf's only its pack", () => {
    const { core, seats } = makeCore('ww-night-text');
    const log = driveGame(core, seats, 'night-text', () => {});
    expect(log.nightTokens.length, 'the drive must have submitted night text').toBeGreaterThan(8);

    const s = stateOf(core);
    const wolves = new Set(ALL.filter((p) => s.roles[p] === 'werewolf'));
    const views = new Map<Seat, string>(ALL.map((v) => [v, flatView(core.viewFor(v, NOW))]));
    const publicStuff = flatEvents(core.eventsSince(0)) + '\n' + canonicalJson(core.publicStateSummary());

    let ownHits = 0;
    for (const { seat: q, token } of log.nightTokens) {
      expect(token.length).toBeGreaterThan(10);
      // Never public. `emitGameEvents` drops every non-public GameEvent, and
      // the night ledgers are absent from publicView, board_text and
      // state_string — so this holds even after the game has ended.
      expect(publicStuff, `${q}'s night text ${token} reached spectators`).not.toContain(token);

      if (views.get(q)!.includes(token)) ownHits++;
      for (const v of ALL) {
        if (v === q) continue;
        const packmate = wolves.has(q) && wolves.has(v);
        if (packmate) continue; // the pack channel is a legitimately SHARED secret
        expect(views.get(v)!, `${q}'s night text ${token} reached ${v}`).not.toContain(token);
      }
    }
    // The negative assertions above would be vacuous if the night words never
    // reached ANYBODY, so pin the positive side too: at least a full opening
    // night's worth is readable by its own author. It is not all of them —
    // resolveNight materialises the ledgers from the LIVING seats after the
    // kill has landed, so a seat murdered on the night it wrote a note keeps
    // that note only in the private GameEvent and the replay, not in noteLog.
    expect(ownHits, 'no seat could read back its own night words').toBeGreaterThanOrEqual(SEATS - 1);
  });

  it('the pack channel travels in private_messages, never in privateView', () => {
    const { core, seats } = makeCore('ww-pack-channel');
    driveGame(core, seats, 'pack-channel', (c) => {
      const s = stateOf(c);
      const wolves = ALL.filter((p) => s.roles[p] === 'werewolf');
      for (const v of ALL) {
        const view = c.viewFor(v, NOW);
        const priv = view.private as Record<string, Json>;
        const isWolf = wolves.includes(v);

        // pack is non-null IFF the viewer is a wolf, alive or dead, and is a
        // SORTED SEAT ARRAY — never a role map, which would fire the canonical
        // role probe on the partner's own correct view.
        if (isWolf) {
          expect(priv['pack']).toEqual([...wolves].sort());
          expect(canonicalJson(priv['pack'] as Json)).not.toContain('werewolf');
        } else {
          expect(priv['pack']).toBeNull();
          expect(priv['pack_alive']).toBeNull();
          expect(priv['pack_message_count']).toBeNull();
        }

        // The WORDS are never in privateView; that surface renders outside the
        // prompt fence, so another agent's bytes must not land in it.
        const privJson = canonicalJson(priv as Json);
        const pubJson = canonicalJson(view.public);
        for (const m of s.packLog) {
          expect(privJson, 'a pack whisper landed in the out-of-fence private view').not.toContain(m.text);
          expect(view.state_string, 'a pack whisper landed in state_string').not.toContain(m.text);
          expect(view.board_text, 'a pack whisper landed in board_text').not.toContain(m.text);
          expect(pubJson, 'a pack whisper landed in publicView').not.toContain(m.text);
        }

        // ...and they DO arrive, fenced, for the pack. The split is the point:
        // privateView carries the STRUCTURE of the pack and renders outside the
        // fence; private_messages carries the bytes another agent wrote and
        // renders inside it.
        const pm = view.private_messages ?? [];
        expect(pm.length).toBe(isWolf ? s.packLog.length : 0);
        for (const msg of pm) expect(msg.channel).toBe('pack');
        if (isWolf) {
          expect(priv['pack_message_count']).toBe(s.packLog.length);
          const fenced = canonicalJson(pm as unknown as Json);
          for (const m of s.packLog) {
            expect(fenced, 'a pack whisper never reached the packmate at all').toContain(m.text);
          }
        }
      }
    });
  });

  it('privateView key set is uniform across every role, alive and dead', () => {
    // A role-dependent key set is itself a role oracle for anything that can
    // observe the shape or the byte length of a stored private view.
    const FROZEN = [
      'pack',
      'pack_alive',
      'pack_message_count',
      'you',
      'you_alive',
      'your_guards',
      'your_night_acts',
      'your_notes',
      'your_peeks',
      'your_role',
    ];
    const { core, seats } = makeCore('ww-private-shape');
    const roleShapes = new Set<string>();
    driveGame(core, seats, 'private-shape', (c) => {
      const s = stateOf(c);
      for (const v of ALL) {
        const priv = c.viewFor(v, NOW).private as Record<string, Json>;
        expect(Object.keys(priv).sort()).toEqual(FROZEN);
        expect(priv['your_role']).toBe(s.roles[v]);
        expect(priv['you']).toBe(v);
        roleShapes.add(String(s.roles[v]));
      }
    });
    expect(roleShapes.size, 'the drive must have observed every role').toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 4. publicView / spectator surfaces
// ---------------------------------------------------------------------------

describe('werewolf public surfaces: the frozen shape and no living role', () => {
  const FROZEN_PUBLIC = [
    'acted_this_night',
    'alive',
    'archived',
    'claims',
    'day',
    'dead',
    'defender',
    'defenders',
    'edges',
    'nights',
    'pending',
    'phase',
    'players',
    'reports',
    'round',
    'spoke_this_round',
    'transcript',
    'village_remaining',
    'vote_history',
    'voted_this_phase',
    'wolves_remaining',
  ];

  it('publicView key set is frozen in every phase (catches a re-added `saved` or `result`)', () => {
    const { core, seats } = makeCore('ww-public-keys');
    const phases = new Set<Phase>();
    const check = (c: RoomCore): void => {
      const s = stateOf(c);
      phases.add(s.phase);
      const pub = werewolf.publicView(s as unknown as Json) as Record<string, Json>;
      expect(Object.keys(pub).sort(), `publicView key set drifted in phase ${s.phase}`).toEqual(FROZEN_PUBLIC);
      // The derived-hidden fields have no owner, so no substring probe can
      // express them: the frozen key set is their only cheap tripwire.
      expect(Object.keys(pub)).not.toContain('saved');
      expect(Object.keys(pub)).not.toContain('result');
      expect(Object.keys(pub)).not.toContain('roles');
      expect(canonicalJson(pub['nights']!)).not.toContain('saved');
    };
    check(core);
    driveGame(core, seats, 'public-keys', check);
    for (const p of ['night', 'day_talk', 'day_defense', 'day_vote', 'over'] as Phase[]) {
      expect(phases.has(p), `phase ${p} was never observed`).toBe(true);
    }
  });

  it('the spectator dossier prints a role only for a seat that has died', () => {
    const { core, seats } = makeCore('ww-spectator-dossier');
    driveGame(core, seats, 'spectator-dossier', (c) => {
      const s = stateOf(c);
      const board = werewolf.renderText(s as unknown as Json, null);
      const pub = publicOf(s);
      for (const p of ALL) {
        const row = board.split('\n').find((l) => l.startsWith(`  ${p} `));
        expect(row, `no roster row for ${p}`).toBeDefined();
        if (s.alive[p] !== true) continue;
        // The ROLE COLUMN is the engine's own statement about the seat and it
        // must be blank for anyone still alive.
        expect(row!, `${p} is alive but its dossier role column names a role`).toMatch(
          new RegExp(`^ {2}${p} -{8} {2}alive`),
        );
        // Anything role-shaped further along the row can only be this seat's
        // OWN public claim — an assertion the seat made itself, out loud.
        const claimed = new Set(pub.claims.filter((c) => c.speaker === p).map((c) => c.role));
        for (const r of ROLES_CANON) {
          if (row!.toLowerCase().includes(r)) {
            expect(claimed.has(r), `${p}'s roster row names ${r} without a public claim`).toBe(true);
          }
        }
      }
      // The seated dossier differs from the spectator one only by the seat line
      // and the YOUR FILE block — nothing in the shared prefix is viewer-shaped.
      const seated = werewolf.renderText(s as unknown as Json, playerId(0)).split('\n');
      const spectator = board.split('\n');
      expect(seated[0]).toBe(spectator[0]);
      expect(spectator[1]).toBe('Spectator view.');
      expect(seated[1]).toBe('You are p0 (seat 0).');
    });
  });

  it('publicStateSummary and every public event carry no living seat role', () => {
    const { core, seats } = makeCore('ww-public-events');
    driveGame(core, seats, 'public-events', (c) => {
      if (c.status !== 'running') return;
      const s = stateOf(c);
      const haystack = canonicalJson(c.publicStateSummary()) + '\n' + flatEvents(c.eventsSince(0));
      for (const q of ALL) {
        for (const probe of probesFor(s, q)) {
          expect(haystack, `${q}'s role reached a public surface`).not.toContain(probe);
        }
      }
    });
  });

  it('a mid-resolution ballot event never publishes a partial tally', () => {
    // The room emits a fresh publicView after EACH applied ballot, so shipping
    // the ballot MAP rather than the SET of seats that have voted would leak a
    // running tally in the intermediate events.
    const { core, seats } = makeCore('ww-partial-tally');
    driveGame(core, seats, 'partial-tally', () => {});
    let checkedMove = 0;
    for (const e of core.eventsSince(0)) {
      if (e.type !== 'move') continue;
      const pub = (e.data as Record<string, Json>)['public'] as Record<string, Json> | undefined;
      if (pub === undefined) continue;
      checkedMove++;
      const voted = pub['voted_this_phase'];
      expect(Array.isArray(voted), 'voted_this_phase must be a SET of seats, not a map').toBe(true);
      for (const x of voted as Json[]) expect(typeof x).toBe('string');
      expect(Array.isArray(pub['acted_this_night'])).toBe(true);
      expect(Array.isArray(pub['spoke_this_round'])).toBe(true);
    }
    expect(checkedMove).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// 5. viewStateString — the out-of-fence state surface
// ---------------------------------------------------------------------------

describe('werewolf viewStateString: own file only', () => {
  it('names no role but the viewer own and the publicly revealed dead', () => {
    const { core, seats } = makeCore('ww-state-string');
    driveGame(core, seats, 'state-string', (c) => {
      const s = stateOf(c);
      for (const v of ALL) {
        const raw = c.viewFor(v, NOW).state_string;
        const parsed = JSON.parse(raw) as {
          revealed: Record<Seat, Role>;
          you: { seat: Seat; role: Role | null; pack: Seat[] | null };
          transcript_digests: { sha8: string }[];
        };
        expect(parsed.you.seat).toBe(v);
        expect(parsed.you.role).toBe(s.roles[v]);
        // `revealed` is exactly the dead set — the only public role map there is.
        expect(Object.keys(parsed.revealed).sort()).toEqual(ALL.filter((p) => s.alive[p] !== true).sort());
        for (const [p, r] of Object.entries(parsed.revealed)) expect(r).toBe(s.roles[p]);
        // The pack is a bare seat array for a wolf and absent for everyone else.
        if (s.roles[v] === 'werewolf') {
          expect(parsed.you.pack).toEqual(ALL.filter((p) => s.roles[p] === 'werewolf'));
        } else {
          expect(parsed.you.pack).toBeNull();
        }
      }
    });
  });

  it('carries transcript DIGESTS, never transcript prose', () => {
    // state_string renders outside the prompt fence, so a single agent-authored
    // byte in it is a fence hole regardless of who wrote it.
    const { core, seats } = makeCore('ww-state-string-prose');
    driveGame(core, seats, 'state-string-prose', (c) => {
      const s = stateOf(c);
      if (s.transcript.length === 0) return;
      for (const v of ALL) {
        const raw = c.viewFor(v, NOW).state_string;
        for (const u of s.transcript) {
          if (u.text === '') continue;
          expect(raw, 'transcript prose reached the out-of-fence state_string').not.toContain(u.text);
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Role-permutation indistinguishability, driven through the room
// ---------------------------------------------------------------------------

/**
 * A role reassignment that fixes everything `viewer` legitimately knows:
 *   - every DEAD seat (its role is already public in `revealed`);
 *   - the viewer's own role;
 *   - wolf-ness everywhere, when the viewer is a wolf (it knows the pack);
 *   - every seat the viewer has checked, when the viewer is the seer.
 * viewer === null gives the spectator/public case (P1).
 *
 * Permuting only within a knowledge block is a strict SUBSET of the true
 * indistinguishability class — weaker than optimal, obviously sound, and it
 * catches every practical leak including the derived bits no substring probe
 * can express (`guards[].saved`, a count, a sort order).
 */
function permuteRoles(
  s: WwState,
  viewer: Seat | null,
  sd: SeedStream,
  tag: string,
): Record<Seat, Role> | null {
  let pool = livingSeats(s);
  if (viewer !== null) {
    pool = pool.filter((p) => p !== viewer);
    const vr = s.roles[viewer];
    if (vr === 'werewolf') pool = pool.filter((p) => s.roles[p] !== 'werewolf');
    if (vr === 'seer') {
      const peeked = new Set(s.peeks.filter((k) => k.seer === viewer).map((k) => k.target));
      pool = pool.filter((p) => !peeked.has(p));
    }
  }
  if (pool.length < 2) return null;
  const order = sd.shuffle(tag, pool);
  const out: Record<Seat, Role> = { ...s.roles };
  for (let i = 0; i < pool.length; i++) out[pool[i]!] = s.roles[order[i]!]!;
  // A rotation over a block of identical roles is a no-op; report it so the
  // caller can prove the corpus was not vacuous.
  return out;
}

function rehydrate(snap: RoomSnapshot, roles: Record<Seat, Role>, game: AnyGame = werewolf): RoomCore {
  const clone = structuredClone(snap) as RoomSnapshot;
  (clone.state as unknown as WwState).roles = roles;
  return RoomCore.hydrate(game, clone);
}

describe('werewolf indistinguishability: the leaks no substring probe can express', () => {
  it('P1 — the public projection and the spectator dossier are role-blind', () => {
    const { core, seats } = makeCore('ww-p1');
    const sd = createSeedStream(sha256Hex('redteam-ww-perm:p1'));
    const log = driveGame(core, seats, 'p1', () => {});
    log.snapshots.push(structuredClone(core.snapshot()) as RoomSnapshot);

    let compared = 0;
    let nonTrivial = 0;
    for (const snap of log.snapshots) {
      const s = snap.state as unknown as WwState;
      const base = RoomCore.hydrate(werewolf, structuredClone(snap) as RoomSnapshot);
      const baseSummary = canonicalJson(base.publicStateSummary());
      for (let k = 0; k < 3; k++) {
        const pi = permuteRoles(s, null, sd, `p1:${k}`);
        if (pi === null) continue;
        compared++;
        if (ALL.some((p) => pi[p] !== s.roles[p])) nonTrivial++;
        const alt = rehydrate(snap, pi);
        expect(
          canonicalJson(alt.publicStateSummary()),
          `the public summary changed under a role permutation (phase ${s.phase})`,
        ).toBe(baseSummary);
      }
    }
    expect(compared).toBeGreaterThan(20);
    // NON-VACUITY: a permutation that happens to be the identity proves nothing.
    expect(nonTrivial / compared).toBeGreaterThan(0.5);
  });

  it('P2 — a seat view is invariant under any permutation fixing what that seat knows', () => {
    const { core, seats } = makeCore('ww-p2');
    const sd = createSeedStream(sha256Hex('redteam-ww-perm:p2'));
    const log = driveGame(core, seats, 'p2', () => {});
    log.snapshots.push(structuredClone(core.snapshot()) as RoomSnapshot);

    let compared = 0;
    let nonTrivial = 0;
    for (const snap of log.snapshots) {
      const s = snap.state as unknown as WwState;
      const base = RoomCore.hydrate(werewolf, structuredClone(snap) as RoomSnapshot);
      for (const v of ALL) {
        const pi = permuteRoles(s, v, sd, `p2:${v}`);
        if (pi === null) continue;
        compared++;
        if (ALL.some((p) => pi[p] !== s.roles[p])) nonTrivial++;
        const alt = rehydrate(snap, pi);
        expect(
          canonicalJson(alt.viewFor(v, NOW) as unknown as Json),
          `${v}'s view changed under a permutation it cannot legitimately detect (phase ${s.phase})`,
        ).toBe(canonicalJson(base.viewFor(v, NOW) as unknown as Json));
      }
    }
    expect(compared).toBeGreaterThan(50);
    expect(nonTrivial / compared).toBeGreaterThan(0.5);
  });

  it('P1 rejects a publicView that reads a hidden field (negative control)', () => {
    const leaky: AnyGame = {
      ...werewolf,
      publicView(state: Json): Json {
        const st = state as unknown as WwState;
        return { ...(publicOf(st) as unknown as Record<string, Json>), roles: st.roles as unknown as Json };
      },
    };
    const { core } = makeCore('ww-p1-control', leaky);
    const snap = structuredClone(core.snapshot()) as RoomSnapshot;
    const s = snap.state as unknown as WwState;
    const sd = createSeedStream(sha256Hex('redteam-ww-perm:control'));
    let pi = permuteRoles(s, null, sd, 'control');
    // Force a genuinely different assignment so the control cannot pass by luck.
    for (let k = 0; k < 20 && pi !== null && !ALL.some((p) => pi![p] !== s.roles[p]); k++) {
      pi = permuteRoles(s, null, sd, `control:${k}`);
    }
    expect(pi).not.toBeNull();
    expect(ALL.some((p) => pi![p] !== s.roles[p])).toBe(true);

    const base = RoomCore.hydrate(leaky, structuredClone(snap) as RoomSnapshot);
    const alt = rehydrate(snap, pi!, leaky);
    expect(canonicalJson(alt.publicStateSummary())).not.toBe(canonicalJson(base.publicStateSummary()));
  });

  it('P2 rejects a privateView that reads another seat role (negative control)', () => {
    const leaky: AnyGame = {
      ...werewolf,
      privateView(state: Json, viewer: PlayerId): Json {
        const st = state as unknown as WwState;
        return { you: viewer, table: st.players.map((p) => st.roles[p]!) as unknown as Json };
      },
    };
    const { core } = makeCore('ww-p2-control', leaky);
    const snap = structuredClone(core.snapshot()) as RoomSnapshot;
    const s = snap.state as unknown as WwState;
    const sd = createSeedStream(sha256Hex('redteam-ww-perm:control2'));
    const victim = ALL.find((p) => s.roles[p] === 'villager')!;
    let pi = permuteRoles(s, victim, sd, 'control2');
    for (let k = 0; k < 20 && pi !== null && !ALL.some((p) => pi![p] !== s.roles[p]); k++) {
      pi = permuteRoles(s, victim, sd, `control2:${k}`);
    }
    expect(pi).not.toBeNull();

    const base = RoomCore.hydrate(leaky, structuredClone(snap) as RoomSnapshot);
    const alt = rehydrate(snap, pi!, leaky);
    expect(canonicalJson(alt.viewFor(victim, NOW) as unknown as Json)).not.toBe(
      canonicalJson(base.viewFor(victim, NOW) as unknown as Json),
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Commentary: an agent's own voice must stay inside the fence
// ---------------------------------------------------------------------------

describe('werewolf commentary: agent-authored bytes stay where untrusted text belongs', () => {
  it('night commentary never rewrites the notation and never escapes to an out-of-fence surface', () => {
    // `commentary` is a spectator aside, is not phase-gated and is not part of
    // the game state. A seat that chooses to narrate its own night action is
    // disclosing its OWN secret, which is its right — but those bytes must land
    // only in the fenced `history` row and the spectator event, never in
    // board_text, state_string or privateView, all of which render OUTSIDE the
    // prompt fence.
    const { core, seats } = makeCore('ww-commentary');
    const talker = seats[0]!;
    const aside = 'ASIDE-QZX I am about to do something interesting tonight';

    const movers = core.playersToMoveNow();
    expect(movers).toContain(talker.seat.player);
    const { submission, signature } = signedSub(core.gameId, talker, core.turnIndex, { index: 0 }, {
      commentary: aside,
    });
    const r = core.submitMove(NOW + 500, talker.seat.agent_id, submission, signature);
    expect(r.ok).toBe(true);

    // Finish the night so the row is applied and shipped. waitingFor(), not
    // playersToMoveNow(): the talker's move is held, not applied, so it is
    // still listed as "to move" for the whole collection window.
    let ms = NOW + 600;
    for (const p of core.waitingFor()) {
      const st = seats.find((x) => x.seat.player === p)!;
      ms += 100;
      const sub = signedSub(core.gameId, st, core.turnIndex, { index: 0 });
      expect(core.submitMove(ms, st.seat.agent_id, sub.submission, sub.signature).ok).toBe(true);
    }

    const row = core.snapshot().history.find((h) => h.player === talker.seat.player);
    expect(row).toBeDefined();
    expect(row!.notation, 'commentary must not alter the redacted notation').toBe(NIGHT_NOTATION);

    for (const v of ALL) {
      const view = core.viewFor(v, NOW + 2_000);
      expect(view.board_text, 'commentary reached the out-of-fence dossier').not.toContain(aside);
      expect(view.state_string, 'commentary reached the out-of-fence state_string').not.toContain(aside);
      expect(canonicalJson(view.public), 'commentary reached publicView').not.toContain(aside);
      expect(canonicalJson(view.private), 'commentary reached the out-of-fence private view').not.toContain(aside);
      expect(
        canonicalJson(view.legal_moves as unknown as Json),
        'commentary reached legal_moves',
      ).not.toContain(aside);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Elimination and the end-of-game reveal
// ---------------------------------------------------------------------------

describe('werewolf elimination and reveal', () => {
  it('a three-strikes elimination reveals only the abandoned seat', () => {
    const { core, seats } = makeCore('ww-eliminate');
    const victim = seats[2]!;
    const victimRole = stateOf(core).roles[victim.seat.player]!;

    let ms = NOW + 100;
    // Three strikes take three TURNS: `illegalThisTurn` resets each turn, so a
    // turn's three illegal attempts cost exactly one strike. Night, then talk
    // round 0, then talk round 1 — all simultaneous, so the elimination runs
    // through submitSimultaneous and the surviving seats must still resolve.
    for (let round = 0; round < 3; round++) {
      expect(core.playersToMoveNow().length, 'this path needs a simultaneous phase').toBeGreaterThan(1);
      for (let attempt = 0; attempt < 3; attempt++) {
        ms += 100;
        const { submission, signature } = signedSub(core.gameId, victim, core.turnIndex, { index: 9_999 });
        const r = core.submitMove(ms, victim.seat.agent_id, submission, signature);
        // Attempts 1 and 2 are rejections; the third takes the strike and
        // holds a forced marker, so it reports ok.
        expect(r.ok, `attempt ${attempt + 1} of strike round ${round + 1}`).toBe(attempt === 2);
      }
      expect(core.strikes[victim.seat.player]).toBe(round + 1);
      if (round === 2) break;
      for (const p of core.waitingFor()) {
        const st = seats.find((x) => x.seat.player === p)!;
        ms += 50;
        const sub = signedSub(core.gameId, st, core.turnIndex, { index: 0 });
        expect(core.submitMove(ms, st.seat.agent_id, sub.submission, sub.signature).ok).toBe(true);
      }
    }

    const s = stateOf(core);
    expect(core.status, 'a werewolf elimination must NOT end the table').toBe('running');
    expect(s.alive[victim.seat.player]).toBe(false);
    expect(s.cause[victim.seat.player]).toBe('abandoned');
    expect(s.revealed[victim.seat.player]).toBe(victimRole);

    // The seat_lost event names the abandoned seat's role — intentional, and
    // uniform with the other two death causes, because it is what keeps
    // public.wolves_remaining derivable from published data.
    const lost = core.eventsSince(0).filter((e) => e.type === 'game:seat_lost');
    expect(lost.length).toBe(1);
    const data = (lost[0]!.data as Record<string, Json>)['data'] as Record<string, Json>;
    expect(data['seat']).toBe(victim.seat.player);
    expect(data['role']).toBe(victimRole);

    // ...and NO other seat's role goes with it.
    const haystack = flatEvents(core.eventsSince(0)) + '\n' + canonicalJson(core.publicStateSummary());
    for (const q of ALL) {
      if (q === victim.seat.player) continue;
      for (const probe of probesFor(s, q)) {
        expect(haystack, `${q}'s role leaked alongside an elimination`).not.toContain(probe);
      }
    }
    for (const v of ALL) {
      const flat = flatView(core.viewFor(v, ms + 100));
      for (const q of ALL) {
        if (q === v) continue;
        for (const probe of probesFor(s, q)) {
          expect(flat, `${q}'s role reached ${v} after an elimination`).not.toContain(probe);
        }
      }
    }
  });

  it('replayFile is null while running; the full role map arrives only after `end`', () => {
    const { core, seats } = makeCore('ww-reveal');
    expect(core.replayFile()).toBeNull();
    driveGame(core, seats, 'reveal', (c) => {
      if (c.status === 'running') expect(c.replayFile()).toBeNull();
    });
    expect(core.status).toBe('ended');

    const events = core.eventsSince(0);
    const endIdx = events.findIndex((e) => e.type === 'end');
    const revealIdx = events.findIndex((e) => e.type === 'reveal');
    expect(endIdx).toBeGreaterThan(0);
    expect(revealIdx, 'the reveal must come strictly after `end`').toBeGreaterThan(endIdx);
    expect(events[revealIdx]!.seq).toBeGreaterThan(events[endIdx]!.seq);

    // The reveal is the sanctioned channel and it carries the whole role map.
    const reveal = events[revealIdx]!.data as Record<string, Json>;
    const roles = reveal['roles'] as Record<string, Json>;
    const s = stateOf(core);
    expect(Object.keys(roles).sort()).toEqual([...ALL].sort());
    for (const p of ALL) expect(roles[p]).toBe(s.roles[p]);
    expect(reveal['reveal_secret']).toBe(SECRET);

    // NOTHING before `end` carries the role map's canonical encoding. The e2e
    // suite runs this union over every state; here it is pinned against the
    // final roles, which is the only encoding revealOnEnd emits.
    const preEnd = flatEvents(events.slice(0, endIdx));
    for (const p of ALL) {
      // Dead seats are public by then, so only the survivors are asserted.
      if (s.alive[p] !== true) continue;
      expect(preEnd, `${p}'s role appeared in a pre-end event`).not.toContain(`"${p}":"${s.roles[p]}"`);
    }
    expect(preEnd).not.toContain(SECRET);
    expect(preEnd).not.toContain(core.snapshot().final_seed);
  });
});
