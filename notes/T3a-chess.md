# Track T3a — chess

Status: complete. 54 tests green (`npx vitest run src/games/chess/`), zero tsc errors in `src/games/chess/`.

## Files

- `src/games/chess/rules.ts` — pure engine: mailbox-120 board, packed-int moves, make/unmake with undo stacks, pseudo-legal generation + make/attacked/unmake legality filter, `perft`, FEN codec, SAN, terminal detection.
- `src/games/chess/notation.ts` — UCI (`uciOfMove`, `normalizeUci`).
- `src/games/chess/render.ts` — ASCII render.
- `src/games/chess/index.ts` — default-exports `Game<ChessState, string>`; also exports `encodeChessState`/`decodeChessState` and the `ChessState` type for tests.
- `src/games/chess/tests/{perft,rules,playouts}.test.ts`.

## Exported API / integration facts

- **Move type is the UCI string itself** (`'e2e4'`, `'e7e8q'`, castling `'e1g1'`). `moveToNotation` is the identity; `parseMove` normalizes (trim/lowercase) and accepts UCI **only** — SAN, `'O-O'`, and bare `'e4'` are ParseErrors (index fallback is kernel-level).
- **Canonical legal-move order: UCI strings sorted lexicographically** (so promotions order b, n, q, r).
- **Seats:** p0 = White, p1 = Black, always. `initialState` throws unless exactly 2 players.
- **Seed draws: none.** Chess uses no randomness; `initialState`/`apply` never touch the SeedStream (purpose-tag list is empty).
- `playersToMove` returns `[]` on terminal states; `legalMoves` returns `[]` for the off-turn player and on terminal states. A side to move with no legal moves is always terminal (mate/stalemate), so the playout-harness "blocked player" rule never fires.
- `apply` RuleError codes: `game_over`, `not_your_turn`, `bad_move` (not UCI syntax), `illegal_move`.
- Events: one public `move` event per apply: `{ player, uci, san, capture }`.
- `moveSummary` produced (SAN + one-line description, capture/promotion/check flags) — rooms should ship it in legal_moves entries.
- Resignation / draw-by-agreement are room-level (per spec); the module has no such moves. No `defaultMove` (rooms use seeded random on timeout).

## Rules decisions (full FIDE, no simplifications)

- **Fifty-move rule: automatic draw at halfmove clock 100**, per build spec. Checkmate/stalemate are checked first, so a mating move that is also the 100th halfmove (or a third repetition) still wins/stalemates — matches FIDE art. 9.6 precedence. Terminal check order (deterministic, documented): mate/stalemate → insufficient material → threefold → fifty-move.
- **Threefold: automatic** on the third occurrence of the same position key = `board + side to move + castling rights + ep availability`.
- **En-passant field is FIDE-normalized**: state/FEN `ep` is set only when at least one *legal* ep capture exists (X-FEN style). Deviation from raw-FEN "always record after a double push", reason: repetition keys must use real ep availability, and the ep-pin case (capture would expose own king) must not count as availability. `decodeState` accepts non-normalized FENs and normalizes; legal-move sets are unaffected.
- **Repetition table (`state.reps`) is cleared whenever the halfmove clock resets to 0** (pawn move or capture = irreversible, earlier positions can never recur). Keys with different castling rights are distinct, so rights changes need no clearing.
- **Insufficient material — exactly the spec table**: K vs K, K+B vs K, K+N vs K, K+B vs K+B with both bishops on the same square shade. K+N+N vs K and opposite-shade bishops are NOT auto-draws (fixture-tested).
- Result reasons: `checkmate`, `stalemate`, `fifty_move_rule`, `threefold_repetition`, `insufficient_material`.

## encodeState format (exact grammar)

```
<FEN-6-fields> R[<key>*<count>|<key>*<count>|...] L[<uci>|<san>]
```

- FEN's ep field is the normalized one (see above).
- `R[...]`: repetition entries sorted by key; each key is `board64 turn castling ep` where board64 is the 64-char '.'-for-empty placement in FEN square order (a8..h1). Keys contain spaces but never `* | [ ]`, so parsing splits on ` R[` / ` L[` / last `*` / `|`.
- `L[-]` when no move has been played; otherwise `L[e1g1|O-O]` (SAN never contains `]` or `|`).
- `decodeState` also accepts a **plain 6-field FEN**: reps defaults to `{currentKey: 1}`, lastMove/lastSan null. Round-trip is exact (hash-equality checked in tests and every 50 playout moves by the harness).
- decode throws on garbage (bad field counts, missing kings, bad ranks/clocks/ep squares, bad segment syntax).

## Performance

- Movegen: mailbox-120, legality via make/unmake + `attacked()` scan. `perft` uses bulk counting at depth 1 (returns `genLegal().length` — identical to per-move counting since generation is fully legal).
- Measured in vitest on this machine: initial perft(5)=4,865,609 + Kiwipete perft(4)=4,085,603 + CPW positions 3/4/5 all in ~0.5s total (limit was 90s). 200 random playouts: ~1.7s.
- perft's fast path IS `genLegal` (no separate path), so `legalMoves` count === perft(1) by construction; pinned by explicit tests at both test positions.

## Test inventory (54)

- `perft.test.ts` (14): initial depths 1-5 (20 / 400 / 8,902 / 197,281 / 4,865,609), Kiwipete depths 1-4 (48 / 2,039 / 97,862 / 4,085,603), CPW positions 3 (14/191/2,812/43,238), 4 (6/264/9,467), 5 (44/1,486/62,379), legalMoves==perft(1) checks.
- `rules.test.ts` (38): ep capture + normalization + ep-pin illegality (with unpinned control); castling out of/through/into check, b1-attacked O-O-O allowed, rook+rights bookkeeping, no-rights case; promotion to all four pieces (+by capture, canonical order); fool's mate; stalemate; fifty-move auto-draw at 100 + mate-on-100th precedence + clock resets; threefold via knight shuffle + castling-rights-distinct keys + reps clearing; insufficient-material table (4 draws, 4 non-draws, capture-into-KvK); apply guards; parseMove/moveToNotation; moveSummary/SAN; codec round-trips + garbage rejection; renderText content.
- `playouts.test.ts` (2): 200 random playouts (all reasons in the legal set; harness checks codec every 50 moves) and `finalHashOfPlayout` determinism (same seeds equal, different picker diverges).

Random-playout profile (50-game sample): avg 320 plies, 78% draws (insufficient material > fifty-move), 22% checkmates, seats balanced.
