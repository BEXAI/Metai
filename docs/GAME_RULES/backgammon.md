# Backgammon (`backgammon`)

Two players, perfect information *of the board*, **dice randomness**
(`meta.randomness: "dice"`) drawn from the seeded stream inside `apply`
so every roll is recomputable from `final_seed` after the game ends.

## Board and setup

24 points, each player owns 15 checkers, standard starting position.
**Point numbering is from each mover's own perspective**: both players
call their own farthest point `24` and their own home board `1`-`6`,
moving from `24` toward `1` and bearing off once all 15 checkers are in
their own `1`-`6`. This means the same physical point on the board has a
different number depending on which seat is asking — the view you
receive is always numbered from *your* perspective, which is exactly how
a human player at a physical board reads it too.

## Notation

Point numbers from the mover's own perspective, `/` for a single
checker's move, `bar` for entering from the bar, `off` for bearing off. A
full turn (see [Legal moves](#legal-moves-are-full-turns) below) is
written as the sequence of individual checker moves that use the turn's
dice, separated by spaces.

Examples:
- `24/18` — moving one checker six points, from the 24-point to the
  18-point.
- `13/11` — moving one checker two points.
- `bar/22` — entering a checker from the bar onto the 22-point (rolled a
  3: entering uses `25 - die` as the landing point in this perspective,
  since the bar itself is effectively point 25).
- `6/off` — bearing a checker off from the 6-point (only legal once all
  15 of that player's checkers are in their home board, points 1-6).

A full turn combines these, e.g. rolling `6-3` might produce the turn
`24/18 13/10` (two separate checkers, one per die) or `24/18/15` (one
checker using both dice in sequence, 24 to 18 with the 6, then 18 to 15
with the 3) — both are different legal turns for the same roll and both
appear as separate entries in `legal_moves` when both are legal.

## Rules

- **Dice**: two dice per turn, drawn from the seed stream
  (`purpose: 'dice:turn:<n>'`, verifiable in the replay like every other
  seeded draw). Rolling **doubles plays four moves** of that die's value
  instead of two.
- **Movement**: each checker moves in its owner's fixed direction
  (`24` toward `1`) by exactly the pips shown on a die, landing only on a
  point that is empty, holds only the mover's own checkers, or holds
  exactly one opposing checker (a "blot").
- **Hitting**: landing on a point with exactly one opposing checker sends
  that checker to the bar; a point with two or more opposing checkers is
  closed and cannot be landed on.
- **Entering from the bar**: a player with any checker on the bar
  **must enter it before making any other move**; entering uses a die to
  land on the corresponding point in the opponent's home board (see
  notation example above) and fails for that die if the target point is
  closed (occupied by two or more opposing checkers); a player who cannot
  enter with either die forfeits movement for the whole turn.
- **Bearing off**: once all 15 of a player's checkers are in their own
  home board (points 1-6), they may bear checkers off using a die that
  exactly matches a checker's point, or, if no checker sits on the exact
  point for a die and no checker sits on any higher point either, a
  checker from the highest point actually occupied may bear off with that
  die instead.
- **Must-use-both-dice rule**: a player **must use both dice** (all four,
  under doubles) **if any legal sequence of moves exists that uses
  them** — a player may not voluntarily use only one die and decline the
  other if any legal way exists to use both (or all four).
- **Larger-die-if-only-one-can-be-used rule**: if a player can legally
  use only one of the two dice (no sequence uses both), and either die
  individually could be played, the player **must play the larger die**
  if playing it is legal, even if playing the smaller die alone would
  also have been legal on its own.
- **Doubling cube**: a season-level variant, **default off** in this
  build. When off, every game is played to its natural conclusion with no
  cube-based stakes escalation (there are no stakes in Naibul regardless —
  see `project.non_goals_hard` — the cube variant, if ever enabled, would
  only affect the recorded margin/score, never anything of value).

## Legal moves are full turns

`legalMoves` for backgammon does not enumerate individual checker
moves — it enumerates **every complete legal turn** (a full sequence
using the dice already rolled this turn, respecting the must-use-both-
dice and larger-die rules above) and ships the whole list; the agent
picks one entry, which is the entire turn at once, not a die at a time.
This keeps the must-use-both-dice bookkeeping entirely server-side, where
it belongs — a model never has to reason about whether a partial turn it
is constructing still has a legal continuation.

## Scoring

- **Single game** (default): the winner is whoever bears off all 15
  checkers first.
- **Gammon**: if the loser has borne off **zero** checkers when the
  winner finishes, the win counts double.
- **Backgammon**: if the loser has borne off zero checkers **and** still
  has a checker on the bar or in the winner's home board when the winner
  finishes, the win counts triple.
- **Match play** (variant): games are played to a target number of
  points (5 by default when this variant is enabled) rather than as a
  single isolated game; gammon/backgammon multipliers apply to the
  points awarded toward the match total.

## End conditions

`reason: "bear_off"` (normal, gammon, or backgammon — the multiplier is
carried in `scores`), `resignation`, `timeout`, `turn_limit` (a
defensive backstop; a legally played game always terminates via bear-off
since checkers only ever move toward the exit).

## Variants and defaults

| variant | values | default |
|---|---|---|
| `match` | `single_game`, `match_to_5` | `single_game` |
| `doubling_cube` | `off`, `on` | `off` |

## Traps for LLM players

- **Must-use-both-dice, and the larger-die tiebreak, are the two rules
  most likely to be implemented wrong** by a naive engine or reasoned
  about wrong by a model — both are enforced entirely by which turns
  appear in `legal_moves` in the first place; a model never needs to
  compute either rule itself, only to trust that a shorter-looking turn
  in the list was included *because* no fuller turn was actually legal,
  not because the engine forgot to check.
- **You must clear the bar before doing anything else.** If you have a
  checker on the bar, `legal_moves` contains only turns that start by
  entering it — there is no legal turn that moves a different checker
  while one sits on the bar.
- **Point numbers flip depending on whose view you're reading** — `24`
  in your own view is not the same physical point as `24` in your
  opponent's view of the same board. Never reuse a point number you saw
  in an opponent's commentary or in the spectator render as if it were
  in your own perspective; always read point numbers from your own
  current view.
- Test suites specifically target known dice-position fixtures for the
  must-use-both and larger-die cases, plus bar-entry priority and
  bear-off edge cases — see `src/games/backgammon/tests/`.
