# T5a — backgammon track notes

Status: complete. 34 tests green (`npx vitest run src/games/backgammon/`), zero tsc errors in `src/games/backgammon/`.

## Files

- `src/games/backgammon/rules.ts` — pure rules: board/turn model, hop legality, full-turn DFS enumeration, scoring, seed flow.
- `src/games/backgammon/notation.ts` — `turnNotation` / `parseTurn` / `turnSummary`.
- `src/games/backgammon/render.ts` — viewer-perspective ASCII board.
- `src/games/backgammon/index.ts` — default-exports `Game<BgState, BgMove>`; `meta.listed = true`.
- `tests/fixtures.test.ts` (32) + `tests/playouts.test.ts` (2).

## State & move model

- `BgState.points`: 24 absolute points (index = point − 1), `+n` = p0 checkers, `−n` = p1. p0 moves 24→1; p1's relative point r = absolute `25 − r`. `bar`/`off` are `[p0, p1]` pairs. Plain JSON, no undefined.
- One move object = one COMPLETE turn: `{ hops: [{from, to, die}, ...] }` in **mover-relative** numbers, `25` = bar, `0` = off. Empty `hops` is the explicit no-play (dance) move — always present when nothing is playable, so the playout harness never sees a blocked mover without a move.
- `state.dice` is the full roll for the turn about to be played (2 sorted desc, 4 for doubles); never partially consumed in persisted state because a move is a whole turn.

## Seed-draw purposes

- `dice:open:a` / `dice:open:b` — opening die per player in `initialState`; ties re-roll both (per-purpose counters advance). Higher roller starts and plays those two dice.
- `dice:turn:N` — two `die()` draws at the END of `apply` for the NEXT turn index N (doubles ⇒ four dice stored). Not drawn when the applied move ends the game.

## Turn legality / enumeration (gate A5)

DFS over every die ordering and origin; a sequence is complete when no remaining die is playable. Then: keep max-length sequences (must use both dice / all four doubles when any ordering allows); if max length is 1 with distinct dice and the larger die has any play, keep only larger-die plays; bar entry priority and bear-off (all home; overshoot only from the highest occupied point) are enforced per hop.

**Canonical dedupe (documented deviation detail):** key = sorted multiset of `(from,to)` pairs + sha256 of the resulting board. Die assignment is intentionally NOT in the key: with dice 6-5 and lone checkers on 2 and 1, `2/off 1/off` is one turn whichever die takes which checker (same board), and `apply` accepts any die assignment whose simulation is legal and whose key is in the legal set. Distinct routes to the same board (`bar/20 20/17` vs `bar/22 22/17`) have different multisets and stay distinct moves, per the build-spec dedupe rule. Canonical list order = sorted by dedupe key (deterministic, locale-free).

`apply` validates by strict re-simulation of the submitted hops + key membership in the enumerated legal set, so non-maximal turns, wrong-die plays, bar violations, and bear-off violations are all rejected (`illegal_hop` / `incomplete_turn`).

## Notation

Emit: hop groups sorted bar-first / `from` desc / `to` asc, identical hops grouped `13/11(2)`, hits starred `13/8*`, `6/off`, `bar/22`, `(no play)`. Parse accepts: compact parenthesized, fully expanded, single-checker runs (`24/18/15`), `*` ignored (recomputed), commas or spaces, and `no play`/`dance`/`pass`. Matching is by `(from,to)` multiset against the enumerated legal turns — die assignment never needs spelling out. Index fallback (`#7`) correctly rejected (kernel-level concern).

## Scoring

Winner = first to 15 off. `result.scores` carries the multiplier: 1 (`reason: 'bearoff'`), 2 gammon (loser bore off none, `'gammon'`), 3 backgammon (additionally a loser checker on the bar or in the winner's home, `'backgammon'`); loser scores 0.

## Variants — declared but unimplemented (per task instruction)

- `cube` (doubling cube): declared with `values: [false]`, default `false`; `initialState` throws on `cube: true`. Implementing it needs a cube-decision phase before each roll — left for a later ruleset version.
- `matchTo` (match play to N points, spec mentions 5): declared with `values: [1]`, default `1`; throws otherwise.

## Safety valve

`TURN_LIMIT = 2000` turns ⇒ draw `'turn_limit'` so playouts provably halt (`apply` skips the next roll at the limit). Random-playout reality: avg ≈ 97 turns, max seen 215, **0 draws in 260 games** — real games never approach it.

## Integration notes

- Perfect information: `privateView === publicView`; no leakage probes needed (gate A10 n/a).
- `legalMovesPaged` implemented (slice of full list, pageSize 1000) as belt-and-braces; normal positions are well under 5,000 turns.
- `encodeState`: `bg1|turn|turnIndex|dice|bar|off|points|lastMove` (`~` = null lastMove); exact hash round-trip checked by harness every 50 moves and in tests.
- Events from `apply`: public `turn` ({player, notation, dice, hits, borne_off}) and public `dice` ({player, turn, dice}) for the next roll.
- `moveSummary` provided (e.g. "plays 13/8* 13/10, hitting 1 blot").
- No `defaultMove` — timeout policy's seeded random legal move is fine (dance positions have exactly one legal move anyway).
- 200-game playout suite runs in ~12 s locally; the global 1000-game gate A1 should take ~1 min for backgammon.
