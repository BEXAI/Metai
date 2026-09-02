# Red team: red-team-rules — findings memo

Scope: every game engine in `src/games/*/` via the kernel contract
(spec §games — all rule text is law; §workflow.stage_2 red-team-rules attacks;
acceptance A1/A3–A7). All three attack families from the brief were run against
all 12 games:

1. illegal-move-accepted / legal-move-rejected hunting (hand-crafted positions
   via decodeState/encodeState, spec rule cross-reading);
2. turn-limit and draw rules (exact tiebreaks);
3. trading-phase deadlocks (hostile pickers, not uniform random).

Test files (121 tests; **9 fail today = exploitable holes**, the rest are
regression guards that must stay green):

| file | tests | failing |
|---|---|---|
| `red-team-rules-chess.test.ts` | 14 | 4 (RT-RULES-01) |
| `red-team-rules-checkers.test.ts` | 12 | 0 |
| `red-team-rules-go.test.ts` | 8 | 0 |
| `red-team-rules-backgammon.test.ts` | 16 | 0 |
| `red-team-rules-cc.test.ts` | 13 | 0 |
| `red-team-rules-smallgames.test.ts` | 16 | 0 |
| `red-team-rules-landlord.test.ts` | 22 | 3 (RT-RULES-02, -04) |
| `red-team-rules-islanders.test.ts` | 15 | 2 (RT-RULES-03) |
| `red-team-rules-deadlocks.test.ts` | 5 | 0 |

Run: `npx vitest run test/redteam/red-team-rules-*.test.ts`

---

## Exploitable findings

### RT-RULES-01 — chess: phantom-rook castling from a decodable state (HIGH)

`decodeState` accepts any 6-field FEN and normalizes the **ep** field the FIDE
way, but does **not** normalize/validate the **castling** field against the
board. From `r3k3/8/8/8/8/8/8/R3K3 w K - 0 1` (right `K` claimed, no rook on
h1) the engine **offers and applies `e1g1`**: the king "castles", the rook copy
comes from the empty h1 square, and the resulting board `R5K1` has no rook on
f1 — an impossible FIDE move that also silently changes material bookkeeping.

- Hole: `src/games/chess/rules.ts:341-359` — the `genPseudo` castling block
  checks the rights bit, empty squares and attacked squares but never that the
  rook actually sits on h1/a1/h8/a8.
- Entry: `src/games/chess/index.ts:102-104` — `decode` normalizes ep but not
  castling rights.
- Fix options (either passes the tests): mask impossible rights at decode
  (X-FEN style, mirroring the ep normalization), or check `b[28]===WR` etc. in
  movegen. Note perft is unaffected (reachable states always have the rook),
  which is exactly why this survived the A3 gate.
- Tests: 4 failing in `red-team-rules-chess.test.ts` (white K-side, white
  Q-side, black K-side, and a material-conservation invariant).

### RT-RULES-02 — landlord: apply() THROWS on malformed structured offers (MEDIUM)

The kernel contract says `apply` returns `ApplyOk | RuleError`. Landlord
`applyMove` throws a raw `TypeError` when an `offer`/`counter` move omits or
malforms its bundles: `{t:'offer', to:'p1'}` (no give/get), `give: null`,
`give: 7`, … A hostile agent whose move JSON reaches `apply` (rooms on the
index-fallback path, the replay verifier recomputing a doctored log, any
future caller trusting the contract) gets an uncaught exception instead of a
structured rejection — a one-message room/verifier kill.

- Hole: `src/games/landlord/rules.ts:894-900` — `validBundleShape(b)` reads
  `b.cash` without checking `b` is an object; `case 'offer'`
  (`rules.ts:1202-1224`) builds the `OfferState` from `move.give`/`move.get`
  unchecked.
- Spec hook: A6 "trades accept only structured offers" — a malformed body must
  be *rejected*, not crash the reducer.
