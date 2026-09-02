# T8 — match & integrity (src/match/, src/integrity/)

## Status

All seven deliverables built and green: 59 tests across 6 files
(`src/match/tests/{glicko2,pairing,seasons}.test.ts`,
`src/integrity/tests/{screens,docket,witness}.test.ts`). Gate A13 KAT passes
(Glickman worked example, tau 0.5: 1464.06 / 151.52 / 0.05999 within
0.5 / 0.5 / 0.001). `tsc --noEmit` clean for both folders.

## Exported API (what integration wires)

### src/match/glicko2.ts
- `rate(player {rating, rd, vol}, results [{opponentRating, opponentRd, score}], tau=0.5)` —
  one call = one rating period; empty results = paper step-6 RD inflation, capped at `MAX_RD` 350.
- `pairwiseResults(standings [{agent_id, rating, position}])` — multiplayer pairwise
  decomposition (better position = 1, tie = 0.5); all pairs go into ONE `rate()` call.
- `standingsFromResult(seatAgents, GameResult)` — positions from a kernel result:
  scores present → rank desc with competition ranking; draw & no scores → all tie;
  else winners = 1, rest = 2.
- `DEFAULT_GLICKO2` (1500/350/0.06), `PROVISIONAL_GAMES` = 20, `isProvisional(gamesPlayed)`.

### src/match/lobby.ts
- `LobbyRow { game, variant, division, agent_id, joined_at }` — matches
  data_model.tables.lobby. **`variant` is an opaque string key** throughout the match
  layer (recommended: canonicalJson of the VariantConfig); GameFactory decodes it.
- `LobbyRepo { join (idempotent), leave, list, remove }` — T7 implements over D1;
  `MemoryLobbyRepo` for tests. `lobbyEntryKey`/`queueKey` join with U+0000 (NUL)
  (cannot appear in canonical JSON output → no collision).

### src/match/pairing.ts
- `runPairingSweep(lobby, state, cfg) -> { created: [{game_id, command}], state }` —
  pure-ish sweep; call from the cron/scheduler.
- `PairerState { sweeps }` is serializable (store in DO/KV between sweeps);
  `initialPairerState()`.
- `PairerConfig`: `seatsFor(game, variant)`, `info(agentIds, queue)` →
  `{agent_id, operator_id, rating, house}`, `houseAgents.available()`,
  `secrets` (SecretProvider), `factory` (GameFactory), band tuning knobs.
- `GameFactory.createGame({ game, variant, division, seats }) -> game_id` — the ONLY
  side-effect door; T7/T6 implement against the GameRoom DO. `seats` = agent ids in
  seat order (seat i → playerId(i)).
- `CryptoSecretProvider` (crypto.getRandomValues 32 bytes) / `testSecretProvider(label)`.

### src/match/seasons.ts
- `seasonIdFor` ('YYYY-MM' UTC), `seasonBounds`, `dailyPeriodBounds(now)` →
  the daily period ending at the latest 00:00 UTC.
- `ensureSeason(now, rulesetVersions, repo)` — idempotent, pins
  `ruleset_versions_json` write-once.
- `closeRatingPeriod(periodEndUtc, finishedGames, ratingsRepo, {inflateIdle=true})` —
  groups by (game, variant, division, season); ONE batched `rate()` per agent with
  opponents at start-of-period ratings; `games_played += games` (not pairs); idle
  rated agents get RD inflation.
