# Track T4b-boards — hex, nine_mens_morris, chinese_checkers

Owner paths: `src/games/hex/`, `src/games/nine_mens_morris/`, `src/games/chinese_checkers/`.
All three are perfect-information, zero-randomness games: **no SeedStream draws anywhere**
(the `seed` parameters of `initialState`/`apply` are accepted and ignored; seat 0 always
moves first). Gate A10 (leakage) is vacuous for these modules: `privateView === publicView`.

Layout per game: `rules.ts` (pure rules + codec), `notation.ts` (parse/summary),
`render.ts` (ASCII), `index.ts` (default-exports the `Game<S, M>`), `tests/`.
**Moves are their canonical notation strings** in all three games (`Game<State, string>`),
so `moveToNotation` is the identity and legal lists are self-describing.
`playersToMove`/`legalMoves` return `[]` on terminal states; `apply` validates by
membership in the enumerated legal list (bulletproof against drift).
Last test run: `npx vitest run src/games/hex/tests src/games/nine_mens_morris/tests src/games/chinese_checkers/tests` — 58/58 green, ~2s.
Typecheck: `npx tsc --noEmit` shows zero errors in owned paths.

## hex

- Variants: `size` ∈ {7, 11, 13}, default 11 (invalid size throws in `initialState`).
- Cells `a1`..(e.g.)`k11`, row-major; **p0 = 'X' connects North (row 1) to South (row N);
  p1 = 'O' connects West (column a) to East (last column)**. Adjacency `(c±1,r)`, `(c,r±1)`,
  `(c+1,r-1)`, `(c-1,r+1)`; render is the classic staircase, consistent with that adjacency.
- **Pie rule, steal-the-move convention** (documented choice): exactly on ply 2 (one stone
  on the board, p1 to move) p1's legal list ends with the extra move `'swap'`, which flips
  the first stone's ownership **in place** (no mirroring); edge assignments never change;
  p0 moves next. `swap` is never offered again.
- Canonical move order: empty cells row-major (a1, b1, … row by row), then `swap` last.
- Win detection: union-find with 4 virtual edge nodes, recomputed in `isTerminal` (cheap).
  No draw path exists; playout fixture asserts `draws === 0` and reason `connection` only.
- Codec: `size|board|toMove|moveCount|swapUsed|lastMove` (`-` = null lastMove).

## nine_mens_morris

- Point order (board string index) = `POINTS` alphabetical: a1,a4,a7,b2,… (d4 not a point).
  16 mill lines, adjacency lists sorted ascending — all canonical orders derive from these.
- Notation: place `d1`, slide/fly `d1-d2`, removal suffix `xd6`; a mill-forming move and
  its removal are ONE move (one legal entry per removal candidate).
- Removal preference: unmilled men first; if every opponent man is milled, any man.
  A mill formed when the opponent has zero men on the board (contrived placing-phase edge)
  is a bare move with no `x` suffix. A simultaneous **double mill removes one man**
  (topology makes double mills possible only in the placing phase — every neighbour of a
  point lies on one of its mill lines; tested); re-forming a mill (oscillation) removes again.
- Phases: placing (9 men each) → moving (adjacent) → flying at exactly 3 men (any empty).
  `phase` is stored explicitly; flying is derived from the on-board count.
- Loss: total men (board+hand) ≤ 2 → `reduced`; player to move with no legal move
  (moving phase) → `blocked`. Draw: threefold repetition of (board, toMove) in the moving
  phase → `repetition` (history resets on removal; keys are board+seat strings kept in
  state); 50 consecutive moving-phase plies without a mill → `fifty_moves` (`quiet` counter).
- Codec: `board|toMove|ih0,ih1|p/m|quiet|moveCount|lastMove|historyCSV`.

## chinese_checkers

- **Labeling (document for agents/UI):** DOUBLED coordinates. Rows 1 (top apex, `m1`) to
  17 (bottom apex, `m17`); columns letters a=1..y=25; row widths 1,2,3,4,13,12,11,10,9,…
  centred on column m. Neighbours `(c±2,r)`, `(c±1,r±1)`; jumps land at twice that. The
  spec's example `d5` does not exist under this scheme (row 5 has odd columns a,c,e,…,y);
  same idea, different valid labels — `parseMove` gives a precise error for non-holes.
- **Seat → start triangle** (goal is always the opposite): 2p `[N,S]`; 3p `[N,SE,SW]`;
  4p `[N,NE,S,SW]`; 6p `[N,NE,SE,S,SW,NW]` (clockwise). 5 players → `initialState` throws
  (meta says min 2 / max 6; rooms must not offer 5 seats).
- Moves: step `m3-l4`, jump chain `d5-f7-h9` (over exactly one adjacent peg of any colour
  into the empty hole beyond; may stop at any landing), or `pass` — **only** present when
  a player has no other move (blocked players are never stuck; pass counts as one of their
  own moves). Enumeration: per peg, steps sorted by destination index, then jump endpoints
  via **BFS over the static jump graph** (pegs are never removed, so reachability is
  path-independent → global visited set is both the explosion cap and the dedupe-by-endpoint;
  each endpoint keeps its BFS-shortest path as canonical notation). The origin counts as
  empty during a chain. A step and a chain to the same hole dedupe to the step.
- `parseMove` accepts ANY physically valid jump path and canonicalizes it to the enumerated
  representative with the same origin+endpoint; `apply` accepts canonical strings only.
- Anti-stall (spec-exact interpretation, documented): a move may not END in the mover's own
  start triangle unless it also STARTED there (shuffling inside before leaving is legal;
  passing through mid-chain is legal); after a player's 30th own move, if any of their pegs
  is still in their start triangle they forfeit (checked after every move ≥ 30; re-entry
  being impossible makes this equivalent to checking at exactly 30). Forfeited players keep
  their pegs on the board as frozen obstacles and are skipped in the rotation; last active
  player wins by `forfeit`. Round counter (1-based) increments when the turn wraps to a
  seat ≤ the mover's; **round > 200** ends the game: active players ranked by pegs in goal,
  all tied at the top are winners with `draw: true` when more than one (shared placement),
  reason `turn_limit`, `scores` = pegs-in-goal for every seat. Filling all 10 goal holes
  wins immediately (`goal`).
- Codec: `n|board121|toMove|round|movesByCSV|forfeitBits|lastMove|moveCount` (`*` = null lastMove).
- **Honest playout note:** uniformly random players essentially never vacate their start
  triangle within 30 moves, so random playouts end almost exclusively by forfeit cascade
  (2p ≈ 59 plies, p1 wins; 6p ≈ 180 plies, usually p5). That is the rule set working as
  specified, not a bug; `goal` and `turn_limit` endings are covered by crafted fixtures.
  This also means CC playouts are fast (200 games ≈ 0.3 s).

## Integration must know

- Exported API surface = the default `Game` export per folder (registry untouched);
  rules internals (`enumerate*`, codecs, `HOLES`, `POINTS`, `MILLS`, `TRIANGLE_HOLES`, …)
  are exported from each `rules.ts` for tests/red-team use.
- `defaultMove` is intentionally absent in all three → rooms apply the seeded-random
  timeout policy (`purpose 'timeout:turn:N'`), which is always legal here since legal
  lists are never empty on a live turn (CC guarantees `pass`).
- Legal-list sizes stay far below 5,000 (hex ≤ 170; nmm ≤ ~250 worst-case flying×mills;
  cc observed ≤ ~600), so `legalMovesPaged` is not needed.
- Terminal states: `playersToMove` and `legalMoves` return `[]`; `apply` returns
  RuleError `game_over`.
