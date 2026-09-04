/**
 * Gate A1: for every registered game, N random-legal-move playouts terminate
 * without error and every intermediate state passes the harness checks
 * (legalMoves consistency, codec round-trips, termination).
 *
 *   LUDUS_PLAYOUTS=1000 npx vitest run test/playouts.test.ts   (gate setting)
 *   LUDUS_PLAYOUTS=25   ...                                    (quick pre-integration)
 *
 * Stub games (tracks not yet landed) are skipped with a warning; the printed
 * PlayoutStats lines feed REPORT.md.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/crypto/canonical.ts';
import { GAMES } from '../src/games/index.ts';
import werewolf from '../src/games/werewolf/index.ts';
import { DAY_LIMIT, ROLE_MULTISET, countRole } from '../src/games/werewolf/board.ts';
import { runPlayouts } from '../src/kernel/playout.ts';
import { isStub } from '../src/kernel/stub.ts';
import { WW_MOVE_CAP, playWerewolf } from './werewolf-playout.ts';

const N = Number(process.env.LUDUS_PLAYOUTS ?? 1000);

describe(`random playouts (${N} per game)`, () => {
  for (const [id, game] of Object.entries(GAMES)) {
    if (isStub(game)) {
      console.warn(`[playouts] skipping '${id}' — stub, its build track has not landed yet`);
      it.skip(`${id}: skipped (stub)`, () => {});
      continue;
    }

    it(`${id}: ${N} playouts at ${game.meta.players.min} players`, () => {
      const stats = runPlayouts(game, { games: N, seedPrefix: 'a1' });
      console.log(`[playouts] ${id} players=${game.meta.players.min} ${JSON.stringify(stats)}`);
      expect(stats.games).toBe(N);
      expect(stats.totalMoves).toBeGreaterThan(0);
      expect(stats.minMoves).toBeGreaterThan(0);
    });

    if (game.meta.players.max > game.meta.players.min) {
      it(`${id}: ${N} playouts at ${game.meta.players.max} players`, () => {
        const stats = runPlayouts(game, {
          games: N,
          seedPrefix: 'a1',
          players: game.meta.players.max,
        });
        console.log(`[playouts] ${id} players=${game.meta.players.max} ${JSON.stringify(stats)}`);
        expect(stats.games).toBe(N);
        expect(stats.totalMoves).toBeGreaterThan(0);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Werewolf. Two things the generic loop above cannot give it.
//
// FIRST, coverage. meta.players is { min: 8, max: 8 }, so the `max > min`
// branch never fires and werewolf gets one invocation where every ranged game
// gets two. The extra invocation below is not a copy: it round-trips the codec
// after EVERY applied move (codecEvery: 1) rather than every 50th, because
// werewolf's state carries free text, a rolling digest chain and four
// key-presence slot maps, and a codec that drops an empty map or reorders a
// key would only show up as a state-hash divergence months later in a replay.
//
// SECOND, termination. runPlayouts reduces a game to counters and discards the
// final state, so it can prove a playout ended but not that it ended for the
// right reason. Werewolf is the first game whose termination is a rule (a day
// counter) rather than a board filling up, and the first where a phase machine
// can rest in a zero-mover configuration — which in a live room is a permanent
// 5-second alarm loop and a POST /move that returns 500 forever. The walker
// asserts the day bound and the terminal phase per game.
// ---------------------------------------------------------------------------

const WOLF_SEATS = countRole(ROLE_MULTISET, 'werewolf');
const VILLAGE_SEATS = ROLE_MULTISET.length - WOLF_SEATS;

describe(`werewolf random playouts (${N} games)`, () => {
  it(
    `werewolf: ${N} playouts at 8 players with a codec round-trip after every move`,
    () => {
      const stats = runPlayouts(werewolf, {
        games: N,
        seedPrefix: 'a1-ww-codec',
        codecEvery: 1,
        maxMoves: WW_MOVE_CAP,
      });
      console.log(`[playouts] werewolf players=8 codecEvery=1 ${JSON.stringify(stats)}`);
      expect(stats.games).toBe(N);
      expect(stats.draws).toBe(0); // isTerminal never returns draw: true
      // A full cycle is 33 applied moves and the game is bounded by DAY_LIMIT,
      // so ~200 is the rule-level ceiling. maxMoves is asserted against the
      // rules, not against the harness's 20,000-move hang cap.
      expect(stats.maxMoves).toBeLessThan(WW_MOVE_CAP);
      // Nobody can win before the first night resolves, and the first night
      // alone is 8 applied moves. A collapse to a handful of moves would mean
      // the phase machine short-circuited.
      expect(stats.minMoves).toBeGreaterThan(20);
    },
    { timeout: 600_000 },
  );

  it(
    `werewolf: ${N} playouts terminate inside DAY_LIMIT, and the balance report`,
    () => {
      const reasons: Record<string, number> = {};
      const finalDays: Record<number, number> = {};
      let villageWins = 0;
      let totalMoves = 0;
      let minMoves = Number.MAX_SAFE_INTEGER;
      let maxMoves = 0;

      for (let g = 0; g < N; g++) {
        // playWerewolf throws on a non-terminal state with no movers, on a
        // mover with no legal moves, on a RuleError from a move legalMoves()
        // itself produced, and on overrunning WW_MOVE_CAP. "Never hangs" is
        // therefore asserted for every game, not sampled.
        const w = playWerewolf(
          sha256Hex(`playout:werewolf:a1-ww:${g}`),
          sha256Hex(`picker:werewolf:a1-ww:${g}`),
        );

        // settle() sets phase 'over' in the same apply() that made the state
        // terminal, so a terminal state is never left in a playable phase.
        expect(w.state.phase).toBe('over');
        // dusk() increments the day and the NEXT settle() iteration sees
        // `day > DAY_LIMIT`, so DAY_LIMIT + 1 is the exact reachable ceiling.
        expect(w.state.day).toBeLessThanOrEqual(DAY_LIMIT + 1);
        expect(w.result.draw).toBe(false);
        // Winners are the whole team, dead and eliminated members included.
        expect(w.result.winners.length).toBe(
          w.result.reason === 'village' ? VILLAGE_SEATS : WOLF_SEATS,
        );

        reasons[w.result.reason] = (reasons[w.result.reason] ?? 0) + 1;
        finalDays[w.state.day] = (finalDays[w.state.day] ?? 0) + 1;
        if (w.result.reason === 'village') villageWins++;
        totalMoves += w.moves;
        minMoves = Math.min(minMoves, w.moves);
        maxMoves = Math.max(maxMoves, w.moves);
      }

      // isTerminal returns exactly three reasons and nothing else may appear.
      for (const r of Object.keys(reasons)) {
        expect(['village', 'wolves', 'day_limit']).toContain(r);
      }

      const villageRate = villageWins / N;
      const wolfRate = 1 - villageRate;
      console.log(
        [
          '',
          `[balance] werewolf gate 14 — random-legal play, ${N} games, 8 seats`,
          `[balance]   reasons            ${JSON.stringify(reasons)}`,
          `[balance]   final day          ${JSON.stringify(finalDays)} (DAY_LIMIT ${DAY_LIMIT})`,
          `[balance]   moves              min ${minMoves} avg ${(totalMoves / N).toFixed(1)} max ${maxMoves}`,
          `[balance]   VILLAGE win rate   ${(villageRate * 100).toFixed(2)}%`,
          `[balance]   WOLF win rate      ${(wolfRate * 100).toFixed(2)}%  (ceiling 70.00%)`,
          `[balance]   verdict            ${wolfRate < 0.7 ? 'PASS' : 'BREACH'}`,
          '',
        ].join('\n'),
      );

      // GATE 14 IS A REPORT, NOT AN ASSERTION — the plan says so in as many
      // words ("A SHIP-BLOCKER THAT IS NOT A TEST FILE — THE BALANCE REPORT.
      // Record the measured `reasons` distribution ... IN THE PR"). Wiring the
      // 70% design target as an expect() would turn a balance decision about a
      // hidden-role game into a build break on every unrelated commit, and the
      // number it measures is the win rate of a policy nobody ships: random
      // legal play is not a town, it lynches uniformly and it never coordinates.
      // So it is printed above and shouted here, and the decision belongs to
      // whoever reads the PR.
      if (wolfRate >= 0.7) {
        console.warn(
          `[balance] GATE 14 BREACH — werewolf wolves win ${(wolfRate * 100).toFixed(2)}% ` +
            `under random play, over the 70% ceiling. Note before applying the plan's first ` +
            `remedy: DAY_LIMIT = 5 makes this WORSE here, not better — day_limit is ` +
            `${(((reasons.day_limit ?? 0) / N) * 100).toFixed(2)}% of outcomes and it is a WOLF win, ` +
            `so shortening the game converts late village wins into wolf wins.`,
        );
      }

      // What IS a hard invariant rather than a balance target: every branch of
      // isTerminal must actually execute, or the rest of the werewolf suite is
      // reasoning about code no playout has run. The thresholds below are the
      // sample sizes at which an ABSENCE is evidence, computed from the rates
      // this suite measures — `village` lands near 15% of games and `day_limit`
      // near 1.5%, so asserting either at the LUDUS_PLAYOUTS=25 quick setting
      // would be a coin flip rather than a gate. At the LUDUS_PLAYOUTS=1000
      // gate setting all three fire, with a miss probability under 1e-6.
      expect(reasons.wolves ?? 0).toBeGreaterThan(0);
      if (N >= 100) expect(villageWins).toBeGreaterThan(0);
      if (N >= 500) expect(reasons.day_limit ?? 0).toBeGreaterThan(0);
      expect(maxMoves).toBeLessThan(WW_MOVE_CAP);
      expect(minMoves).toBeGreaterThan(20);
    },
    { timeout: 600_000 },
  );
});
