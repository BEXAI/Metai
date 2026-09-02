# Tournament ruling — Go scoring and superko

Judge: stage-3 tournament (spec `workflow.stage_3_tournaments`: "fixture suite for
capture, ko, superko, seki; 1,000 9x9 playouts; scores match a reference
implementation"). Adjudicated against the Tromp-Taylor rules text in spec
`games.M2_large_boards_and_multiplayer.go` and acceptance A4.

- **Incumbent:** `src/games/go/` (Game object; state carries FNV position-hash
  history including the current position; superko = resulting hash already in
  the set; suicide checked before superko; area scoring by reach).
- **Candidate B:** `src/games/go/candidates/b.ts` (`applyGoMove`/`scoreArea` on
  `number[][]` boards; exact whole-board string keys; caller-maintained history).
- **Differential suite:** `test/tournament/go.test.ts` (re-runnable, seeded via
  `createSeedStream(sha256Hex(...))`; every mismatch throws with the incumbent's
  encoded state string before the move + the diverging move as the repro).

## Driving convention (fixes candidate B's caller-contract degrees of freedom)

- Board mapping: incumbent index `row*size+col` (row 0 = bottom) ↔ candidate
  `Board[row][col]`, same row indexing.
- Candidate `history` mirrors the incumbent's hash-set semantics: contains every
  position seen **including the current one** (this is what makes single-stone
  suicide under `allow_suicide` fall to superko in both engines, which is the
  Tromp-Taylor-correct outcome — the "board unchanged" position repeats).

## What ran (all green, `npx vitest run test/tournament/go.test.ts`)

1. **16 shared fixtures**, each evaluated by BOTH engines (incumbent via its
   Game interface — `decodeState` with `hashes=auto` + move sequences; B via
   boards): single/multi/corner/edge capture, double capture in one move,
   occupied + out-of-bounds rejects, simple ko (barred then legal after an
   exchange), sending-two-returning-one positional superko, suicide default
   (single + multi), `allow_suicide` variant (multi allowed identically,
   single barred via superko), Tromp-Taylor scores at komi 7.5 AND 0
   (split-columns 36:36+komi, corner seki 40:39+komi with 2 neutral shared
   liberties, empty-board 0:komi incl. komi-0 draw, lone-stones dame case,
   all-one-color case), pass superko-exemption, capture-then-two-pass area
   bookkeeping. Score expectations are hand-counted from the rules text, not
   taken from either engine.
2. **Differential sweep:** 1,000 seeded random 9x9 playouts driven by the
   incumbent's `legalMoves` (uniform incl. pass), every move mirrored into B —
   asserting identical legality verdict, identical capture count, identical
   resulting board every ply, and identical final area scores + winner at game
   end (123,789 total plies; sanity floor asserted). Plus 50 games on 13x13
   (13,313 plies) and 20 games on 9x9 with `allow_suicide: true`.
3. **Superko cross-check at every ply:** up to 3 sampled empty points the
   incumbent does NOT list must be B-illegal, and 3 random empty points must
   get the same verdict from both engines (catches asymmetric superko/suicide
   handling in either direction). Several hundred thousand sampled probes over
   the 137k plies.

## Divergences found

**None.** Every legality verdict, capture count, board, and score agreed across
all fixtures and 1,070 playouts. Points examined and dismissed:

- *Suicide-vs-superko precedence:* both engines check self-capture before the
  repetition check, so a default-rules single-stone suicide reports "suicide"
  in both; verdict parity regardless of code.
- *Candidate `captured` on multi-stone suicide is 0* while the incumbent
  credits suicided stones to the opponent's tally — the incumbent's `capB/capW`
  are documented display-only (scoring is pure area in both), so this is a
  reporting convention, not a rules divergence; boards matched exactly.
- *Hash exactness (implementation-risk note, not an observed divergence):* the
  incumbent detects repetition via a 64-bit FNV-1a hash of the board, candidate
  B via the exact board string. An FNV collision would make the incumbent
  reject a legal move; probability over a game's few hundred positions is
  ~1e-14 and it never fired in 137k plies. Candidate B is strictly more exact
  here, but this is unobservable in practice and does not outweigh the tie rule.

## Ruling

**Tie → incumbent stays.** The engines are behaviorally identical over the
entire judged surface. On the simplicity tiebreak the incumbent also stands:
it is a complete Game-contract module (legal-move enumeration, codec, events,
scoring result mapping) whose per-move work is comparable, while candidate B
covers only apply+score with the superko history pushed onto the caller.
No changes required to product code.
