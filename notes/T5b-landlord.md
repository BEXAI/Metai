# T5b — landlord (original property-trading game, 2-4 players)

Status: complete. 59 tests green in `src/games/landlord/tests/` (rules 30, trading 10,
flows 8, leakage 6, playouts/determinism 5). Typecheck clean for all owned files.

## Files

- `src/games/landlord/board.ts` — static data: 40-space board, 22 original streets in
  8 groups (umber/sky/rose/amber/crimson/gold/jade/violet), 4 transit lines, 2 utilities,
  2 tax spaces, two original 16-card event decks (A "Harbormaster Dispatches",
  B "Town Ledger Notices"), rent/price/cost tables, money constants.
- `rules.ts` — pure reducer: state/move types, phase machine, payment pipeline, auctions,
  bankruptcy, trading. `render.ts` — ASCII board. `notation.ts` — parse/print/summary.
  `index.ts` — assembles the `Game<LandlordState, LandlordMove>` default export and
  exports `secretProbes` for the leakage harness.

## IP note

Every name and card text is invented (Meridian Bay theme). No trademarked names
('Launch Pier' start, 'Detention Yard' jail, 'Rest Green' free space, "Constable's
Order" go-to). Mechanics numbers (salary 200, classic rent tables, 32/12 building
supply, house costs 50-200 by side) are unprotected mechanics, reused for balance.

## Phase machine

`state.phase`: `roll -> buy_or_auction? -> auction? -> manage -> end_turn` plus `debt`.
A payment **pipeline** (`state.payments` queue + `state.bankQueue` + `state.afterPipeline`)
drives rent/tax/card payments, multi-party card payments, the forced detention fine, and
post-bankruptcy bank auctions. `playersToMove` follows the phase (auction cycles bidders;
a pending offer moves the responder; debt moves the debtor).

## Seed-draw purposes

