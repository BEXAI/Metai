# Ludus build plan

Spec: `LUDUS_BUILD_SPEC.json` (repo root). Read your track's spec sections before coding.
This file is the coordination truth for interfaces, path ownership, and gates.

## Stage-0 decisions (already built — do not re-decide)

- **Kernel contract** in `src/kernel/types.ts`. Deviations from the spec interface, with reasons, are documented at the top of that file: `apply(state, player, move, seed)`, `playersToMove(state)`, `renderText(state, viewer)`, kernel-level `hashState`.
- **Players** are seat-ordered ids `p0`..`p5` (`playerId(seat)` / `seatIndex(p)`).
- **States and moves are plain JSON** (`Json` type). No classes, no Maps, no undefined inside states.
- **SeedStream** (`src/kernel/seed.ts`): HMAC-SHA256 purpose+counter streams, rejection sampling, Fisher–Yates. The algorithm is frozen; golden tests exist. Draw purposes must be stable and documented per game (e.g. `dice:turn:12`, `shuffle:chance`, `steal:turn:40`).
- **Canonical JSON + hashing** (`src/crypto/canonical.ts`): `canonicalJson`, `sha256Hex`, `hashJson`. Everything hashed/signed goes through these.
- **Log/replay shapes and all signing prefix strings** are frozen in `src/kernel/replay.ts`. Rooms produce, API serves, verifiers recompute — all four import from there.
- **Registry**: `src/games/index.ts` imports `src/games/<id>/index.ts` default export. Game tracks replace their own folder's stub `index.ts`; nobody edits the registry file.
- Imports use explicit `.ts` extensions (needed for `node --experimental-strip-types`).
- Tests live in `src/<area>/tests/*.test.ts` or `src/games/<id>/tests/*.test.ts`; cross-module tests in `test/`. Runner: `npx vitest run <paths>`. Typecheck: `npx tsc --noEmit`.

## Path ownership (strict — never edit outside your track; never touch package.json / tsconfig.json / vitest.config.ts / wrangler.jsonc / src/kernel/types.ts / src/kernel/replay.ts / src/games/index.ts)

| Track | Owner | Paths |
|---|---|---|
| T1 | kernel-engineer | `src/kernel/` (except types.ts, replay.ts, seed.ts, hash.ts, stub.ts — extend, don't rewrite; you MAY add files), `test/playouts.test.ts`, `test/verify-replay.ts` |
| T2 | crypto-engineer | `src/crypto/` (canonical.ts is done — build on it) |
| T3 | games-engineer-a | `src/games/{tictactoe,connect_drop,chess,checkers,reversi}/` |
| T4 | games-engineer-b | `src/games/{hex,nine_mens_morris,go,chinese_checkers}/` |
| T5 | games-engineer-c | `src/games/{backgammon,landlord,islanders}/` |
| T6 | rooms-and-agents-engineer | `src/rooms/`, `src/agents/` |
| T7 | api-and-identity-engineer | `src/index.ts`, `src/doc.ts`, `src/mcp.ts`, `src/api/`, `src/identity/`, `schema.sql` |
| T8 | match-engineer | `src/match/`, `src/integrity/` |
| T9 | spectator-web-engineer | `web/` |
| T10 | docs-writer | `docs/` |

## Cross-track interfaces (import points)

- Everyone: `src/kernel/types.ts` (Game, SeedStream, ViewObject, MoveSubmission, LegalMoveEntry, CONTENT_BOUNDARY), `src/kernel/seed.ts` (createSeedStream), `src/kernel/hash.ts`, `src/crypto/canonical.ts`, `src/kernel/replay.ts` (LogEntry, ReplayFile, prefixes).
- T1 must export: `src/kernel/view.ts#buildView(game, state, player, opts)` assembling ViewObject; `src/kernel/playout.ts` random-playout harness used by every game's tests (`runPlayouts(game, {games, seedPrefix, variant, players})` returning stats and throwing on illegal states); `src/kernel/verify.ts#verifyReplay(replay: ReplayFile): VerifyReport` — pure, no network, used by `test/verify-replay.ts` CLI and the browser verifier.
- T2 must export: `src/crypto/ed25519.ts` (verify(pubHex, message, sigHex), sign for tests/house use), `src/crypto/commit.ts` (makeCommitment, deriveFinalSeed, verifyCommitment — using the frozen prefix strings), `src/crypto/chain.ts` (appendEntry/verifyChain per replay.ts rule), `src/crypto/checkpoint.ts` (RFC 6962 Merkle root + sign/verify), `src/crypto/drand.ts` (quicknet fetch with injectable fetch fn; pure verify of round->randomness mapping is out of scope — record round + randomness).
- T6 consumes GAMES registry, buildView, crypto; produces LogEntry chains exactly per replay.ts; the DO class must be named `GameRoom` and exported from `src/rooms/room.ts` (re-export from `src/index.ts` happens in T7's file — T7 does the re-export, T6 just exports the class).
- T7 owns the Worker entry; re-export `GameRoom` from `src/index.ts`; D1 schema per spec `data_model.tables`; API per spec `api` section; MCP JSON-RPC 2.0 at `/mcp`; `/mcp/read` read-only door; plain-text front door at `/`; `/llms.txt`; `/openapi.json`; `/.well-known/mcp.json` — generated from ONE route table in `src/doc.ts`.
- T8 consumes D1 shapes from schema.sql (coordinate via spec data_model); Glicko-2 in `src/match/glicko2.ts` with a reference fixture test.
- T9 consumes only public HTTP API + `verifyReplay` compiled for the browser (write `web/verifier.js` as a hand-port or esbuild bundle via `npx esbuild` at build time into `web/public/`).
- House agents (T6): `random` baseline (seeded), `mock-llm` deterministic scripted adapter for tests, `anthropic` adapter reading `env.ANTHROPIC_API_KEY` (Worker secret; NEVER in repo). No key available in this build environment — e2e uses random + mock.

## Timeouts/strikes (frozen policy, spec §llm_player_protocol)

Illegal move: reject with reason, turn not consumed; 2nd illegal same turn: reject with full legal list; 3rd: seeded random legal move applied (`purpose 'illegal:turn:N'`) + strike. Timeout: game's `defaultMove` if present else seeded random legal (`purpose 'timeout:turn:N'`) + strike. Three strikes in a game = forfeit. Move clocks per game meta (chess 60s/move — for local e2e, rooms accept a `clock_scale` test override).

## Gates (spec §acceptance_tests) — owner in stage 1

A1 playouts T1+games · A2 determinism T1 · A3 chess perft T3 · A4 go T4 · A5 backgammon T5 · A6 landlord T5 · A7 islanders T5 · A8 randomness T2+T6 · A9 identity T7 · A10 leakage T1 harness + games · A11 LLM protocol T6 · A12 injection T6+T9 · A13 ratings T8 · A14 secrets T7 (+.gitignore done)

## Build-environment notes

- `wrangler` not authenticated → staging deploy deferred until `wrangler login`.
- No `ANTHROPIC_API_KEY` in env → house LLM matches use mock adapter locally.
- Deviation: built in `~/Desktop/Metai` (spec file location) instead of `~/ludus`; repo remote is github.com/BEXAI/Metai.
- Witness snapshot: GitHub Actions dispatch is stubbed behind an interface (`src/integrity/witness.ts`) — no GH repo secret configured in this build; recorded for REPORT.md.

## Track notes (append yours here — one line per decision/deviation)

- (stage 0) workers-types v5 required by wrangler 4.128.
