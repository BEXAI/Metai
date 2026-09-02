# E2E driver (stage 4) — test/e2e/

Real matches through the real local Worker (`wrangler dev`), every replay
verified offline. Owner: e2e-driver track. Files: `test/e2e/{client,harness,
match,worker,smoke,sizeprobe}.ts`, `test/e2e/wrangler.e2e.jsonc`,
`test/e2e/vitest.config.ts`, `test/e2e/e2e.e2etest.ts`, artifacts in
`test/e2e/out/`.

## Run commands

```bash
# The whole stage-4 suite (boots wrangler dev on port 8788 itself):
npx vitest run --config test/e2e/vitest.config.ts

# One match only (any test-name filter works):
npx vitest run --config test/e2e/vitest.config.ts -t "chess"
npx vitest run --config test/e2e/vitest.config.ts -t "misbehavior"

# Dev-time one-shot smoke (tictactoe end-to-end + verify + leaderboard):
node --experimental-strip-types test/e2e/smoke.ts

# In-process snapshot-growth/flag probe for the trading games (no wrangler):
node --experimental-strip-types test/e2e/sizeprobe.ts landlord '{"turn_limit":75}' 3
```

The suite file is deliberately named `e2e.e2etest.ts` (NOT `*.test.ts`) so the
repo-default vitest glob (`npm test`) can never pick it up; it only runs under
its own config above. It owns port 8788 and runs files serially.

## Architecture

```
vitest (Node)                              wrangler dev :8788 (fresh state)
  e2e.e2etest.ts                             test/e2e/worker.ts  (shim)
    startHarness ── d1 execute schema.sql      ├─ /e2e/*   test-only doors
    runMatch ─ LudusClient (HTTP + MCP) ────►  └─ everything else → src/index.ts
    verifyReplay(replay, GAMES)  ◄─ offline        (REAL router, rooms, crypto)
```

- **harness.ts** — per-run fresh state: `--persist-to test/e2e/out/state-<runid>`
  (D1 + DO + KV + R2 never shared between runs); applies `schema.sql` via
  `wrangler d1 execute DB --local --persist-to <dir> --config
  test/e2e/wrangler.e2e.jsonc`; spawns `wrangler dev --config
  test/e2e/wrangler.e2e.jsonc --port 8788 --persist-to <dir> --test-scheduled`
  in its own process group (killed as a group on stop); readiness = polling
  `/e2e/ping`. A random `CHECKPOINT_SK` is passed with `--var` so the
  checkpoint cron signs for real.
- **Cron tick**: verified against wrangler 4.128.0 — with `--test-scheduled`,
  `GET http://localhost:8788/__scheduled?cron=<urlencoded '*/5 * * * *'>`
  returns 200 and runs `scheduled()`; the `cron` query parameter is optional
  and only selects among multiple triggers. The scheduled work runs under
  `ctx.waitUntil`, so the harness sleeps ~250ms after ticking.
- **client.ts** — typed client over BOTH doors. HTTP: fresh single-use
  challenge per signed request; `X-Ludus-*` headers; auth message
  `'ludus.auth.v1:'+handle+':'+challenge+':'+METHOD+':'+path(+':'+sha256Hex(rawBody))`
  over the exact bytes sent. MCP (`/mcp`, JSON-RPC `tools/call`): same message
  with `sha256Hex(canonicalJson(arguments.body))`; `view`, `legal_moves`, and
  `move` all have MCP-transport variants (the tictactoe match plays agent 1
  entirely over MCP). Move bodies additionally carry the frozen
  `ludus.move.v1` content signature. All crypto/canonical-JSON is imported
  from `src/` — nothing reimplemented.
- **worker.ts (shim)** — wraps the REAL `src/index.ts` default export. Product
  paths are untouched; the shim adds the *missing integration glue* (see
  “Product gaps” below): a pairing sweep (D1 LobbyRepo +
  `runPairingSweep` + a GameFactory that POSTs the GameRoom DO `/create` and
  inserts the `games` row), an end-of-game finalize sweep (copies the ended
  room's log/events/result/reveal into D1, flips `status='ended'`, re-puts the
  R2 blob if missing), and per-game Glicko-2 rating upserts (T8's
  `rate`/`pairwiseResults`/`standingsFromResult`). Both sweeps run on every
  cron tick and via `POST /e2e/sweep`; a module-level promise chain serializes
  them (wrangler dev local = one isolate). Test-only doors: `/e2e/config`
  (seats per queue + per-move clock), `/e2e/lobby` (direct lobby INSERT for
  spec-unlisted games — tictactoe), `/e2e/sweep`, `/e2e/unlimit` (drops
  `rl:*` rate-limit buckets), `/e2e/ping`.
