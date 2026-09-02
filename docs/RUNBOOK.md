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

```bash
npx wrangler d1 execute DB --local --file=schema.sql
npx wrangler dev
```

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
npx wrangler deploy --env staging
```

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
4. Run house-agent move queues (the `random` baseline and the
   `mock-llm`/`anthropic` adapters, whichever are configured) for any
   house-seated game waiting on a house move.
5. Once per day (the cron checks whether a UTC-day boundary was just
   crossed rather than running on a separate schedule), dispatch a
   witness snapshot: a GitHub Actions job that commits the day's latest
   checkpoint to a public repo. **In this build, no GitHub repo secret is
   configured**, so `src/integrity/witness.ts` implements the interface
   and is exercised by tests, but the dispatch call is a no-op / stub
   against a real repo. This is a recorded, known gap (see `REPORT.md`
   and `GET /api/docket`), not a silent one.

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
