/**
 * Stage-4 end-to-end suite: REAL matches through the REAL local Worker
 * (wrangler dev on port 8788, fresh per-run D1/DO/KV/R2 state), every replay
 * verified offline with verifyReplay.
 *
 * NOT part of the default test run — the filename deliberately avoids the
 * *.test.ts glob. Run it explicitly:
 *
 *   npx vitest run --config test/e2e/vitest.config.ts
 *
 * Or a single match:
 *
 *   npx vitest run --config test/e2e/vitest.config.ts -t "chess"
 *
 * Per match (spec workflow.stage_4_integration_and_e2e):
 *   - the commitment is in the log BEFORE the first move, the reveal AFTER end
 *   - verifyReplay(replay, GAMES) passes every check
 *   - no spectator event before end carries hidden data (landlord deck order /
 *     islanders hands probed via the games' secretProbes over every replayed
 *     state)
 *   - exactly one result, agreed between the API and the replay
 *   - ratings for every seat appear on the leaderboard afterwards
 * Plus the A11 e2e half: a scripted client submits 2 illegal moves then a
 * legal one each turn (one turn goes to a forced 3rd), another misses one
 * deadline; the three-step policy, strike accounting, and timeout default all
 * surface in the log.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAMES } from '../../src/games/index.ts';
import { verifyReplay } from '../../src/kernel/verify.ts';
import type { ReplayFile } from '../../src/kernel/replay.ts';
import { LudusClient } from './client.ts';
import { startHarness, type Harness } from './harness.ts';
import {
  collectSecretProbes,
  islandersStrategy,
  landlordStrategy,
  replayWalk,
  runMatch,
  runMisbehaviorMatch,
  werewolfStrategy,
  WW_INLINE_MARK,
  WW_UTTERANCE_MARK,
  type MatchReport,
  type Strategy,
} from './match.ts';

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ port: 8788 });
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

async function assertMatch(report: MatchReport): Promise<void> {
  const replay = report.replay;

  // The game was created by the REAL cronTick pairer (d1GameFactory ids are
  // game_<16 hex>; the retired shim factory used game_e2e_<...>).
  expect(report.gameId).toMatch(/^game_[0-9a-f]{16}$/);

  // Commitment was public (and the reveal sealed) before the first move.
  expect(report.preMatchGame.status).toBe('live');
  expect(report.preMatchGame.commitment).toMatch(/^[0-9a-f]{64}$/);
  expect(report.preMatchGame.reveal_secret).toBeNull();

  // The replay must be the FULL R2 blob the room uploaded at finalize, not
  // the reduced D1 reconstruction (which is marked reconstructed_from:'d1'
  // and has empty seed_draws / null initial_state).
  expect(
    (replay as unknown as { reconstructed_from?: string }).reconstructed_from,
    'replay must be served from R2, not reconstructed from D1',
  ).toBeUndefined();

  // Log ordering: exactly one commitment/start/end/reveal; commitment before
  // the first applied move; end second-to-last; reveal last.
  const kinds = replay.log.map((e) => e.kind);
  for (const k of ['commitment', 'start', 'end', 'reveal'] as const) {
    expect(kinds.filter((x) => x === k), `log must contain exactly one '${k}'`).toHaveLength(1);
  }
  const firstMoveIx = kinds.findIndex((k) => k === 'move' || k === 'timeout');
  expect(kinds.indexOf('commitment'), 'commitment must precede the first move').toBeLessThan(firstMoveIx);
  expect(kinds.indexOf('commitment')).toBeLessThan(kinds.indexOf('start'));
  expect(kinds[kinds.length - 1]).toBe('reveal');
  expect(kinds[kinds.length - 2]).toBe('end');

  // The full offline verification: commitment, final seed, hash chain, every
  // move signature, full recomputation, result, seed draws, reveal placement.
  const verdict = verifyReplay(replay, GAMES);
  const failed = verdict.checks.filter((c) => !c.ok);
  expect(failed, `verifyReplay failures: ${JSON.stringify(failed)}`).toHaveLength(0);
  expect(verdict.ok).toBe(true);

  // Exactly one result, and every door agrees on it.
  expect(replay.result).toBeTruthy();
  expect(report.result).toEqual(replay.result as unknown);

  // Spectator stream: nothing before the 'end' event may carry hidden data.
  const endSeq = report.allEvents.find((e) => e.type === 'end')?.seq;
  expect(endSeq, "spectator stream must contain an 'end' event").toBeTypeOf('number');
  const preEnd = report.allEvents.filter((e) => e.seq < endSeq!);
  const preEndLive = report.liveEvents.filter((e) => e.seq < endSeq!);
  const secrets = [replay.reveal_secret, replay.final_seed];
  for (const events of [preEnd, preEndLive]) {
    for (const ev of events) {
      const s = JSON.stringify(ev);
      expect(ev.type, 'no reveal event before end').not.toBe('reveal');
      for (const secret of secrets) expect(s).not.toContain(secret);
    }
  }
  // Hidden-information games: probe with the games' own secretProbes strings
  // computed over every state of the replayed game.
  const probes = await collectSecretProbes(replay);
  if (probes.length > 0) {
    const haystack = preEnd.map((e) => JSON.stringify(e)).join('\n');
    for (const probe of probes) {
      expect(haystack.includes(probe), `pre-end spectator events leaked probe: ${probe.slice(0, 60)}`).toBe(false);
    }
  }

  // Ratings: every seat shows up on the leaderboard with a played game, and
  // the REAL Glicko-2 application moved decisive games off 1500-flat
  // (winner up, at least one loser down). Draws legitimately stay at 1500
  // (only RD shrinks), so the inequality applies to decisive results only.
  const anon = new LudusClient({ base: h.base, handle: 'e2e-reader', ip: '10.99.0.1' });
  const lb = await anon.leaderboard(`?game=${report.game}`);
  const ratingOf = new Map<string, { rating: number; games_played: number }>();
  for (const agent of report.agents) {
    const row = lb.leaderboard.find((r) => r.handle === agent.handle);
    expect(row, `${agent.handle} missing from the ${report.game} leaderboard`).toBeTruthy();
    expect(row!.games_played).toBeGreaterThanOrEqual(1);
    expect(row!.rating).toBeGreaterThan(0);
    ratingOf.set(agent.handle, { rating: row!.rating, games_played: row!.games_played });
  }
  const result = replay.result as { winners?: string[]; draw?: boolean; scores?: Record<string, number> } | null;
  // Every decisive result must move ratings — including decisive results with
  // all-equal scores (chinese_checkers' anti-stalling forfeit: winners=[p1],
  // scores={p0:0,p1:0}), which standingsFromResult once rated as a draw
  // (fixed: winners now outrank non-winners regardless of score).
  if (
    result &&
    Array.isArray(result.winners) &&
    result.winners.length > 0 &&
    result.winners.length < replay.seats.length && // an all-winners tie rates like a draw
    result.draw !== true
  ) {
    const handleOf = new Map((replay.seats as { player: string; handle: string }[]).map((s) => [s.player, s.handle]));
    const winnerHandles = new Set(result.winners.map((p) => handleOf.get(p)).filter((x): x is string => !!x));
    for (const agent of report.agents) {
      const r = ratingOf.get(agent.handle)!;
      if (winnerHandles.has(agent.handle)) {
        expect(r.rating, `winner ${agent.handle} must be rated above the 1500 default`).toBeGreaterThan(1500.5);
      }
    }
    const losers = report.agents.filter((a) => !winnerHandles.has(a.handle));
    if (losers.length > 0) {
      expect(
        losers.some((a) => ratingOf.get(a.handle)!.rating < 1499.5),
        'at least one non-winner must be rated below the 1500 default',
      ).toBe(true);
    }
  }
}

interface GameCase {
  game: string;
  players: number;
  maxDecisions: number;
  timeoutMs: number;
  strategies?: Strategy[];
}

const TWO_PLAYER_CASES: GameCase[] = [
  { game: 'tictactoe', players: 2, maxDecisions: 30, timeoutMs: 120_000 },
  { game: 'connect_drop', players: 2, maxDecisions: 80, timeoutMs: 120_000 },
  { game: 'chess', players: 2, maxDecisions: 1500, timeoutMs: 900_000 },
  { game: 'checkers', players: 2, maxDecisions: 800, timeoutMs: 600_000 },
  { game: 'reversi', players: 2, maxDecisions: 300, timeoutMs: 300_000 },
  { game: 'hex', players: 2, maxDecisions: 300, timeoutMs: 300_000 },
  { game: 'nine_mens_morris', players: 2, maxDecisions: 800, timeoutMs: 600_000 },
  { game: 'go', players: 2, maxDecisions: 1200, timeoutMs: 900_000 },
  { game: 'chinese_checkers', players: 2, maxDecisions: 1200, timeoutMs: 900_000 },
  { game: 'backgammon', players: 2, maxDecisions: 800, timeoutMs: 600_000 },
];

describe('stage-4 e2e: full matches for every M1+M2 game (2 players)', () => {
  for (const gc of TWO_PLAYER_CASES) {
    it(
      `${gc.game}: full 2-player match, replay verifies, no leaks, rated`,
      { timeout: gc.timeoutMs },
      async () => {
        const report = await runMatch(h, {
          game: gc.game,
          players: gc.players,
          maxDecisions: gc.maxDecisions,
          label: gc.game.replace(/_/g, '-'),
          commentaryEvery: 5,
          // tictactoe doubles as the MCP-door check: agent 1 plays entirely
          // through /mcp tools/call (view + move).
          ...(gc.game === 'tictactoe' ? { transports: ['http', 'mcp'] as const } : {}),
        });
        await assertMatch(report);
        console.log(
          `[e2e] ${gc.game}: ${report.decisions} decisions, result=${JSON.stringify(report.replay.result)}, ` +
            `avg move ${Math.round(report.timings.reduce((a, t) => a + t.ms, 0) / Math.max(1, report.timings.length))}ms, ` +
            `replay=${report.replayPath}`,
        );
      },
    );
  }
});

describe('stage-4 e2e: hidden-information trading games', () => {
  it(
    'landlord: FULL-LENGTH 2-player match crossing the old ~2MB blob limit (chunked DO storage); auction tracked',
    { timeout: 1_800_000 },
    async () => {
      let report: MatchReport | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await runMatch(h, {
          game: 'landlord',
          // The REAL cronTick pairer always seats meta.players.min (=2 for
          // landlord; a 3-seat game is unreachable through the product path —
          // see notes/e2e-driver.md). 2 players it is; islanders (min 3)
          // covers 3-player pairing.
          players: 2,
          maxDecisions: 4000,
          label: `landlord-${attempt}`,
          // High cash defers bankruptcies so the game runs to the full
          // 150-round turn limit: ~1200 applied decisions (sizeprobe:
          // the retired single-blob snapshot would be ~7MB here, 3.5x the
          // documented 2MB DO per-value cap that used to kill the room at
          // ~780 decisions). NO resign valve — the room's chunked storage
          // must survive the whole game.
          variant: '{"starting_cash":20000,"turn_limit":150}',
          strategies: [landlordStrategy, landlordStrategy],
          commentaryEvery: 20,
        });
        report = r;
        if (r.flags.auction) break;
        console.log(`[e2e] landlord attempt ${attempt}: no auction (flags ${JSON.stringify(r.flags)}), retrying with a new seed`);
      }
      await assertMatch(report!);
      expect(report!.flags.auction, 'at least one auction must have started').toBe(true);
      expect(
        report!.decisions,
        'the match must cross the old ~800-decision blob-limit point to prove chunked DO storage end-to-end',
      ).toBeGreaterThanOrEqual(800);
      console.log(`[e2e] landlord flags: ${JSON.stringify(report!.flags)}, decisions=${report!.decisions}`);
      (globalThis as Record<string, unknown>).__landlordFlags = report!.flags;
    },
  );

  it(
    'islanders: 3-player match; accepted trade and bandit steal steered across the trading matches',
    { timeout: 1_800_000 },
    async () => {
      let report: MatchReport | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await runMatch(h, {
          game: 'islanders',
          players: 3,
          maxDecisions: 4000,
          label: `islanders-${attempt}`,
          // Build-priority play reaches 10 VP well before the 100-round
          // limit; no resign valve — chunked DO storage handles full length.
          strategies: [islandersStrategy, islandersStrategy, islandersStrategy],
          commentaryEvery: 20,
        });
        report = r;
        if (r.flags.steal && r.flags.trade) break;
        console.log(`[e2e] islanders attempt ${attempt}: flags ${JSON.stringify(r.flags)}, retrying with a new seed`);
      }
      await assertMatch(report!);
      console.log(`[e2e] islanders flags: ${JSON.stringify(report!.flags)}, decisions=${report!.decisions}`);
      const landlordFlags = (globalThis as Record<string, unknown>).__landlordFlags as
        | { trade: boolean; bankruptcy: boolean }
        | undefined;
      // Spec targets across the trading matches: >=1 auction (asserted in the
      // landlord test), >=1 accepted trade, >=1 bankruptcy OR bandit steal.
      const tradeSomewhere = report!.flags.trade || landlordFlags?.trade === true;
      const stealOrBankruptcy = report!.flags.steal || landlordFlags?.bankruptcy === true;
      expect(tradeSomewhere, 'at least one accepted trade across the trading matches').toBe(true);
      expect(stealOrBankruptcy, 'at least one bandit steal or bankruptcy across the trading matches').toBe(true);
    },
  );
});

describe('stage-4 e2e: werewolf — eight seats, hidden roles, words as moves', () => {
  it(
    'werewolf: 8-seat match through the real signed door; replay verifies, roles never leak pre-end, speech rides BOTH channels',
    { timeout: 1_200_000 },
    async () => {
      // The whole seat configuration is meta.players, and the product pairer
      // seats players.min: if this ever became a range the "8-seat match"
      // below would silently become something else.
      expect(GAMES['werewolf']!.meta.players).toEqual({ min: 8, max: 8 });

      const report = await runMatch(h, {
        game: 'werewolf',
        players: 8,
        // A full-length game is 6 days x 33 rows; 600 is a safety cap only.
        maxDecisions: 600,
        label: 'werewolf',
        strategies: Array.from({ length: 8 }, () => werewolfStrategy),
        // Also exercises the commentary gate: `commentary` is a PUBLIC aside,
        // so the room DROPS it in a phase whose speech audience is not the
        // village — otherwise a wolf narrating its kill would publish the pack
        // straight through the `night` redaction.
        commentaryEvery: 3,
      });

      // Everything the other matches assert: R2 replay, log ordering, FULL
      // offline verifyReplay, one agreed result, ratings, and the generic
      // pre-end secret-probe scan.
      await assertMatch(report);

      const replay = report.replay;
      const seats = replay.seats.map((s) => s.player);
      expect(seats).toHaveLength(8);
      expect(new Set(replay.seats.map((s) => s.handle)).size, 'eight distinct agents').toBe(8);
      for (const s of replay.seats) expect(s.pubkey_ed25519).toMatch(/^[0-9a-f]{64}$/);

      const walk = replayWalk(replay);
      const finalState = (walk.steps.length > 0 ? walk.steps[walk.steps.length - 1]!.post : walk.initial) as {
        alive?: Record<string, boolean>;
        cause?: Record<string, string>;
        packLog?: { text: string }[];
        noteLog?: { text: string }[];
      };
      const alive = finalState.alive ?? {};

      // The DAY mechanic actually resolved at least once. Without this the
      // match could satisfy everything else while only the wolves ever ate:
      // strict plurality with ANY TIE IS NO LYNCH means a strategy that
      // scattered its ballot would silently stop exercising the lynch path,
      // and a 'wolves' result would still look like a clean game.
      const causes = Object.values(finalState.cause ?? {});
      expect(causes, 'the day vote must have lynched somebody at least once').toContain('lynch');

      const endSeq = report.allEvents.find((e) => e.type === 'end')!.seq;
      const preEnd = report.allEvents.filter((e) => e.seq < endSeq);
      const moveEvents = report.allEvents.filter((e) => e.type === 'move');
      const preEndMoveEvents = preEnd.filter((e) => e.type === 'move');
      const moveEntries = replay.log.filter((e) => e.kind === 'move');
      const kinds = replay.log.map((e) => e.kind);

      // ----------------------------------------------------------------------
      // 1. The game genuinely REACHED a natural terminal result — it was not
      //    carried there by the clock, by strikes, or by the driver's cap.
      // ----------------------------------------------------------------------
      const result = replay.result as {
        winners: string[];
        draw: boolean;
        reason: string;
        teams: Record<string, string>;
      };
      expect(['village', 'wolves', 'day_limit'], `unexpected end reason ${result.reason}`).toContain(result.reason);
      expect(result.draw).toBe(false);
      expect(kinds.filter((k) => k === 'timeout'), 'no seat may have been carried by the clock').toHaveLength(0);
      expect(kinds.filter((k) => k === 'strike'), 'no seat may have been struck').toHaveLength(0);
      expect(kinds.filter((k) => k === 'forfeit'), 'no seat may have been forfeited').toHaveLength(0);
      // resign and draw_offer are DISABLED here: neither may appear at all.
      expect(kinds.filter((k) => k === 'resign' || k === 'draw_offer' || k === 'draw_accept')).toHaveLength(0);
      for (const entry of moveEntries) {
        expect((entry.payload as { forced?: unknown }).forced, 'no move may have been forced by the room').toBeUndefined();
      }
      // At least one complete cycle at eight seats (8 night + 8 + 8 talk +
      // defence + 8 ballots), so none of the phase assertions below is vacuous.
      expect(moveEntries.length, 'the match must cover a whole night/day cycle').toBeGreaterThanOrEqual(33);

      // ----------------------------------------------------------------------
      // 2. The result names a whole TEAM, dead members included — not a seat.
      // ----------------------------------------------------------------------
      expect(Object.keys(result.teams).sort()).toEqual([...seats].sort());
      const wolves = seats.filter((p) => result.teams[p] === 'wolves').sort();
      const village = seats.filter((p) => result.teams[p] === 'village').sort();
      expect(wolves, 'the deal is exactly 2 werewolves').toHaveLength(2);
      expect(village, 'the deal is exactly 6 non-wolves').toHaveLength(6);
      const winningTeam = result.reason === 'village' ? village : wolves;
      expect([...result.winners].sort(), 'winners must be the whole winning team').toEqual(winningTeam);
      expect(result.winners.length).toBeGreaterThan(1);
      const losers = seats.filter((p) => !result.winners.includes(p));
      if (result.reason === 'village') {
        // The village wins with its night-killed members still on the sheet.
        expect(
          result.winners.filter((p) => alive[p] !== true).length,
          'a village win must crown the seats the wolves already ate',
        ).toBeGreaterThan(0);
      } else {
        // Wolves win at parity or at the day limit with villagers still alive:
        // surviving is not winning, being on the team is.
        expect(
          losers.some((p) => alive[p] === true),
          'a wolf win leaves living villagers on the losing side',
        ).toBe(true);
      }

      // ----------------------------------------------------------------------
      // 3. THE NIGHT REDACTION. Every move played in phase `night` — kill,
      //    peek, guard, sleep, stay_in, any target, any words — notates as the
      //    single constant token, in the log and on the public feed alike.
      // ----------------------------------------------------------------------
      let nightMoves = 0;
      for (const step of walk.steps) {
        if (step.entry.kind !== 'move') continue;
        const payload = step.entry.payload as { notation?: string; player?: string };
        if ((step.pre as { phase?: string }).phase !== 'night') {
          expect(payload.notation, 'only a night move may notate as `night`').not.toBe('night');
          continue;
        }
        nightMoves++;
        expect(
          payload.notation,
          `${payload.player}'s night move leaked its verb: ${payload.notation}`,
        ).toBe('night');
      }
      expect(nightMoves, 'every living seat acts every night').toBeGreaterThanOrEqual(8);
      for (const ev of preEndMoveEvents) {
        const notation = String((ev.data as { notation?: unknown }).notation ?? '');
        expect(
          /^(kill|peek|guard|sleep|stay_in)\b/.test(notation),
          `a night verb reached the spectator feed: ${notation}`,
        ).toBe(false);
        // A `commentary` next to a `night` notation would publish the action
        // the redaction just hid — for the mover's partner as well as itself.
        if (notation === 'night') {
          expect(
            (ev.data as { commentary?: unknown }).commentary,
            'commentary must be dropped on a night move',
          ).toBeUndefined();
        }
      }
      expect(
        moveEvents.some((e) => typeof (e.data as { commentary?: unknown }).commentary === 'string'),
        'day commentary must survive, or the night-drop check above proves nothing',
      ).toBe(true);

      // ----------------------------------------------------------------------
      // 4. state_hash: WITHHELD from the live public feed (the role space is
      //    840 deals, so a live digest of the full state is brute-forceable),
      //    but still logged on every entry for the offline verifier.
      // ----------------------------------------------------------------------
      for (const ev of [...report.allEvents, ...report.liveEvents]) {
        if (ev.type !== 'move' && ev.type !== 'timeout') continue;
        expect(
          (ev.data as { state_hash?: unknown }).state_hash,
          `werewolf must not publish state_hash on a live ${ev.type} event`,
        ).toBeUndefined();
      }
      for (const entry of moveEntries) {
        expect((entry.payload as { state_hash?: unknown }).state_hash).toMatch(/^[0-9a-f]{64}$/);
      }
      // The withholding is scoped, not a blanket removal: the post-end `end`
      // event still publishes the final hash.
      expect(
        (report.allEvents.find((e) => e.type === 'end')!.data as { final_state_hash?: unknown }).final_state_hash,
      ).toMatch(/^[0-9a-f]{64}$/);

      // ----------------------------------------------------------------------
      // 5. WORDS ARE MOVES, over BOTH channels: inline as a quoted JSON string
      //    literal in the notation, and in the separate signed `utterance`
      //    field that bindUtterance folds into the move object.
      // ----------------------------------------------------------------------
      const subOf = (e: (typeof moveEntries)[number]): { move?: unknown; utterance?: unknown } =>
        ((e.payload as { submission?: { move?: unknown; utterance?: unknown } }).submission ?? {});
      const inlineEntries = moveEntries.filter((e) => {
        const m = subOf(e).move;
        return typeof m === 'string' && m.includes(WW_INLINE_MARK);
      });
      const utteranceEntries = moveEntries.filter((e) => {
        const u = subOf(e).utterance;
        return typeof u === 'string' && u.includes(WW_UTTERANCE_MARK);
      });
      expect(inlineEntries.length, 'some moves must carry inline quoted speech').toBeGreaterThan(0);
      expect(utteranceEntries.length, 'some moves must use the separate utterance field').toBeGreaterThan(0);
      const notationOf = (e: (typeof moveEntries)[number]): string =>
        String((e.payload as { notation?: unknown }).notation ?? '');
      expect(
        inlineEntries.some((e) => notationOf(e).includes(WW_INLINE_MARK)),
        'inline speech must survive into the recorded day notation',
      ).toBe(true);
      expect(
        utteranceEntries.some((e) => notationOf(e).includes(WW_UTTERANCE_MARK)),
        'bindUtterance must fold the separate field into the move itself',
      ).toBe(true);

      // The words are in the STATE (and therefore in the state hash that
      // verifyReplay already recomputed), not merely in the submission.
      const transcriptTexts = new Set<string>();
      for (const state of [walk.initial, ...walk.steps.map((s) => s.post)]) {
        for (const u of (state as { transcript?: { text?: string }[] }).transcript ?? []) {
          if (typeof u.text === 'string' && u.text !== '') transcriptTexts.add(u.text);
        }
      }
      const spoken = [...transcriptTexts];
      expect(spoken.some((t) => t.includes(WW_INLINE_MARK)), 'inline speech reached the transcript').toBe(true);
      expect(spoken.some((t) => t.includes(WW_UTTERANCE_MARK)), 'utterance speech reached the transcript').toBe(true);

      // …and the day transcript is genuinely public: it reaches spectators.
      const feedSpeech = report.allEvents
        .filter((e) => e.type === 'game:speech')
        .map((e) => String((e.data as { data?: { text?: unknown } }).data?.text ?? ''));
      expect(feedSpeech.some((t) => t.includes(WW_INLINE_MARK))).toBe(true);
      expect(feedSpeech.some((t) => t.includes(WW_UTTERANCE_MARK))).toBe(true);

      // NIGHT words go the other way: both channels land in the private pack /
      // note ledgers, which only the post-end replay ever shows.
      const nightTexts = [
        ...(finalState.packLog ?? []).map((x) => x.text),
        ...(finalState.noteLog ?? []).map((x) => x.text),
      ];
      expect(nightTexts.some((t) => t.includes(WW_INLINE_MARK)), 'inline night speech was recorded').toBe(true);
      expect(nightTexts.some((t) => t.includes(WW_UTTERANCE_MARK)), 'utterance night speech was recorded').toBe(true);
      const preEndBlob = preEnd.map((e) => JSON.stringify(e)).join('\n');
      for (const text of nightTexts) {
        expect(preEndBlob.includes(text), `night words reached the spectator feed: ${text}`).toBe(false);
      }

      // ----------------------------------------------------------------------
      // 6. NO PRE-END LEAK. assertMatch already ran the union probe scan; this
      //    is the sharper, TIME-SCOPED form: for every pre-end event, no seat
      //    whose role is still hidden AT THAT POINT may appear with its role in
      //    any of the three encodings werewolf's own secretProbes pins. (A seat
      //    that has already died is excluded, because every death legitimately
      //    reveals — which is exactly why the union form has to be scoped.)
      // ----------------------------------------------------------------------
      const probes = await collectSecretProbes(replay);
      expect(probes.length, 'the leak scan must not be vacuous').toBeGreaterThan(0);

      const revealEntry = replay.log.find((e) => e.kind === 'reveal')!;
      const roles = (revealEntry.payload as { roles?: Record<string, string> }).roles!;
      expect(Object.keys(roles).sort()).toEqual([...seats].sort());

      const revealedByNow = new Set<string>();
      for (const ev of preEnd) {
        const pub = (ev.data as { public?: { dead?: { seat: string; role: string | null }[] } } | null)?.public;
        for (const d of pub?.dead ?? []) if (d.role !== null) revealedByNow.add(d.seat);
        const blob = JSON.stringify(ev);
        for (const seat of seats) {
          if (revealedByNow.has(seat)) continue;
          const role = roles[seat]!;
          for (const probe of [`"${seat}":"${role}"`, `"seat":"${seat}","role":"${role}"`, `${seat} ${role.toUpperCase()}`]) {
            expect(
              blob.includes(probe),
              `pre-end ${ev.type} event #${ev.seq} leaked living seat ${seat}: ${probe}`,
            ).toBe(false);
          }
        }
      }
      expect(revealedByNow.size, 'seats died during the match, so the scan tracked real reveals').toBeGreaterThan(0);

      // The roles ARE published — after `end`, on the reveal event. Without
      // this the absence above could just mean nobody ever computed them.
      const revealEv = report.allEvents.find((e) => e.type === 'reveal')!;
      expect(revealEv.seq).toBeGreaterThan(endSeq);
      expect((revealEv.data as { roles?: unknown }).roles).toEqual(roles);

      console.log(
        `[e2e] werewolf: ${report.decisions} decisions, result=${JSON.stringify(replay.result)}, ` +
          `night moves=${nightMoves}, inline=${inlineEntries.length}, utterance=${utteranceEntries.length}, ` +
          `replay=${report.replayPath}`,
      );
    },
  );
});

describe('stage-4 e2e: deliberate misbehavior (A11)', () => {
  it(
    'three-step illegal policy, forced third move, timeout default, strike accounting',
    { timeout: 600_000 },
    async () => {
      const report = await runMisbehaviorMatch(h);

      // 1st illegal submission: rejected with the reason; turn NOT consumed.
      const first = report.firstIllegal as { code?: string; illegal_attempt?: number; legal_moves?: unknown };
      expect(first.code).toBe('illegal_move');
      expect(first.illegal_attempt).toBe(1);

      // 2nd illegal, same turn: rejected AND the full legal list is restated.
      const second = report.secondIllegal as { code?: string; illegal_attempt?: number; legal_moves?: unknown[] };
      expect(second.code).toBe('illegal_move');
      expect(second.illegal_attempt).toBe(2);
      expect(Array.isArray(second.legal_moves)).toBe(true);
      expect((second.legal_moves as unknown[]).length).toBeGreaterThan(0);

      // Legal 3rd submission of that turn: accepted, not forced — the two
      // rejections consumed nothing.
      expect(report.legalAfterIllegals.applied).toBe(true);
      expect(report.legalAfterIllegals.forced ?? false).toBeFalsy();

      // A turn taken to the 3rd illegal: the room applied a seeded random
      // legal move itself and recorded a strike.
      expect(report.forcedVerdict, 'the all-illegal turn must have resolved').toBeTruthy();
      expect(report.forcedVerdict!.applied).toBe(true);
      expect(report.forcedVerdict!.forced).toBeTruthy();

      // Log-level accounting.
      const log = report.replay.log;
      const strikes = log.filter((e) => e.kind === 'strike').map((e) => e.payload as { player: string; reason: string; strike_count: number });
      const timeouts = log.filter((e) => e.kind === 'timeout').map((e) => e.payload as { player: string; applied_notation?: string });
      expect(
        timeouts.some((t) => t.player === report.timedOutPlayer && typeof t.applied_notation === 'string'),
        `timeout entry with a default move for ${report.timedOutPlayer}; log kinds: ${log.map((e) => e.kind).join(',')}`,
      ).toBe(true);
      expect(strikes.some((s) => s.reason === 'timeout' && s.player === report.timedOutPlayer)).toBe(true);
      const illegalStriker = report.agents[0]!.player;
      expect(strikes.some((s) => s.reason === 'illegal_move' && s.player === illegalStriker)).toBe(true);
      for (const s of strikes) expect(s.strike_count).toBeGreaterThanOrEqual(1);

      // FULL strict offline verification. The old gap #9 (verifyReplay had
      // no branch for forced-third-illegal 'move' entries) is fixed:
      // src/kernel/verify.ts now recomputes payload.forced==='illegal'
      // entries, so a replay containing a forced move, a timeout default,
      // and strikes must pass EVERY check.
      const verdict = verifyReplay(report.replay, GAMES);
      const failed = verdict.checks.filter((c) => !c.ok);
      expect(failed, `verifyReplay failures on the misbehavior replay: ${JSON.stringify(failed)}`).toHaveLength(0);
      expect(verdict.ok).toBe(true);
    },
  );
});

describe('stage-4 e2e: doors', () => {
  it('MCP tools/list serves the 16 spec tools on the real /mcp door', async () => {
    const res = await fetch(`${h.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const rpc = (await res.json()) as { result?: { tools?: { name: string }[] } };
    expect(rpc.result?.tools?.length).toBe(16);
  });

  it('front door and OpenAPI answer', async () => {
    const front = await fetch(`${h.base}/`);
    expect(front.status).toBe(200);
    expect(front.headers.get('content-type')).toContain('text/plain');
    await front.body?.cancel();
    const openapi = (await (await fetch(`${h.base}/openapi.json`)).json()) as { paths?: Record<string, unknown> };
    expect(Object.keys(openapi.paths ?? {}).length).toBeGreaterThanOrEqual(27);
  });
});

// Type-only usage so the ReplayFile import stays load-bearing.
const _replayShape: ReplayFile | null = null;
void _replayShape;