- `first_player` — one int at setup (seat order is otherwise p0..pN).
- `shuffle:deckA`, `shuffle:deckB` — deck orders at setup (the game's ONLY hidden info).
- `dice:roll:K` — two d6 per movement/detention-attempt roll; K = `state.rollCount` (global, 1-based).
- `dice:utility:K` — two d6 when the Works Inspection card (evA04) charges 10x a fresh roll.

## Rules decisions / rulings (familiar-mechanics ambiguities)

- **Auction** (spec-fixed): open ascending, bids = multiples of 10, strictly greater than
  the standing high (an equal bid is illegal — "tie to the earlier bid"), up to bidder
  cash; pass allowed without dropping out; ends after a full round with no new bid, or
  after 3 rounds; a bid-less first round leaves the property unowned. Order = alive
  players seat-cyclic from the current player; the decliner may bid. Winner pays the bank.
- **Doubles**: re-roll entitlement granted at `end_turn` (same player back to `roll`);
  3rd consecutive double -> detention, no movement, no re-roll. Doubles exit from
  detention does NOT grant a re-roll; paying/writ before rolling does.
- **Detention**: after the 3rd failed doubles attempt the fine is forced through the
  pipeline and the player moves by that roll (debt/bankruptcy possible). Detained players
  still collect rent, manage, and trade. Going to detention keeps the manage phase (turn
  movement ends; transactions are allowed — common ruling, noted).
- **Monopoly rent** doubles on an unimproved, unmortgaged street when the owner holds the
  full group (siblings' mortgage state irrelevant — common ruling). Mortgaged transit/
  utility count toward the owner's multiple but collect nothing when landed on.
- **Mortgage**: half list; unmortgage = mortgage + ceil(10%) (zephyr: 175 -> 193).
  Mortgaged property changing hands (trade or bankruptcy) costs the receiver an immediate
  ceil(10%) fee to the bank; the property stays mortgaged (lift later at +10% again).
- **House shortage**: a hotel normally breaks down to 4 houses (needs supply); when fewer
  than 4 houses remain, the hotel must be sold whole via `sell_buildings(prop,5)`
  (shortage exception, keeps debt liquidation always achievable).
- **Debt**: explicit moves — sell/mortgage until `pay_debt` (cash >= amount) or
  `declare_bankruptcy` (only legal when full liquidation could not cover: enforced).
  `pay_debt`/`declare_bankruptcy` are two extra move tags beyond the spec's notation
  list (the spec's rules require the mechanic; documented deviation).
- **Bankruptcy to a player**: buildings auto-sold at half cost, then all cash, properties
  and writs go to the creditor; creditor's mortgage fees are capped at their cash (bank
  waives the remainder — avoids cascading bankruptcy; deviation, noted). **To the bank**:
  writs return to their decks' bottoms, mortgages clear, properties auction one by one in
  board order among survivors; the bankrupt current player's turn then ends.
- **Net worth** (turn-limit scoring): cash + list price of unmortgaged holdings
  + mortgage value (half list) of mortgaged holdings + building cost (hotel = 5x house
  cost). Task said "list prices"; mortgaged-at-half is the accounting-consistent reading
  (mortgaging would otherwise mint half the list price out of thin air). Ties shared
  (multiple winners, draw=false). `round > 150` ends the game (150 full rounds played).
- **Trading**: one pending offer at a time (the responder is the only player to move, so
  the board is frozen while an offer is open). Max 3 initiated offers per turn (counters
  do not count). One counter per offer, then only accept/reject. Traded properties must
  be building-free; mortgaged OK (fee above). Writs transfer FIFO by count. Cash sides
  validated so nobody goes negative at accept time — trades can never cause debt.
- **Event decks**: drawn from the front, non-writ cards rotate to the back; drawn writs
  leave the deck until used (returned to the bottom of their source deck on use, also on
  bankruptcy-to-bank). Card identity becomes public when drawn (the event and render show
  it); only the order of undrawn cards is secret.

## Deviation: offer enumeration vs. the full grammar

`legalMoves` cannot enumerate every structured offer (unbounded cash x subsets x
recipients). Everything enumerated is legal and applies cleanly; additionally
`parseMove`/`apply` accept the FULL offer grammar (any recipient, any non-negative
integer cash, any owned building-free property set, any writ count, note <= 280 chars).
Enumerated canonical set: sell-at-list and buy-at-list single-property offers targeting
the next alive player, plus one canonical counter (mirror + 100 cash). Rooms should
treat `legalMoves` as complete for phase logic (never empty when it must not be), but
validate arbitrary offers through `parseMove`+`apply`, not list membership.
`legalMovesPaged` (pageSize 1000) exists because bid lists can grow with cash.

## Hidden info & leakage (A10)

Only `state.deckA`/`state.deckB` order is hidden — from players AND spectators.
`publicView` exposes counts; `privateView` = public + `you`/`your_writs` (writ holdings
are public anyway per spec). `secretProbes` (exported from `index.ts`) returns joined
JSON-fragment sequences of each deck (full order + next-3); same-deck sequences of >= 2
ids can never legitimately appear in a view (each deck holds only one writ, so held-writ
arrays never contain two same-deck ids). Probes attributed to every player, so the
harness cross-checks all views and the public render. 350+120+120 states checked.

## Integration notes

- `encodeState` = `JSON.stringify` of the full state (includes deck order — treat the
  state string as secret while a game runs; views/renders are the shareable surfaces).
- `defaultMove` (timeout): end_turn > decline > reject > pay_debt > first legal.
- `moveSummary` implemented (one human line, used for trades/bids).
- Playout cost: ~5.4k applied moves per 4p game, ~2.2k per 2p; pass `maxMoves: 60_000`
  to harnesses (rule-level round limit guarantees termination; random managers dawdle).
- Terminal reasons: `last_standing`, `turn_limit`. `scores` = net worths (bankrupt: 0).
- Notation quick ref: simple tags plus `auction_bid(N)`, `build(prop,n)`,
  `sell_buildings(prop,n)`, `mortgage(prop)`, `unmortgage(prop)`, `accept(id)`,
  `reject(id)`, `offer({"get":{...},"give":{...},"note":...,"to":"pX"})`,
  `counter(id,{"get":...,"give":...,"note":...})` (canonical-JSON key order;
  `pay_jail` accepted as an alias for `pay_detention`).
