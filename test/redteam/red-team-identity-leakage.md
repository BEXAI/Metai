# Red team: identity & leakage — findings memo

Team: `red-team-identity-leakage`
Targets: `src/crypto/ed25519.ts`, `src/rooms/core.ts` (submitMove auth), `src/identity/`,
`src/api/` (challenge auth, registration, homologation), private/hidden data paths everywhere.
Spec: `identity_and_integrity`, `llm_player_protocol.move_submission`, `api.write_signed`,
`data_model.rules`, acceptance A9/A10.

Test files (all attacks assert the DEFENDED behavior; a failing test = live hole):

| File | Tests | Status |
|---|---|---|
| `red-team-identity-leakage-move-forgery.test.ts` | 17 | all pass (defended) |
| `red-team-identity-leakage-room-private.test.ts` | 8 | **3 FAIL (exploitable)**, 5 pass |
| `red-team-identity-leakage-api-private-paths.test.ts` | 10 | all pass (defended) |
| `red-team-identity-leakage-homologation.test.ts` | 13 | all pass (defended) |
| `red-team-identity-leakage-challenge-auth.test.ts` | 17 | all pass (defended) |

Run: `npx vitest run test/redteam/red-team-identity-leakage-*.test.ts`

---

## F1 — CRITICAL, EXPLOITABLE: `state_string` in live views ships the FULL hidden state to every seated player

**The hole.** `buildView` (`src/kernel/view.ts:54`) sets
`state_string: game.encodeState(state)` on every ViewObject. For
hidden-information games `encodeState` is the *complete* state:

- landlord: `encodeState = JSON.stringify(state)` (`src/games/landlord/index.ts:122`)
  → includes `deckA` / `deckB`, i.e. the full hidden event-deck order.
- islanders: `encodeState = canonicalJson(state)` (`src/games/islanders/index.ts:67`)
  → includes every player's `hands`, unplayed `progress` (saga) cards, **and
  the entire shuffled saga `deck` order**.
- mini fixture: `JSON.stringify(state)` → both players' secret probes.

`RoomCore.viewFor` (`src/rooms/core.ts:397`) passes this straight through, the
`GameRoom` DO serves it at `GET /view/:player`, and the API serves it to the
seated agent at `GET /api/games/:id/view` (also `legal_moves` shares the same
fetch). So **any seated agent, using only its own fully-authorized view,
reads every opponent hand, every unplayed card, and the exact future deck
order, live**. No signature forgery needed; this beats the commit-reveal
scheme entirely (why verify the reveal when the deck order is in your view?).

**Why A10 didn't catch it.** The gate-A10 harness (`src/kernel/leakage.ts`)
inspects `publicView`, `privateView`, and `renderText` — never `encodeState`
and never the assembled `buildView` output. The games all pass their leakage
suites while the room leaks everything. That harness gap should be closed by
whoever fixes this (scan the whole ViewObject).

**Demonstrated by (currently failing):**
- `room viewFor: cross-player hidden data (mini fixture) > p0's live view never contains p1's secret`
- `room outputs: landlord deck order > no seat's live view contains the event-deck order`
- `room outputs: islanders hands and saga cards > p1's and p2's live views never contain p0's hand or saga cards`

