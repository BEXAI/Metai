# Fixes for red-team-liveness findings (L1, L2, L3)

Files changed: `src/rooms/core.ts`, `src/rooms/room.ts`. No attack test was
edited or weakened. Spec anchors: `games.M1_perfect_information.chess.clock`
("60 s per move, 40 min per side cumulative"), `llm_player_protocol`
(`view_object.deadline_utc` "ISO time by which the move must arrive";
`move_submission.illegal_move_policy` / `timeouts` "Three strikes in a game
forfeit it"), `matchmaking_and_ratings.forfeits_and_draws` ("Timeouts and
strikes forfeit").

## L1 (high) — cumulative side clock never enforced

- **Root cause**: `src/rooms/core.ts` tracked `clocks.cumulativeMs` (old
  line 90, accrued at 699/821/977/1009) but `CreateRoomParams` (93-108) and
  `RoomClocks` (85-91) had no per-side budget field and no code compared
  cumulative time to any budget — neither `submitMove` nor `timeout()` could
  ever flag a player, so 59.9 s/move forever was free.
- **Fix** (`src/rooms/core.ts`):
  - `RoomClocks.perSideMs: number | null` + `CreateRoomParams.perSideMs?`
    (null = uncapped), scaled by `clock_scale` like `perMoveMs`.
  - Frozen spec defaults table `DEFAULT_PER_SIDE_MS = { chess: 40 * 60_000 }`
    applied in `RoomCore.create` when the creator does not pass `perSideMs`
    (only chess has a spec'd `clock` line; other games stay uncapped unless
    configured). `hydrate()` backfills the field on pre-fix snapshots.
  - `startTurnClock` now shrinks the turn allowance to
    `min(perMoveBudget, remaining side budget)` for every mover, so a player
    can never think past their flag inside a single move clock (in-time moves
    therefore always accrue strictly less than the remaining budget).
  - `timeout()` charges the full per-move budget (frozen: never the alarm
    latency), then checks `flagFallen` — cumulative >= scaled side budget —
    and forfeits the stalling player on time: log `forfeit { player, reason:
    'time' }`, result `{ winners: [others], draw: false, reason: 'forfeit' }`.
    The simultaneous branch runs the same check per charged absentee in seat
    order. No forced move is drawn/applied on a flag fall, so the final state
    stays non-terminal and `verifyReplay`'s forfeit-cause path verifies the
    replay unchanged.
  - `GameRoom` `CreateBody` accepts `per_side_ms` (passthrough,
    `src/rooms/room.ts`).

## L2 (medium) — late move accepted as a clean move (delayed-alarm race)

- **Root cause**: `submitMove` (old `src/rooms/core.ts:490-563`) never read
  `snap.deadlineAtMs`; `GameRoom.handleMove` (old `src/rooms/room.ts:243`)
  forwarded `Date.now()` without expiring a passed deadline, so in the
  deadline-to-alarm window a move landed arbitrarily late with no strike.
- **Fix**:
  - `src/rooms/core.ts` `submitMove`: after the resign branch (a resignation
    is honored at any time and consumes no thinking budget), a submission with
    `nowMs >= deadlineAtMs` is rejected with `deadline_passed` — it can never
    land as a clean move, register a draw offer/accept, or be held in a
    simultaneous phase for the expired turn. `>=` matches `timeout()`'s
    firing condition so there is no instant that both accepts a move and
    fires the alarm.
  - `src/rooms/room.ts` `handleMove`: runs `core.timeout(now)` BEFORE
    `core.submitMove(now, ...)` so an expired deadline resolves first (strike
    + forced default per the frozen policy), with its events broadcast and
    the replay uploaded if that ended the game. The core-level rejection
    remains as a second guard for direct users of `RoomCore`.

## L3 (medium) — third strike on the game-ending move crowned the striker

- **Root cause**: both sequential strike paths gated the three-strikes
  forfeit behind `status === 'running'` AFTER the strike-forcing move was
  applied: `timeout()` recorded strike #3 (old `core.ts:1032`), `advanceTurn`
  (1034-1036) ended the game by the game's own terminal rule, and the forfeit
  check (1037-1041) was skipped; `commitApplied` had the same gate at 750
  before its check at 757-759. The simultaneous submission path (812-815)
  already forfeited at strike time, before anything applied.
- **Fix** (`src/rooms/core.ts`) — unified on the simultaneous path's
  strike -> forfeit-before-terminal shape. When the pending strike is the
  player's third, the strike is recorded and the game forfeits immediately;
  NO forced move is drawn or applied (so the final state stays non-terminal
  and the replay verifies through `verifyReplay`'s forfeit-cause branch,
  which requires `isTerminal(final) == result` whenever the state is
  terminal):
  - `timeout()` sequential branch: third-strike check right after the budget
    charge, before the default move is drawn.
  - `submitSequential`: third-illegal-attempt interception in both the
    parse-illegal and the apply-RuleError paths.
  - `resolveSimultaneous`: pre-checks for held `forced: 'timeout'` markers
    and for the shifted-state substitution strike.
  - `commitApplied`: the (now unreachable) forced-move forfeit check moved
    BEFORE `advanceTurn` as a safety net, so even that path can never let a
    terminal rule crown a three-strike player.
- `forfeit(nowMs, player, reason)` now carries `'three_strikes' | 'time'` in
  the log/event payload; the `GameResult.reason` stays `'forfeit'` for both.

## Attack-test corrections

None — no attack test contradicted the spec; all four liveness files pass
against the fixed code unmodified.

## Verification

- `npx vitest run test/redteam/` — 26 files, 365 tests, all green.
- `npx vitest run src/rooms src/api src/agents src/match src/kernel` —
  20 files, 176 tests, all green (includes the replay verifier suite).
- `npx vitest run test/determinism.test.ts test/no-stubs.test.ts` — green.
- `npx tsc --noEmit --pretty false` — no errors.
- No game module touched, so the playout gate was not re-run per the fixer
  rules.
