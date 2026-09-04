/**
 * RED TEAM red-team-randomness — werewolf, the OFFLINE VERIFIER (plan E2,
 * gate ▲22). The headline test in this file is not about randomness:
 *
 *   A GAME THE VERIFIER CANNOT REPRODUCE IS WORTHLESS.
 *
 * Werewolf adds two things no board game in the hall had, and both live on the
 * path verifyReplay walks:
 *
 *  1. AN ELIMINATION IS A STATE TRANSITION. `forfeitPlayer` kills a seat and
 *     runs settle(), which can open a ballot, resolve a night and change the
 *     phase. Until E2 that transition was invisible offline: verify.ts's
 *     STATE_KINDS was { move, timeout } and 'forfeit' appeared only in
 *     CAUSE_KINDS, and the room logged { player, reason } with no state_hash,
 *     no draws and no events. Every replay containing an elimination would
 *     have failed verification — in the one game where eliminations are most
 *     likely, because four villagers submit a one-option `sleep` every night.
 *  2. THE MOVE IS NOT RECOVERABLE FROM THE NOTATION. Night moves all notate as
 *     the constant `night`, so a verifier that re-parsed the logged notation
 *     would replay every night as an abstention and diverge on the first kill.
 *     Verification works only because it re-resolves `payload.submission`
 *     through the SHARED kernel/move.ts ladder — the same code the room ran —
 *     including bindUtterance, whose output goes into the state hash.
 *
 * So the file drives ONE real 8-seat room through all five paths a game can
 * reach the verifier by — `{ index }` + utterance, inline notation carrying
 * quoted text, a timeout, a third-illegal forced move, and a three-strikes
 * ELIMINATION (the path E2 exists for) — plus the `'#n'` kernel index fallback
 * as a sixth, and then attacks the record: strip the hook, delete the entry,
 * strip its state_hash, move it to another seat, flip a byte of a logged
 * utterance, drop an utterance, and un-redact a night notation. Every one must
 * fail, and the untampered replay must pass every named check.
 *
 * Deterministic only: sha256-derived keys, explicit nowMs, no Math.random.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { signEd25519 } from '../../src/crypto/ed25519.ts';
import { publicKeyOf } from '../../src/identity/ed25519.ts';
import { rehashLog } from '../../src/kernel/tests/fixture-game.ts';
import type { LogEntry, ReplayFile } from '../../src/kernel/replay.ts';
import {
  playerId,
  type AnyGame,
  type Json,
  type MoveSubmission,
  type PlayerId,
} from '../../src/kernel/types.ts';
import { verifyReplay } from '../../src/kernel/verify.ts';
import {
  moveSignMessage,
  RoomCore,
  type RoomSeat,
  type SubmitOk,
  type SubmitReject,
  type SubmitResult,
} from '../../src/rooms/core.ts';
import werewolfGame from '../../src/games/werewolf/index.ts';
import { NIGHT_NOTATION } from '../../src/games/werewolf/notation.ts';
import { livingSeats, type WwState } from '../../src/games/werewolf/rules.ts';

const werewolf = werewolfGame as unknown as AnyGame;
const GAMES: Record<string, AnyGame> = { werewolf };

const SEATS: PlayerId[] = Array.from({ length: 8 }, (_, i) => playerId(i));
const SECRET = 'd4'.repeat(32);
const DRAND = '61'.repeat(32);
const T0 = 4_000_000;

/** The seat that abandons the table. Never a mover after turn 2. */
const QUITTER: PlayerId = 'p7';
/** The seat that burns a turn on three illegal submissions. */
const FUMBLER: PlayerId = 'p5';
/** Inline speech, quoted inside the notation itself. */
const INLINE = 'accuse(p2) "you dodged the check, p2"';

// ---------------------------------------------------------------------------
// One real 8-seat room, driven through every submission path there is
// ---------------------------------------------------------------------------

interface TestSeat {
  seat: RoomSeat;
  secretKey: string;
}