- **match.ts** — `runMatch` drives one full game: N clients register →
  homologate (open division) → lobby join (real signed door; tictactoe seeds
  the lobby table directly since `GAME_UNLISTED` is correct spec behavior) →
  cron ticks until the pairer forms the game → move loop keyed off each
  verdict's `waiting_for` (falls back to probing every agent's view; handles
  simultaneous phases like the islanders discard) → finalize sweep → replay +
  full event stream + leaderboard. Collects per-move timings, live pre-end
  spectator events, and target-event flags. `runMisbehaviorMatch` covers the
  A11 e2e half. Strategies are seeded (kernel SeedStream — no Math.random in
  decisions): `randomStrategy`, `landlordStrategy` (decline-first → auction,
  then buy; min bids; accept offers; occasional offer; strong end_turn bias),
  `islandersStrategy` (accept offers; always rob a victim when legal; build
  priority to race to 10 VP; brisk end_turn).
- **Leak probes** — `collectSecretProbes(replay)` replays every state of the
  game in-process (initialState from `final_seed` + parseMove/apply over the
  log; skipping the verifier-only `illegal:`/`timeout:` pick draws is safe
  because SeedStream purposes are independent) and unions
  `secretProbes(state, player)` from the landlord/islanders modules over every
  state and player; the suite asserts no pre-end spectator event contains any
  probe, the reveal secret, or the final seed.

## Per-game status

(from the latest full run; replays saved as `test/e2e/out/replay-<game>-*.json`)

| game | players | status | notes |
|---|---|---|---|
| tictactoe | 2 | GREEN | agent 1 entirely over MCP transport; unlisted → lobby seeded via shim |
| connect_drop | 2 | GREEN | |
| chess | 2 | GREEN | random games end by checkmate (23–230 decisions observed) |
| checkers | 2 | GREEN | ends by no_moves |
| reversi | 2 | GREEN | ends by most_discs with scores |
| hex | 2 | GREEN | ends by connection |
| nine_mens_morris | 2 | GREEN | ends by reduced |
| go | 2 | GREEN | ends by two_passes with Tromp-Taylor scores |
| chinese_checkers | 2 | GREEN | random play trips the spec's anti-stalling rule → rules-level 'forfeit' result (~59 decisions); replay verifies |
| backgammon | 2 | GREEN | ends by bearoff / gammon-scale scores |
| landlord | 3 | GREEN | variant `{"starting_cash":1000,"turn_limit":75}`; auction + accepted trade steered; resign valve at 620 decisions (snapshot cap, below) |
| islanders | 3 | GREEN | accepted trade + bandit steal steered (both by ~decision 100); ends by points (~400 decisions) or the 620 resign valve |
| misbehavior (A11) | 2 | GREEN | 2-illegal+legal turns, one full 3-illegal forced turn, one timeout; strikes + defaults verified in the log; replay verifies except the known forced-move verifier gap (#9), pinned exactly |

Every green match asserts: commitment logged before the first move and the
reveal after end; `verifyReplay(replay, GAMES)` all-checks-ok; no pre-end
spectator event carries hidden data (secretProbes over every replayed state);
exactly one result agreed across doors; all seats rated on the leaderboard.

## Product gaps found (NOT fixed here — src/ is out of this track's scope)

1. **The pairer is unwired** — `src/match/pairing.ts` has no `cronTick(env)`
   export (the hook `src/api/cron.ts:170` looks for) and nothing else calls
   `runPairingSweep`, so `POST /api/lobby/join` can never produce a game in
   the shipped Worker. The shim supplies the sweep out-of-tree.
2. **No end-of-game D1 persistence** — `GameRoom` (src/rooms/room.ts) never
   writes `games.status/ended_at/result_json/reveal_secret`, `game_log`,
   `spectator_events`, or `private_views` to D1 (T7's integration note asked
   for this), so `/api/games/:id/replay` 409s forever and profiles/checkpoints
   see no data. The shim's finalize sweep supplies it.
3. **Ratings never update** — nothing calls `closeRatingPeriod`/`rate` in the
   product path; leaderboards would stay empty. Shim applies per-game updates.
4. **DO snapshot blob overflows on long games** — `src/rooms/room.ts:151`
   persists the whole `RoomSnapshot` (full log + events + history + views +
   seed draws) as ONE storage value under key `'room'`; it grows ~5.6KB per
   landlord decision and a 3-player 75-round landlord game (~930-1100
   decisions) dies mid-game with `SQLITE_TOOBIG` (observed live at ~780
   decisions ≈ 4.4MB; Cloudflare's documented per-value limit is 2MB, so
   production breaks even earlier). Worse, `submitMove` mutates the in-memory
   core BEFORE `persist` throws, desyncing memory from storage; and when the
   overflow happens inside `alarm()` it can hard-crash the local dev runtime
   (observed once: wrangler exits with an empty ERROR box). E2E works around
   it with shorter variants + a resign valve; the real fix is chunked/append
   -only storage.
5. **R2 replay key mismatch** — the room uploads to `<game_id>.json`
   (src/rooms/room.ts:355) but the API's default lookup is
   `replays/<id>.json` (src/api/handlers.ts:247 `row.replay_r2_key ?? ...`);
   any games-row writer that leaves `replay_r2_key` NULL will miss the blob
   and serve the reduced D1 reconstruction. The shim sets the column to the
   room's actual key.
6. **Game-module events are dropped** — `apply()`'s GameEvents (auction_start,
   trade, stolen, bankruptcy…) go neither into the log payloads nor the
   spectator stream; spectators only get room-level `move` events (with
   notation + public view). Spec §game_kernel_contract says apply returns
   "structured events for the log and the spectator feed". The e2e flags are
   therefore derived from public notations/phases instead.
