# Red team: randomness (commit–reveal, seed stream, drand, room seed handling)

Targets: `src/kernel/seed.ts`, `src/crypto/commit.ts`, `src/crypto/chain.ts`,
`src/crypto/drand.ts`, `src/rooms/core.ts` (seed handling), `src/kernel/verify.ts`.
Spec: `identity_and_integrity.randomness`, `game_kernel_contract.seed_stream`, gate A8.

Attack tests (all seeded, no `Date.now` / `Math.random`):

- `test/redteam/red-team-randomness-prediction.test.ts` — attack 1 (predict draws from published data)
- `test/redteam/red-team-randomness-binding.test.ts` — attack 2 (commitment binding, drand, replay tamper)
- `test/redteam/red-team-randomness-seedstream.test.ts` — attacks 3+4 (stream integrity, bias)
- shared fixtures: `test/redteam/red-team-randomness-helpers.ts`

Run: `npx vitest run test/redteam/red-team-randomness-*.test.ts`
Current state: **74 tests, 68 pass (defended / regression guards), 6 fail — each
failing test demonstrates one of the exploitable findings F2–F4 below and must
pass unchanged after the fix.**

> Mid-run note: F1 (the `state_string` deck-order leak) WAS fully exploitable
> when this red team started (demonstrated: `JSON.parse(view.state_string).deck`
> equalled the true hidden saga deck / landlord deckA+deckB for every seated
> player). A builder fix landed in the working tree while this suite was being
> written (`src/kernel/view.ts` now routes hidden-information games through a
> new `game.viewStateString(state, viewer)`; islanders/landlord ship redacted
> encodings). The two F1 attack tests now pass unchanged and stay as the
> regression guard for that fix. F1 below is kept with its as-found analysis.

---

## Exploitable findings

### F1 — CRITICAL (as found; FIXED mid-run, now guarded): `state_string` handed every player the full hidden deck order (future shuffle contents) pre-reveal

The ViewObject sent to a seated agent embeds the FULL game state:
`src/kernel/view.ts:57` (`state_string: game.encodeState(state)`), and the
hidden-information games serialize everything:

- `src/games/islanders/index.ts:67-69` — `encodeState = canonicalJson(state)`
  includes `state.deck` (`src/games/islanders/rules.ts:282`, comment says
  "hidden from everyone": the shuffled 25-card saga deck).
- `src/games/landlord/index.ts:122-124` — `encodeState = JSON.stringify(state)`
  includes the shuffled `deckA`/`deckB` orders (`src/games/landlord/rules.ts:282-283`).

Delivery path: `src/rooms/core.ts:397-408` (`viewFor`) → `src/rooms/room.ts:271`
(served to the agent) → `src/agents/prompt.ts:80` (`STATE: ${view.state_string}`
is literally pasted into the LLM prompt). `JSON.parse(view.state_string).deck`
equals the true hidden deck — every future card draw in islanders/landlord is
known to every player from turn 0. The commit–reveal scheme is bypassed
entirely for shuffle-based hidden information. (`publicView`/`privateView`
redact correctly; spectator events and `publicStateSummary` are clean — the
leak is exclusively `state_string`.)

Attack tests (now passing regression guards): `attack 1c > islanders …`,
`attack 1c > landlord …` (prediction file), plus the spectator-surface check.
Fix that landed mid-run (reviewed, sound): `src/kernel/view.ts` ships
`game.viewStateString(state, viewer)` for `meta.information === 'hidden'`
(empty string when a hidden game defines none — fail closed); islanders
redacts deck + other hands to counts keeping the viewer's own cards; landlord
replaces deckA/deckB with remaining counts. Perfect-information games keep
`encodeState`.

### F2 — HIGH: honest replays fail verification (A8) on two room↔verifier drifts

Gate A8 requires `verifyReplay` to recompute every draw. Two legal, in-policy
game flows produce replays the verifier rejects, so the room can resolve games
whose outcome can never be publicly verified (and a cheater can hide behind
"verification is just flaky"):

