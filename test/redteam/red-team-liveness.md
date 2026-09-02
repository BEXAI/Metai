# Red team: liveness (clocks, strikes, forfeits, lobbies, quotas)

Team `red-team-liveness`. Targets: `src/rooms/core.ts`, `src/match/`, `src/api/`.
Spec anchors: `llm_player_protocol.move_submission` (illegal_move_policy,
timeouts), `matchmaking_and_ratings` (quotas, forfeits_and_draws,
house_agents), `games.chess.clock`, api `$comment`, acceptance A11.

Attack tests (assert the DEFENDED behavior; a failing test = live hole):

- `test/redteam/red-team-liveness-stalls.test.ts` — 9 tests, **1 failing**
- `test/redteam/red-team-liveness-clocks.test.ts` — 6 tests, **2 failing**
- `test/redteam/red-team-liveness-lobby.test.ts` — 6 tests, all passing
- `test/redteam/red-team-liveness-quotas.test.ts` — 8 tests, all passing

## EXPLOITABLE findings

### L1 (high) — cumulative side clock is never enforced; a player can stall a chess game forever at 59.9 s/move

Spec `games.chess.clock`: **"60 s per move, 40 min per side cumulative."**
`RoomCore` tracks `clocks.cumulativeMs` (`src/rooms/core.ts:90`, accrued at
`:699`, `:821`, `:977`, `:1009`) but no code anywhere compares it to a
budget: `CreateRoomParams` (`core.ts:93-108`) and `RoomClocks`
(`core.ts:85-91`) have no per-side field, and neither `submitMove` nor
`timeout` ever forfeits on cumulative exhaustion. Proven by
`red-team-liveness-clocks.test.ts` › "a player burning 59.9 s on every move
must flag once past 40 min cumulative": after 41 chess moves of 59.9 s each
(cumulative 40.93 min > 40 min) the game is still `running`. Total game time
is unbounded — 300-ply games at ~59 s/ply hold a room, a concurrent-games
slot, and the opponent hostage for 5+ hours while never striking.
Fix note: the test drives the real chess game through `RoomCore.create` with
default params and accepts either fix shape (shrinking deadline → timeout
strikes → forfeit, or direct flag-fall forfeit at the crossing); it only
asserts the game ends with p1 winning, no draw, by ~ply 84.

### L2 (medium) — a move arriving after its deadline is accepted as a clean move (delayed-alarm race)

`submitMove` (`src/rooms/core.ts:490-563`) never reads
`snap.deadlineAtMs`; the deadline is enforced only when `timeout()` runs
(DO alarm / `POST /tick`). `GameRoom.handleMove` (`src/rooms/room.ts:243`)
forwards `Date.now()` straight into `submitMove` without first expiring a
passed deadline. DO alarms are at-least-once and may be delayed, so in the
window between the deadline and the alarm an agent can land a move
arbitrarily late — no strike, no timeout, full extra thinking time. The spec
view contract says `deadline_utc` is "ISO time by which the move must
arrive". Proven by `red-team-liveness-clocks.test.ts` › "a move arriving a
full minute after the deadline must not land as a clean unforced move".
Fix note: either reject late submissions (`deadline_passed`) or run the
timeout resolution before processing the submission; the test only asserts
the late submission is not logged as a clean unforced `move` for the expired
turn.

### L3 (medium) — a player carrying three strikes can WIN when the strike-forcing move ends the game

Spec: "Three strikes in a game forfeit it." In both strike paths the forfeit
check is gated behind `status === 'running'`, and the strike-causing forced
move is applied (and may end the game) first:
- `timeout()`: strike #3 recorded at `src/rooms/core.ts:1032` while running,
  `advanceTurn` at `:1034-1036` hits the terminal check, and the forfeit
  check at `:1037-1041` is skipped because the game already ended;
- `commitApplied()`: same gate at `src/rooms/core.ts:750` before the forfeit
  check at `:757-759`.
Proven by `red-team-liveness-stalls.test.ts` › "a third strike earned on the
game-ending move must still forfeit, not crown the striker": p0 farms two
timeout strikes, then times out on the turn-limit-ending move — result is
`{ winners: ['p0'], reason: 'turn_limit' }`. An agent two strikes deep on
the final move can stop answering (or spam a third illegal) and still take
the win/rating points. Also note the inconsistency: the simultaneous path
forfeits immediately at submission time (`core.ts:812-815`) while the
sequential path applies the forced move first — the fix should unify on
strike → forfeit-before-terminal.

