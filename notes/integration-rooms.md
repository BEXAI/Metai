# Rooms-side integration (stage 4 fixes) — BUILDER-R

Fixes for e2e findings #2, #4, #5, #6 (notes/e2e-driver.md) inside
`src/rooms/**`. 26 room tests green (`npx vitest run src/rooms/tests`),
`tsc --noEmit` clean on owned paths.

## 1. Chunked DO storage (finding #4 — SQLITE_TOOBIG)

The monolithic `'room'` snapshot value is gone. `GameRoom` now persists:

- `'core'` — bounded record `{ v: 2, snap (RoomSnapshot minus every unbounded
  array), counts }`. `counts` = `{ log_count, ev_count, hist_count, sd_count,
  sd_chunks, pv_floor }`; reassembly slices each row family to these counts so
  orphan rows from a crashed oversized batch are ignored.
- `'log:<seq8>'` / `'ev:<seq8>'` / `'hist:<idx8>'` — one immutable row per
  log entry / spectator event / history entry, written once on creation.
- `'sd:<chunk8>'` — the SeedDraw delta of each persist as one chunk.
- `'pv:<turn8>:<player>'` — per-turn private views, pruned to the last
  `PV_RETAIN_TURNS = 8` turns (exported from core.ts). RoomSnapshot's
  `privateViews` field became `privateViewsByTurn: Record<turn, Record<player,
  view>>` (nothing outside src/rooms read the old field).
- Legacy `'room'` blobs migrate on first wake (hydrate normalizes the old
  shape, rewrites chunked, deletes the blob; crash-safe — the blob stays
  authoritative until `'core'` lands).

**Desync-proof ordering**: every mutation is followed by ONE multi-entry
`storage.put({new immutable rows…, core})` — atomic per the DO storage
contract (≤128 keys; oversized deltas fall back to immutable-rows-first
batches with `'core'` last, protected by count-slicing). Watermarks advance
and events broadcast only after the put succeeds; on failure the DO drops its
in-memory core (`resetMemory`) and returns 500 `persist_failed` — the next
request rebuilds from storage, so the submission effectively never happened.
`alarm()` failures never throw: docket-style structured log + best-effort D1
docket row + retry alarm (+5 s).

`RoomSnapshot.replay` was removed; `core.replayFile()` assembles the
ReplayFile on demand after end (it duplicated the whole log — half the blob).

## 2. End-of-game D1 finalization (finding #2)

`GameRoom.finalize(core)` runs on every end path (result / forfeit / resign /
draw — `handleMove`, `handleTick`, `alarm()` all call it when
`core.status === 'ended'`), guarded by a persisted `finalized` flag in the
core snapshot (exactly-once):

1. R2 upload of the replay to **`replays/<game_id>.json`** (finding #5's key
   fix — matches the API default `row.replay_r2_key ?? 'replays/<id>.json'`).
   R2 failure never blocks finalization (D1 reconstruction serves).
2. D1 via `env.DB` (new optional structural binding `RoomDb` on `RoomEnv`;
   the real D1Database satisfies it): a `games` **UPSERT** (INSERT … ON
   CONFLICT(id) DO UPDATE) setting `status='ended', ended_at, result_json,
   reveal_secret, replay_r2_key` — insert path fills game/variant/division/
   commitment/seats_json/etc. so finalize survives a lost pairing-time
   insert; conflict path touches only end-of-game columns (season_id stays
   the pairer's). Plus `game_log`, `spectator_events` (full event object as
   `public_event_json`), and `private_views` rows (retained window only, see
   above; `view_json` = game.privateView per seat per turn). All INSERT OR
   REPLACE, batched via `db.batch` in chunks of 50.
3. Only then `markFinalized()` + persist. D1 failure → docket row + retry
   alarm (+5 s); an ended-but-unfinalized room always keeps a retry alarm
   pending (syncAlarm), so finalization completes even across crashes.
4. **Ratings hook** (finding #3, T8 interface contract): after successful
   finalize, `applyGameRatings(env, gameId)` from `src/match/ratings.ts` —
   loaded lazily (a ratings-layer problem can never break finalization) and
   wrapped in try/catch (failure logs, never un-finalizes; applyGameRatings
   is itself idempotent via its rated_games claim). Since ratings takes the
   ApiEnv shape, the room adapts its raw env at the call boundary: passes
   bindings through and fills `now()/fetchFn/secrets/games` only when absent
   (so an ApiEnv-bearing caller keeps its own injectables).
   `setRatingsHookForTests(fn|null)` swaps the hook for room unit tests.

## 3. Game-module events (finding #6)

`apply()` GameEvents are no longer dropped: `move` and `timeout` log payloads
carry `payload.events` (the full entries, with `visibility`, when non-empty),
and the `visibility:'public'` ones are emitted live to spectators as
`game:<type>` events with data `{ turn_index, player, data }`. Private events
exist only in the log → replay (post-end). Verifier impact: additive payload
field only — chain hashes are computed over the payload as logged, and
verify.ts ignores unknown fields (red-team + kernel suites re-run green).
T9 note: new spectator event types `game:*`; `data.data` is game-authored
JSON — render escaped like everything else.

## Interface notes for the match builder (T8/pairing side)

- The room's `/create` contract is unchanged; games-row creation at pairing
  time still owns `season_id` (and may leave `replay_r2_key` NULL — finalize
  sets it to `replays/<game_id>.json`).
- Duplicate-tolerant: if the pairing insert already wrote the games row, the
  finalize UPSERT only flips the end-of-game columns.
- `applyGameRatings` may also be invoked by sweeps; the room calls it exactly
  once per game after finalize, and swallows (logs) any error.

## Test coverage added (src/rooms/tests/)

- `room-persistence.test.ts` (9): chunked round-trip (fresh instance ==
  pre-sleep room, verifiable finish), flat core-value growth, legacy-blob
  migration, failed-move-persist recovery (500, nothing applied, same signed
  submission then succeeds, seqs contiguous), alarm-path failure (no throw,
  retry alarm, exactly-once timeout), full finalize row shapes (games binds,
  game_log mirror of the replay, spectator_events, private_views incl. probe,
  R2 key, ratings call) + exactly-once across tick/restart/alarm, D1-failure
  retry via alarm, throwing ratings hook doesn't un-finalize, public-only
  `game:*` emission with a private-event probe (probe reaches the log/replay,
  never the live feed).
- `helpers.ts`: MockStorage (atomic multi-put, list, delete, failure
  injection), MockBucket, recording FakeDb (batch + failure injection).
- mini-game now emits a public `played` event AND a private `peek` event
  carrying the seat's secret probe (A10 pressure on the new event path).