1. **Forced third-illegal move.** The room logs the penalty as kind `'move'`
   with the REJECTED submission plus `forced: 'illegal'`
   (`src/rooms/core.ts:702-712`, simultaneous path `:903-914`). The verifier
   re-resolves the move from `payload.submission`
   (`src/kernel/verify.ts:266-272` → `resolveMove` `:88-120`) and fails with
   e.g. `submission notation 'zzz' did not parse`. The verifier's own header
   (`src/kernel/verify.ts:43-47`) documents the OTHER convention (a `'timeout'`
   entry with `purpose: 'illegal:turn:N'`) — T1 and T6 shipped different
   contracts.
2. **Kernel `'#N'` index fallback.** The room resolves `'#7'` as
   `legal_moves[7]` (`src/rooms/core.ts:584-591`); the verifier passes the raw
   string to `game.parseMove` (`src/kernel/verify.ts:96-102`) and fails.

Failing tests: `attack 2e > three illegal attempts …`, `attack 2e > a game
played with the kernel '#N' index fallback …` (binding file). The tests also
pin that hash_chain/signatures/commitment/final_seed DO pass on those replays,
so post-fix they stay meaningful.
Fix direction: either side may move, but both must land on one frozen
convention (verifier understanding `forced`/`#N`, or room logging per the
verify.ts header).

### F3 — MEDIUM: `RoomCore.hydrate` accepts snapshots with a broken commit–reveal binding

`src/rooms/core.ts:314-331` replays `seedDraws` against `snapshot.final_seed`
(good — a tampered draw result throws) but never re-derives
`makeCommitment(game_id, secret)` or
`deriveFinalSeed(game_id, secret, drand_randomness)`. Three accepted forgeries
(all should hard-fail):

- flipped `secret` → game resolves, reveal entry publishes a secret that does
  not match the published commitment; the replay can never verify;
- swapped `commitment` → same;
- fully self-consistent reforge of `drand_randomness` + `final_seed` +
  recomputed `seedDraws` → hydration passes its own check and the room
  continues on randomness that contradicts its already-published log entries.

Storage/DO-layer tampering (or any bug that corrupts a snapshot) therefore
converts silently into unverifiable games instead of a hard stop.
Failing tests: the three `attack 2c > rejects …` cases (binding file).
Fix direction: hydrate re-derives both values and cross-checks
`commitment`/`final_seed`/`drand_randomness` before rebuilding the stream.

### F4 — MEDIUM: nothing enforces "a drand round at or after the commitment time"

Spec `identity_and_integrity.randomness[1]` requires the mixed-in quicknet
round to be at/after commitment time — that ordering is the ONLY thing that
stops the house from grinding `s` against a *known* `drand_randomness` for a
favorable `final_seed` before publishing `C`. `RoomCore.create`
(`src/rooms/core.ts:218-312`) and the DO create handler
(`src/rooms/room.ts:204-217`) accept any `(drand_round, drand_randomness)`
pair; `roundTimeMs` (`src/crypto/drand.ts:63-66`) is available but never
consulted. The offline verifier cannot catch this either: `created_at` is
outside the hash chain and explicitly ignored (`src/kernel/verify.ts:48`), so
house grinding is undetectable after the fact.
Failing test: `attack 2d > create rejects a round whose emission time is far
before the commitment time`; the companion regression test pins that
at-or-after rounds keep working.
Fix direction: `create(nowMs, …)` rejects `roundTimeMs(drandRound) < nowMs`
(small negative slack allowed for clock skew if desired).

---

## Attacked and held (defended — passing tests are regression guards)

- **Pre-reveal secrecy of `secret`/`final_seed`** (attack 1a): scanned every
  surface — log entries, spectator events, `publicStateSummary`, both players'
  views, submit results — mid-game and pre-reveal-log; neither value appears;
  `replayFile()` is null while running. Reveal is strictly after `end` in both
  log and event stream; commitment is entry 0. (API layer, read for context:
  `src/api/handlers.ts:121-124` nulls `reveal_secret` until ended;
  `:240-247` refuses replays pre-end.)
