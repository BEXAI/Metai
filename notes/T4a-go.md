# T4a-go — track notes

Owner: games-engineer (go). Files: `src/games/go/{rules,notation,render,index}.ts`, `src/games/go/tests/{rules,playouts}.test.ts`.

## Exported API

- `src/games/go/index.ts` default-exports `Game<GoState, GoMove>` (id `go`, listed).
- `rules.ts` exports for tests/tools: `GoState`, `GoMove`, `boardHash`, `resolvePlay`, `checkPlay`, `enumerateLegal`, `applyGo`, `scoreGo`, `goResult`, `initialGoState`, `encodeGo`/`decodeGo`, `neighborIndices`, `GO_SIZES`, `GO_KOMIS`, char consts `EMPTY/BLACK/WHITE`.
- `notation.ts` exports `GO_LETTERS` (`ABCDEFGHJKLMNOPQRST`, no I), `colLetter`, `pointToNotation`, `goMoveToNotation`, `parseGoMove`.

## Rules implemented (Tromp-Taylor, exact)

- 9x9 default; variants `board_size` (9/13/19), `komi` (7.5 default; 6.5/5.5/0.5/7/0), `allow_suicide` (false default). Variant values validated strictly in `initialState` (throws on anything off-list).
- Play resolution order: place stone → remove libertyless opponent groups (distinct enemy groups are never adjacent, so removal order is safe) → self-capture check → positional-superko check.
- Positional superko: `state.hashes` holds a cheap deterministic hash (two FNV-1a 32-bit passes → 16 hex chars, `Math.imul`-based, identical across runtimes) of every board position seen **including the current one**. A play whose resulting board hash is already present is illegal (`code: 'superko'`). Simple ko falls out of this; so does single-stone suicide under `allow_suicide` (board unchanged → recreates current position).
- Suicide: default illegal (`code: 'suicide'`); `allow_suicide` permits multi-stone suicide. Suicided stones are added to the *opponent's* capture tally (`capB`/`capW` are display-only; scoring is pure area).
- Two consecutive passes → `ended`; `isTerminal` then scores: stones + empty regions reaching only one color; empty regions reaching both/neither are neutral. White gets komi. Result `reason: 'two_passes'`, `scores: {p0, p1}` (p1 includes komi); tie → draw (only possible at integer komi).
- Black is always seat p0, White p1. **Zero seed draws** — go has no randomness; `initialState`/`apply` ignore the SeedStream (documented, so verify-replay expects an empty draw list from this game).
- `defaultMove` = pass (deterministic timeout action).

## Board / codec / notation conventions

- Board string: `size*size` chars `. X O`, index = `row*size + col`, **row 0 = bottom** (A1 = index 0).
- Moves: `{pass:true}` or `{pass:false, col, row}` (0-based). Canonical legal order: plays by ascending board index (A1, B1, … row-major bottom-up), `pass` always last. Empty 19x19 ships 362 entries (fits under the 5,000 cap; no `legalMovesPaged` needed).
- Notation: `E5` (col letter skipping I + 1-based row), lowercase accepted, output uppercase; `pass` lowercase. `parseMove` accepts only this grammar (index fallback is kernel-level).
- State string (13 pipe-separated fields): `go1|size|komi|suicide01|toMove(B/W)|passes|capB|capW|board|last|hashes|moves|ended01`. `last` is `B[E5]`/`W[pass]`/`-`; `hashes` comma-joined; `moves` is the SGF-style list `B[E5];W[pass];…` or `-`. Decode accepts `hashes=auto` → seeds the superko history with just the given board (used by test fixtures to compose positions directly). `decode(encode(s))` is exact (playout harness verifies hash equality every 50 moves).
- Render: column letters on BOTH top and bottom edges (spec trap), row numbers both sides, `+` star points (9: 5 pts, 13: 5 pts, 19: 9 pts), last move wrapped `( )`, capture counts, komi, pass count, status line; viewer p0/p1 gets a "You are …" line (perfect info — same board for everyone).

## Tests (27 passing: 23 rules + 4 playout)

Single/multi/corner/edge capture; occupied/out-of-turn rejects; simple ko forbidden immediately then legal after an exchange; **sending-two-returning-one** (White captures TWO, Black's returning throw-in would recreate the position 3 plies back — rejected `superko`; simple ko would have allowed it); suicide rejected by default, 3-stone suicide allowed under variant, single-stone suicide rejected under variant via superko; two-pass end + pass-counter reset + post-end rejects; exact area fixtures (empty board 0:7.5, split-columns 36:43.5, seki corner 40:46.5 with the two shared liberties neutral); komi-0 draw; notation incl. `I` skip and `t19`; codec round-trip + malformed rejects; renders for 9x9/19x19. Playouts: 1,000 random 9x9 (avg ~128 moves, all end `two_passes`), 13x13 + 19x19 smoke (10 each, `maxMoves: 40_000`), determinism via `finalHashOfPlayout` twice (9x9 and 13x13).

## Deviations / judgment calls

- Spec's "SGF-style move list plus board hash" state string: implemented as the full-field codec above (move list + entire hash history) because positional superko needs the whole position-hash set to survive encode/decode round-trips.
- Position hash is FNV-1a (fast, deterministic) rather than sha256 — spec explicitly allowed a cheap hash; collision odds over ≤ a few hundred positions/game are ~1e-14.
- Komi variant is a fixed values list (VariantSpec requires one); off-list komi throws.
- Capture tallies count suicided stones for the opponent (display-only convention; does not affect area scoring).