**Suggested fix direction** (builders' choice): give `Game` a viewer-safe
encoding for hidden-information games (e.g. `encodeState(state, viewer)` or a
redacted `stateString` hook), or have `buildView` substitute a redacted
encoding whenever `meta.information === 'hidden'`. The three tests above must
pass unchanged after the fix. Note perfect-information games (chess FEN etc.)
are fine and must keep their state_string.

Independent confirmation: the randomness red team's `attack 1c` tests fail on
the same root cause.

## F2 — defended: spectator/public channels carry no hidden data pre-end

Spectator events (`RoomCore.eventsSince`), `publicStateSummary`, and the
hash-chained log's public serving path were scanned with the games' own
`secretProbes` across driven landlord play, hydrated islanders states with
real hands, and mini-fixture games: no probe, no commit secret, no
`final_seed` before the `end` event; `reveal` event strictly after `end`.

## F3 — defended: live replays are unreachable

`RoomCore.replayFile()` is null until ended. `GET /api/games/:id/replay`
returns 409 for a live game **even when the R2 blob already exists** and
**even when game_log rows (including a `reveal` row) already sit in D1** —
and serves normally once `status='ended'`.

## F4 — defended: `reveal_secret` column never joins a public response pre-end

A live `games` row with `reveal_secret` already populated serves `null` on
detail and listing (plus no replay link); after end it serves the secret.

## F5 — defended: `private_views` storage is owner-scoped

The room-down D1 fallback of `/view` returns only the caller's stored view
(keyed by authenticated `agent_id`); the other seat's stored view never
appears, and stored private views never surface on public game endpoints.

## F6 — defended: view seat binding comes from the signature

`?player=p0` and similar query params are inert — the room is asked for the
authenticated agent's own seat only. Unseated-but-authenticated agents get
403 `NOT_SEATED` with zero room calls; unauthenticated get 401.

## F7 — defended: move forgery/replay/tamper family (A9)

Room-level (`RoomCore.submitMove`) and API-level: replay on a later turn /
different game / different seat, signing with a different registered key,
every single-field body mutation (move, commentary, resign, draw_offer,
turn_index, injected extras), malformed signatures (empty, truncated,
overlong, non-hex, all-zero, bit-flipped), signatures over nine near-miss
message constructions (missing prefix, wrong version, pipe separators,
non-canonical body hash, hash including the signature, ...), past/future/
negative/fractional/string turn indexes, and double submission (sequential
and simultaneous) are all rejected; exactly one move per turn is logged.

## F8 — defended: homologation (A9 second half)

Changing any of model_id / system_prompt_sha256 / config_sha256 / tool_access
/ endpoint_url / adapter_kind mid-season voids the previous entry
(`voided_at` set) and mints a NEW hash; identical re-filing is idempotent
(no void, no new row). The stored hash and `fields_json` byte-match a
hand-built `sha256(canonicalJson)` over EXACTLY the eight spec fields in
sorted key order. Boundary-shift / null-vs-"null" / swapped-hash field sets
do not collide; body key order and smuggled extra fields cannot perturb the
hash. `NOT_YOUR_AGENT` blocks homologating another agent; a voided division
homologation no longer admits rated lobby play; pure division refuses
`tool_access: 'engine-assisted'`.

## F9 — defended: challenge auth (`src/identity/auth.ts`)

Single-use enforced (exact replay and fresh-signature reuse both 401
`CHALLENGE_SPENT`; a replayed signed move request reaches the room exactly
once); expiry enforced on both the KV-TTL path and the recorded-`exp` path
(stale entry deleted on rejection); wrong key → `SIG_INVALID` **without**
burning the challenge for its rightful owner (deliberate: forgeries can't
DoS the owner; Ed25519 brute force is infeasible; failures are logged per
gate A9); challenges are handle-scoped; the signature binds method, path,
and exact body bytes (one flipped byte inside commentary kills it); every
write_signed route hard-401s without headers. Registration verifies
possession of the key in the body (`SIG_INVALID` otherwise), enforces
one-handle-per-key (409), and header/body handle equality (401).

## F10 — defended: Ed25519 signature malleability

The `(R, s + L)` twin of a valid signature (group-order addition, classic
malleability) is rejected by `verifyEd25519` (noble ZIP215 enforces s < L)
and by a live room on a real move.

---

## Informational notes (no test, no current exploit)

1. **Late-move grace window.** `RoomCore.submitMove` never checks
   `deadlineAtMs`; a move arriving after the deadline but before the DO
   alarm/cron tick fires is accepted at full validity. Distributed-clock
   tolerance, but worth an explicit decision (an agent colluding with a slow
   ticker gains thinking time; cumulative clocks do record the overage).
2. **DO trust boundary.** `GameRoom` endpoints (`/view/:player`, `/replay`,
   `/create`, `/move`) are unauthenticated by design — the Worker is the
   auth gate. Anything else that ever gets a route to the DO namespace
   inherits full read access to private views. Documented in room.ts; keep
   the namespace binding exclusive to the Worker.
3. **Query strings are unsigned.** The challenge signature covers the
   pathname only (documented). No authenticated route currently derives
   authority from query params (F6 proves `/view` ignores them); preserve
   that invariant when adding routes.
4. **Registration challenge namespace.** Challenges are issued for any
   well-formed handle without existence checks — fine today (single-use,
   5-minute TTL, rate-limited), just noting the KV growth vector.
