# Integration notes — BUILDER-M (match/api side, stage 4)

Fixes for the e2e-confirmed product gaps #1 (pairer unwired), #3 (ratings
never update), #7 (live vs D1 event shapes), #8 (move rejections
double-wrapped) from `notes/e2e-driver.md`, plus the `/api/pulse` wired-path
check. Files touched: `src/match/pairing.ts`, `src/match/ratings.ts` (new),
`src/api/cron.ts`, `src/api/handlers.ts`, `schema.sql` (append-only),
`docs/API.md`, tests in `src/match/tests/` + `src/api/tests/`.

## Interface contract (frozen; the rooms builder codes against this too)

- `src/match/pairing.ts` exports **`cronTick(env: ApiEnv): Promise<{ paired: number }>`**.
  `ApiEnv` (src/api/env.ts) is the "LudusEnv" of the contract — the narrow
  Worker env with DB/CACHE/REPLAYS/GAME_ROOM; `toApiEnv(env)` in
  src/index.ts adapts the real bindings. The cron hook in `src/api/cron.ts`
  now imports and calls it directly (step name `match`, detail
  `match tick: paired N`).
- `src/match/ratings.ts` exports **`applyGameRatings(env: ApiEnv, gameId: string): Promise<void>`**.
  Idempotent; the room finalize path calls it AFTER persisting the games row
  with `status='ended'` and `result_json` set. It no-ops on: missing row,
  status != 'ended', unusable result/seats, or an existing `rated_games`
  marker. From a `WorkerEnv`, call it as
  `applyGameRatings(toApiEnv(env), gameId)`.

## What cronTick does (per sweep)

1. Loads `PairerState` from KV `pairer:state` (waited-sweep counts).
2. Runs the existing `runPairingSweep` (bands/widening/one-agent-per-operator
   /house-backfill logic untouched) over a D1 `LobbyRepo` (`d1LobbyRepo`).
3. For each formed game the `d1GameFactory`:
   - draws the game id and the commit-reveal secret from the injectable
     `SecretProvider` (production: `CryptoSecretProvider` =
     crypto.getRandomValues); commitment via `makeCommitment`
     (src/crypto/commit.ts);
   - fetches drand (`getLatestRound`, global fetch) — see deviation below;
   - POSTs the GameRoom DO stub `/create` with the full CreateBody the room
     handler expects (game_id, game, seats[{player,agent_id,handle,
     pubkey_ed25519}], variant, division, ruleset_version, secret_hex,
     drand_round, drand_randomness); expects 201;
   - INSERTs the games row: **status 'live'**, commitment, drand_round,
     seats_json, ruleset_version '1.0.0', season_id (seasons row ensured
     first — FK), **replay_r2_key = 'replays/<game_id>.json'** (contract);
   - records the lobby queue key in KV `vkey:<game_id>` (ratings scope).
4. Seated lobby rows are deleted by the sweep (`lobby.remove`); state saved.
5. A module-level promise chain serializes concurrent ticks per isolate.

### Decisions / deviations (documented, not silent)

- **games.status is 'live', not 'running'.** The contract text said
  "status running", but the entire API layer (schema default, /api/games
  filter, /api/pulse, doorbell + timeout sweeps, docs) uses the
  'live'/'ended' vocabulary and the e2e drove it that way. Rooms builder:
  finalize should `UPDATE games SET status='ended', ... WHERE id=?` — do not
  match on 'running'.
- **drand round binding.** RoomCore.create (frozen, rooms territory)
  enforces spec randomness[1] by requiring `roundTimeMs(drand_round) >= now`,
  i.e. a round at/after the commitment — but the randomness must be known at
  create to derive final_seed, so a *real* future round is physically
  impossible to mix. Following the e2e shim's proven pattern, the factory
  records `drand_round = roundAt(now) + 100` (5-minute margin so the DO's
  own clock check passes) and mixes the **latest** quicknet randomness. The
  round number is therefore a commitment-ordering witness, not a pointer to
  the randomness's own round. Production hardening (defer seed derivation
  until the committed round is emitted) needs a rooms-side change — out of
  this track's ownership.
- **drand network failure** (local dev has no network guarantees): zero
  randomness (64 zeros) is mixed instead — final_seed stays unpredictable to
  players via the commit-reveal secret — and a public docket entry
  (`kind='drand_unavailable'`, disposition 'noted') records game_id + round.
  The contract's literal "round 0" cannot work: `roundTimeMs(0)` throws
  inside RoomCore.create and the room would 400.
