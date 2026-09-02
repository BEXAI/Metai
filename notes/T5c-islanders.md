# T5c — islanders (src/games/islanders/)

Original island-settlement game, 3-4 players, per spec
`games.M3_hidden_information_and_trading.islanders` + `project.intellectual_property_note`.
All names are original: resources **palm / coral / reed / taro / obsidian**
(terrains grove / reef / marsh / paddy / volcano / dunes), the bandit piece is
the **Raider**, progress cards are **saga cards** (warrior, landmark,
pathfinder, bounty, tithe), ports are **harbors**. Notation verbs follow the
spec exactly (`move_bandit`, `buy_progress`, ...), so only prose/legend uses
the original names.

## Files / exported API

- `rules.ts` — geometry, constants, `IslState`, `IslMove`, `createInitialState`,
  `playersToMove`, `legalMoves`, `applyMove`, `isTerminal`, `victoryPoints`,
  `longestRoadLength`, `produce`, `discardCombos`, `bankRate`, `secretProbes`,
  `moveToNotation` (lives here so apply can stamp `lastMove` without an import
  cycle), plus test-facing helpers (`stealVictims`, `pathfinderMoves`, ...).
- `notation.ts` — `parseMove`, `moveSummary` (re-exports `moveToNotation`).
- `render.ts` — `publicView`, `privateView`, `renderText`.
- `index.ts` — default-exports `Game<IslState, IslMove>`; also re-exports
  `secretProbes` for the leakage gate. Implements `legalMovesPaged` (pageSize
  1000) and `defaultMove` (end_turn > reject > first legal — first legal is the
  canonical-first discard combo in the discard phase).

## Board coordinates (documented scheme)

19 land hexes lettered `A`-`S` in reading order over the axial radius-2
hexagon (rows r=-2..2); the 18 surrounding sea hexes (axial ring radius 3) are
lettered `a`-`r` the same way. **Edge id** = the ASCII-sorted letters of the 2
hexes it separates (`AB`, `Aa`); **vertex id** = the sorted letters of the 3
hexes it touches (`ABa`). 54 vertices / 72 edges, asserted in tests. Sea
letters exist only to name coastal spots; `renderText` prints them around the
map (`~a~`). Adjacency is derived from the letter->axial table at module load.

## Beginner layout (original design)

Terrain by letter: A volcano, B marsh, C grove, D paddy, E reef, F marsh,
G reef, H paddy, I grove, J dunes (Raider start), K grove, L volcano, M grove,
N paddy, O reef, P marsh, Q volcano, R paddy, S marsh.
Tokens: A10 B2 C9 D12 E6 F4 G10 H9 I11 K3 L8 M8 N3 O4 P5 Q5 R6 S11
(standard multiset 2,3,3,...,12; incidentally no 6/8 adjacency).
Harbors (fixed coastal edges, same in both variants): Aa=2:1 palm,
Cc=3:1, Gh=2:1 coral, Hg=3:1, Lj=3:1, Mk=2:1 reed, Pl=2:1 taro,
Qp=2:1 obsidian, Sn=3:1 — 4 generic + one per resource.

## Variants

`layout: 'beginner' | 'random'` (default beginner). Random shuffles the
terrain multiset over A-S (`shuffle:terrain`) and the 18 tokens over the
non-dunes hexes in letter order (`shuffle:tokens`). Per track brief, the 6/8
non-adjacency constraint is NOT enforced in the random variant. Harbors do not
move. Raider starts on the dunes hex wherever it lands.

## Seed-draw purposes (in draw order)

- `shuffle:terrain`, `shuffle:tokens` — random layout only, in `initialState`.
- `shuffle:progress` — 25-card saga deck (14 warrior, 5 landmark,
  2 pathfinder, 2 bounty, 2 tithe), in `initialState`; buys pop from the front.
- `dice:turn:N` — two d6 draws at the start of turn N (drawn inside the apply
  of the move that starts turn N: the last setup road for turn 1, otherwise
  `end_turn`). N is the 1-based global player-turn counter.
- `steal:turn:N` — one `int(handSize)` per steal (7-raider move AND warrior
  card; the per-purpose counter separates two steals in one turn). The victim's
  hand is flattened in canonical resource order (palm, coral, reed, taro,
  obsidian) and indexed.

## Rules decisions (implementation choices, spec rules unchanged)

- **Turn structure**: there is no explicit `roll` move (matches the spec's
  notation list); the roll happens automatically when the turn starts. No
  pre-roll card plays, per the spec's "roll, then any order of ..." line.
