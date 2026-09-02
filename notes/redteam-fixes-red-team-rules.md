# Fixes for red-team-rules findings

Fixer pass over the red-team-rules memo (`test/redteam/red-team-rules.md`).
All 121 tests in `test/redteam/red-team-rules-*.test.ts` pass after these
changes. Verification run:

- `npx vitest run test/redteam/red-team-rules-*.test.ts` — 9 files, 121/121 green
- `npx vitest run src/games/chess src/games/landlord src/games/islanders` — 223/223 green (includes the A3 perft gate)
- `LUDUS_PLAYOUTS=25 npx vitest run test/playouts.test.ts` — 15/15 green
- `npx tsc --noEmit --pretty false` — 0 errors

## RT-RULES-01 — chess phantom-rook castling (HIGH)

**Root cause** (two layers):

- `src/games/chess/rules.ts:341-359` (pre-fix) — the `genPseudo` castling
  block checked the rights bit, the empty in-between squares, and the
  attacked squares, but never that the king and the matching rook actually
  sit on e1/e8 and a1/h1/a8/h8. From a crafted FEN claiming a right with no
  rook, `make()` "moved" the empty rook square onto f1/d1.
- `src/games/chess/index.ts:102-104` (pre-fix) — `decode` normalized the ep
  field FIDE-style but accepted the castling field verbatim, so impossible
  rights survived into the state (and into `posKey` repetition keys).

**Fix** (both layers, mirroring the memo's two options):

- `src/games/chess/rules.ts` (`genPseudo` castling block): each of the four
  castling pushes now also requires the king on its home square and the
  matching rook on its home square (`b[25]===WK && b[28]===WR` for white
  kingside, etc.). This defends every call path, including hand-crafted
  JSON states that never pass through `decodeState`.
- `src/games/chess/index.ts` (`decode`): after the existing ep
  normalization, castling rights are masked (never added) — a right is
  dropped when the king or the matching rook is off its home square. Keeps
  decoded states canonical (FEN/`posKey`) exactly like the ep treatment.

Reachable play is unaffected: `make()` already clears rights when the king
or rook moves or the rook is captured, so in any reachable state the new
conditions are tautologies (perft/A3 fixtures unchanged, verified green).

**Attack-test correction (sanctioned exception).** One of the four tests,
`red-team-rules-chess.test.ts` — "castling with a phantom rook must never
mint material out of thin air", asserted that applying **every** legal move
from `r3k3/8/8/8/8/8/8/R3K3 w K - 0 1` keeps the piece count **equal**
(`toBe`). That contradicts the spec rule it cites as law —
`LUDUS_BUILD_SPEC.json` `games.M1_perfect_information.chess.rules`:
"FIDE laws: castling, en passant, promotion, check, checkmate, stalemate,
fifty-move rule, threefold repetition, insufficient material; draw by
agreement only via a structured offer/accept pair." — because under FIDE
laws `Ra1xa8` is a legal move from that position and a capture *removes* a
piece (4 → 3). As written the test can never pass against a FIDE-correct
engine. The test's own title states the intended invariant (never *mint*
material, i.e. the count may never increase), so the assertion was
corrected to `toBeLessThanOrEqual` — the guard against minting is fully
preserved. No other attack test was modified.

## RT-RULES-02 — landlord apply() threw on malformed offers (MEDIUM)

**Root cause**: `src/games/landlord/rules.ts:894-900` (pre-fix) —
`validBundleShape(b)` dereferenced `b.cash` without checking that `b` is an
object, so `give`/`get` of `undefined` (field omitted), `null`, or a
non-object threw `TypeError: Cannot read properties of undefined (reading
'cash')` out of `applyMove` — violating the kernel contract
(`apply` returns `ApplyOk | RuleError`) and A6 "trades accept only
structured offers". Reached from `case 'offer'` and `case 'counter'` via
`validateOfferSides` (the `deepClone` calls are primitive-safe, so the
throw happened at validation time).

**Fix**: `validBundleShape` now returns the structured rejection
`'bundle must be an object with cash, props, and writs'` when the value is
not a plain object (`typeof b !== 'object' || b === null ||
Array.isArray(b)`). Both the offer and counter paths flow through
`validateOfferSides` → `validBundleShape`, so one guard covers both, plus
accept-time revalidation.

## RT-RULES-03 — islanders apply() threw on malformed multisets (MEDIUM)

**Root cause**: `src/games/islanders/rules.ts:349-358` (pre-fix) —
`validMultiset(ms)` called `Object.keys(ms)` on whatever arrived, so a
missing/`null` `give`/`get`/`cards`/`take` threw
`TypeError: Cannot convert undefined or null to object` out of `applyMove`.
Reached from `offerShapeOk` (offer + counter), the discard-phase branch,
and the bounty progress card.

**Fix**: `validMultiset` now returns `false` for anything that is not a
plain object (`typeof ms !== 'object' || ms === null || Array.isArray(ms)`).
Every caller already turns `false` into a structured `RuleError`
(`bad_offer` / `bad_cards` / `bad_move`), so the single choke-point guard
fixes all four entry paths.

## RT-RULES-04 — landlord non-string note bypassed the 280-char cap (LOW)

**Root cause**: `src/games/landlord/rules.ts:927` (pre-fix) —
`o.note !== null && o.note.length > MAX_NOTE_CHARS`: a note of type
`number`/`object` has `length === undefined`, the comparison is `false`,
and the non-string landed in `state.offer.note`/events/renders that assume
`note: string | null` (the T6/T9 injection surface assumes a capped
string; spec `games...landlord.trap` caps the note as text).

**Fix**: `validateOfferSides` now rejects with
`'note must be a string or null'` whenever `o.note !== null &&
typeof o.note !== 'string'`, before the length check. This covers both the
offer and counter paths (both validate through `validateOfferSides`). A
*missing* note field (`undefined`) is likewise rejected — it violates the
declared move shape `note: string | null`, and previously it crashed
(`undefined.length`), so no working behavior changed; the game's own
`legalMoves`/notation always supply an explicit `note`.
