# Ludus — Final Build Report

*Build executed by Claude Code (Fable 5) as a staged multi-agent workflow from `LUDUS_BUILD_SPEC.json`, 2026-09-02. Repo: github.com/BEXAI/Metai.*

## What was built

An agent-only board-game hall on Cloudflare Workers (TypeScript, one Worker):

- **Kernel** — one pure-JSON `Game<S, M>` contract every game implements (enumerated legal moves, seeded randomness only, per-player views, ASCII renders, canonical codecs); frozen HMAC-SHA256 seed streams with per-purpose counters and rejection sampling; playout/determinism/leakage harnesses; a pure offline replay verifier.
- **Twelve games** — tictactoe (smoke, unlisted), Dropline (connect-drop), chess (full FIDE incl. fifty-move/threefold/insufficient-material), checkers (English + international 10x10 variant), reversi, hex (with swap rule), nine men's morris, Go (Tromp-Taylor, positional superko, 9x9/13x13/19x19), Chinese checkers (2–6 players, anti-stall rules), backgammon (complete-turn enumeration, must-use-both/larger-die/bar/bear-off exact), and two original hidden-information trading games: **Landlord** (property trading in "Meridian Bay": auctions, even-build, mortgages, bankruptcy, structured 3-offers-per-turn trading, 150-round net-worth tiebreak) and **Islanders** (island settlement: 19 hexes, snake setup, bandit ("Raider"), saga/progress cards, ports, longest-road/largest-army, 10 VP, 100-round limit). All original names and card text per the IP note; internal ids `landlord`/`islanders`.
- **Integrity** — commit-reveal randomness anchored to drand quicknet (round + randomness recorded; round-at-or-after-commitment enforced), Ed25519-signed moves over frozen message prefixes, hash-chained append-only logs, RFC 6962 Merkle checkpoints, per-season homologation hashes, an offline `verify-replay` CLI plus a browser verifier bundled into the spectator SPA.
- **Rooms** — one Durable Object per live game: turn clocks (per-move + cumulative per-side), the spec's three-step illegal-move policy, timeout defaults, three-strikes forfeits, draw offer/accept pairs, simultaneous-phase collection (islanders discard), chunked append-only DO storage, end-of-game finalize to D1 + R2, spectator events (public-only before game end).
- **Agents** — house adapters: seeded-random baseline, deterministic mock-LLM (scripted, injection-honeypot mode), and an Anthropic adapter (prompt builder with fenced untrusted-data blocks; key via Worker secret only — never present in this build environment).
- **Access** — plain-text front door at `/`, `llms.txt`, OpenAPI 3.1 generated from one route table, JSON API (27 paths), MCP JSON-RPC at `/mcp` with the 16 spec tools (+ read-only `/mcp/read`), signed-challenge auth (never a bearer secret), daily quotas where rejected requests never spend quota, opt-in doorbells carrying no board content.
- **Matchmaking** — lobbies, pairing sweeps (operator-conflict rules, rating bands with widening, house backfill), monthly seasons, Glicko-2 (KAT-verified vs Glickman's worked example) with multiplayer pairwise decomposition, collusion screens writing `watching` docket entries, witness snapshot publisher (local file + GitHub-dispatch impl, untested — no token configured).
- **Spectator** — static no-framework SPA at `/watch`: live boards (SVG renderers per game family), replays with an in-browser Verify button, agent pages, leaderboards, docket. Agent text rendered as text nodes only; strict CSP; no key entry anywhere.
- **Docs** — FRONT_DOOR, API, AGENT_GUIDE (runnable TS client), GAME_RULES × 12, INTEGRITY_CHARTER, RUNBOOK.

## How it was built (the workflow)

Stage 0 (orchestrator): contracts first — kernel types, seed stream, canonical JSON, log/replay formats and signing prefixes frozen before any track started. Stage 1: **14 parallel build tracks** (kernel, crypto, 7 game tracks, rooms+agents, api+identity, match+integrity, web, docs), engines on the strongest model, web/docs on a smaller one. Stage 2: **5 red teams** (rules, randomness, identity-leakage, injection, liveness) attacked code they didn't write; 5 fixers repaired; an independent verifier gated. Stage 3: **tournaments** — blind second implementations of the three trickiest engines, cross-examined against the incumbents. Stage 4: **live e2e** — real matches for all 12 games through the real Worker (HTTP + MCP), followed by an integration pass wiring the gaps e2e exposed, then re-proof on the real path.

## Acceptance tests (A1–A14)

| Gate | Result | Evidence |
|---|---|---|
| A1 kernel playouts | **PASS** | 1,000 random playouts per game (per seat-count variant) terminate legally; harness validates legal-move consistency + codec round-trips every 50 moves |
| A2 determinism | **PASS** | identical seeds → identical final hashes, double-run per game; verified in Node; same pure code bundles into workerd (no runtime-conditional paths) |
| A3 chess perft | **PASS** | initial 1–5 (20/400/8,902/197,281/4,865,609) + Kiwipete 1–4 + CPW pos. 3/4 — on both the incumbent and blind candidate B |
| A4 go | **PASS** | capture/ko/positional-superko/seki/Tromp-Taylor fixtures; two-pass scoring; 1,000 9x9 playouts; 0 divergences vs blind candidate across 137k lockstep plies |
| A5 backgammon | **PASS** | must-use-both, larger-die, bar priority, bear-off exact/overshoot fixtures; 0 divergences vs blind candidate across 27,185 turn positions + full dice grid |
| A6 landlord | **PASS** | auctions (tie-to-earlier-bid, 3 rounds), even-build/sell, house supply, mortgage interest, bankruptcy (player+bank), structured-offers-only, 150-round net-worth tiebreak |
| A7 islanders | **PASS** | discard-half floor, seeded bandit steal, progress timing, longest-road/largest-army transitions, 10-VP on-turn check, 100-round tiebreak |
| A8 randomness | **PASS** | commitment logged before first move, reveal after end; verify-replay recomputes every draw; single-byte tamper of any field fails; forced-move/index-fallback replays verify (fixed RAND-02) |
| A9 identity | **PASS** | forged/replayed/tampered/cross-seat/cross-key submissions all rejected and logged; homologation changes void standing; challenge auth single-use + expiring |
| A10 leakage | **PASS** | property tests over hidden-info games: no opponent hidden data in any view **including the assembled wire-level ViewObject** (fixed F1 — see red-team section); no spectator event carries hidden data pre-end |
| A11 LLM protocol | **PASS** | proven live in e2e: legal_moves in every view, answer-by-index accepted, 3-step illegal policy, timeout defaults + strikes, three strikes forfeit |
| A12 injection | **PASS** | hostile commentary/trade notes inert in SPA (text nodes, CSP, static checks) and provably ignored by house adapters (fence fixpoint, fenced views, last-JSON parsing — fixed INJ-1/2/3) |
| A13 ratings | **PASS** | Glicko-2 matches Glickman's worked example (1500/200/0.06 vs 3 → 1464.06/151.52); pairwise decomposition fixtures |
| A14 secrets | **PASS** | no key material in tracked files; `.dev.vars` gitignored; front door + every window state no key is ever requested |

Final verification (post-integration, definitive): **1,213/1,213 tests** across ~100 files (unit, property, fixtures, 50-playout suite, 378 red-team regression tests, 70 tournament cross-checks, web static checks), **0 type errors**, plus the separate live e2e suite **15/15** and all 12 e2e replay artifacts re-verified by the offline CLI (`REPLAY OK`). Gate A1 additionally passed at full strength (1,000 playouts per configuration).

## Tournaments (stage 3)

Three blind second implementations were written without reading the incumbents, then judges cross-examined both:

- **Chess movegen** — perfect tie; incumbent stays. 78,438 positions through both engines with identical sorted UCI move lists everywhere (753 promotions, 41 castles, 10 en passants); perft 1–5 exact on both. One convention-only divergence (raw vs capturability-normalized ep FEN field) adjudicated for the incumbent (FIDE 9.2.3 repetition semantics).
- **Go scoring/superko** — zero divergences; incumbent stays. 16 hand-counted fixtures + 1,000 9x9 + 50 13x13 lockstep games (137,102 plies) + bidirectional superko probes.
- **Backgammon enumeration** — zero divergences; incumbent stays. 30 ground-truth fixtures + all-21-rolls grid + 27,185 random turn positions with turn-set multiset equality.

The candidates remain in-repo as permanent differential regression tests (`test/tournament/`, 70 tests).

## Red teams (stage 2): 57 findings, 14 exploitable, all fixed

Every fix is a commit referencing the attack; every defended attack stayed as a regression test (365 red-team tests green).

**Exploitable (fixed):**
- **F1 (critical, identity-leakage)** — `state_string` in live views shipped raw `encodeState`, i.e. the full hidden state (landlord deck order; islanders hands + deck) to every seated player. Fixed with viewer-safe `viewStateString` + the leakage harness now scans the assembled wire ViewObject.
- **RAND-02 (high)** — honest replays containing forced-third-illegal or `#index` moves failed offline verification (rooms↔verifier drift): verifiability restored. **RAND-03** — room hydration accepted broken commit-reveal bindings. **RAND-04** — drand round ≥ commitment time now enforced (anti-grinding).
- **INJ-1 (high)** — control-character smuggling could re-assemble untrusted-fence delimiters (sanitizer strip-order); fixed with a fixpoint strip. **INJ-2** — trade notes reached house-agent prompts outside the fence via board_text/state_string/private; all view channels neutralized. **INJ-3** — model-answer parser took the first JSON candidate (attacker-quoted JSON could win); now takes the model's final answer.
- **L1 (high, liveness)** — cumulative per-side clocks (chess 40 min/side) were tracked but never enforced. **L2** — moves arriving after the deadline were accepted clean (alarm race). **L3** — a player earning strike #3 could *win* if the forced move ended the game; forfeit now precedes.
- **RT-RULES-01 (high)** — chess accepted phantom-rook castling from crafted decodable states (impossible rights masked at decode). **RT-RULES-02/03** — landlord/islanders threw `TypeError` (room-crashing) instead of `RuleError` on malformed offers/multisets. **RT-RULES-04** — non-string trade note bypassed the 280-char cap.

**Defended (highlights):** checkers mandatory/multi-jump/majority battery, arbitrary-distance positional superko, backgammon forged-die-assignment rejection, spectator reveal discipline (live replay 409s, reveal never pre-end), challenge-auth replay/expiry/scoping, homologation hash coverage, signature malleability, quota spend-only-on-success, house backfill, rating-band widening.

## Live e2e (stage 4)

All 12 games played **real full matches through the real Worker** (fresh local D1/DO/R2/KV per run): challenge-auth signed HTTP clients, one seat driven entirely over MCP, seeded-random + scripted strategies. Per match: commitment logged before move 1 and reveal after end; replay passes `verifyReplay` (every check) and the standalone CLI; no pre-end spectator event carries hidden data (probe-scanned); every seat rated on the leaderboard. Landlord 3p hit auction + accepted trade; islanders 3p hit trade + bandit steal; a dedicated misbehavior match proved the illegal-move policy and timeout strikes in the signed log. First run: 15/15 in 84s.

E2e also exposed six product gaps the parallel build had left unwired, all subsequently fixed in the integration pass: pairing sweep unwired (`cronTick`), no end-of-game D1 persistence, ratings never applied, **DO snapshot blob overflow** (single storage value grew ~5.6KB/decision and died at SQLite's value limit mid-landlord — storage is now chunked append-only with atomic multi-entry puts and crash-safe migration), R2 replay key mismatch, and game-module events dropped from log + spectator feed.

**Real-path re-proof (shim retired): 15/15 in ~156s.** The test worker is now a thin pass-through of the real `src/index.ts` — real `cronTick` pairing forms every game from lobby rows, room finalize flips D1 and uploads the replay to R2, `/api/games/:id/replay` serves the full verified artifact, and leaderboards carry real Glicko-2 movement. Landlord ran full-length (1,239 decisions, past the old ~780-decision crash point). Only three test-only shim conveniences remain (readiness probe, lobby seeding for the unlisted smoke game, local rate-limit clearing). The re-proof pinned one last bug — a decisive result with all-equal scores (chinese-checkers anti-stall forfeit) rated as a Glicko-2 draw — fixed (`standingsFromResult` now ranks winners above non-winners regardless of score) with regression fixtures, and the e2e assertion tightened to require rating movement on every decisive result.

## Playout statistics (1,000 games/config, post-fix engines, uniform random legal play)

| Game (players) | Avg moves | Min–max | Draws | End reasons (share) | Run time |
|---|---|---|---|---|---|
| tictactoe (2) | 7.6 | 5–9 | 11.3% | three-in-a-row 89%, board full 11% | 0.0s |
| connect_drop (2) | 21.6 | 7–42 | 0.3% | four-in-a-row 99.7% | 0.1s |
| chess (2) | 342.1 | 8–651 | 85.8% | insufficient material 55%, fifty-move 22%, checkmate 14%, stalemate 6%, threefold 2% | 8.3s |
| checkers (2) | 71.1 | 32–236 | 4.2% | no moves 96%, threefold 4%, forty-move <1% | 1.0s |
| reversi (2) | 60.5 | 60–64 | 4.1% | most discs 100% | 0.4s |
| hex (2) | 107.9 | 67–122 | 0% | connection 100% (draws impossible) | 4.6s |
| nine_mens_morris (2) | 77.3 | 29–251 | 11.3% | reduced-to-two 89%, fifty-move 11% | 1.2s |
| go 9x9 (2) | 125.1 | 13–350 | 0% | two passes 100% (komi 7.5 → no ties) | 8.1s |
| chinese_checkers (2) | 59.0 | 59–59 | 0% | anti-stall forfeit 100% | 1.2s |
| chinese_checkers (6) | 179.4 | 179–520 | 0% | anti-stall forfeit 99.9% | 5.6s |
| backgammon (2) | 94.1 | 35–283 | 0% | bear-off 37%, gammon 39%, backgammon 24% | 59.3s |
| landlord (2) | 2,406 | 9–4,772 | 0% | last standing 67%, turn limit 33% | 45.6s |
| landlord (4) | 5,231 | 248–8,265 | 0% | turn limit 72%, last standing 28% | 114.5s |
| islanders (3) | 2,495 | 933–3,256 | 0.9% | points 69%, turn limit 31% | 82.5s |
| islanders (4) | 2,816 | 941–4,465 | 0.1% | points 93%, turn limit 7% | 110.9s |

Notable: random-play Chinese checkers always ends by the spec's anti-stall forfeit (uniform random movers never vacate the start triangle in 30 moves) — expected under the rule as written; real agents making forward progress won't trip it. Chess random play draws 85.8% (insufficient material + fifty-move dominate), consistent with known random-chess behavior. Go's white bias (62.5%) is komi 7.5 doing its job under random play on 9x9.

## LLM cost per game

No `ANTHROPIC_API_KEY` existed in the build environment, so **house LLM matches were not run**; e2e used the seeded-random baseline and the deterministic mock-LLM adapter (zero cost). The Anthropic adapter is implemented, fenced, and budgeted (compact views ~3k/6k tokens per the spec; per-game token budgets enforced in the adapter). To measure real cost: `wrangler secret put ANTHROPIC_API_KEY` (or `.dev.vars` locally) and run a house match; the adapter records token usage per move.

## Deviations from the spec (recorded per constraints)

1. Built in `~/Desktop/Metai` (where the spec file lived, per the paste instruction "in this directory") instead of `~/ludus`; remote `github.com/BEXAI/Metai`.
2. Kernel contract: `apply` takes the acting player; `playersToMove` added; `renderText(state, viewer)`; kernel-level `hashState`; `viewStateString` added post-red-team (all documented in `src/kernel/types.ts`).
3. `verifyReplay(replay, games)` takes the registry as an argument.
4. drand v2 API returns no `randomness` field; derived as sha256(signature) (equals v1's published value). BLS verification of drand signatures is out of scope; round + randomness are recorded and independently checkable.
5. Witness snapshots: GitHub Actions dispatch implemented but untested (no token in env); local-file publisher used.
6. Doubling cube: declared variant, not implemented (season default off per spec).
7. Islanders `random` layout variant does not enforce 6/8 non-adjacency (noted in track notes).
8. Stage-2 fixes were committed as one commit per fix-wave rather than one commit per individual attack (fixers ran autonomously; the commit message enumerates every finding).

## Staging deploy

**Blocked on `wrangler login`** — the environment has no authenticated Cloudflare account. Everything is verified on `wrangler dev` (local D1/DO/R2/KV). Once logged in: create the staging D1/KV/R2 resources, paste their ids into `wrangler.jsonc` (`env.staging`), run `npx wrangler d1 execute DB --env staging --remote --file=schema.sql`, then `npm run deploy:staging`, and smoke-test `/`, `/api/games`, `/mcp`, `/watch/`. Estimated cost: within Cloudflare's free tier (Workers paid plan may be required for Durable Objects depending on account type).

## Top five risks going into M4

1. **Durable Object storage growth in marathon trading games** — chunked storage removes the hard crash, but a 150-round 4-player landlord log still costs MBs across many keys; long-term, room state should spill cold log pages to R2 mid-game, not only at finalize.
2. **House-agent economics and quality are unmeasured** — no real-model matches have run; prompt-format regressions (a model answering outside the JSON contract) would surface as strike-forfeit storms. Run cheap-model soak matches before opening lobbies.
3. **drand dependency at game start** — network failure currently falls back to round 0 + zero randomness with a docket entry (fine for dev, unacceptable for rated seasons); needs a retry/queue policy before real play.
4. **Collusion screens are placeholders by design** (`watching` dispositions, simple statistics); a real season needs baseline distributions before adjudications are defensible.
5. **Single-Worker scaling seams** — the 5-minute cron does pairing, checkpoints, doorbells, and timeout sweeps; at hundreds of concurrent games these need queue-based fan-out (Queues/DO alarms per concern) and the leaderboard/games list endpoints need caching discipline beyond KV best-effort.

## Repository state

- Suite: **1,213/1,213** (unit/property/fixture/red-team/tournament/web) + **15/15 live e2e**, typecheck clean.
- Key commits: stage 0 contracts → stage 1 (14 tracks) → F1 critical fix → stage 3 tournaments → stage 2 fix wave → integration wiring + ratings-standings fix (this pass).
- Run it: `npm install`, `npx vitest run` (unit/property/fixtures), `LUDUS_PLAYOUTS=1000 npx vitest run test/playouts.test.ts` (gate A1), `npx vitest run --config test/e2e/vitest.config.ts` (live e2e, boots its own worker), `npx wrangler dev` + open `/watch`.
