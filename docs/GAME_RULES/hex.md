# Hex (`hex`)

Two players, perfect information, no randomness. Connection game on a
rhombus of hexagons; no draws are ever possible in Hex (a mathematical
property of the game, not a rule choice — exactly one player will always
have a connected path once the board fills).

## Board and setup

11x11 default (variants: 7x7, 13x13). Columns `a`..`k` (default size),
rows `1`..`11`. `p0` connects the two opposite sides labeled by columns
(left column-edge to right column-edge); `p1` connects the two opposite
sides labeled by rows (top row-edge to bottom row-edge). The board is a
rhombus, so the render staggers each row to show the true hex adjacency
(each cell touches up to six neighbors, not four).

## Notation

A move is the coordinate of the empty cell to place a stone on:
`a1`..`k11` (or `..g7`/`..m13` under the smaller/larger variants), plus
the special move `swap`, legal for `p1` only, only as the reply to `p0`'s
very first move.

Examples:
- `f6` — the center cell on the 11x11 board, a common opening move.
- `a1` — a corner cell.
- `swap` — `p1` takes over `p0`'s first move and color instead of
  playing their own stone (the pie rule — see below); this appears in
  `legal_moves` only on `p1`'s first turn, alongside every empty-cell
  placement.

## Rules

- Players alternate placing one stone of their color on any empty cell.
  Stones never move and are never captured or removed.
- **Swap (pie) rule**: because the first player in Hex has a
  significant advantage, `p1`'s first move may instead be `swap`,
  claiming `p0`'s already-placed first stone and effectively becoming
  the player who made the strong opening move, while `p0` becomes the
  second player from that point on (seat labels `p0`/`p1` do not change
  — the color/side association does). This is why `p0`'s literal first
  move is deliberately not something to obsess over strength-wise from
  `p0`'s perspective: playing too strong a first move invites a swap;
  the balancing act is the entire point of the rule.
- A player wins the instant their two assigned sides are connected by an
  unbroken chain of their own stones through adjacent hexes — the game
  does not wait for the board to fill.

## End conditions

- **Connection made** — `reason: "connection"`, the connecting player the
  sole winner. This is the only way a Hex game with legal play ends;
  there is no draw, no stalemate, no other terminal condition.
- A defensive `turn_limit` backstop exists at the room level (the board
  has a finite number of cells, so a game cannot exceed that many plies),
  but should never actually trigger under correct rules, since the board
  filling completely always produces a winner by the connection property.

## Variants and defaults

| variant | values | default |
|---|---|---|
| `board_size` | `7`, `11`, `13` | `11` |

## Traps for LLM players

- **"No draws are possible" is a genuine LLM discriminator** — a model
  that doesn't understand Hex's connection-game structure sometimes
  plays as if blocking is symmetric with connecting (as in tic-tac-toe or
  connect-drop); in Hex, blocking your opponent's connection **is**
  connecting your own, because the board's topology guarantees exactly
  one side wins.
- **The swap rule only ever appears as a legal move for `p1`, only on
  `p1`'s very first turn.** A model playing `p0` should expect its first
  move might vanish from the game in that sense (get "taken over" by
  `p1`'s swap) and should not read that as an engine bug.
- Row/column adjacency in Hex is **not** a standard 4-neighbor grid — the
  ASCII render staggers rows specifically so the six true neighbors of
  any cell are visually adjacent to it; don't reason about connectivity
  from an unstaggered mental grid.
