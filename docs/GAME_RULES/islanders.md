# Islanders (`islanders`)

3 or 4 players, hidden information (resource-hand contents and unplayed
saga cards — counts are public), dice and card randomness.

**A note on names**: `islanders` is this build's internal id for an
original island-settlement game — hex terrain board, five original
resources, roads, villages, cities, a Raider, and hidden "saga" progress
cards — built to familiar mechanics under original names
(`project.intellectual_property_note`). Every name below comes directly
from `src/games/islanders/rules.ts`, the game track's published data —
nothing here is a placeholder.

## Board

19 land hexes, **lettered `A`-`S`** in reading order, each (except one)
producing one of five resources; ringed by 18 sea hexes, **lettered
`a`-`r`**, which exist only so coastal points have names. A **vertex** is
named by the ASCII-sorted letters of the 3 hexes touching it (e.g.
`ABa`); an **edge** by the 2 hexes it separates (e.g. `AB`, or `Aa` for
an edge on the coast). The board has exactly **54 vertices and 72
edges**.

Terrain and its resource:

| terrain | resource |
|---|---|
| grove | palm |
| reef | coral |
| marsh | reed |
| paddy | taro |
| volcano | obsidian |
| dunes | (none — starts holding the Raider) |

Each non-`dunes` hex carries a number token (2-12, excluding 7); rolling
that number produces one unit of its resource for every player with a
village (two units for a city) on one of its adjacent vertices.

- **`beginner` layout** (default): a fixed, documented terrain and
  number-token arrangement.
- **`random` layout** (variant): terrain and number tokens are shuffled
  from the seed (`purpose: 'shuffle:terrain'` / the matching token
  shuffle); harbors stay fixed in both layouts.

**Harbors** sit on specific coastal edges: each is either a generic
harbor (any resource, 3:1 with the bank) or a resource-specific harbor
(that one resource, 2:1) — only usable by a player with a settlement on
one of that harbor's two vertices.

## Notation

Exactly as `src/games/islanders/notation.ts` parses and prints:

```
build_road(AB)
build_village(ABa)
build_city(ABa)
buy_progress
play_progress(warrior,hex,victim|-)
play_progress(pathfinder,e1[,e2])
play_progress(bounty,res+res)
play_progress(tithe,res)
trade_bank(give,get)
offer(give,get,to)
accept(id) · reject(id) · counter(id,give,get)
move_bandit(hex,victim|-)
discard(res+res+...)
end_turn
```

`res` is one of `palm`, `coral`, `reed`, `taro`, `obsidian`. `victim|-`
is either an opponent's player id or the literal `-` when no opponent is
adjacent to steal from.

Examples:
- `build_road(AB)` — build a road on the edge between hexes A and B.
- `build_village(ABa)` — build a village on the vertex touching hexes A,
  B, and the sea hex a.
- `play_progress(tithe,obsidian)` — play a tithe card naming obsidian;
  every other player hands over all the obsidian they hold.
- `play_progress(warrior,C,p2)` — play a warrior card, moving the Raider
  to hex C and stealing one card from `p2`.
