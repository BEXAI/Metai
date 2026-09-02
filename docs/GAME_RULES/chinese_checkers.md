# Chinese Checkers (`chinese_checkers`)

2, 3, 4, or 6 players, perfect information, no randomness.

## Board

The standard 121-hole hexagram ("star") board: a central hexagon of 61
holes surrounded by 6 triangular arms of 10 holes each (1+2+3+4 rows per
triangle). Each player is assigned one triangular arm to start in and the
**opposite** arm as their goal.

Seat-to-triangle assignment by player count (the standard convention, so
every player's goal triangle sits directly across the board from their
own start, never adjacent to it):

- **2 players**: opposite pair of triangles.
- **3 players**: every other triangle around the hexagram (3 of the 6,
  none adjacent to another player's start).
- **4 players**: 4 of the 6 triangles, leaving one opposite pair empty,
  chosen so every occupied triangle's opposite is also occupied (so
  every player has a real goal triangle rather than an empty arm with no
  opponent to interact with there).
- **6 players**: all six triangles occupied; every player's goal is the
  triangle directly opposite their own.

Each player starts with **10 pegs**, filling their start triangle
completely.

## Notation

Holes are labeled by an axial coordinate rendered as a short label (e.g.
`d5`); a move is either a single step (`from-to`) or a chain of jumps
written as a dash-separated path through every landing hole in order.

Examples:
- `d5-d6` — a single non-jumping step to an adjacent empty hole.
- `d5-f7` — a single jump over one adjacent occupied hole, landing on the
  empty hole immediately beyond it.
- `d5-f7-h9` — a jump chain: from `d5`, jump to `f7`, then immediately
  jump again from `f7` to `h9`, all as one move, as long as each
  individual hop is a legal jump over a single occupied hole onto an
  empty landing hole.

## Rules

- On your turn, move exactly one of your pegs either:
  - **one step** to any adjacent empty hole (any of the up-to-6
    directions on the triangular grid), or
  - **a chain of jumps**, each hop jumping over one adjacent occupied
    hole (yours or an opponent's — jumped pegs are never removed; this
    is not a capturing game) onto the empty hole immediately beyond it
    in a straight line, and continuing the chain from the new hole for
    as long as further jumps are available and the player chooses to
    keep jumping.
- A single step and a jump chain are mutually exclusive within one move
  (a move that starts as a step cannot also jump; a move that starts with
  a jump may continue jumping but never mixes in a plain step).
- **Anti-stalling rule**: a peg may **never re-enter its own player's
  start triangle** once that player has vacated it (i.e. once no pegs of
  that player remain in the start triangle, none may move back in) — this
  prevents a player from shuffling a peg in and out of "safety" to run
  out the clock. Additionally, **a player who has not vacated their start
  triangle within 30 of their own moves forfeits** the game outright.
- **Turn limit**: 200 rounds (one round = every seat has moved once). If
  reached with no winner, the game ends by tiebreak: the player with the
  **most pegs already in their goal triangle** wins; further ties break
  by... (see the game track's fixture tests for the exact secondary
  tiebreak; the spec fixes "most pegs in goal" as the primary rule).

## End conditions

- **Filled the opposite triangle**: the instant a player has all 10 of
  their pegs inside their assigned goal triangle, they win immediately —
  `reason: "goal_filled"`. In games with more than 2 players, other
  players continue playing for remaining placings unless the game ends
  the moment a first winner is decided (see the game track's exact
  multi-player continuation rule).
- **Anti-stall forfeit**: a player who never vacates their start triangle
  within 30 of their own moves is removed from contention —
  `reason: "stall_forfeit"`.
- **Turn limit reached**: `reason: "turn_limit"`, most pegs in goal wins.

## Variants and defaults

| variant | values | default |
|---|---|---|
| `players` | `2`, `3`, `4`, `6` | `2` |

## Traps for LLM players

- **Jump-chain enumeration can explode combinatorially** if implemented
  naively (a peg near the board's center can sometimes chain through
  many pegs in several different orders reaching several different
  endpoints). The engine caps this search with a visited-hole set and
  dedupes chains by final endpoint — `legal_moves` presents one entry
  per *reachable endpoint*, not one entry per possible *path* to a
  shared endpoint, so don't expect to choose among multiple routes to
  the same final hole; the engine picks a canonical one.
- **Jumped pegs are never removed** — this is not checkers or draughts;
  every peg, yours and every opponent's, stays on the board for the
  whole game. A model reasoning about "material" the way it would in
  checkers is reasoning about the wrong game.
- **You cannot retreat into your own vacated start triangle** — a model
  that tries to "camp" a peg back home to stall is submitting an illegal
  move once the triangle has been vacated, not a legal defensive one.
- **The 30-own-move stall clock is per player, counted in that player's
  own moves, not total game turns** — in a 4- or 6-player game this is a
  much longer wall-clock stretch than "30 turns of the game," which
  matters when reasoning about how much time is left to vacate safely.
