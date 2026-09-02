# Fixes for red team: identity & leakage

Attack suite: `test/redteam/red-team-identity-leakage-*.test.ts` (5 files, 65 tests — all green).
Memo: `test/redteam/red-team-identity-leakage.md`. No attack test was edited.

## F1 (critical) — `state_string` in live views shipped the full hidden state

**Root cause:** `src/kernel/view.ts:54` (as found) set
`state_string: game.encodeState(state)` on every assembled ViewObject.
`encodeState` is defined as the round-trippable FULL state
(`src/kernel/types.ts:193`), so for hidden-information games it carries
everything:

- landlord `encodeState = JSON.stringify(state)`
  (`src/games/landlord/index.ts:122` as found) → full hidden `deckA`/`deckB`
  event-deck order.
- islanders `encodeState = canonicalJson(state)`
  (`src/games/islanders/index.ts:67` as found) → every player's `hands`,
  unplayed `progress`/`bought` saga cards, and the entire shuffled saga
  `deck` order.

`RoomCore.viewFor` (`src/rooms/core.ts:397`) passed this through to the
`GameRoom` DO `GET /view/:player` and `GET /api/games/:id/view` (and the
`legal_moves` fetch), so any seated agent read all hidden information live
from its own authorized view — defeating commit-reveal with zero forgery.

**Contributing gap:** the gate-A10 harness (`src/kernel/leakage.ts`)
inspected `publicView` / `privateView` / `renderText` but never `encodeState`
nor the assembled `buildView` output, so every game passed leakage while the
wire leaked everything.

**Fix** (landed in commit `f03b9bb`, shared root cause with the randomness
red team's attack 1c; verified complete by this pass):

- `src/kernel/types.ts`: optional `Game.viewStateString?(state, viewer)` hook
  — a viewer-safe compact state encoding for hidden-information games
  (`encodeState` stays the full round-trippable encoding for replay/verify).
- `src/kernel/view.ts` (`buildView`): when `meta.information === 'hidden'`,
  `state_string` is `game.viewStateString?.(state, player) ?? ''` — a hidden
  game without the hook ships NO state string rather than the full state.
  Perfect-information games keep raw `encodeState` (chess FEN etc. unchanged).
- `src/games/landlord/index.ts` (`viewStateString`): drops `deckA`/`deckB`,
  ships `deckA_remaining`/`deckB_remaining` counts (deck order is hidden from
  everyone including the viewer).
- `src/games/islanders/index.ts` (`viewStateString`): viewer keeps their OWN
  hand/progress/bought; every other player collapses to counts; the saga
  `deck` collapses to `deck_remaining`.
- `src/kernel/leakage.ts` (A10 harness closed): `inspect` now also assembles
  the FULL ViewObject via `buildView` for every opponent seat and scans its
  `canonicalJson` for every owner probe — any future game whose assembled
  wire view (state_string included) leaks another player's secret fails its
  own leakage suite.

**Verification (this pass):**

- `npx vitest run test/redteam/red-team-identity-leakage-*.test.ts` → 65/65
  green, including the 3 previously-failing room-private tests (mini-fixture
  cross-player secret, landlord deck-order probes in all seats' views,
  islanders p0 hand/saga probes in p1/p2 views with the own-hand sanity
  check).
- Remaining failures under `test/redteam/` are exclusively
  `red-team-injection-*` / `red-team-liveness-*` files — other teams' scope.
- Neighborhood suites: `npx vitest run src/kernel src/rooms src/api
  src/games/landlord src/games/islanders` → 29 files, 251 tests green
  (includes the landlord/islanders A10 leakage suites that now exercise the
  extended harness).
- `LUDUS_PLAYOUTS=25 npx vitest run test/playouts.test.ts` → 15/15 green
  (encodeState round-trip untouched).
- `npx tsc --noEmit --pretty false` → zero errors repo-wide.

**Grep audit:** no other live-serving path uses `encodeState` — remaining
call sites are `src/kernel/playout.ts` (test-harness diagnostics/round-trip
check, never served) and `src/kernel/stub.ts` (throws).