- `closeSeason(seasonId, seasons, ratings, finishedGames)` — marks closed, returns
  final tables keyed by space-joined `game variant division` (JSON-friendly;
  iterate, don't parse), each sorted by rating desc with
  wins/losses/draws/rating/rd/provisional/games_played.
- Repos: `SeasonRepo`, `RatingsRepo { get, listAll, upsert }` + Memory impls.
  `FinishedGame { game_id, game, variant, division, season_id, ended_at, seat_agents[], result }`
  — T7/T6 build these from the games table at cron time.

### src/integrity/docket.ts
- `DocketRepo { append, list({kind?, since_id?, limit?}) }` — append-only BY INTERFACE
  (no update/delete methods exist); `MemoryDocketRepo` for tests; T7 implements over
  D1 and serves `list()` verbatim at /api/docket (ascending id).
- Dispositions: 'watching' (automated screens — the only one this build writes),
  'adjudicated', 'cleared', 'noted' (manual).

### src/integrity/screens.ts
- `screenResignations(ScreenGame[], {percentile=0.9, minSamples=20})` — flags a
  resignation whose FINAL SCORE sits at/above the 90th percentile of all final
  scores pooled per (game, variant). Games without score tables (chess etc.) are
  skipped — documented limit; a positional eval is out of scope this build.
- `screenTradeBias(TradeRecord[], {minNet=15, minGames=3, minImbalance=0.5})` —
  net value between one OPERATOR pair across ≥3 distinct games, with an
  imbalance ratio (|net|/gross) so high-volume balanced traders aren't flagged.
  Same-operator (house-house) trades ignored. Rooms report `value` per trade
  (card count / pip value — no market model).
- `fileFlags(flags, docket, now?)` — appends with disposition 'watching',
  deduped by (kind, sha256(subject)) via `subject_sha256` embedded in
  subject_json, so repeated cron sweeps don't spam.

### src/integrity/witness.ts
- `buildWitnessSnapshot(when, {root, tree_size, signature}, leaderboards[]) ->
  { version:'ludus.witness.v1', date, checkpoint, leaderboard_hashes, content_sha256 }`;
  `witnessJson()` = canonical bytes.
- `LocalFilePublisher(dir)` — writes `witness/<date>.json` (node:fs via dynamic
  import; used for this build's daily snapshot).
- `GitHubDispatchPublisher({owner, repo, token, eventType?, fetchFn?})` — POSTs a
  repository_dispatch with the snapshot as client_payload. **Code-complete but
  untested against the live GitHub API** (no token in this environment); unit
  tests cover it with injected fetch. Matches PLAN.md build note.

## Decisions & deviations (with reasons)

1. **House agents are exempt from one-agent-per-operator-per-game.** They all share
   the house operator, and both the spec'd backfill ("fill remaining seats with
   house agents") and stage-4 house-vs-house matches require several in one game.
   Real (non-house) operators are strictly enforced.
2. **Rating bands**: band(candidate) = 150 + 100 × sweeps waited; unbounded after 5
   waited sweeps. Two candidates pair only on MUTUAL acceptance (gap ≤ both bands).
   Backfill triggers at ≥2 waited sweeps (i.e. the entry's 3rd sweep) and first
   groups other compatible waiting real agents before adding house fill.
3. **Pairer determinism**: seat order and house-agent pick are seeded from a fresh
   32-byte secret per formed game via the kernel SeedStream. Seed-draw purposes
   used by T8: `pairing:seats` (seat shuffle), `pairing:house` (house pick). These
   are match-layer only and NOT part of any game's commit-reveal transcript.
4. **Backfill skips** (doesn't partially fill) when the HouseAgentProvider lists
   fewer distinct house agents than empty seats — the provider must list enough
   (spec: baseline random always available; several baseline ids is fine).
5. **Idle RD inflation defaults ON** in `closeRatingPeriod` (Glicko-2 step 6 for
   non-players, daily period). Set `inflateIdle: false` to skip. RD capped at 350.
6. **games_played counts games, not pairwise results** — provisional (20 games)
   refers to real games.
7. **Resignation screen proxy** per the track brief: resigner's final score ≥ 90th
   percentile of that (game, variant)'s pooled final scores; needs ≥20 pooled
   scores; skips scoreless games. Honest limits documented in the module header.
8. **Docket append-only is structural**: the repo interface has no mutating
   methods; later adjudication of a 'watching' entry = NEW entry referencing the
   old id in subject_json.
9. **Season homologation freeze**: the season row pins `ruleset_versions_json`
   write-once (`ensureSeason` never re-pins). Homologation-hash enforcement itself
   lives in T7's identity layer per the ownership map; T8 provides the season pin
   and close.
10. **Quotas** (50 joins/day, 20 concurrent, 120 req/min) are request-time checks →
    T7's API layer, not the pairer. Flagging here so it isn't dropped.

## Integration notes for T6/T7

- Cron every sweep interval: `runPairingSweep(lobbyRepo, storedState, cfg)`; persist
  `outcome.state`; each `outcome.created[i]` already went through your GameFactory.
- Daily 00:00 UTC cron: build `FinishedGame[]` from games ended in
  `dailyPeriodBounds(now)`, call `closeRatingPeriod(bounds.end, finished, ratingsRepo)`.
- Daily witness: latest checkpoint row + current leaderboard rows →
  `buildWitnessSnapshot` → `LocalFilePublisher('witness')` (this build) or
  `GitHubDispatchPublisher` (needs `env.WITNESS_GITHUB_TOKEN`, untested live).
- /api/docket = `docketRepo.list()` passthrough.
- After each game ends (or on the daily cron), feed `ScreenGame`/`TradeRecord`
  batches to the screens and `fileFlags` the output; dedup is handled.
