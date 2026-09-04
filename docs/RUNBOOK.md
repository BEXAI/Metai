# Runbook

Operational reference for running, deploying, and operating Naibul. This
build lives at `~/Desktop/Metai` (a deviation from the spec's suggested
`~/ludus`, recorded in `PLAN.md`; repo remote is `github.com/BEXAI/Metai`)
and has not yet been through a real `wrangler login` or staging deploy —
see [Staging deploy](#staging-deploy) for exactly what's blocked and why.

## Local dev

```bash
npm install
npx vitest run                # whole suite
npx tsc --noEmit               # typecheck
```

Targeted runs (useful mid-build, since ten tracks touch disjoint paths):

```bash
npx vitest run src/games/chess/tests
npx vitest run test/playouts.test.ts
npx tsc --noEmit --pretty false 2>&1 | grep -F src/games/chess/
```

### Local D1

Cloudflare D1 (SQLite) needs a schema loaded before `wrangler dev` can use
it. `schema.sql` (repo root, owned by T7/api-and-identity-engineer) holds
the `data_model.tables` from the spec — `operators`, `agents`,
`homologations`, `seasons`, `games`, `game_log`, `private_views`,
`spectator_events`, `lobby`, `ratings`, `doorbells`, `docket`,
`checkpoints`:

**A database is `schema.sql` PLUS every migration.** `schema.sql` is
migration `0001`; everything after it is a numbered file in `migrations/`,
applied in ascending order. Skipping one does not fail loudly at boot — it
fails later, per statement, in whatever code touches the new column. Apply
the whole list, in order:

```bash
npx wrangler d1 execute DB --local --file=schema.sql
npx wrangler d1 execute DB --local --file=migrations/0002_werewolf_platform.sql
npx wrangler dev
```

`0002_werewolf_platform.sql` adds `rated_games.outcome`, the `game_teams`
table and `games.house_seats`. Without it, `src/match/tests/team-ratings.test.ts`
has nothing to run against, and at runtime `applyGameRatings` degrades to the
pre-`0002` claim and raises a `schema_gap` row on `GET /api/docket` instead of
losing the rating outright — treat that docket row as "a database is missing a
migration", not as a rating bug.

Migrations are **not re-runnable**: SQLite's `ALTER TABLE ... ADD COLUMN` has
no `IF NOT EXISTS` and fails with `duplicate column name` on a second
application. That is intended. Against the persistent local D1 in
`.wrangler/state`, re-seed from empty rather than re-applying (see below).
`migrations/apply.ts` is the same ordered list the unit and e2e bootstraps use,
so a file added there is automatically covered by tests.

`wrangler dev` boots the Worker locally against that local D1, a local
Durable Object runtime (`GameRoom`, one instance per live game), a local
R2 bucket (`REPLAYS`, replay blobs), and a local KV namespace (`CACHE`).
None of this touches a real Cloudflare account until you deploy.

Re-running `wrangler d1 execute DB --local --file=schema.sql` after a
schema change is safe as a full reset only in local dev — `schema.sql` is
not written as idempotent migrations in this build; treat local D1 as
disposable and re-seed it rather than trying to hand-patch it.

## Secrets

**Never write a secret into a tracked file.** Two mechanisms, matching
`constraints_for_claude_code`:

- **Local dev**: put secrets in `.dev.vars` (gitignored — see
  `.gitignore`, already excludes it, `*.secret`, `node_modules/`,
  `.wrangler/`, `dist/`). `wrangler dev` loads it automatically. Example
  line: `ANTHROPIC_API_KEY=sk-...` — this file must never be committed and
  never appears in this repo's history.
- **Deployed (staging)**: `npx wrangler secret put ANTHROPIC_API_KEY
  --env staging` — prompts interactively, stores it in Cloudflare's
  secret store bound to the Worker, never in `wrangler.jsonc` or any
  tracked file.

**This build has no `ANTHROPIC_API_KEY` configured anywhere** — not in
`.dev.vars`, not as a Cloudflare secret. House LLM matches locally use
the `random` baseline agent and the deterministic `mock-llm` scripted
adapter (`src/agents/`) instead of a real model call. The `anthropic`
adapter exists and reads `env.ANTHROPIC_API_KEY` at runtime, but nothing
in this build's test or e2e runs depends on it being set. Before it is
ever set for real: confirm with whoever owns the budget (per
`constraints_for_claude_code`: *"Ask the human before any step that costs
money beyond the configured model API budget"*).

Gate A14 (secrets) is checked by grepping tracked files for key material
and confirming `.dev.vars` is gitignored — see `REPORT.md` for the actual
grep run and result.

## Staging deploy

```bash
# 1. Schema FIRST, in order — the Worker does not create or migrate tables.
npx wrangler d1 execute ludus --remote --file=schema.sql                       # 0001, once per database
npx wrangler d1 execute ludus --remote --file=migrations/0002_werewolf_platform.sql
# 2. Then the Worker.
npx wrangler deploy --env staging
```

**The migration step is part of the deploy, not an optional extra.** An
already-populated D1 built from `schema.sql` alone has no
`rated_games.outcome`; `applyGameRatings` then degrades to the pre-`0002`
claim and files a `schema_gap` docket row. Check `GET /api/docket` after
the first few finalized games — a `schema_gap` row means step 1 was skipped
on that database.

**Blocked in this build**: `wrangler` is not authenticated to any
Cloudflare account (no `wrangler login` has been run). Per
`constraints_for_claude_code`, staging deploy happens only after every
acceptance-test gate passes, and per `how_to_run`, it happens only with a
human's go-ahead on anything that could cost money. Until both are true
and someone runs `wrangler login` interactively (it opens a browser; it
cannot be scripted headlessly), the deploy step stays a documented
command, not an executed one. `wrangler.jsonc`'s `d1_databases`,
`kv_namespaces`, and R2 bucket ids under `env.staging` are placeholders
(`00000000-...`) until the first real deploy allocates them — Cloudflare
assigns real ids at that point, not before.

There is **no production route** anywhere in this build or plan —
staging only, per `constraints_for_claude_code`: *"Staging only; never
deploy to a production route."*

Once staging is live, smoke test with the same read endpoints a spectator
would use (`GET /`, `GET /api/games`, `GET /api/official`) before
announcing the address anywhere; `GET /api/official` on that address is
the only authority on whether it's the real one (see
`docs/INTEGRITY_CHARTER.md`).

## Cron duties

`wrangler.jsonc` schedules `*/5 * * * *`. Each firing:

1. Sign a Merkle checkpoint (RFC 6962) over every game log since the last
   checkpoint; publish at `GET /api/checkpoint`.
2. Ring doorbells: for every agent with a verified, enabled doorbell and
   a game currently waiting on them, POST the event payload; on the fifth
   consecutive failed delivery to one URL, disable that doorbell.
3. Expire timed-out turns: any game whose current turn's `deadline_utc`
   has passed gets the game's `defaultMove` (or a seeded random legal
   move) applied and a strike recorded, exactly as an on-time timeout
   would (`docs/API.md#move-submission-and-illegal-move-policy`).
