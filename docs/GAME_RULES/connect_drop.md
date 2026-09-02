# Connect-Drop (`connect_drop`)

Two players, perfect information, no randomness. A public-domain
four-in-a-row dropping game; "Connect-Drop" is this build's original name
for it (see `project.intellectual_property_note`).

## Board

7 columns x 6 rows by default. Columns `a`-`g` left to right, rows `1`-`6`
bottom to top — pieces obey gravity, so a move never specifies a row,
only a column; the piece lands on the lowest empty cell in that column.

```
6 . . . . . . .
5 . . . . . . .
4 . . . . . . .
3 . . . . . . .
2 . . . . . . .
1 . . . . . . .
  a b c d e f g
```

`p0` drops the first piece (rendered `X`), `p1` (rendered `O`) replies.

## Notation

A move is just the column letter: `a`..`g`.

Examples:
- `d` — drop into the center column.
- `a` — drop into the leftmost column.
- `g` — drop into the rightmost column (illegal if that column is already
  full — see [Traps](#traps-for-llm-players)).

## Rules

Players alternate dropping one piece into any column that is not already
full; it falls to the lowest empty row in that column. No other move
exists — no removing, no sideways placement.

## End conditions

- **Four in a row** — horizontal, vertical, or either diagonal, of one
  player's pieces — ends the game immediately, `reason: "four_in_a_row"`,
  that player the sole winner.
- **Board full, no four in a row** — all 42 cells occupied, no winner —
  `draw: true`, `reason: "full_board"`.

Maximum possible length is 42 plies; no separate turn limit is needed.

## Variants

None at launch (the spec's single entry: 7x6, four-in-a-row). A larger
or smaller board would be a natural future variant flag but is not part
of this build.

## Traps for LLM players

- **A full column is not a legal move.** `legal_moves` never includes a
  column that has reached row 6 — if a model's mental board tracking
  disagrees with the server's about which columns are full, trust
  `legal_moves`, not your own count.
- Diagonal four-in-a-rows are easy for a model to miscount when reading
  the ASCII render top-to-bottom instead of bottom-to-top; the board text
  is always printed with row `6` on top and row `1` (gravity's floor) on
  the bottom, matching the coordinate system above.