- **Setup**: snake order p0..pN,pN..p0; each placement is two moves
  (`build_village` then `build_road`, road must touch that village). The
  second-pass village immediately pays 1 resource per adjacent producing hex.
  Setup villages additionally require a free adjacent edge so the paired road
  always has a spot (prevents a dead-end the playout harness would flag).
- **Discard**: hand > 7 discards floor(hand/2). Simultaneous:
  `playersToMove` returns every player still owing; each submits
  `discard(cards)`; when the last lands the phase flips to `raider` (roller
  moves the raider). Room trap per spec: one deadline collects them all.
- **Raider victim**: `move_bandit(hex, victim)` — victim must be an opponent
  with a building on the hex and >=1 card; `-` only when no such opponent.
- **Production**: villages 1 / cities 2 to ALL players; the Raider blocks its
  hex. Bank shortage rule: if a resource cannot cover everyone owed it and
  more than one player is owed, nobody gets it; a lone claimant takes what
  remains.
- **Trades**: bank at the player's best rate only (2:1 own-resource harbor,
  3:1 any-harbor, else 4:1) — `trade_bank(give,get)` always trades rate-for-1.
  Structured offers are **bounded** so `legalMoves` stays complete: give/get
  each total 1-2, combined <= 3 (1:1, 2:1, 1:2 — no 2:2), no resource on both
  sides, both non-empty. Max 3 offers initiated per player per turn (counters
  do not count); one counter per offer (responder's perspective), then the
  original offerer accepts/rejects. `accept` is only legal when the payer side
  can pay.
- **Saga cards**: max one non-landmark play per turn; the copy bought this
  turn is unplayable (an older identical copy is). Landmarks are never
  "played": they count (hidden) toward the win check and are revealed in the
  final scores. Pathfinder must place 2 roads when any sequential pair exists,
  else 1; placements are ordered pairs. Bounty takes exactly 2 bank resources
  (1 if the bank holds only 1 card total). Tithe (monopoly) drains one named
  resource from all opponents.
- **Longest road (5+) / largest army (3+)**: sticky holder; transfers only
  when strictly exceeded; ties retain. Longest road is the longest edge-trail
  that may not pass THROUGH an opponent-built vertex (may end there) —
  recomputed on every road build (incl. pathfinder) and village build, so an
  opponent village CAN break it: if the holder drops below 5 the bonus goes to
  the unique strict leader with 5+, else to no one (set aside).
- **Win**: `isTerminal` awards the win only when the CURRENT player (incl.
  hidden landmarks) has >=10 VP — a non-current player at 10 does not end the
  game (a non-current player can never gain VP in this ruleset, but the check
  is explicit and tested). Turn limit: after turn 100*n ends, most VP wins
  (hidden landmarks revealed), ties by total resources held, remaining ties are
  a shared draw. Reasons: `points`, `turn_limit`.

## Hidden information / leakage

Hidden: hand contents (counts public) and unplayed saga cards (count public);
the deck order is hidden from everyone (views expose `deckCount` only).
`secretProbes(state, p)` returns: `"pX":<sorted-hand-JSON>` and
`"pX":<progress-array-JSON>` (raw-state fragments) plus the exact
`Hand (pX): ...` / `Saga cards (pX): ...` lines that `renderText` prints only
for the owner. Public per-player data is shaped to never collide with these
(dense 5-key hands in probes vs. sparse event payloads; no `"pX":[...]` or
`"pX":{...}` hand-shaped structures in public views). The public `warriors`
count key contains the substring `warrior` by design — probes use quoted/array
forms so it cannot false-positive. Steal/discard/buy card identities are
`private` events targeted `to:` the involved players only.

## State/codec

State is dense plain JSON (hands always carry all 5 resource keys — keeps
hashes stable and probes exact). `encodeState` = `canonicalJson(state)`;
`decodeState` = `JSON.parse` + shape check; round-trip hash equality is
exercised every 50 moves by the playout harness and directly in views.test.

## Tests (all in src/games/islanders/tests/)

board, setup, turn (production/discard/steal), progress, trading, scoring
(longest road/army/win/limit), views (views+codec+notation), playouts
(200x3p + 200x4p + 50 random-variant + determinism), leakage (300 states 3p +
150 4p + probe self-test). 66 tests, all passing; suite ~43s (playouts
dominate). Playout stats: ~2300 moves/game, most games end by `points`.

## Integration notes

- `applyMove` returns `not_your_turn` for players outside `playersToMove` —
  including the current player while a trade offer is pending (the responder
  is the only mover).
- Offers appear in the public view (structured trades are public by design).
- `moveSummary` is implemented for all move types (wanted for trading games).
- Turn counter `state.turn` is global 1-based (0 during setup); round =
  ceil(turn / nPlayers); rooms can display `phase` from the public view
  (`trade_response` is surfaced while an offer is pending).
