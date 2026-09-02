# E2E driver (stage 4) — test/e2e/

Real matches through the real local Worker (`wrangler dev`), every replay
verified offline. Owner: e2e-driver track. Files: `test/e2e/{client,harness,
match,worker,smoke,sizeprobe}.ts`, `test/e2e/wrangler.e2e.jsonc`,
`test/e2e/vitest.config.ts`, `test/e2e/e2e.e2etest.ts`, artifacts in
`test/e2e/out/`.

**STATUS (post-integration re-prove, 2026-09-02): the shim is now a THIN
pass-through.** The stage-4 integration builders wired the real product paths
(notes/integration-match.md, notes/integration-rooms.md): cronTick pairing,
end-of-game D1 persistence + R2 upload + `replay_r2_key`, per-game Glicko-2
application, chunked DO storage, and live `game:*` events. The shim's pairing
sweep, finalize sweep, and ratings supplements are DELETED — the real Worker
does all three, and the whole matrix was re-proven against it: **15/15 tests
green** (fresh-state run), with one precisely-pinned known ratings bug (see
gap #10).

## Run commands

```bash
# The whole stage-4 suite (boots wrangler dev on port 8788 itself):
npx vitest run --config test/e2e/vitest.config.ts

# One match only (any test-name filter works):
npx vitest run --config test/e2e/vitest.config.ts -t "chess"
npx vitest run --config test/e2e/vitest.config.ts -t "misbehavior"

# Dev-time one-shot smoke (tictactoe end-to-end + verify + leaderboard):
node --experimental-strip-types test/e2e/smoke.ts

# In-process snapshot-growth probe for the trading games (no wrangler):
node --experimental-strip-types test/e2e/sizeprobe.ts landlord '{"starting_cash":20000,"turn_limit":150}' 2
```

The suite file is deliberately named `e2e.e2etest.ts` (NOT `*.test.ts`) so the
repo-default vitest glob (`npm test`) can never pick it up; it only runs under
its own config above. It owns port 8788 and runs files serially.

## Architecture

```
vitest (Node)                              wrangler dev :8788 (fresh state)
  e2e.e2etest.ts                             test/e2e/worker.ts  (THIN shim)
    startHarness ── d1 execute schema.sql      ├─ /e2e/*   3 test-only doors
    runMatch ─ LudusClient (HTTP + MCP) ────►  └─ everything else → src/index.ts
    verifyReplay(replay, GAMES)  ◄─ offline        (REAL router, cron/pairing,
                                                    rooms+finalize, ratings)
```

- **harness.ts** — per-run fresh state: `--persist-to test/e2e/out/state-<runid>`
  (D1 + DO + KV + R2 never shared between runs); applies `schema.sql`; spawns
  `wrangler dev --test-scheduled` in its own process group; readiness =
  polling `/e2e/ping`. A random `CHECKPOINT_SK` is passed with `--var` so the
  checkpoint cron signs for real. `tickCron()` fires
  `GET /__scheduled?cron=...` (wrangler 4.x convention) and sleeps ~250 ms for
  the `ctx.waitUntil` work.
- **client.ts** — typed client over BOTH doors (HTTP challenge-auth +
  MCP JSON-RPC tools/call), all crypto/canonical-JSON imported from `src/`.
  Unchanged by the re-prove.
- **worker.ts (THIN shim)** — passes `fetch` and `scheduled` straight to the
  real `src/index.ts` export. Remnants (ALL test-only, none supply product
  behavior):
    1. `GET /e2e/ping` — harness readiness liveness probe.
    2. `POST /e2e/lobby` — direct D1 lobby INSERT, used ONLY for spec-unlisted
       games (tictactoe): `POST /api/lobby/join` correctly rejects them with
       `GAME_UNLISTED` (asserted first); the REAL cronTick pairer still forms
       the game from the seeded row.
    3. `POST /e2e/unlimit` — deletes `rl:*` KV rate-limit buckets. The
       120 req/min/IP limit is real product behavior; the local driver is far
       faster than any real agent. Used by the client's 429-retry path.
  Deleted vs the pre-integration shim: the pairing sweep, the finalize sweep,
  the ratings upserts, `/e2e/config` (seat/clock overrides), `/e2e/sweep`,
  the pseudo-drand, and the serialization chain. There is NO clock override
  anymore: the misbehavior test waits out the room's real 60 s default
  per-move clock (the product pairer passes no clock and offers no test
  hook — an accepted cost of a fully real path, ~64 s test).
- **match.ts** — `runMatch` drives one full game: N clients register →
  homologate (open division) → lobby join (real signed door; tictactoe seeds
  the lobby table via the shim door) → cron ticks until the REAL cronTick
  pairer forms the game → move loop keyed off each verdict's `waiting_for` →
  the room's own finalize flips D1/uploads R2 on the end path
  (`waitForEnded` just polls the games row) → replay + full event stream +
  leaderboard. `runMisbehaviorMatch` covers the A11 e2e half. Strategies are
  seeded (kernel SeedStream — no Math.random in decisions). Target-event
  flags now key off the REAL live `game:*` spectator events (auction_start,
  auction_won, trade, stolen, bankruptcy) wired by the rooms integration,
  with the old notation/phase heuristics kept as a fallback cross-check.
- **Leak probes** — `collectSecretProbes(replay)` replays every state
  in-process and unions `secretProbes(state, player)` over every state and
  player; the suite asserts no pre-end spectator event contains any probe,
  the reveal secret, or the final seed. Now also covers the new live
  `game:*` events (public-visibility only — verified clean).

## Per-game status

(from the definitive fresh-state real-path run; replays in
`test/e2e/out/replay-<game>-*.json`)

| game | players | status | notes |
|---|---|---|---|
| tictactoe | 2 | GREEN | agent 1 entirely over MCP transport; unlisted → lobby seeded via shim door, REAL pairer forms the game |
| connect_drop | 2 | GREEN | |
| chess | 2 | GREEN | ends by checkmate |
| checkers | 2 | GREEN | ends by no_moves |
| reversi | 2 | GREEN | ends by most_discs with scores |
| hex | 2 | GREEN | ends by connection |
| nine_mens_morris | 2 | GREEN | ends by reduced |
| go | 2 | GREEN | ends by two_passes with Tromp-Taylor scores |
| chinese_checkers | 2 | GREEN* | anti-stalling 'forfeit' result; *ratings pinned as a Glicko-2 draw — known product bug #10 |
| backgammon | 2 | GREEN | ends by bearoff / gammon-scale scores |
| landlord | 2 | GREEN | **FULL LENGTH, no resign valve**: variant `{"starting_cash":20000,"turn_limit":150}` → 1239 applied decisions (1160 on the first re-prove run), ends by turn_limit; crosses the old ~780-decision SQLITE_TOOBIG point (retired single-blob snapshot would be ~7 MB, 3.5x the 2 MB DO cap) — chunked storage survives, the ~1 MB replay serves from R2 and passes verifyReplay. 2p not 3p: product pairer always seats players.min (see gap #11). auction + auction_won + trade flags seen (via real game:* events) |
| islanders | 3 | GREEN | REAL 3-seat pairing (players.min=3); accepted trade + bandit steal; ends by points, ~455-475 decisions, no resign valve |
| misbehavior (A11) | 2 | GREEN | 2-illegal+legal turns, one full 3-illegal forced turn, one REAL 60 s timeout (default clock, no override); strikes + defaults verified in the log; **verifyReplay now passes ALL checks strictly** — old gap #9 (forced-third-illegal) is fixed |

Every green match asserts: game id matches the real d1GameFactory shape
(`game_<16hex>` — the retired shim factory used `game_e2e_*`); commitment
logged before the first move and the reveal after end;
`verifyReplay(replay, GAMES)` all-checks-ok; the replay is the FULL R2 blob
(no `reconstructed_from:'d1'` marker); no pre-end spectator event carries
hidden data (secretProbes over every replayed state); exactly one result
agreed across doors; all seats rated on the leaderboard with
`games_played>=1`; and for decisive results (winners ⊂ seats, not a draw,
scores not all-equal) the REAL Glicko-2 application moved ratings off
1500-flat (winner > 1500, some loser < 1500).

## Product gaps — status after the integration re-prove

Gaps #1-#9 from the original run are FIXED and re-proven end-to-end:

1. ~~Pairer unwired~~ — `cronTick(env)` exists (src/match/pairing.ts), called
   by the cron `match` step; lobby join → cron tick → real game PROVEN for
   all 13 matches.
2. ~~No end-of-game D1 persistence~~ — `GameRoom.finalize` writes
   games/game_log/spectator_events/private_views; PROVEN (status flips to
   'ended' immediately after the ending move; replay + events serve post-DO).
3. ~~Ratings never update~~ — `applyGameRatings` runs from room finalize;
   PROVEN (leaderboards move off 1500 for decisive games — but see #10).
4. ~~DO snapshot blob overflow (SQLITE_TOOBIG)~~ — chunked storage; PROVEN by
   the full-length 1160-decision landlord match (old failure point ~780).
5. ~~R2 replay key mismatch~~ — factory + finalize agree on
   `replays/<game_id>.json`; PROVEN (replays serve from R2, never the D1
   reconstruction).
6. ~~Game-module events dropped~~ — public GameEvents emit live as
   `game:<type>`; PROVEN (flags for auction_start/auction_won/trade/stolen
   observed in the live feed; leak probes stay clean).
7. ~~Live vs D1 event shapes differ~~ — one envelope both phases; the
   driver's `normalizeEvents` keeps handling both shapes anyway.
8. ~~Move rejections double-wrapped~~ — flat room codes (`illegal_move`,
   `not_your_turn`, ...) surface as `error.code`; PROVEN by the misbehavior
   match (the full verdict still rides in `error.data`).
9. ~~verifyReplay cannot verify forced-third-illegal moves~~ — the verifier
   has a `payload.forced==='illegal'` branch now; the misbehavior test
   requires a FULL strict pass (all checks ok) and gets it.

Still open (found in this re-prove — NOT fixed here, src/ is out of scope):

10. **standingsFromResult prefers scores over winners**
    (src/match/glicko2.ts:195): whenever `result.scores` exists, standings
    rank by score alone and `result.winners` is ignored. A decisive result
    with all-equal scores — chinese_checkers' anti-stalling forfeit is
    `{winners:['p1'], draw:false, scores:{p0:0,p1:0}, reason:'forfeit'}` —
    rates as a Glicko-2 DRAW: both players stay 1500 while games_played
    increments. The suite pins exactly that signature (decisive + all-equal
    scores → tolerated flat ratings with a console.warn); every other
    decisive result must move ratings. Fix candidates: rank winners first
    and break ties by score, or have forfeit-type results score the winner.
11. **The pairer can only form players.min-seat games**
    (src/match/pairing.ts cronTick `seatsFor` = `meta.players.min`): there is
    no product path to e.g. a 3-player landlord game (min 2, max 4) — no
    lobby/variant knob carries a seat count. The e2e therefore proves
    landlord at 2p full length and 3-seat pairing via islanders (min 3).
    The old shim's `/e2e/config` seats override is gone with the shim sweep.
12. (Unchanged severity, inherited from the match builder's own notes:
    drand round is a commitment-ordering witness, not the mixed randomness's
    round; factory failure mid-sweep can re-pair earlier winners' lobby rows
    next tick. See notes/integration-match.md.)

## Quirks / decisions

- **Real drand now**: the real d1GameFactory fetches the latest quicknet
  round at game creation (network), falling back to zero randomness + a
  public docket row when unreachable. The shim's pseudo-drand is gone.
  verifyReplay treats round+randomness as recorded inputs either way.
- **Rate limit**: 120 req/min/IP is real and the driver is much faster; the
  client spoofs a per-agent `cf-connecting-ip` AND clears `rl:*` buckets via
  `/e2e/unlimit` on any 429, then retries. Neither touches product behavior
  for real deployments.
- **Unlisted tictactoe**: `GAME_UNLISTED` on lobby join is asserted as correct
  spec behavior; the match then seeds the lobby table directly through the
  shim door so the REAL pairer (not any hand-rolled path) still creates the
  game.
- **Resign valve retired**: `resignAfterDecisions` still exists in the driver
  as a generic capability but no test uses it — the trading games run to
  their natural ends on chunked storage.
- **Misbehavior clock**: the timeout half waits out the room's REAL 60 s
  default per-move clock (~64 s test). If a faster suite matters more than a
  fully-real clock, the product would need a create-time clock hook exposed
  through pairing (per_move_ms/clock_scale exist on the room's /create but
  nothing product-side passes them).
- **Suite timings** (Apple Silicon, local; definitive fresh-state run):
  15/15 tests in ~138 s total — every M1+M2 game under 4 s, landlord ~33 s
  (1239 decisions, ~27 ms/decision incl. driver overhead), islanders ~19 s,
  misbehavior ~64 s (real 60 s timeout wait). Avg applied-move round trip
  ~8-11 ms over HTTP.