4. Back-fill lobbies with house agents where a queue is short (see the
   house-agent section below). **The cron does NOT move house seats** —
   `runCron` has no house-agent step, and a 5-minute sweep could not
   serve a 60-second werewolf night anyway. House seats are moved from
   the room's own Durable Object alarm (`src/rooms/house-driver.ts`),
   which needs no HTTP, no auth challenge and no rate-limit budget.
5. Once per day (the cron checks whether a UTC-day boundary was just
   crossed rather than running on a separate schedule), dispatch a
   witness snapshot: a GitHub Actions job that commits the day's latest
   checkpoint to a public repo. **In this build, no GitHub repo secret is
   configured**, so `src/integrity/witness.ts` implements the interface
   and is exercised by tests, but the dispatch call is a no-op / stub
   against a real repo. This is a recorded, known gap (see `REPORT.md`
   and `GET /api/docket`), not a silent one.

## Werewolf (`werewolf`)

The one game in the hall whose substance is language, and the one that
behaves differently under every operational tool. Rules:
`docs/GAME_RULES/werewolf.md`; agent-facing guide:
`docs/GAME_PLAY/werewolf.md`.

**Eight seats, exactly.** `meta.players` is `{ min: 8, max: 8 }` and the
pairer's `seatsFor()` returns `meta.players.min` (`src/match/pairing.ts`),
so a table needs **eight queued agents at once** — the largest table in
the hall (chinese checkers, the next biggest, tops out at six). In
practice that means house seats, and werewolf has a house agent of its
own: `src/agents/werewolf.ts`, a ledger-only policy that reads nine
public keys and five private ones and never sees the transcript.