interface Table {
  core: RoomCore;
  seats: TestSeat[];
  gameId: string;
  now: number;
}

function makeTable(tag: string): Table {
  const seats: TestSeat[] = SEATS.map((player, i) => {
    const secretKey = sha256Hex(`redteam-randomness-werewolf:${tag}:seat:${i}`);
    return {
      seat: { player, agent_id: `agent-${i}`, handle: `agent${i}`, pubkey_ed25519: publicKeyOf(secretKey) },
      secretKey,
    };
  });
  const gameId = `rt-ww-verify-${tag}`;
  const core = RoomCore.create(T0, {
    gameId,
    game: werewolf,
    variant: {},
    seats: seats.map((s) => s.seat),
    division: 'open',
    rulesetVersion: '1.0.0',
    secretHex: SECRET,
    drandRound: 606,
    drandRandomnessHex: DRAND,
    clockScale: 1,
  });
  return { core, seats, gameId, now: T0 + 100 };
}

function submit(t: Table, p: PlayerId, move: MoveSubmission['move'], extra?: Partial<MoveSubmission>): SubmitResult {
  const s = t.seats.find((x) => x.seat.player === p)!;
  const submission: MoveSubmission = { game_id: t.gameId, turn_index: t.core.turnIndex, move, ...extra };
  const signature = signEd25519(s.secretKey, moveSignMessage(t.gameId, t.core.turnIndex, submission));
  t.now += 50;
  return t.core.submitMove(t.now, s.seat.agent_id, submission, signature);
}

function fireDeadline(t: Table): void {
  const deadline = t.core.deadlineAtMs!;
  expect(t.core.timeout(deadline).fired).toBe(true);
  t.now = deadline + 10;
}

function stateOf(core: RoomCore): WwState {
  return core.snapshot().state as unknown as WwState;
}

/** Words unique per seat and per turn, so a mis-bound utterance is legible. */
function word(p: PlayerId, turn: number): string {
  return `SPEECH-${p.toUpperCase()}-T${turn}-QZX`;
}

/**
 * The five-path game, played once and shared by every test below (the tamper
 * cases all clone it, exactly like red-team-randomness-binding.test.ts).
 *
 *   turn 0  night   p0 { index } + utterance · p1 '#0' + utterance ·
 *                   p2..p6 { index } · p7 SILENT   -> timeout + strike 1
 *   turn 1  talk r0 p0 inline quoted notation · rest { index } + utterance ·
 *                   p7 SILENT                      -> timeout + strike 2
 *   turn 2  talk r1 p5 three illegal submissions   -> forced legal + strike ·
 *                   rest { index } + utterance ·
 *                   p7 SILENT                      -> strike 3 + ELIMINATION
 *   then the survivors play the game out with the null act.
 */