- **Initial-state shuffle draws never enter mid-game logs** (attack 1b): the
  `shuffle:deckA/deckB` and `setup:layout` draws exist only in post-end
  `replay.seed_draws`; move-entry `draws` cover exactly the randomness consumed
  by that already-applied (already-public) move.
- **Published values cannot regenerate the stream** (attack 1d): streams keyed
  on commitment / drand randomness / their hashes / round-number derivations
  never reproduce the actual draw log.
- **A8 tamper half** (attacks 2a/2b): 18 single-field mutations of a genuine
  room-produced replay (commitment, drand_randomness, reveal_secret,
  final_seed, drand_round, submission byte, notation, entry hash, prev_hash,
  signature flip/strip/transplant, initial_state, seed_draws, result, reveal
  payload, truncation, reordering) each hard-fail `verifyReplay`; chain-resealed
  variants are still caught by signatures/recomputation/reveal_after_end; a
  fresh secret with consistently re-derived final_seed still fails the
  commitment check (preimage binding holds). Timeout-path replays
  (`timeout:turn:N`, defaultMove and seeded variants) verify clean.
- **Hydration draw-replay check** (attack 2c-defended): a flipped recorded draw
  result throws `seed draw mismatch`. Malformed secrets are refused at create.
- **drand recording path** (attack 2f): mismatched claimed randomness, bad
  round numbers, malformed/uppercase/short signatures all throw;
  `randomnessMatchesSignature` fails on one flipped byte on either side;
  `roundAt`/`roundTimeMs` are exact inverses with pre-genesis clamping;
  injected-fetch failures propagate. (BLS verification of the signature is
  documented out of scope — the round↔randomness binding rests on online
  recheck against drand relays; acceptable per spec, noted here.)
- **Purpose hygiene** (attack 3a): source audit of every literal draw site in
  `src/games/**` + `src/rooms/core.ts` — no game uses the room-reserved
  `illegal:*`/`timeout:*` purposes; the room uses exactly the frozen
  `illegal:turn:N`/`timeout:turn:N`. Same-purpose draws are separated by the
  per-purpose counter; `p` vs `p#0` style concatenation ambiguity in the HMAC
  input does not collide in practice (tested); commit/seed/move prefix strings
  are domain-separated and (game_id, secret, drand) fields are fixed-width hex
  at the string tail, so `:`-injection cannot forge a colliding preimage.
- **Counter integrity across encode/decode** (attack 3b): a JSON
  snapshot→hydrate round trip mid-game continues the stream byte-identically
  to an unbroken room (identical final replay); double-hydration from the same
  snapshot is deterministic.
- **Stream replay + separation** (attack 3c): fresh stream + same purposes
  reproduces ints/shuffles/bytes/draw-log exactly; a different `game_id` under
  the same secret+drand shares no randomness; interleaving other purposes never
  shifts a purpose's own sequence (verifier stability).
- **Rejection sampling & bias** (attacks 4a-4c): domain errors on
  0/negative/float/NaN/`2^32+1`; `2^32` ceiling exact (threshold = 2^64, no
  rejection, full range); `bytes()` DoS bounds; independent `node:crypto`
  reimplementation of the documented algorithm agrees byte-for-byte on
  rejection-heavy ranges (`3`, `2^31+1`, `2^32-1`), Fisher–Yates, and block
  concatenation; chi-square screens (10k d6, 10k d7, 6k 3-perms, ceiling mean/
  top-bit, worst-case-rejection halves) all comfortably uniform.

## Observations (no test, for the record)

- `snapshot()` returns the live internal object (`src/rooms/core.ts:333-337`);
  any caller mutation corrupts the room. Internal-only today (`room.ts`
  persistence), but a defensive deep-copy would be cheap.
- With F4 unfixed, note the compounding: `created_at` is unhashed and
  unsigned, so even a vigilant auditor cannot reconstruct commit-vs-round
  ordering from a replay alone; fixing F4 at create time is what makes the
  fairness claim real.