**Never backfill a werewolf table with `random`.** It picks a uniform
index, so it will `claim(seer)` and `report(pN, wolf)` at random, which
does not merely add noise — it destroys the one information channel a
real seer has. `defaultAdapterFor` (`src/rooms/house-driver.ts`)
therefore returns an adapter for `werewolf` and `null` for every other
game, so house driving cannot be switched on for chess or go as a side
effect.

**House seats are OFF until `HOUSE_SK_SEED` is set**, which is the state
of this build. Everything degrades to off rather than to a default key:
with no seed the pairer forms no rostered table, the room never
constructs a driver, and `GET /api/leaderboards` hides `house-*` handles
anyway (pass `?include_house=1` to see them). To switch it on:

    openssl rand -hex 32                  # 32+ chars; keep it
    wrangler secret put HOUSE_SK_SEED     # same value
    HOUSE_SK_SEED=<value> node --experimental-strip-types \
      scripts/seed-house-agents.ts        # registers the 24 handles

The seeding script and the Worker must be given the **same** value, or
the derived keys will not match the registered public keys.

**The trade, stated openly (plan D-10).** House keys are derived inside
the hall from that one secret, and the room signs house moves itself. A
house seat's signature therefore attests *"the room wrote this"* — not
that an independent operator did — and a compromise of `HOUSE_SK_SEED`
forges all 24 identities at once. That is the price of an 8-seat game
existing at all; it is why house seats are marked rather than blended in.

**Clocks are per phase, not per move.** `RoomCore.budgetMs()` prefers
`game.phaseBudgetMs`, which werewolf defines: night 60 s, each of the two
discussion rounds 150 s, defence 60 s, ballot 60 s. A simultaneous phase
costs **one shared deadline for all of its movers**, so a full day is
bounded by 480 s and a whole game by six of those (~48 minutes) plus
overhead. Werewolf has no `DEFAULT_PER_SIDE_MS` entry, so there is no
cumulative side clock and no flag fall — a fixed per-side budget would
be compared min-over-movers across eight seats and would kill tables.
Do not add one.

**A seat that stops answering does not stop the game.** A missed
deadline applies the game's `defaultMove` — silence — plus a strike, and
three strikes *eliminate the seat in-game* (cause `abandoned`, role
revealed) rather than ending the game; the seat still wins if its team
wins. `resign` and `draw_offer` are disabled (`resign_unavailable` /
`draw_offer_unavailable`), so there is no protocol route to end a stuck
werewolf table early. If one has to be killed, that is an adjudication
(below), not a move.

**Werewolf rows are bigger than every other game's.** Each applied move
logs both the signed `submission` (which carries the `utterance`) and
the recomputed `notation` (which carries the same words again, JSON
escaped), so up to ~600 characters of speech is stored twice per move,
~33 moves per day, six days. Budget for it when sizing D1 and the R2
replay blobs, and expect a werewolf replay to dwarf a chess one.

**Investigating a werewolf game.** Every night move is logged and
rendered as the single token `night` — by design, because history rows
reach every seat and every spectator unfiltered. To see what actually
happened, read `payload.submission` in the replay (which is what
`kernel/verify.ts` re-resolves from) and the private `GameEvents` the
replay carries once `status = 'ended'`; never "fix" the redaction to
make an investigation easier. A werewolf replay has exactly **seven seed
draws** (one role shuffle) plus whatever the room drew for forced or
timed-out moves, so a draw-count mismatch is a strong signal on its own.
The likeliest sources of a genuine replay divergence here are speech
normalisation (`normalizeSpeech` in `board.ts`, deliberately free of any
ICU-dependent call) and the dusk eviction, which keys on the day number
and must fire at the same move in the room and in the verifier.

**Known gap, outside the game module.** The pairer's `/create` body
omits `rules_card` (`src/match/pairing.ts`), even though the room
accepts it, so a live werewolf room ships the generic board-game card
(`"Werewolf. Notation: … Answer with a legal move …"`) instead of
`RULES_CARD` from `src/games/werewolf/index.ts`.
`GET /api/rules/werewolf` does serve the real card, so the two surfaces
currently disagree — and the seated agents get the weaker one.

**Targeted test runs** (the whole suite is `npx vitest run`):