function playFivePathGame(tag: string): Table {
  const t = makeTable(tag);

  // ---- turn 0: night -----------------------------------------------------
  expect(stateOf(t.core).phase).toBe('night');
  expect(submit(t, 'p0', { index: 0 }, { utterance: word('p0', 0) }).ok).toBe(true);
  expect(submit(t, 'p1', '#0', { utterance: word('p1', 0) }).ok).toBe(true);
  for (const p of SEATS.slice(2, 7)) expect(submit(t, p, { index: 0 }).ok).toBe(true);
  expect(t.core.waitingFor()).toEqual([QUITTER]);
  fireDeadline(t);
  expect(t.core.strikes[QUITTER]).toBe(1);

  // ---- turn 1: discussion round 0 ---------------------------------------
  expect(stateOf(t.core).phase).toBe('day_talk');
  expect(submit(t, 'p0', INLINE).ok).toBe(true);
  for (const p of SEATS.slice(1, 7)) {
    expect(submit(t, p, { index: 0 }, { utterance: word(p, 1) }).ok).toBe(true);
  }
  fireDeadline(t);
  expect(t.core.strikes[QUITTER]).toBe(2);

  // ---- turn 2: discussion round 1 ---------------------------------------
  const r1 = submit(t, FUMBLER, { index: 9_999 }) as SubmitReject;
  expect(r1.illegal_attempt).toBe(1);
  expect((submit(t, FUMBLER, { index: -1 }) as SubmitReject).illegal_attempt).toBe(2);
  const forced = submit(t, FUMBLER, { index: 9_999 }) as SubmitOk;
  expect(forced.ok).toBe(true);
  expect(t.core.strikes[FUMBLER]).toBe(1);
  for (const p of SEATS.slice(0, 5)) {
    expect(submit(t, p, { index: 0 }, { utterance: word(p, 2) }).ok).toBe(true);
  }
  expect(submit(t, 'p6', { index: 0 }, { utterance: word('p6', 2) }).ok).toBe(true);
  expect(t.core.waitingFor()).toEqual([QUITTER]);
  fireDeadline(t);
  expect(t.core.strikes[QUITTER]).toBe(3);
  expect(t.core.status, 'the elimination must not end the table').toBe('running');
  expect(stateOf(t.core).alive[QUITTER]).toBe(false);

  // ---- out to the end ----------------------------------------------------
  let guard = 0;
  while (t.core.status === 'running') {
    expect(guard++, 'the room never terminated').toBeLessThan(60);
    const movers = t.core.playersToMoveNow();
    expect(movers.length, 'LIVENESS: running room with nobody to move').toBeGreaterThan(0);
    for (const p of movers) expect(submit(t, p, { index: 0 }).ok, `${p} @${t.core.turnIndex}`).toBe(true);
  }
  expect(t.core.result?.reason).not.toBe('forfeit');
  return t;
}

const FIVE_PATH = playFivePathGame('five');
const BASE: ReplayFile = FIVE_PATH.core.replayFile()!;

function clone(): ReplayFile {
  return structuredClone(BASE);
}

function payloadOf(e: LogEntry): Record<string, Json> {
  return e.payload as Record<string, Json>;
}

function submissionOf(e: LogEntry): Record<string, Json> {
  return payloadOf(e)['submission'] as Record<string, Json>;
}

function failures(r: ReplayFile, reg: Record<string, AnyGame> = GAMES): { name: string; detail?: string }[] {
  return verifyReplay(r, reg)
    .checks.filter((c) => !c.ok)
    .map((c) => ({ name: c.name, detail: c.detail }));
}

function detailOf(r: ReplayFile, name: string, reg: Record<string, AnyGame> = GAMES): string {
  const hit = failures(r, reg).find((f) => f.name === name);
  expect(hit, `expected the '${name}' check to fail; failures were ${JSON.stringify(failures(r, reg))}`).toBeDefined();
  return hit!.detail ?? '';
}

/**
 * The log entry the recomputation first disagreed with. Asserting WHERE the
 * divergence starts is the durable claim; the exact message is not, because a
 * desynced replay can surface as a hash mismatch, an out-of-range index or a
 * rejected move depending on how far the state has drifted.
 */
function firstBadSeq(detail: string): number {
  const m = /entry (\d+)/.exec(detail);
  expect(m, `no entry number in ${JSON.stringify(detail)}`).not.toBeNull();
  return Number(m![1]);
}

/** Turn indices whose entries were played in the `night` phase. */
function nightTurns(): Set<number> {
  const turns = new Set<number>();
  for (const e of BASE.log) {
    if (e.kind !== 'move' && e.kind !== 'timeout') continue;
    const p = payloadOf(e);
    const notation = e.kind === 'move' ? p['notation'] : p['applied_notation'];
    if (notation === NIGHT_NOTATION) turns.add(p['turn_index'] as number);
  }
  return turns;
}

// ---------------------------------------------------------------------------
// 1. The baseline: every path in one replay, and it verifies
// ---------------------------------------------------------------------------