- `discard(palm+palm+coral)` — discard exactly this multiset during the
  discard phase (see [Seven](#seven-the-raider)).

## Setup

**Snake-order placement**: seat order places a first village and an
adjacent first road each; the same seat order then **reverses** for a
second village and road, so the last player to place first places
second immediately next without waiting a full round. **The second
village's adjacent hexes each pay out one unit of their resource** as
starting resources (the first village pays nothing at setup).

## Building costs and supply

| piece | cost | per-player supply |
|---|---|---|
| road | 1 palm + 1 coral | 15 |
| village | 1 palm + 1 coral + 1 reed + 1 taro | 5 |
| city (upgrades a village in place) | 2 taro + 3 obsidian | 4 |
| saga card | 1 reed + 1 taro + 1 obsidian | — (25-card deck, below) |

The bank holds 19 of each resource; if production would need more of a
resource than the bank has left for everyone owed it, and more than one
player is owed it, **nobody receives that resource** that roll (a single
owed player still takes what remains).

## Turn structure

1. **Roll** (production resolves for **every** player at once, based on
   the number rolled — not just the active player's). Rolling **7**
   skips production and triggers [the seven](#seven-the-raider) instead.
2. **Any order** of building, trading, buying a saga card, and playing
   saga cards held from a previous turn.
3. **`end_turn`**.

## Saga cards (hidden until played)

A single 25-card deck: **14 warrior, 5 landmark, 2 pathfinder, 2 bounty,
2 tithe.**

- **`warrior`** — move the Raider and (optionally) steal, exactly like
  the seven's Raider move; counts toward **largest army**.
- **`landmark`** — a silent hidden victory point. Unlike every other
  card, a `landmark` counts toward the 10-point win check **immediately
  on purchase**, even before it would otherwise become "playable" next
  turn — there is nothing to actively play. Never announced when bought
  or held; only visible in the replay, or the instant it's the specific
  card that wins the game.
- **`pathfinder`** — build one or two roads immediately at no resource
  cost (`args: e1[,e2]` — a second edge is optional, e.g. if only one
  legal placement remains).
- **`bounty`** — take one or two resources of your choice from the bank
  in one action (`res+res`, which may repeat the same resource twice).
- **`tithe`** — name one resource; every other player hands over all of
  that resource they currently hold.

**A card cannot be played the turn it was bought** (`landmark` is exempt,
since it is never "played," only held or counted). 25 cards total means
the deck can run out late in a long game; the game track's design does
not require a reshuffle to keep playing without saga cards once it does.

## Seven: the Raider

Whenever a **7** is rolled:

1. **Every player holding more than 7 cards discards `floor(total / 2)`**
   of their own choosing, submitted as `discard(...)`. **This is
   simultaneous**: `playersToMove` lists every player who still owes a
   discard at once, not just the roller — the room collects every
   required discard under one shared deadline before continuing (see
   [Traps](#traps-for-llm-players)).
2. The roller moves the Raider to any other hex (`move_bandit(hex,
   victim|-)`) — production from a hex holding the Raider is suppressed
   until it moves again.
3. If any opponent has a village/city adjacent to the Raider's new hex,
   the roller names one such adjacent opponent to steal from; **which
   specific card comes out of that opponent's hand is a seeded random
   draw** (`purpose: 'steal:turn:<n>'`), never the roller's choice and
   never predictable before it happens. `victim: "-"` when no opponent
   is adjacent.

## Bonuses

- **Longest road** (5+ edges in the player's longest simple road trail):
  the current holder keeps it until **strictly exceeded** by another
  player; if the holder's own road breaks below 5, the bonus passes to
  whichever other player has a unique strict leader at 5+, or to nobody
  if there's a tie or nobody reaches 5. Worth **+2 VP** while held.
- **Largest army** (3+ `warrior` cards played, cumulative for the whole
  game): passes to whoever has played strictly more than the current
  holder, once at least 3. Worth **+2 VP** while held.

## End conditions

- **`reason: "points"`** — 10 victory points, **checked only on the
  current player's own turn** (hidden `landmark` cards already count
  toward this the instant they're bought, per above).
- **`reason: "turn_limit"`** — 100 rounds reached with no winner; most
  victory points wins, ties broken by total resources currently held.

## Hidden information

**Resource-hand contents and unplayed/just-bought saga cards.** Counts
(how many resource cards, how many saga cards) are public at all times;
which specific resources or cards are known only to their holder until
either played (saga cards) or exchanged (resources, visible only to the
trade counterparty). None of this appears in any spectator event or
`publicView` before `ended_at`.

## Traps for LLM players

- **The discard phase is simultaneous, not sequential.** If several
  players are over 7 cards when a 7 is rolled, the room is waiting on
  every one of them at once, not just the roller — don't read "not my
  roll" as "not my turn to act" during this phase.
- **A saga card just bought cannot be played this same turn** (except
  `landmark`, which is never "played" and counts toward victory points
  immediately). A missing `play_progress` entry for a card you just
  bought is this rule, not a bug.
- **`tithe` and `bounty` argument grammar matters**: `tithe` names
  exactly one resource; `bounty` takes one or two resources (possibly
  the same resource twice) in a single action — read `legal_moves` for
  the exact enumerated combinations rather than assuming any resource
  string is accepted.
- **Trade offers cap at 3 per player per turn, one counter per offer.**
- **The Raider's steal target is your choice; the specific card is
  not.** `move_bandit`/`warrior` let you pick *which adjacent opponent*
  to steal from, but the actual card that comes out is a seeded random
  draw, recomputable in the replay, never something either side
  controls or can predict in advance.
- **Vertex and edge labels encode adjacency directly** (`ABa` touches
  hexes A, B, and sea hex a; `AB` separates hexes A and B) — a model
  reasoning about board connectivity can derive a lot of it straight
  from the label text rather than needing a separate adjacency lookup,
  but should still trust `legal_moves` over its own derivation for what
  is actually buildable right now.
