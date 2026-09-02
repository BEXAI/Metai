# Checkers (`checkers`)

Two players, perfect information, no randomness. Default variant: English
draughts, 8x8. Variant: international draughts, 10x10.

## Board and setup (English default)

8x8, played on the dark squares only, numbered 1-32 in the traditional
English-draughts numbering (row by row from one player's back rank).
`p0`'s 12 men start on squares 1-12, `p1`'s 12 men start on squares 21-32;
squares 13-20 are the empty middle rows. `p0` moves first.

```
   1   2   3   4
 5   6   7   8
   9  10  11  12
13  14  15  16
  17  18  19  20
21  22  23  24
  25  26  27  28
29  30  31  32
```
(schematic — the ASCII render ships full rank/file context; this table
exists only to show the numbering direction.)

## Notation

Square numbers with `-` for a simple move and `x` for a capture (jump);
multi-jumps are a single move with each landing square chained by
another `x`:

Examples:
- `11-15` — a simple non-capturing move from square 11 to 15.
- `23x14` — a single jump, capturing the man on the square between 23 and
  14.
- `11x18x25` — a double jump: from 11, capturing over to 18, then
  immediately capturing again over to 25, all in one move (mandatory
  multi-jump — see below).

## Rules (English draughts, 8x8 default)

- **Men** move diagonally forward only, one square at a time, onto an
  empty square.
- **Capture** is diagonal, jumping over an adjacent enemy piece onto the
  empty square immediately beyond it, removing the jumped piece.
- **Captures are mandatory**: if any legal capture exists for the player
  to move, only capturing moves are legal that turn — a non-capturing
  move is illegal even if it looks like the "obviously better" move.
- **Multi-jump chains are mandatory to complete**: if, after landing from
  a jump, a further jump is available from the new square with the same
  piece, the move is not over — the full chain must be taken as one move.
  `legalMoves` enumerates only complete chains (`11x18x25`, not `11x18`
  as a separate legal stopping point when `x25` was available).
- **Kings**: a man reaching the opponent's back rank becomes a king and
  moves/captures diagonally in all four directions (backward as well as
  forward) from then on.
- **Draw conditions**: 40 moves without a capture or a man's advance
  (kings shuffling with no progress is the classic case this catches), or
  threefold repetition.

### International variant (10x10)

- Board is 10x10; each side starts with 20 pieces.
- **Flying kings**: a king moves any distance along a diagonal (like a
  bishop), not just one square, and can capture a piece any distance away
  as long as the landing square beyond it is empty and the path to the
  captured piece is otherwise clear.
- **Majority-capture rule**: when multiple different capture sequences
  are available, only the sequence(s) that capture the **greatest number
  of pieces** are legal — a shorter capture is illegal if a longer one
  exists, even though both are "a legal jump" in isolation.

## End conditions

- **No legal moves for the player to move** (all pieces blocked or
  captured away) — `reason: "no_moves"`, the other player wins.
- **Down to zero pieces** — the same result via the same mechanism (zero
  pieces trivially has no legal moves).
- **Draw**: 40 moves without capture or man-advance, or threefold
  repetition — `draw: true`, `reason: "forty_move_rule"` or
  `"threefold_repetition"`.

## Variants and defaults

| variant | values | default |
|---|---|---|
| `board` | `english_8x8`, `international_10x10` | `english_8x8` |

## Traps for LLM players

- **Mandatory capture is the rule most likely to trip up a model or a
  naive engine.** `legal_moves` never includes a quiet move when any
  capture is available — if a model "wants" to make a quiet move in that
  position, it is simply not a legal option and will be rejected.
- **Multi-jump chains must be enumerated and submitted whole.** A model
  that submits only the first hop of a mandatory double-jump is
  submitting an incomplete move, not a legal one — `legal_moves` only
  ever contains the complete chain as a single entry (`11x18x25`), so
  picking by index avoids constructing a partial chain by hand.
- **International majority-capture** silently removes shorter captures
  from `legal_moves` even when they are otherwise valid single jumps —
  don't assume every diagonal jump you can see on the board is one of
  this turn's legal moves; only the longest available chain(s) are.
- Test suites specifically target known tricky positions for mandatory-
  capture enumeration and multi-jump chains — see
  `src/games/checkers/tests/`.
