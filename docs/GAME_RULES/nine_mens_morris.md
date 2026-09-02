# Nine Men's Morris (`nine_mens_morris`)

Two players, perfect information, no randomness. Public-domain board game
played on three concentric squares connected by four spokes.

## Board

The standard 24-point board: three concentric squares (outer, middle,
inner) with midpoints of each side connected across the squares by four
spokes, giving 24 points and 16 straight three-in-a-row lines (mills): 8
around the perimeters of the three squares (each square contributes its
4 sides as potential mill-lines split at the midpoints — concretely, each
square's 4 edge-midpoint-to-corner segments pair into mill lines with
the adjacent corner) plus 4 running along the spokes connecting the
squares. Points are labeled `a1`..`g7` on the standard grid layout, using
only the 24 points that actually exist on the board (the labeling scheme
leaves gaps at coordinates with no physical point, e.g. there is no
`b2`, `b6`, `f2`, `f6`, matching the classic board's missing
inner-corner-to-outer-corner diagonals).

This build uses the classic tournament topology with **no diagonal mill
lines** (some historical variants add four short diagonals at the
board's outer corners; this build does not implement that variant).

Each player has 9 pieces (hence the name).

## Notation

A move depends on the current phase:

- **Placing phase**: the point to place on, e.g. `d2`.
- **Moving phase**: `from-to` along a board line connecting them, e.g.
  `d2-d3`.
- **Flying phase**: `from-to` to *any* empty point, not just an adjacent
  one, e.g. `d2-g7`.
- **Mill removal**: whenever a move completes a mill, the same move
  additionally specifies which opposing piece to remove, e.g.
  `d2-d3xb4` (moving phase, removing the opponent's piece at `b4`) or
  `d2xb4` (placing phase, same idea). `legal_moves` enumerates each
  legal (move, removal) pair as its own entry — never a bare
  mill-forming move with the removal left unspecified.

Examples:
- `d2` — a placing-phase move onto point d2.
- `d2-d3` — a moving-phase slide along an existing board line.
- `a1-a4xd2` — a moving-phase move (assuming `a1`-`a4` is a valid line
  segment on the board's topology) that completes a mill and removes the
  opponent's piece on `d2`.

## Rules

Three phases, in order, tracked per player independently (one player can
be placing while the other has moved on to moving/flying, depending on
how many pieces each has placed so far — though with 9 pieces each and
alternating placement, both players are normally in the same phase at the
same time):

1. **Placing phase**: each player places their 9 pieces one at a time
   onto any empty point, alternating turns.
2. **Moving phase**: once a player has placed all 9 pieces, on their turn
   they slide one piece to an **empty, orthogonally-connected** adjacent
   point (along a drawn line on the board — not a jump, not to a
   non-adjacent point).
3. **Flying phase**: a player reduced to exactly **3 pieces remaining**
   may move any one of their pieces to **any** empty point on the board,
   not just an adjacent one, for as long as they have exactly 3 pieces.

**Mills**: whenever a move (placing, moving, or flying) results in three
of that player's pieces in a row along one of the board's 16 mill lines,
that player immediately removes one opposing piece from the board as
part of the same move. A piece that is currently part of an opponent's
own already-formed mill may not be removed **unless every one of the
opponent's pieces is part of a mill** (the standard protection rule).
Re-forming a mill by moving a piece out and back counts as forming a new
mill each time it re-forms.

## End conditions

- **Reduced to two pieces**: a player with only 2 pieces remaining
  cannot form a mill again (needs 3) and loses immediately —
  `reason: "two_pieces"`.
- **No legal move**: if the player to move (in the moving phase, with
  more than 3 pieces, so not yet flying) has every remaining piece
  blocked by opponents on all adjacent points, they lose —
  `reason: "no_moves"`.

## Variants

None at launch — one board topology (no diagonals), 9 pieces per side,
the three-phase structure above.

## Traps for LLM players

- **Mill removal is part of the same move, not a follow-up decision** —
  `legal_moves` bundles the removal target into the move entry itself
  (`d2-d3xb4`), so a model must pick which opposing piece to remove
  *before* submitting, by choosing among the enumerated (move, removal)
  pairs, not by making the mill-forming move and expecting a
  second prompt.
- **The protected-piece rule for removal is easy to get backwards**: you
  normally *cannot* remove a piece that is part of one of the opponent's
  mills — *except* when literally every one of their pieces is in a
  mill, in which case the protection lifts entirely. `legal_moves` only
  ever lists removal targets that are actually legal under this rule; if
  a piece you expected to be removable is missing from the choices, it's
  protected.
- **Flying only ever unlocks at exactly 3 pieces**, and only for the
  player who is at 3 — a model should not assume flying rules apply to
  the opponent's moves just because that model itself is down to 3.
- **The move/moving-phase transition is per player, based on that
  player's own placement count**, not a single global phase — read the
  view's `phase` field for whose phase is whose rather than assuming
  both players transition together (they usually do, given equal
  piece counts and alternating placement, but the room tracks it per
  player, not globally).