## DEFENDED (attacked, held — tests stay as regression guards)

- **Illegal-move policy is exact** (stalls file): 2 illegal submissions per
  turn forever never strike, never consume the turn, counter resets per turn
  and per player; attempt 2 restates the full legal list; the 3rd forces the
  seeded random move + strike; a draw offer riding a forced move does not
  register. Unbounded 2-illegal-then-legal farming is free work by spec.
- **Timeout farming is bounded**: 2 strikes with legal play between are
  survivable; the 3rd timeout mid-game forfeits with full end/reveal chain.
- **Simultaneous phase**: with 1 of 3 players submitted, ONE `timeout()`
  call defaults + strikes BOTH absentees in seat order, advances the turn
  once, refreshes one shared deadline; replaying the alarm is a no-op.
- **Draw offers**: spam keeps exactly one pending slot; an offer dies the
  moment the opponent's next turn is consumed (move or timeout); a stale
  offer cannot be accepted later (a late `draw_offer` is a NEW offer);
  accept works only in-window.
- **Resignation off-turn** is honored (resigner loses); after `end` every
  submission (`move`/`resign`/`draw_offer`) rejects `room_ended`, timeouts
  return `fired:false`, log/events/result are immutable.
- **Clock bookkeeping**: cumulative accrues exact thinking time from event
  times; a late alarm charges the 60 s budget, not the alarm latency;
  deadlines anchor to the last event (move applied / alarm fired) with no
  wall drift; `timeout()` fires exactly once per deadline under retries.
- **Lobby churn** (API + repo): duplicate join → 409 with no second row (D1
  PK also guards), leave spends nothing, every successful join spends
  exactly 1, 20 churn cycles never duplicate rows.
- **House backfill**: a lone agent is filled with house agents on the sweep
  where it has waited 2 (the 3rd sweep) — the frozen
  `backfillAfterSweeps: 2` bound, never later.
- **Operator conflict**: two same-operator agents are never seated together
  across sweeps and BOTH get separate house-filled games by sweep 3.
- **Rating outlier**: a 2900-point gap pairs on sweep 6 via the
  unbounded-after-5 band rule (no house help), and is rescued on sweep 3
  when house agents exist. No permanent starvation found.
- **Join quota shaping**: 100 joins across 100 attacker-crafted variant
  queues (variant is a free ≤64-char string) → exactly 50 succeed; all 50
  rejections spend nothing; ledger and lobby rows both read 50.
- **Concurrent cap**: the 21st concurrent join rejects `QUOTA_CONCURRENT`
  spending nothing; ending one game frees the slot.
- **Rejections advance nothing**: bad signature (401) and malformed JSON
  (400, pre-auth) leave the single-use challenge alive and quota at 0 — the
  same challenge then succeeds and only then burns; a rate-limited signed
  join (429) spends nothing and the identical request succeeds after refill.
- **Token bucket boundary**: exactly 120 burst per IP, 121st → 429, 500 ms
  refills exactly one token, other IPs unaffected; path shaping
  (`/api%2Fpulse`, `//api/pulse`, `/API/pulse`, trailing slash, `//`) never
  reaches a handler around the limiter, and dot-segments normalize into the
  limited path.

## Notes for builders (no test written)

- `spendJoin` runs after the lobby INSERT (`src/api/handlers.ts:644-648`);
  a crash between the two gives a free (uncounted) join. Not
  attacker-triggerable; consider spend-then-insert or a transaction.
- Rate-limit IP falls back to spoofable `x-forwarded-for`
  (`src/api/router.ts:64`) when `cf-connecting-ip` is absent — fine behind
  Cloudflare, a bypass in any non-CF deployment.
- `concurrentGames` uses `seats_json LIKE '%"<id>"%'` — safe today because
  agent ids are fixed-format `a_<32hex>` (`src/identity/register.ts:32-34`);
  revisit if id format ever changes.
- Pairer: a lobby row whose agent is missing from `cfg.info()` waits forever
  with no sweep credit (`src/match/pairing.ts:219`) — unreachable while the
  API enforces registration, but a deleted agent row would wedge that entry.
