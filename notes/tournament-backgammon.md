# Tournament ruling — backgammon full-turn enumerator

Judge for spec `workflow.stage_3_tournaments` contest `backgammon full-turn enumerator`
("known dice-position fixtures including must-use-both and larger-die rules").

- Incumbent: `src/games/backgammon/` (Game object; one move = one complete turn).
- Candidate B: `src/games/backgammon/candidates/b.ts` (`legalTurns(pos, dice)`, mover-perspective signed board, `[]` = dance).
- Differential harness: `test/tournament/backgammon.test.ts` (re-runnable; deterministic seeds via `createSeedStream(sha256Hex(...))`; fails loudly with the smallest reproducing position — mover-perspective points array + dice + incumbent `encodeState` string).

## Equality model

Two complete turns are the same turn iff their multisets of `(from, to)` hops match; die
assignment is excluded (a fixed hop multiset always yields the same final board: the landing-point
set fixes the hits, counts are additive, and a die-assignment difference is only possible on
bear-off overshoots, which reach the identical board). This is exactly both engines' documented
dedupe rule — the incumbent's extra final-board hash in its key is redundant under this argument,
and no counterexample surfaced. A position matches iff the multiset-of-turn-multisets matches,
with dance normalized (incumbent: the explicit `{ hops: [] }` move; candidate: the empty list).

## Evidence (all green, `npx vitest run test/tournament/backgammon.test.ts`)

1. **30 shared ground-truth fixtures**, evaluated on BOTH engines from BOTH seats (validates the
   absolute-board mirroring both ways), asserting exact turn-set equality against hand-verified
   expectations: candidate B's 18 documented fixtures (B1–B18) + the incumbent's gate-A5 positions
   (F1–F8, F5b, F6a/F6b, die-agnostic bear-off, hit-en-route). Coverage per the spec rule lines:
   must-use-both in both orders (B2 small-die-first unlock, F1 large-die-first run), larger-die-only
   (B3, B14, F2), smaller-die-only (B4), bar-entry priority/partial block/dance (B5, B6, B8, B15,
   B16, F5, F5b, F7), bear-off exact vs overshoot with higher point occupied (B9, B10, F6a, F8, F9),
   doubles four-hop chains (B7, B8, B17, F4, F6b, B18), mid-turn bear-off activation (B11, B13, B18).
   Also checks the adapter itself: incumbent notation (`(n)` shorthand, `*` hits, `bar`/`off`)
   expands to exactly the hop-object multiset for every enumerated turn.
2. **Dice grid**: every fixture position × all 21 distinct rolls × both seats = 1,260 position
   comparisons, incumbent vs candidate. 0 divergences.
3. **Seeded random sweep**: 300 full games driven through the incumbent (`game:{g}` /
   `pick:{g}` seed tags), comparing the complete turn-set at EVERY turn position for the actual
   rolled dice: **27,185 turn positions** (1,295 of them dances; longest game 261 turns).
   0 divergences.

Incumbent + candidate unit suites also green as a baseline: `npx vitest run src/games/backgammon/` → 54 passed.

## Divergences found

None. The two engines are extensionally identical on full-turn enumeration across every fixture,
the dice grid, and 27,185 sampled positions — including the trap rules (must-use-both, larger die,
bar priority, bear-off overshoot legality) and the dedupe convention (die assignment excluded;
distinct intermediate routes kept distinct).

Pre-adjudicated equivalences (code-level differences that provably cannot diverge):

- Overshoot rule: incumbent allows overshoot only when `from === highestPoint`; candidate when no
  mover checker sits on `from+1..6`. Identical once bear-off is active (all checkers in 1..6).
- Maximality: incumbent DFS explores all die orderings from the remaining-dice multiset with a
  per-level tried-set; candidate enumerates both permutations (doubles: the single order ×4).
  Same reachable sequence set for 2 dice / doubles, then the same max-length + larger-die filter.
- Dedupe key: incumbent = sorted `(from,to)` multiset **+ final-board hash**; candidate = sorted
  multiset only. Equivalent because the multiset determines the board (argument above).
- Dance: incumbent's explicit no-play move ⟷ candidate's `[]`; normalized by the harness.

## Ruling

**Tie — the incumbent stays.** Judging criterion (fixture correctness) is fully met by both
engines with zero divergences, so the spec's tie-break applies. On simplicity the candidate is a
clean standalone enumerator but covers only enumeration; the incumbent's enumerator is of
comparable size and additionally carries the product's integration surface (apply-by-resimulation,
notation, codec, scoring), which the candidate would need rebuilt for no correctness gain. The
tournament rule "a tie means the incumbent stays" settles it: no code change to the product.

Re-run after any backgammon fix: `npx vitest run test/tournament/backgammon.test.ts`.