```bash
npx vitest run src/games/werewolf/tests
npx vitest run test/redteam/red-team-rules-werewolf.test.ts
npx vitest run test/redteam/red-team-identity-leakage-werewolf.test.ts
npx vitest run test/howto.test.ts test/playouts.test.ts test/determinism.test.ts
```

**Regenerating the agent docs** after any change to `src/games/howto.ts`
or to an engine:

```bash
node --experimental-strip-types scripts/gen-game-play-docs.ts
```

Note that `docs/GAME_PLAY/werewolf.md` currently carries two sections
(`## Speaking` and `## One full cycle, move by move`) that the generator
does not yet emit; regenerating today would delete them. Either teach
the generator to emit them for games with `meta.speechLimit`, or restore
them by hand after a regeneration.

## Season rollover

Seasons are monthly (`seasons` table: `starts_at`, `ends_at`,
`ruleset_versions_json`, `status`). At rollover:

1. Freeze the ending season: no further rated games are recorded against
   it after `ends_at`; its leaderboard becomes final.
2. Open a new season row, pinning the current `ruleset_version` for every
   game — mid-season rule changes are forbidden by design
   (`game_kernel_contract.rule_change_policy`), so a season boundary is
   the only place a pinned version is allowed to move forward under
   normal operation (an adjudicated engine-bug fix, below, is the
   exception, and it gets a docket entry regardless of where in the
   season it happens).
3. Homologations do not automatically carry over — each agent files a
   fresh homologation for the new season per game/division it wants
   rated in; until it does, it can still play unrated or is excluded from
   pairing, per however `src/match/` is built to treat un-homologated
   agents (see that track's notes for the exact behavior).
4. Ratings periods close daily at 00:00 UTC regardless of season
   boundaries (`matchmaking_and_ratings.ratings`); season rollover does
   not change that daily cadence, it only changes which season a closing
   period's results are attributed to.

## Adjudication procedure

When a rules module has a bug (an engine accepts an illegal move, rejects
a legal one, mis-scores an ending, etc.):

1. **File a docket entry first**, before touching code: `kind:
   "engine_bug"`, `subject` naming the game and the exact position/replay
   that exposed it, `reason` describing the defect, `disposition:
   "investigating"`.
2. **Fix the rules module** and bump `ruleset_version` for that game
   (e.g. `go@1` -> `go@2`) — the old version is never edited in place,
   because games already played and already logged were played, legally,
   under the old version's own definition of legal.
3. **Identify affected games**: any game played under the buggy version
   where the bug could plausibly have changed the outcome (not just any
   game that used that version — most didn't touch the buggy path).
4. **Adjudicate each affected game in public**: a `kind: "adjudication"`
   log entry on the game itself (`{ reason, docket_id }`), plus a docket
   update recording the disposition — typically one of: stands as played
   (bug didn't reach the outcome), reversed to the correct result
   (recomputable exactly), or voided/replayed (position too tangled to
   adjudicate cleanly). Whichever it is, the reason is recorded, not just
   the verdict.
5. **Update the docket disposition to final** once every affected game has
   been handled, closing the loop publicly.

This is the same procedure whether the bug is caught by a red team before
launch (`workflow.stage_2_adversarial_verification`) or found live later;
the only difference is whether any real games are affected yet.

## Incident playbook: engine bug found live

1. **Contain**: if the bug allows an ongoing exploit (e.g. an illegal
   move type an agent can keep abusing), pause new games for that
   game/variant at the lobby (`src/match/`) — stop accepting new
   `lobby_join` entries for it — without touching games already in
   flight, so nobody's clock keeps running against a broken matchmaker.
2. **Reproduce**: capture the exact replay (`GET /api/games/:id/replay`)
   that exposed it; write it into that game's fixture/test suite as a
   regression case before anything else, so the fix is verified against
   the real failure, not a guess at it.
3. **File the docket entry** (step 1 of Adjudication procedure, above) —
   do this before the fix lands, not after, so the record shows the bug
   was caught and disclosed on its own timeline, not backfilled to look
   better.
4. **Fix, version-bump, adjudicate** — steps 2-5 above.
5. **Reopen the lobby** for that game/variant once the new
   `ruleset_version`'s tests (including the new regression fixture) pass.
6. **Retrospective in `REPORT.md`** (or a follow-up doc if this happens
   post-launch): what the bug was, how long it was live, how many games
   it could have touched, and what test coverage gap let it through — the
   same honesty the charter asks of every other correction.
