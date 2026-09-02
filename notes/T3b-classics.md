# Track T3b-classics — tictactoe, connect_drop, checkers, reversi

Status: complete. All four modules replace their stubs with full `Game<S, M>` implementations
(rules.ts / notation.ts / render.ts / index.ts / tests/ per game). All colocated tests green;
`npx tsc --noEmit` reports nothing for these folders.

## Seed-draw purposes

None. All four games are perfect-information and randomness-free; `initialState` and `apply`
never touch the SeedStream. (The playout picker draws come from the harness, not the games.)

## Move types (plain JSON)

| game | Move type | notation |
|---|---|---|
| tictactoe | `string` cell | `a1`..`c3` (col a-c, row 1-3 from the BOTTOM) |
| connect_drop | `string` column | `a`..`g` |
| checkers | `number[]` square path | `11-15` quiet, `11x18x25` jump chains (one `x` per capture) |
| reversi | `string` cell or `'pass'` | `a1`..`h8` (row 1 at the TOP, Othello convention) + `pass` |

For the three string-move games `moveToNotation` is the identity and `parseMove` is a
trim/lowercase + syntax check. Checkers `parseMove` validates square range per variant and
separator discipline (quiet = exactly `from-to`; jumps = all `x`); legality is checked by
`apply` (kernel contract: parse is syntax-only).

## Decisions / conventions

- **Seats**: p0 always moves first. tictactoe/connect_drop: X = p0. reversi: Black (B) = p0.
  checkers english: Black = p0 (official — Black moves first), White = p1; checkers
  **international: White = p0** (official — White moves first), Black = p1. `seatOfColor()` in
  `src/games/checkers/rules.ts` is the single mapping point.
- **Reversi orientation**: row 1 at the top (standard Othello), so the classic Black openings
  are exactly `d3 c4 f5 e6` and White's replies `c3 e3 c5` — both asserted in fixtures.
- **Checkers geometry**: dark squares numbered 1..32 / 1..50 left-to-right, top-to-bottom;
  square 1 at (row 0, col 1); dark squares where (row+col) is odd. Black always on the
  low-numbered squares moving down (+row), White moving up, in both variants. Verified against
  the standard English move table (1→5,6; 4→8; 21→17; 24→19,20).
- **Checkers chain enumeration**: DFS over a working board where jumped pieces are marked dead
  (`#`) — they block squares and cannot be jumped twice; removal happens when the chain
  completes (matters for flying-king lines). Only **maximal** chains are emitted. English:
  every maximal chain is legal (no majority rule); a man landing on the crowning row ends the
  chain immediately (crowned) even if a king-jump could continue. International: majority
  filter keeps only maximum-capture chains (men/kings count equally); men capture backward;
  flying kings capture at distance with every landing square beyond the victim enumerated as a
  separate move; a man passing through the crowning row mid-chain is NOT crowned (crowns only
  if the move ends there).
- **Checkers draws**: `quietClock` counts plies since the last capture or man move; draw at 80
  (= 40 moves by each side), reason `forty_move_rule`. Threefold repetition of
  `board + sideToMove` since the last irreversible ply, reason `threefold_repetition`; the
  `rep` table lives in the state (JSON object) and is cleared on every capture/man move, so it
  stays ≤ 80 entries. isTerminal precedence: threefold, then 40-move, then no-moves
  (player to move with no legal move loses, which also covers "no pieces left").
- **Canonical move order**: board-index order (tictactoe/reversi row-major, connect_drop a..g,
  checkers paths sorted lexicographically by square numbers). Reversi `pass` is legal ONLY
  when no flanking move exists (then it is the single legal move); game ends after two
  consecutive passes or a full board, result carries a `scores` table, reason `most_discs`.
- **encodeState**: compact custom strings, every state field encoded (round-trip is
  hash-exact; playout harness checks every 50 plies). Checkers embeds the rep table as sorted
  `key:count` pairs. tictactoe `board toMove moveCount lastMove`; connect_drop columns
  bottom-up joined by `/`; reversi `board64 toMove passes moveCount lastMove`.
- **renderText** is viewer-independent (perfect information): grid + coordinates + legend +
  last move + one-line status. Checkers cells show occupant+square number (`b12`, `.16`) so
  agents can map the numeric notation without counting squares.
- **Events**: connect_drop `drop`; reversi `place` (with flip count) / `pass`; checkers
  `capture` (squares) and `crown`. All public. tictactoe emits none.
- `moveSummary` implemented for all four (kernel view attaches it to legal_moves entries).
- `defaultMove` deliberately omitted — seeded-random-legal on timeout is correct for all four
  (reversi's forced pass is the only legal move when it applies, so random picks it anyway).

## Hand-verified checkers fixtures (in tests/checkers.test.ts)

1. mandatory single capture 14x23 (quiet move rejected with code `capture_mandatory`)
2. other pieces frozen while any capture exists
3. double jump 13x22x31 ending in crowning
4. **triple jump 6x15x24x31** as one complete move
5. king quiet both ways + king backward capture 23x16
6. English free choice among maximal chains: 10x17x26 AND 10x19 both legal
7. English crowning-by-capture stops the chain (11x2, continuation over 6 forbidden)
8. **international flying-king capture** 46 over 37 with all 7 landing squares
9. international majority rule: 28x19x10 only; 28x17 rejected (`not_maximal_capture`)
10. international backward man capture 28x37
11. international pass-through-crowning-row man stays a man (11x2x13)
12. flying king quiet slides (8 landings, blocked by enemy)
plus threefold-repetition and 80-quiet-ply draw sequences and quiet-clock reset cases.

## Integration notes

- Default exports are `AnyGame` (via cast); state/move TS types re-exported from each
  `index.ts` (`TttState`, `DropState`, `CheckersState`/`CheckersVariant`, `ReversiState`).
- checkers meta.variants: `ruleset: english | international` (default english). Others: none.
- `tictactoe` meta.listed = false; the other three are listed.
- RuleError codes used: `game_over`, `not_your_turn`, `bad_move`, `occupied` (ttt/reversi),
  `column_full` (drop), `no_flank`, `pass_illegal` (reversi), `illegal_move`,
  `capture_mandatory`, `not_maximal_capture` (checkers).
- Playout sanity (random play): ttt avg ~7.7 plies; drop ~21; reversi ~60 (always
  `most_discs`); checkers english ~70 plies mostly `no_moves` with occasional
  `threefold_repetition`; international ~99 plies.
- Tests: 200 playouts each for tictactoe/connect_drop/reversi, 200 english + 100
  international for checkers, plus `finalHashOfPlayout` determinism (both checkers variants).