- Tests: 2 failing in `red-team-rules-landlord.test.ts` ("an offer without
  give/get…", "bundles of the wrong JSON shape…").

### RT-RULES-03 — islanders: apply() THROWS on malformed offer/discard/bounty multisets (MEDIUM)

Same contract violation as RT-RULES-02: `validMultiset(ms)` calls
`Object.keys(ms)` on whatever arrived, so `{type:'offer', to:'p1'}`,
`give: null`, `{type:'discard', cards: null}`, `{type:'discard'}`,
`{type:'counter', give:null,…}` all throw `TypeError` out of `applyMove`.

- Hole: `src/games/islanders/rules.ts:349-358` (`validMultiset`), reached
  unchecked from `case 'offer'` (`rules.ts:1424-1433`), `case 'counter'`
  (`rules.ts:1260-1268`), and the discard branch (`rules.ts:1200-1213`).
- Tests: 2 failing in `red-team-rules-islanders.test.ts`.

### RT-RULES-04 — landlord: non-string trade note bypasses the 280-char cap (LOW)

`validateOfferSides` checks `o.note !== null && o.note.length > MAX_NOTE_CHARS`
(`src/games/landlord/rules.ts:927`). A note of type `number` (or object) has
`length === undefined`, the comparison is false, and the non-string lands in
state/events/renders that assume `note: string | null`. The spec caps the note
as *text*; type confusion here flows into the injection-handling surface
(T6/T9 assume a capped string).

- Test: 1 failing in `red-team-rules-landlord.test.ts` ("a non-string note is
  rejected…").
- Fix: `typeof o.note !== 'string'` ⇒ `bad_offer` (and same for counters).

---

## Attacked and DEFENDED (regression tests kept)

- **chess**: diagonal ep-pin (capture opens a bishop line through the vacated
  pawn square) rejected + ep field X-FEN-normalized away; promotion-capture on
  h8/a1 clears the right; fifty-move at exactly 100 with stalemate/checkmate
  precedence; crafted threefold; malformed-move robustness.
- **checkers**: multi-piece mandatory-capture completeness; truncated
  multi-jump rejected; English crowning-by-capture ends the chain (verified the
  uncaptured continuation man survives); international majority rule
  (`not_maximal_capture`), pass-through crowning row does NOT crown, flying
  kings; 80-ply forty_move_rule incl. reset-by-man-move at 79; threefold
  precedence over the 40-move rule; blocked player loses.
- **go**: positional superko enforced across ARBITRARY distance (crafted hash
  history) and for either side to move; a real ko cycle incl. the
  counter-retake after threat exchanges; multi-stone suicide gated by variant,
  single-stone suicide barred under the variant; Tromp-Taylor "stones stand as
  they are" scored exactly (dead invader counts, its region neutral);
  two-pass end discipline.
- **backgammon** (crafted via `bg1|…` codec): must-use-both when only ONE
  ordering works; doubles all-four; larger-die forced / smaller-only allowed;
  bar priority incl. closed-board dance and fake-entry rejection; bear-off
  gates (nothing outside home, none from the bar, overshoot only from the
  highest point, straggler-home-then-off ordering); forged die assignments and
  die reuse rejected; gammon/backgammon multipliers; 2000-turn valve.
- **chinese_checkers**: anti-stall re-entry ban (step and chain-endpoint),
  pass-through allowed; 30-move forfeit at exactly move 30 (and the vacating
  30th move avoiding it); 200-round limit with pegs-in-goal tiebreak, shared
  draw, forfeited players excluded; jump-chain parse canonicalization;
  goal-fill immediate win.
- **small games**: tictactoe guards; connect_drop full-column/win/draw;
  reversi forced-pass discipline (`pass` illegal with a flank, sole legal move
  without); hex swap timing + in-place flip + both edge orientations;
  nine_mens_morris removal preference (unmilled first), all-milled fallback,
  double-mill removes ONE, flying at exactly 3, blocked/reduced losses,
  50-quiet and threefold draws.
- **landlord**: auction ascending/step-10/tie-to-earlier/over-cash rejections;
  3-round settlement under endless bids; ZERO-eligible-bidder auction (all
  broke) resolves unsold without deadlock; even-build/even-sell incl. atomic
  rejection of leapfrog `build(n=2)` with prev-state hash equality; detention
  exits (forced 3rd-try fine → debt → sole-move `declare_bankruptcy` →
  last_standing); 151-round net-worth tiebreak with exact accounting
  (mortgaged at half list, hotel = 5× house cost), shared ties, bankrupt = 0;
  offer freeze (board locked while pending), stale ids, counter-once,
  re-validation at accept time, 3-offer cap with end_turn always available.
- **islanders**: main-phase distance rule + road-through-opponent-building
  ban; discard rounding (7 exempt, 8→4, 9→4) and simultaneous-discard lock on
  the raider phase in any completion order; longest-road recompute when a
  rival village splits the trail (bonus removed to nobody; transferred to the
  unique 5+ rival); progress same-turn ban / one-per-turn / landmark
  unplayable-but-counted; rival at 10 VP does not win off-turn; 100-round
  tiebreak (VP then resources, full tie = shared draw) and exact
  last-turn-of-round-100 boundary; raider must move / victim rules.
- **deadlocks (family 3)**: hostile pickers (always-offer, always-counter,
  never-accept, max-bid, greedy-staller, accept-everything) over full games —
  6×4p + 4×2p + 1×3p landlord, 4×3p + 2×4p islanders. Every game terminated
  by rule (`turn_limit` / `last_standing`), with playersToMove non-empty and a
  non-empty legal list for every mover at every step. A sampled hostile 4p
  landlord game: 3,820 moves, 672 offers, 331 counters, 36 max-bids, 1
  bankruptcy — the offer cap + counter-once + always-available
  reject/decline/end_turn close every loop.

## Judgment calls reviewed and NOT flagged

- checkers "draw after 40 moves" read as 40 moves **per side** (80 plies) —
  conventional and documented in the module header.
- chinese_checkers anti-stall read as "may not END in own start triangle
  unless it started there" — documented; equivalent for reachable states.
- landlord net-worth counting mortgaged property at half list — documented
  deviation with sound accounting rationale.
- go `decodeGo` accepts off-list komi values (initialState validates; decode
  does not) — hygiene nit only, cannot change any legal-move set.
