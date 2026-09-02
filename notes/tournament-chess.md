# Stage-3 tournament — chess move generation

Judge run: 2026-09-02. Suite: `test/tournament/chess.test.ts` (re-runnable, deterministic seeds via `createSeedStream(sha256Hex(...))`). Result: **19/19 passed** (`npx vitest run test/tournament/chess.test.ts`, ~4 s).

## Contestants

- **Incumbent** — `src/games/chess/` (Game object; mailbox-120; used by the live product).
- **Candidate B** — `src/games/chess/candidates/b.ts` (independent blind build; 0x88; `legalMovesFromFen` / `applyUci` / `perftFromFen` on plain FEN).

## What was measured

1. **Spec criterion, perft 1-5 initial** (20 / 400 / 8,902 / 197,281 / 4,865,609): exact for BOTH engines. Incumbent measured two ways: (a) its importable engine helper `rules.perft` for depths 1-5, and (b) a pure public-Game-interface walk (`legalMoves`/`apply`) for depths 1-4 — both exact.
2. **Differential sweep**: 340 seeded games (300 from the initial position + 40 feature-start games) driven through the incumbent Game interface with uniform random legal moves. At every one of **78,438 positions**: plain FEN extracted from `encodeState` (cross-checked against `publicView().fen`), sorted UCI legal-move lists compared incumbent-vs-B — **identical everywhere**. Every applied move's resulting FEN core (placement, side, castling, ep-by-capturability, halfmove, fullmove) compared — **no rule divergence**. Coverage counters: 753 promotions (577 underpromotions), 19 white + 22 black castles, 10 en-passant captures.
3. **Fixtures**: Kiwipete, CPW positions 3 and 4 — depth-1 move lists identical (48 / 14 / 6) and perft(3) exact for both engines (97,862 / 2,812 / 9,467).

## Divergences found

### D1 — FEN en-passant field convention (convention-only; 1,964 occurrences; adjudicated for the incumbent)

Smallest repro: apply `e7e5` from `rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1` → incumbent FEN ep `-`, candidate B ep `e6`. (Same thing in B's own test: `applyUci(START,'e2e4')` → `... e3 0 1`.)

- Incumbent records the ep target **only when a legal ep capture exists** (X-FEN style) — a deliberate, documented decision (`notes/T3a-chess.md`): repetition keys must use *real* ep availability per FIDE art. 9.2.3 (a position differs only if an ep capture is actually possible, including the ep-pin case), and the module's threefold detection is built on those keys.
- Candidate B records the raw ep target after **every** double push — the classic FEN/PGN-export convention. Also standards-compliant in isolation, but it does not match this module's documented state-string contract, and raw ep squares used as repetition keys would under-count threefold repetitions.
- Judged by **capturability** (each engine normalized with its OWN legal-move list), the two engines agreed at all 1,964 positions — zero semantic ep divergences, and B's legal-move sets are unaffected (it generates the ep capture only when a pawn is adjacent and drops it via its legality filter when pinned). Ruling: not a move-generation error; within this codebase the incumbent's convention is the correct one.

No other divergence of any kind was found: no legal-move set differences, no placement/side/castling/halfmove/fullmove differences, no crashes, no illegal-move acceptance.

## Verdict

**Incumbent stays.** Both engines are FIDE-correct on every judged criterion (perft 1-5 exact; 78,438 sweep positions ≥ the 10,000-playout-positions criterion without error; fixtures exact), so this is a tie, and per the spec ties break on simplicity / incumbent retention. The incumbent additionally carries the product-required surface B does not implement (SAN, terminal detection incl. threefold/fifty-move/insufficient material, repetition-aware codec, renders) and its ep convention is the one the product's repetition logic depends on. Candidate B is a high-quality independent confirmation of the incumbent's move generator.

## Re-run

```
npx vitest run test/tournament/chess.test.ts
```

Deterministic; passes while the engines agree, fails with the smallest reproducing FEN (plus shard/game/ply) on any divergence.