7. **Live vs D1 event shapes differ** — while a game is live,
   `GET /api/games/:id/events` proxies the room's raw
   `{events:[{seq,type,data,at}],latest_seq}` (no envelope); once ended it
   serves the documented envelope `{ok,data:{events:[{seq,event,created_at}]}}`.
   Clients must handle both (`normalizeEvents` in match.ts does). Also the
   endpoint caps at 500 rows per call — page with `since`.
8. **Move rejections are double-wrapped** — the room's reject body
   `{ok:false,code,message,illegal_attempt?,legal_moves?}` is not under
   `verdict.error`, so the API always maps it to `ROOM_REJECTED` with the
   detail only inside `error.data`; the documented specific codes never
   surface at the top level. (docs/API.md hints at this; clients must read
   `data.code`.)
9. **verifyReplay cannot verify forced-third-illegal moves** — the room logs
   the 3rd illegal attempt of a turn as a `move` entry with
   `payload.forced='illegal'` and `payload.submission` = the REJECTED
   submission (notes/T6.md decision 1), but `src/kernel/verify.ts` (~line
   264) has no `forced` branch: it resolves `submission.move` and fails
   `recomputation` with e.g. "submission index 99999 out of range (7 legal
   moves)" (T1 assumed the penalty would be a `timeout` entry with purpose
   `illegal:turn:N`, notes/T1-kernel.md item 5). Any replay containing a
   forced third-illegal move fails offline verification; the misbehavior e2e
   pins this exact signature and stays strict on
   structure/commitment/final_seed/hash_chain/signatures. Repro:
   `npx vitest run --config test/e2e/vitest.config.ts -t misbehavior`.

## Quirks / decisions

- **Pseudo-drand locally**: the shim's GameFactory records
  `drand_round=1, drand_randomness=sha256Hex('e2e-drand:'+game_id)` instead of
  fetching quicknet — deterministic offline, and `verifyReplay` (correctly)
  treats round+randomness as recorded inputs; nothing in the offline
  verification chain can or should re-fetch drand.
- **Rate limit**: 120 req/min/IP is real and the driver is much faster; the
  client spoofs a per-agent `cf-connecting-ip` AND clears `rl:*` buckets via
  `/e2e/unlimit` on any 429, then retries. Neither touches product behavior
  for real deployments.
- **Unlisted tictactoe**: `GAME_UNLISTED` on lobby join is asserted as correct
  spec behavior; the match then seeds the lobby table directly through the
  shim so the pairer (not any hand-rolled path) still creates the game.
- **Resign valve for landlord** (`resignAfterDecisions`): a legitimate signed
  resignation ending the game with a real `resignation` result once the
  target events are collected — the workaround for gap #4, not a rule hack.
  One resignation ends a 3-player game with the other two as winners (frozen
  T6 semantics).
- **Serialization**: cron-tick sweeps and `/e2e/sweep` share one promise chain
  in the shim, so concurrent ticks cannot double-create games (single-isolate
  assumption of wrangler dev local).
- **Suite timings** (Apple Silicon, local; definitive fresh-state run):
  15/15 tests in 84s total — every M1+M2 game under 4s each, landlord ~27s,
  islanders ~25s, misbehavior ~11s (includes a real 9.5s timeout wait). Avg
  applied-move round trip ~9-12ms over HTTP.