describe('a werewolf game covering every submission path verifies offline', () => {
  it('all FIVE submission paths — elimination included — are present in the one log', () => {
    // Coverage first: without this, "the replay verifies" could be a statement
    // about a game that exercised one code path eight times.
    const moves = BASE.log.filter((e) => e.kind === 'move');
    const byIndex = moves.filter((e) => {
      const m = submissionOf(e)['move'];
      return typeof m === 'object' && m !== null && typeof submissionOf(e)['utterance'] === 'string';
    });
    expect(byIndex.length, '{ index } + utterance').toBeGreaterThan(5);

    const inline = moves.filter((e) => submissionOf(e)['move'] === INLINE);
    expect(inline, 'inline notation carrying quoted speech').toHaveLength(1);
    expect(payloadOf(inline[0]!)['notation'], 'the words ride in the notation itself').toBe(INLINE);

    expect(moves.filter((e) => submissionOf(e)['move'] === '#0'), "the '#n' kernel fallback").toHaveLength(1);
    expect(BASE.log.filter((e) => e.kind === 'timeout').length, 'a forced timeout').toBeGreaterThanOrEqual(2);
    expect(
      moves.filter((e) => payloadOf(e)['forced'] === 'illegal'),
      'a third-illegal forced move',
    ).toHaveLength(1);

    const eliminations = BASE.log.filter((e) => e.kind === 'forfeit');
    expect(eliminations, 'a three-strikes elimination').toHaveLength(1);
    const fp = payloadOf(eliminations[0]!);
    expect(fp['player']).toBe(QUITTER);
    expect(fp['reason']).toBe('three_strikes');
    expect(fp['state_hash'], 'the ELIMINATION shape, not the terminal { player, reason }').toBeTypeOf('string');
    expect(fp['draws'], 'forfeitPlayer takes no SeedStream').toEqual([]);
    expect(eliminations[0]!.signature, "'forfeit' is not in the verifier's SIGNED_KINDS").toBeNull();
  });

  it('every named check passes on the untampered replay', () => {
    const report = verifyReplay(BASE, GAMES);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    // …and the elimination really did move the state: the entry before it and
    // the entry itself disagree on the state hash, so a verifier that skipped
    // 'forfeit' (STATE_KINDS before E2) would desync on the very next entry.
    const i = BASE.log.findIndex((e) => e.kind === 'forfeit');
    const prior = BASE.log.slice(0, i).reverse().find((e) => payloadOf(e)['state_hash'] !== undefined)!;
    expect(payloadOf(prior)['state_hash']).not.toBe(payloadOf(BASE.log[i]!)['state_hash']);
  });

  it('the forced and timed-out entries carry no words: the engine never invents speech', () => {
    // bindUtterance is reached only from resolveSubmittedMove, which the
    // forced and timeout paths never call. A fabricated word would be signed
    // by nobody and attributed to the seat for the life of the replay.
    for (const e of BASE.log) {
      const p = payloadOf(e);
      if (e.kind === 'timeout') {
        expect(String(p['applied_notation'])).not.toContain('"');
        expect(p['submission'], 'a timeout has no submission at all').toBeUndefined();
      } else if (e.kind === 'move' && p['forced'] === 'illegal') {
        expect(String(p['notation'])).not.toContain('"');
      }
    }
  });

  it('the night redaction survives verification, because verification reads the SUBMISSION', () => {
    // The public record of a night is the constant `night` for every seat and
    // every role. Verification does not re-parse it — it re-resolves
    // payload.submission through kernel/move.ts and re-derives the notation —
    // which is exactly why a replay that publishes zero bits still recomputes
    // to the same state hash byte for byte.
    const nights = nightTurns();
    expect(nights.size, 'the game must contain at least two nights').toBeGreaterThanOrEqual(2);
    let rows = 0;
    for (const e of BASE.log) {
      const p = payloadOf(e);
      if (!nights.has(p['turn_index'] as number)) continue;
      if (e.kind !== 'move' && e.kind !== 'timeout') continue;
      rows++;
      const notation = e.kind === 'move' ? p['notation'] : p['applied_notation'];
      expect(notation, 'a night entry named an action').toBe(NIGHT_NOTATION);
    }
    expect(rows).toBeGreaterThanOrEqual(10);
    expect(verifyReplay(BASE, GAMES).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. The elimination must be load-bearing, not decoration
// ---------------------------------------------------------------------------

describe("the verifier RE-RUNS the elimination: 'forfeit' is a state entry", () => {
  it('a game module without forfeitPlayer cannot verify a replay containing one', () => {
    // The E2 regression in its cleanest form. If the room ever logs an
    // elimination the verifier cannot reproduce, every werewolf replay with an
    // abandoned seat reports as tampered — indistinguishable, to a spectator,
    // from an actual forgery.
    const hookless: AnyGame = { ...werewolf };
    delete (hookless as { forfeitPlayer?: unknown }).forfeitPlayer;
    const detail = detailOf(clone(), 'recomputation', { werewolf: hookless });
    expect(detail).toContain('forfeit carries state_hash but the game module has no forfeitPlayer');
  });

  it('deleting the elimination entry breaks the very next state hash', () => {
    // Under the pre-E2 STATE_KINDS this mutation was a no-op: 'forfeit' was
    // skipped, so a replay with the entry and a replay without it verified
    // identically. Now the entry IS the transition and removing it desyncs.
    const r = clone();
    const cut = r.log.findIndex((e) => e.kind === 'forfeit');
    r.log = r.log.filter((e) => e.kind !== 'forfeit');
    r.log.forEach((e, i) => (e.seq = i));
    rehashLog(r);
    // Everything BEFORE the removed entry still reproduces exactly; the
    // divergence starts at it and never heals — the recomputed table still
    // has an eighth living seat that the rest of the log knows is gone.
    expect(firstBadSeq(detailOf(r, 'recomputation'))).toBeGreaterThanOrEqual(cut);
  });

  it('stripping state_hash from the elimination fails closed on the next entry', () => {
    // verify.ts distinguishes a terminal forfeit from an elimination purely by
    // the presence of state_hash, so an adversary can make the recomputation
    // skip the entry. It must not help them: the state has still moved, and
    // everything downstream is chained to it.
    const r = clone();
    const f = r.log.find((e) => e.kind === 'forfeit')!;
    delete payloadOf(f)['state_hash'];
    rehashLog(r);
    expect(firstBadSeq(detailOf(r, 'recomputation'))).toBeGreaterThanOrEqual(f.seq);
  });

  it('re-pointing the elimination at another seat is caught', () => {
    const r = clone();
    const f = r.log.find((e) => e.kind === 'forfeit')!;
    payloadOf(f)['player'] = 'p0';
    rehashLog(r);
    expect(detailOf(r, 'recomputation')).toContain('state_hash does not match the recomputed state');
  });

  it('the elimination survives the round trip: the recomputed seat is dead, and only that seat', () => {
    // A positive statement of what the verifier reconstructs, so the negative
    // cases above cannot pass by the recomputation failing for some unrelated
    // reason. The reveal is the sanctioned channel for the role map, and it is
    // the only place the abandoned seat's role and the survivors' agree.
    const reveal = BASE.log[BASE.log.length - 1]!;
    expect(reveal.kind).toBe('reveal');
    const roles = payloadOf(reveal)['roles'] as Record<string, Json>;
    const st = stateOf(FIVE_PATH.core);
    expect(Object.keys(roles).sort()).toEqual([...SEATS].sort());
    expect(st.cause[QUITTER]).toBe('abandoned');
    expect(st.revealed[QUITTER]).toBe(roles[QUITTER]);
    expect(livingSeats(st)).not.toContain(QUITTER);
    expect(verifyReplay(BASE, GAMES).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Bind drift: the utterance is part of the move, therefore part of the hash
// ---------------------------------------------------------------------------

describe('speech is bound into the move, so tampering with it fails verification', () => {
  /** A DAY move whose bound words are visible in the logged notation. */
  function dayEntryWithUtterance(r: ReplayFile): LogEntry {
    const hit = r.log.find((e) => {
      if (e.kind !== 'move') return false;
      const u = submissionOf(e)['utterance'];
      return typeof u === 'string' && u.length > 0 && String(payloadOf(e)['notation']).includes(u);
    });
    expect(hit, 'the fixture must contain a day move carrying a bound utterance').toBeDefined();
    return hit!;
  }

  /** A NIGHT move whose bound words are invisible in the logged notation. */
  function nightEntryWithUtterance(r: ReplayFile): LogEntry {
    const nights = nightTurns();
    const hit = r.log.find((e) => {
      if (e.kind !== 'move') return false;
      const u = submissionOf(e)['utterance'];
      return (
        typeof u === 'string' &&
        u.length > 0 &&
        nights.has(payloadOf(e)['turn_index'] as number) &&
        payloadOf(e)['notation'] === NIGHT_NOTATION
      );
    });
    expect(hit, 'the fixture must contain a night move carrying a bound utterance').toBeDefined();
    return hit!;
  }

  it('flipping one character of a logged utterance fails verification', () => {
    const r = clone();
    const e = dayEntryWithUtterance(r);
    const u = submissionOf(e)['utterance'] as string;
    submissionOf(e)['utterance'] = `${u.slice(0, -1)}Z`;
    const names = failures(r).map((f) => f.name);
    // Two independent layers catch it: the seat's signature covers the whole
    // submission, and the recomputation re-binds the words into the move.
    expect(names).toContain('signatures');
    expect(names).toContain('recomputation');
  });

  it('a chain-resealed utterance tamper is still caught by the recomputation', () => {
    const r = clone();
    const e = dayEntryWithUtterance(r);
    const u = submissionOf(e)['utterance'] as string;
    submissionOf(e)['utterance'] = `${u.slice(0, -1)}Z`;
    rehashLog(r);
    const names = failures(r).map((f) => f.name);
    expect(names).not.toContain('hash_chain'); // resealed…
    expect(detailOf(r, 'recomputation')).toContain('logged notation'); // …and still dead
  });

  it('DELETING the utterance while keeping the notation is caught by the notation (day)', () => {
    // The bind-drift case the plan names: a room that stopped calling
    // bindUtterance, or a verifier that never started, would produce exactly
    // this log — words in the notation, no words in the move.
    const r = clone();
    const e = dayEntryWithUtterance(r);
    delete submissionOf(e)['utterance'];
    rehashLog(r);
    expect(detailOf(r, 'recomputation')).toContain('logged notation');
  });

  it('DELETING the utterance from a NIGHT move is caught by the events, not the notation', () => {
    // Sharper than it looks. The night notation is the constant, so the
    // notation check CANNOT see this edit — the redaction that protects the
    // roles also hides the tamper from the cheapest check. Two deeper layers
    // do see it, and the first to fire is the events check: a night whisper
    // exists ONLY as a private GameEvent in the log, so verify.ts recomputes
    // `p.events ?? []` rather than guarding on `!== undefined`, and a dropped
    // word is a dropped event. The state hash would have caught it next.
    const r = clone();
    const e = nightEntryWithUtterance(r);
    delete submissionOf(e)['utterance'];
    rehashLog(r);
    const detail = detailOf(r, 'recomputation');
    expect(firstBadSeq(detail)).toBe(e.seq);
    expect(detail, 'the redacted notation cannot be what caught it').not.toContain('logged notation');
    expect(detail).toMatch(/logged events differ|state_hash does not match/);
  });

  it('un-redacting a night notation fails: the recomputed one is always the constant', () => {
    const r = clone();
    const nights = nightTurns();
    const e = r.log.find(
      (x) => x.kind === 'move' && nights.has(payloadOf(x)['turn_index'] as number),
    )!;
    payloadOf(e)['notation'] = 'kill(p2)';
    rehashLog(r);
    const detail = detailOf(r, 'recomputation');
    expect(detail).toContain(`!= recomputed '${NIGHT_NOTATION}'`);
  });

  it('sanity: the untampered clone still verifies (the mutations are the only cause)', () => {
    expect(verifyReplay(clone(), GAMES).ok).toBe(true);
  });
});
