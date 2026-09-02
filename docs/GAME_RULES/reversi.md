# Reversi (`reversi`)

Two players, perfect information, no randomness. 8x8 flipping game.

## Board and setup

8x8, files `a`-`h`, ranks `1`-`8`. Standard starting position: the four
center squares `d4`, `e5` one color, `d5`, `e4` the other, in the
crisscross pattern (`d4`/`e5` = `p1`'s discs, `d5`/`e4` = `p0`'s discs, or
the mirror — the render always shows exactly what's on the board, so
treat this paragraph as background, not something to memorize). `p0`
moves first.

```
8 . . . . . . . .
7 . . . . . . . .
6 . . . . . . . .
5 . . . O X . . .
4 . . . X O . . .
3 . . . . . . . .
2 . . . . . . . .
1 . . . . . . . .
  a b c d e f g h
```

## Notation

A move is the coordinate of the empty square you place a disc on:
`a1`..`h8`, plus the literal move `pass` when no legal placement exists.

Examples:
- `d3` — a common early flanking move from the starting position above.
- `f5` — another.
- `pass` — submitted only when `legal_moves` contains nothing else (see
  below); never a free choice when a real move is available.

## Rules

- A legal move must **flank** at least one opposing line: placing a disc
  such that one or more straight (horizontal, vertical, or diagonal)
  lines of the opponent's discs are immediately bounded by the new disc
  on one end and one of your own discs already on the other end. Every
  opposing disc in every such flanked line is flipped to your color as
  part of the same move.
- If the player to move has **no legal flanking placement anywhere on the
  board**, their only legal move is `pass` — `legal_moves` contains
  exactly that one entry in this situation, never an empty list (an empty
  `legal_moves` while a player is in `playersToMove` would violate the
  kernel contract).
- Play continues, alternating, with passes handled the same way for
  either side.

## End conditions

- **Neither player has a legal move** (both would have to pass in
  succession) or **the board is completely full** — the game ends,
  `reason: "no_moves"` or `"full_board"`.
- Whoever has **more discs of their color** on the board at that point
  wins; equal counts is a draw. `scores` on the result carries each
  player's final disc count.

## Variants

None at launch — one board size, one ruleset.

## Traps for LLM players

- **Passing is not a strategic option to choose freely** — it only
  appears in `legal_moves` when it is the only legal entry. A model that
  tries to submit `pass` while a real flanking move exists gets rejected
  as an illegal move.
- **A placement that doesn't flank anything is illegal**, even on an
  otherwise-empty square — reversi has no "just place a disc" move; every
  legal move flips at least one opposing disc. Don't assume any empty
  square is playable; trust `legal_moves`.
- Counting discs by eye from `board_text` to judge "who's ahead" is
  notoriously misleading mid-game in reversi (the leader on disc count
  often loses once corners flip) — use `public.scores` (if the game
  exposes a running count) rather than eyeballing the render for anything
  that matters to a decision.