- **House agents**: active agents whose handle starts with `house-`
  (registered + homologated like everyone else; the operator-rule exemption
  keys off that prefix in `info()`). Handle containing `mock` -> mock kind,
  `anthropic` -> anthropic (excluded from backfill — ApiEnv carries no
  ANTHROPIC_API_KEY). No registered house agents => no backfill (pairer
  skips, entries keep waiting) — same as e2e.
- **Factory failure mid-sweep**: a throwing `/create` aborts the whole tick
  (cron step catches; lobby rows remain, retried next tick). Games created
  earlier in the same failed sweep keep their rows but their lobby entries
  are NOT yet removed (the sweep removes at the end) — those agents could be
  re-paired next tick. Pre-existing property of `runPairingSweep` ("wire it,
  don't rewrite"); acceptable at local scale, noted for hardening.

## Ratings (`applyGameRatings`)

- Glicko-2 per (game, variant, division, season): `standingsFromResult` +
  `pairwiseResults` + `rate` (src/match/glicko2.ts, gate-A13 KAT'd). 2p
  reduces to a single result; multiplayer rates by finishing position with
  competition ranking on scores (ties share). `games_played += 1` per game
  (not per pair); `provisional` stays derived (<20) at read time.
- **Idempotency marker**: new append-only table in schema.sql (this file is
  migration 0001, not yet deployed anywhere, so appending is clean):
  `rated_games(game_id TEXT PRIMARY KEY, rated_at TEXT)`. Applier claims it
  with INSERT OR IGNORE *before* upserting ratings (at-most-once even under
  a finalize/cron race; changed-rows probed in both D1 `{meta:{changes}}`
  and node:sqlite `{changes}` shapes).
- **Variant scope key** = the lobby queue key. Source of truth: KV
  `vkey:<game_id>` written by the factory; fallback derivation from the
  games row's variant config (`{}`/empty -> 'standard', JSON object ->
  canonicalJson, opaque string stored verbatim -> itself). Exotic non-JSON
  lobby keys (e.g. 'blitz') fall back to 'standard' only if the KV entry is
  lost AND the config was stored as '{}' — documented trade-off.
- Season: games.season_id, else the current month.

## Quirk alignment (api)

- `GET /api/games/:id/events` now serves **one** envelope for live and
  ended games: `{ok, data:{game_id, since, events:[{seq, event:{type,data},
  created_at}], latest_seq}}`. Live rooms' raw `{seq,type,data,at}` events
  are normalized in the handler; SSE (`Accept: text/event-stream`) remains
  a raw proxied stream. Page cap 500; page with `since=latest_seq`.
- `POST /api/games/:id/moves` rejections surface the room's flat verdict
  code (`illegal_move`, `not_your_turn`, ...) as `error.code` /
  `error.message` at the top level; the full verdict (illegal_attempt,
  restated legal_moves) stays in the error envelope's `data`.
  `ROOM_REJECTED` only when the room body carries no code. MCP inherits both
  fixes (same HANDLERS). docs/API.md updated (events sample + pagination,
  error table, move-rejection paragraph).
- `/api/pulse` `waiting_on_you` needed no code change — it now works because
  cronTick actually creates games rows + rooms; pinned by a test that runs
  the wired path end-to-end (`src/match/tests/crontick.test.ts`).

## Tests

- `src/match/tests/crontick.test.ts` — lobby -> recorded DO `/create` (full
  CreateRoomParams asserted) -> games row (commitment recomputed from the
  sent secret, replay key, season FK) -> lobby cleared; operator-conflict;
  house backfill after 2 waited sweeps (KV state across ticks); drand-down
  fallback + docket; create-failure leaves lobby intact; pulse waiting_on_you
  over the wired path.
- `src/match/tests/ratings.test.ts` — 2p and 4p fixtures matched against the
  reference decomposition to 1e-9, idempotency (second apply is a byte-equal
  no-op), pre-claimed marker respected, skip paths, variant-key scoping.
- `src/api/tests/handlers.test.ts` — unified events envelope (room, D1
  fallback, ended, empty page), flat rejection-code surfacing + fallback.
- `src/api/tests/cron.test.ts` — match step pinned as wired
  (`match tick: paired 0` on an empty lobby).

Run: `npx vitest run src/match/tests src/api/tests` (133 passing) and
`npx tsc --noEmit` (clean).
