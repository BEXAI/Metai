# T1-kernel — track notes

## Exported API (new in this track)

- `src/kernel/verify.ts` — `verifyReplay(replay: ReplayFile, games: Record<string, AnyGame>): VerifyReport`.
  Pure (no network, no Date). Named checks, in report order: `structure`,
  `commitment`, `final_seed`, `hash_chain`, `signatures`, `game_module`,
  `recomputation`, `result`, `seed_draws`, `reveal_after_end`. Never throws;
  a check that throws internally is reported as failed with the message.
  - Deviation from PLAN.md's one-arg sketch: takes the games registry as a
    second parameter (per the track brief) so the browser verifier (T9) and
    tests can inject game modules. Callers: `verifyReplay(replay, GAMES)`.
- `src/kernel/tests/fixture-game.ts` — test-only helpers (not registry games):
  `fixtureGame` ("fixture_nim", 2p, seeded first player + d6 per move),
  `buildFixtureReplay()` (complete signed 2-move ReplayFile, deterministic),
  `fixtureKeypair(label)`, `signMoveMessage(key, gameId, turnIndex, body)`,
  `rehashLog(replay)` (re-seal a tampered chain, for negative tests).
- `test/verify-replay.ts` — CLI: `node --experimental-strip-types
  test/verify-replay.ts <replay.json>`; prints the report, exit 1 on any failed
  check, exit 2 on usage/read errors. Merges `fixture_nim` into GAMES so
  fixture replays verify pre-integration (id cannot collide with a real game).

## Payload refinements T6 (rooms) MUST match — replay.ts untouched

replay.ts's payload comments are informal; verify.ts pins them down:

1. **Log ordering**: `entry.seq === array index` starting at 0; exactly one
   `commitment`, `start`, `end`, `reveal`; commitment before start before the
   first move/timeout; `end` second-to-last, `reveal` last.
2. **Signed body**: for `move` entries the Ed25519 signature is over the frozen
   move message with `sha256Hex(canonicalJson(payload.submission))` — the exact
   MoveSubmission the agent sent. For `resign`/`draw_offer`/`draw_accept` the
   body is `payload.submission` when present, else the payload itself
   (`{ turn_index, player }`). `turn_index` in the message comes from
   `payload.turn_index`. Signed kinds must have a signature; all other kinds
   must have `signature: null`.
3. **Move re-resolution**: verifier resolves `submission.move` itself —
   notation via `parseMove`, `{ index }` into `legalMoves` canonical order (so
   rooms must resolve indexes against the same canonical order they shipped in
   legal_moves). If a room additionally logs the resolved move as
   `payload.move`, it must deep-equal the re-resolved move (signature pins the
   submission; a substituted move fails `signatures` and/or `recomputation`).
4. **Move payload checks**: `submission.game_id === replay.game_id`,
   `submission.turn_index === payload.turn_index`, `payload.notation ===
   moveToNotation(move, stateBefore)`, `payload.state_hash ===
   hashState(stateAfter)`, `payload.draws` deep-equals the SeedDraw slice made
   during that entry (pick draw included for penalty moves, see 5).
5. **Timeout/illegal penalties** are logged as `timeout` entries.
   `payload.purpose` selects the seed purpose; default `timeout:turn:N`
   (N = payload.turn_index). Third-illegal-move penalty uses
   `purpose: 'illegal:turn:N'`. Recomputation rule: if `game.defaultMove`
   exists and purpose is not `illegal:*`, the move is
   `defaultMove(state, player, legal)` (no draw); otherwise
   `legal[seed.int(purpose, legal.length)]` (one int draw, part of
   payload.draws). `payload.applied_notation` = notation of the applied move.
6. **start payload**: `initial_state_hash` must equal hashState of the state
   recomputed by `initialState(freshSeedStream(final_seed), players, variant)`
   — i.e. rooms must create the seed stream once and use that same stream for
   initialState and all subsequent draws. `start.game`, `start.variant`,
   `start.ruleset_version` must match the replay header fields.
7. **result**: `end.result` deep-equals `replay.result`; `end.final_state_hash`
   matches the recomputed final state. If `isTerminal(finalState)` is non-null
   it must deep-equal `replay.result`; otherwise the last
   resign/forfeit/adjudication/draw_accept entry explains it (resign: no draw,
   resigner not a winner; forfeit: forfeiter not a winner; draw_accept: draw).
8. **seats**: seat i must be player `p{i}` in order. `replay.seed_draws` must
   equal the full recomputed draw log. `created_at` is ignored (not verifiable
   offline).

## Seed-draw purposes used by kernel-owned code

- `pick` — playout harness move picker (separate picker stream, not game seed).
- `timeout:turn:N` / `illegal:turn:N` — penalty-move pick (frozen policy,
  PLAN.md); drawn from the game seed stream, recomputed by verify.ts.
- Fixture game only: `first` (initialState), `dice:turn:N` (per move).

## Decisions / deviations

- Hash-chain verification is implemented directly in verify.ts from the frozen
  constants in replay.ts rather than importing T2's `chain.ts`, to keep the
  verifier's dependency surface at exactly replay.ts + canonical.ts +
  ed25519.ts (T9 compiles it for the browser). Signature verification DOES go
  through `src/crypto/ed25519.ts#verifyEd25519` (landed by T2, matching the
  promised signature).
- The CLI imports `src/kernel/tests/fixture-game.ts` (test helper) on purpose —
  documented above; remove nothing at integration, real games shadow nothing.
- `buildView` >5000 guard: throws only when `legalMovesPaged` is absent;
  entries are truncated to `maxMoves` (default 5000) when it is present —
  matches view.ts as written in stage 0 (unchanged).
- No in-place fixes were needed in the frozen files (types.ts, replay.ts,
  seed.ts, hash.ts, stub.ts, view.ts, leakage.ts, playout.ts — all untouched).

## Test status at track close

- `npx vitest run src/kernel/tests` — 3 files, 27 tests, all green
  (seed golden vectors, view/guard, verify + tamper + CLI spawn).
- `LUDUS_PLAYOUTS=25 npx vitest run test/determinism.test.ts
  test/playouts.test.ts` — green; 11 games skipped as stubs at run time, `hex`
  (T4, already landed) ran for real: 25 playouts, avg 109.4 moves, all
  terminating by connection.
- `test/no-stubs.test.ts` — run once, FAILS as intended listing the 11
  outstanding stubs; excluded from this track's green expectation until all
  game tracks land (end-of-stage-1 gate).
- Gate runs later: `LUDUS_PLAYOUTS=1000` for A1; A2 cross-runtime half reuses
  `finalHashOfPlayout` in stage 4.
