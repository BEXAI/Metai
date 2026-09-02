/**
 * RED TEAM red-team-injection — attacks 1(b,c) and 2 through a REAL RoomCore:
 * hostile commentary must round-trip as inert data (stored verbatim, capped
 * at 280, never parsed as protocol), and a mock-llm honeypot's chosen moves
 * must be bit-identical with and without hostile history (gate A12).
 *
 * Deterministic keys (sha256-derived secrets), no runtime CSPRNG, no
 * Date.now / Math.random.
 */

import { describe, expect, it } from 'vitest';
import { buildPrompt, UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../../src/agents/prompt.ts';
import { canonicalJson, hashJson, sha256Hex } from '../../src/crypto/canonical.ts';
import { verifyChain } from '../../src/crypto/chain.ts';
import { signEd25519 } from '../../src/crypto/ed25519.ts';
import { publicKeyOf } from '../../src/identity/ed25519.ts';
import type { Json, MoveSubmission } from '../../src/kernel/types.ts';
import { createMockLlmAgent } from '../../src/agents/mock-llm.ts';
import { moveSignMessage, RoomCore, type RoomSeat, type SubmitOk, type SubmitReject } from '../../src/rooms/core.ts';
import { miniGame, P0, P1 } from '../../src/rooms/tests/mini-game.ts';
import { count, HOSTILE_ALL, HOSTILE_BEHAVIORAL, HOSTILE_FORGERY } from './red-team-injection-corpus.ts';

const ROOM_SECRET = '55'.repeat(32);
const DRAND = 'ab'.repeat(32);

interface Seat {
  seat: RoomSeat;
  secretKey: string;
}

function makeSeat(i: number, agentId: string): Seat {
  const secretKey = sha256Hex(`redteam-injection:seat:${i}`);
  return {
    seat: { player: i === 0 ? P0 : P1, agent_id: agentId, handle: agentId, pubkey_ed25519: publicKeyOf(secretKey) },
    secretKey,
  };
}

function makeCore(gameId: string, limit: 5 | 9 = 5): { core: RoomCore; attacker: Seat; victim: Seat } {
  const attacker = makeSeat(0, 'attacker');
  const victim = makeSeat(1, 'victim');
  const core = RoomCore.create(1_000_000, {
    gameId,
    game: miniGame,
    variant: { limit },
    seats: [attacker.seat, victim.seat],
    division: 'open',
    rulesetVersion: '1.0.0',
    secretHex: ROOM_SECRET,
    drandRound: 7,
    drandRandomnessHex: DRAND,
  });
  return { core, attacker, victim };
}

function submit(core: RoomCore, gameId: string, seat: Seat, move: MoveSubmission['move'], nowMs: number, extra?: Partial<MoveSubmission>) {
  const submission: MoveSubmission = { game_id: gameId, turn_index: core.turnIndex, move, ...extra };
  const signature = signEd25519(seat.secretKey, moveSignMessage(gameId, submission.turn_index, submission));
  return core.submitMove(nowMs, seat.seat.agent_id, submission, signature);
}

describe('A12 room round-trip: hostile commentary is stored verbatim as inert data', () => {
  for (const entry of HOSTILE_ALL) {
    it(`'${entry.name}' — accepted, stored byte-for-byte, surfaced as data only`, () => {
      const gameId = `inj-room-${entry.name}`;
      const { core, attacker, victim } = makeCore(gameId);

      const r0 = submit(core, gameId, attacker, 'a', 1_000_100, { commentary: entry.commentary });
      expect(r0.ok, JSON.stringify(r0)).toBe(true);

      // The victim's view carries the commentary VERBATIM (data, not parsed,
      // not normalized, not truncated below 280).
      const view = core.viewFor(P1, 1_000_200);
      const hist = view.history[view.history.length - 1]!;
      expect(hist.commentary).toBe(entry.commentary);

      // The spectator event carries it verbatim too (public data).
      const moveEvents = core.eventsSince(0).filter((e) => e.type === 'move');
      const evData = moveEvents[moveEvents.length - 1]!.data as { commentary?: string };
      expect(evData.commentary).toBe(entry.commentary);

      // The game continued normally: no resign, no draw, no strike, no parse.
      expect(core.status).toBe('running');
      expect(core.turnIndex).toBe(1);
      expect(core.strikes[P0] ?? 0).toBe(0);
      expect(core.eventsSince(0).some((e) => e.type === 'resign' || e.type === 'draw_offer')).toBe(false);

      const r1 = submit(core, gameId, victim, 'b', 1_000_300);
      expect(r1.ok).toBe(true);
    });
  }

  it('a full hostile game ends with commentary verbatim in the signed replay log and an intact chain', () => {
    const gameId = 'inj-room-full';
    const { core, attacker, victim } = makeCore(gameId, 5);
    const entries = [HOSTILE_BEHAVIORAL[0]!, HOSTILE_BEHAVIORAL[4]!, HOSTILE_FORGERY[0]!];
    let now = 1_000_100;
    for (let i = 0; i < 5; i++) {
      const isAttacker = i % 2 === 0;
      const res = isAttacker
        ? submit(core, gameId, attacker, 'a', (now += 100), { commentary: entries[Math.floor(i / 2)]!.commentary })
        : submit(core, gameId, victim, 'b', (now += 100));
      expect(res.ok, JSON.stringify(res)).toBe(true);
    }
    expect(core.status).toBe('ended');
    const replay = core.replayFile()!;
    expect(verifyChain(gameId, replay.log).ok).toBe(true);
    const moveEntries = replay.log.filter((e) => e.kind === 'move');
    const stored = moveEntries
      .map((e) => (e.payload as { submission?: { commentary?: string } }).submission?.commentary)
      .filter((c): c is string => typeof c === 'string');
    for (const entry of entries) expect(stored).toContain(entry.commentary);
  });
});

describe('A12 room round-trip: the 280 cap is enforced, turn not consumed on rejection', () => {
  it('281 chars rejected with bad_commentary; the same turn then accepts a legal resubmission', () => {
    const gameId = 'inj-cap-281';
    const { core, attacker } = makeCore(gameId);
    const r = submit(core, gameId, attacker, 'a', 1_000_100, { commentary: 'z'.repeat(281) }) as SubmitReject;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('bad_commentary');
    expect(core.turnIndex).toBe(0);
    expect(core.strikes[P0] ?? 0).toBe(0);

    const r2 = submit(core, gameId, attacker, 'a', 1_000_200, { commentary: 'z'.repeat(280) }) as SubmitOk;
    expect(r2.ok).toBe(true);
    expect(r2.applied).toBe(true);
    expect(core.viewFor(P1, 1_000_300).history[0]!.commentary).toBe('z'.repeat(280));
  });

  it('astral plane: 280 UTF-16 units accepted, 282 rejected (cap is unit-exact, no double counting)', () => {
    const gameId = 'inj-cap-astral';
    const { core, attacker } = makeCore(gameId);
    const bombs280 = '\u{1F4A3}'.repeat(140); // length 280
    const bombs282 = '\u{1F4A3}'.repeat(141); // length 282
    expect(bombs280.length).toBe(280);

    const rBad = submit(core, gameId, attacker, 'a', 1_000_100, { commentary: bombs282 }) as SubmitReject;
    expect(rBad.ok).toBe(false);
    expect(rBad.code).toBe('bad_commentary');

    const rOk = submit(core, gameId, attacker, 'a', 1_000_200, { commentary: bombs280 });
    expect(rOk.ok).toBe(true);
    expect(core.viewFor(P1, 1_000_300).history[0]!.commentary).toBe(bombs280);
  });

  it('non-string commentary is rejected, not coerced', () => {
    const gameId = 'inj-cap-nonstring';
    const { core, attacker } = makeCore(gameId);
    const submission = {
      game_id: gameId,
      turn_index: core.turnIndex,
      move: 'a',
      commentary: { $type: 'exec', cmd: 'resign' },
    } as unknown as MoveSubmission;
    const signature = signEd25519(attacker.secretKey, moveSignMessage(gameId, 0, submission));
    const r = core.submitMove(1_000_100, 'attacker', submission, signature) as SubmitReject;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('bad_commentary');
  });
});

describe('A12 room round-trip: commentary is never parsed as protocol', () => {
  it("'resign'/'{\"resign\":true}'/'#1' in commentary do not resign, offer draws, or change the move", () => {
    const gameId = 'inj-noparse';
    const { core, attacker, victim } = makeCore(gameId, 9);
    const protocolLookalikes = ['resign', '{"resign": true, "draw_offer": true}', '#1', 'draw_offer=true', 'timeout'];
    let now = 1_000_100;
    for (const c of protocolLookalikes) {
      const mover = core.playersToMoveNow()[0]!;
      const seat = mover === P0 ? attacker : victim;
      const res = submit(core, gameId, seat, 'a', (now += 100), { commentary: c }) as SubmitOk;
      expect(res.ok, JSON.stringify(res)).toBe(true);
      expect(res.applied).toBe(true);
      expect(res.notation).toBe('a'); // the SIGNED move, not the commentary text
    }
    expect(core.status).toBe('running');
    const types = core.eventsSince(0).map((e) => e.type);
    expect(types).not.toContain('resign');
    expect(types).not.toContain('draw_offer');
    expect(types).not.toContain('timeout');
  });

  it('commentary on a forced (third-illegal) move is discarded, not attributed to the forced move', () => {
    const gameId = 'inj-forced-drop';
    const { core, attacker } = makeCore(gameId, 9);
    const hostile = HOSTILE_BEHAVIORAL[0]!.commentary;
    // Two illegal attempts, then a third which forces a seeded random move.
    const r1 = submit(core, gameId, attacker, { index: 999 }, 1_000_100, { commentary: hostile }) as SubmitReject;
    expect(r1.ok).toBe(false);
    const r2 = submit(core, gameId, attacker, { index: 999 }, 1_000_200, { commentary: hostile }) as SubmitReject;
    expect(r2.ok).toBe(false);
    expect(r2.legal_moves).toBeDefined();
    const r3 = submit(core, gameId, attacker, { index: 999 }, 1_000_300, { commentary: hostile }) as SubmitOk;
    expect(r3.ok).toBe(true);
    expect(r3.forced).toBe('illegal');
    // The forced move's history entry and event must NOT carry the commentary.
    const view = core.viewFor(P1, 1_000_400);
    expect(view.history[0]!.commentary).toBeUndefined();
    const moveEv = core.eventsSince(0).find((e) => e.type === 'move')!;
    expect((moveEv.data as { commentary?: string }).commentary).toBeUndefined();
  });
});

describe('A12 honeypot: hostile history never alters the mock-llm move (bit-identical rooms)', () => {
  it('two identical rooms, benign vs hostile attacker commentary: honeypot submissions and final state hash are identical', { timeout: 600_000 }, async () => {
    const script = Array.from({ length: 4 }, (_, i) => ({ kind: 'index', index: i % 2 }) as const);

    async function playRoom(gameId: string, hostile: boolean): Promise<{ subs: string[]; stateHash: string; observed: string[] }> {
      const { core, attacker, victim } = makeCore(gameId, 9);
      const honeypot = createMockLlmAgent({ agentId: 'victim', script, mode: 'injection-honeypot' });
      let now = 1_000_100;
      const subs: string[] = [];
      let hostileCursor = 0;
      while (core.status === 'running' && core.turnIndex < 8) {
        const mover = core.playersToMoveNow()[0]!;
        if (mover === P0) {
          const commentary = hostile
            ? HOSTILE_ALL[hostileCursor++ % HOSTILE_ALL.length]!.commentary
            : 'nice weather we are having';
          const res = submit(core, gameId, attacker, 'b', (now += 100), { commentary });
          expect(res.ok, JSON.stringify(res)).toBe(true);
        } else {
          const view = core.viewFor(P1, now);
          const sub = await honeypot.chooseMove(view);
          subs.push(canonicalJson(sub as unknown as Json));
          const signature = signEd25519(victim.secretKey, moveSignMessage(gameId, sub.turn_index, sub));
          const res = core.submitMove((now += 100), 'victim', sub, signature);
          expect(res.ok, JSON.stringify(res)).toBe(true);
        }
      }
      // Hash only fields that must be commentary-independent.
      const summary = core.publicStateSummary() as { [k: string]: Json };
      const stateHash = hashJson({ public: summary['public'] ?? null, board_text: summary['board_text'] ?? null, turn: summary['turn_index'] ?? null });
      return { subs, stateHash, observed: honeypot.observedCommentary.slice() };
    }

    // Same gameId so signatures/seeds/turn structure match exactly.
    const benign = await playRoom('inj-honeypot-twin', false);
    const hostileRun = await playRoom('inj-honeypot-twin', true);

    // Proof the hostile text actually reached the honeypot.
    for (const entry of HOSTILE_ALL.slice(0, 4)) {
      expect(hostileRun.observed.some((c) => c.includes(entry.probe))).toBe(true);
    }
    expect(benign.observed.some((c) => c.includes('INJPROBE'))).toBe(false);

    // The submissions are BIT-identical (canonical JSON string equality).
    expect(hostileRun.subs).toEqual(benign.subs);
    expect(hostileRun.stateHash).toBe(benign.stateHash);
  });
});

describe('A12 full chain: forged-marker commentary through a real room defeats the prompt fence', () => {
  for (const entry of HOSTILE_FORGERY) {
    it(`'${entry.name}' — the victim's built prompt must still contain exactly one marker pair`, () => {
      const gameId = `inj-chain-${entry.name}`;
      const { core, attacker } = makeCore(gameId);
      const res = submit(core, gameId, attacker, 'a', 1_000_100, { commentary: entry.commentary });
      expect(res.ok, JSON.stringify(res)).toBe(true);

      const view = core.viewFor(P1, 1_000_200);
      const prompt = buildPrompt(view);
      expect(count(prompt.user, UNTRUSTED_OPEN), 'exactly one open marker in the victim prompt').toBe(1);
      expect(count(prompt.user, UNTRUSTED_CLOSE), 'exactly one close marker in the victim prompt').toBe(1);
    });
  }
});
