# T7 — api-and-identity-engineer

Owns: `src/index.ts`, `src/doc.ts`, `src/mcp.ts`, `src/api/`, `src/identity/`, `schema.sql`.
Tests: `npx vitest run src/api/tests` — 10 files, 81 tests, all green. Typecheck: clean for all owned paths.

## Exported API (what integration can rely on)

- `src/doc.ts` — **the one route table**: `ROUTES: RouteDef[]`, `MCP_ALIASES`, `MCP_TOOL_ORDER`
  (frozen to spec §api.mcp_tools), `MCP_READ_ONLY_TOOLS`, `NO_KEY_SENTENCE`, `API_BOUNDARY`,
  `AUTH_PREFIX ('ludus.auth.v1')`, `CHALLENGE_TTL_SECONDS (300)`, and the generators
  `frontDoorText(base)`, `llmsTxt(base)`, `openapiJson(base)`, `mcpWellKnown(base)`, `officialDoc(base)`.
  Docs track: mirror the auth text from the header comment of `src/doc.ts`; tests pin
  the front door to contain `NO_KEY_SENTENCE`, quotas, and every route.
- `src/api/env.ts` — `ApiEnv`: narrow, fake-able environment `{ DB, CACHE, REPLAYS, GAME_ROOM,
  secrets: { checkpoint_sk? }, games, now(), fetchFn() }`. `src/index.ts#toApiEnv(env)` adapts real bindings.
  `games` is the injectable registry (production: `GAMES`; tests: stubs) so T7's suite never depends on
  concurrently-changing game modules.
- `src/api/router.ts` — `handleApiRequest(env, request)`: rate limit → match → parse → handler → envelope.
- `src/api/handlers.ts` — `HANDLERS` keyed `'METHOD /path'` 1:1 with ROUTES (test-enforced).
- `src/mcp.ts` — `handleMcpHttp(env, request, readOnlyDoor)`, `handleMcpRpc`, `callTool`, `toolsList`.
- `src/api/cron.ts` — `runCron(env, { witnessPublisher?, forceWitness? }) -> CronReport` (5 steps, each try/caught).
- `src/identity/auth.ts` — `issueChallenge`, `authenticate`, `authMessage`, `HANDLE_RE`.
- `src/identity/register.ts` — `validateRegisterBody`, `registerAgent`, `operatorIdFromToken`, `agentIdFor`.
- `src/identity/homologation.ts` — `homologationHash` (spec formula), `validateHomologateBody`, `homologate`.
- `src/identity/doorbell.ts` — `registerDoorbell`, `verifyDoorbell`, `disableDoorbell`, `ringDoorbell`,
  `listActiveDoorbells`, `RING_PREFIX ('ludus.ring.v1')`, `DOORBELL_MAX_FAILURES (5)`.
- `src/identity/ed25519.ts` — local `verify/sign/publicKeyOf` wrapper over @noble (see deviations).
- Test fakes: `src/api/tests/fakes.ts` (`makeTestEnv`, `FakeDb` = **node:sqlite loaded with the real
  schema.sql**, `FakeKv` honoring TTL against the injected clock, `FakeR2`, `FakeRoomNamespace` with a
  scriptable response + recorded calls), `src/api/tests/helpers.ts` (`insertAgent`, `signedHeaders`, ...).

## Auth protocol (canonical; docs must mirror)

1. `GET /api/auth/challenge?agent=<handle>` → `{ challenge (64 hex), expires }`; KV, 5-min TTL, single-use.
2. Headers `X-Ludus-Agent`, `X-Ludus-Challenge`, `X-Ludus-Signature`; signature = Ed25519 over
   `'ludus.auth.v1:'+handle+':'+challenge+':'+METHOD+':'+path` and for POST `+':'+sha256Hex(rawBody)`
   (exact raw bytes over HTTP; `sha256Hex(canonicalJson(arguments.body))` over MCP — the server serializes
   the MCP body with canonicalJson so both hash the same bytes).
3. Challenge deleted only after a signature VERIFIES (failed attempts don't burn it; replays → `CHALLENGE_SPENT`).
4. Registration verifies against `body.pubkey` (proof of possession; agent doesn't exist yet).
5. Moves additionally carry the body-level `signature` per `ludus.move.v1` (room re-verifies it).

## Decisions / deviations (with reasons)

- **Extra routes beyond spec list**: `GET /api/my/games`, `GET /api/games/:id/legal_moves` — needed as HTTP
  twins for the spec-required MCP tools `my_games` / `legal_moves` ("MCP exposes the same operations as the API").
  `resign`/`offer_draw` are MCP alias tools over `POST /api/games/:id/moves`; the caller must include
  `resign:true`/`draw_offer:true` **inside the signed body** (server refuses to inject flags the signature
  doesn't cover).
- **Envelope**: every JSON response is `{ ok, data|error, metadata: { boundary, untrusted_fields? } }`
  (spec §api $comment). `error` may carry `data` (e.g. room's restated legal list on 2nd illegal move).
- **operators table has no token column**: `operator_id = 'op_'+sha256('ludus.operator.v1:'+token)[0:32]` —
  same token links, token never stored. `agent_id = 'a_'+sha256('ludus.agent.v1:'+handle+':'+pubkey)[0:32]`.
- **"Register once per key"** → UNIQUE index on `agents.pubkey_ed25519` (and handle).
- **Homologation**: spec hash formula implemented verbatim; `division` (pure|open) lives beside the hashed
  field set (which carries `tool_access`); pure division requires `tool_access:'pure'`. Refiling identical
  fields is idempotent; any change sets `voided_at` on the old row and inserts a new one. Fixture hash pinned:
  `89619c059d948e14152a99e31580c13eaccf5262d67cf2f5fb39ec4205313ddf`.
- **Lobby join requires an unvoided homologation for the division** (403 `NOT_HOMOLOGATED`) — rated play is
  homologated play per spec. E2E flows must homologate before joining.
- **Quotas** (spec: rejected requests never spend): order is validate → homologation → duplicate → quota check
  → INSERT → spend. Added a `quotas (agent_id, day, joins)` table because lobby rows vanish when the pairer
  drains them. Concurrency = COUNT of live `games` with agent_id in `seats_json` (LIKE match on the
  `"a_<hash>"` id, collision-safe). Lobby seats don't count toward the 20.
- **Rate limit**: KV token bucket `{t, ts}` per IP, 120 capacity, 120/min refill, fail-open on KV errors
  (best effort; hard guarantees are signatures + quotas). Runs before any handler.
- **Reveal rule**: `reveal_secret` nulled in every game payload until `status='ended'`; replays 409 before end.
- **Replay fallback**: R2 first (`replay_r2_key`, default `replays/<id>.json`), else reconstructed from D1
  games+game_log with `reconstructed_from:'d1'` and `initial_state:null` (recomputable:
  `game.initialState(createSeedStream(final_seed), players, variant)`); `seed_draws:[]` in fallback.
- **A9 "rejected and logged"** at API layer = console.warn + KV counter `authfail:<handle>` (24h TTL);
  move-level rejections are logged in the game log by the room (T6).
- **ed25519 duplication**: `src/identity/ed25519.ts` wraps @noble directly because T2's file didn't exist when
  T7 started. T2's `verifyEd25519/signEd25519` are behaviorally identical; either may win at integration
  (cron already uses T2's checkpoint module directly).
- **`skipped`-style cron steps report ok:true with a detail string** rather than failing; every step is
  try/caught so one broken piece never kills the cron (test-enforced).

## Room (T6) contract consumed

`GET /events?since=N[&sse=1]`, `GET /view/<player>`, `GET /state` (uses `turn_index`, `waiting_for`,
`deadline_at_ms`), `POST /move` with `{ agent_id, submission (body minus signature), signature }`,
`POST /tick` (cron timeout sweep). All calls try/caught; view/events fall back to D1
(`private_views` latest row / `spectator_events`), moves 503 `ROOM_UNAVAILABLE`.

## Cron (spec §architecture.scheduling) — `runCron` steps

1. **checkpoint**: leaves = `game_log.hash` ordered by (game_id, seq), LIMIT 50000 (revisit if logs outgrow it);
   root = T2 `merkleRoot` (RFC 6962); `signCheckpoint(checkpoint_sk, size, root, ts)`; INSERT `checkpoints`.
   Skips cleanly with no `checkpoint_sk`.
2. **doorbells**: verified+enabled bells × live games; ring when the agent's seat is in `waiting_for`;
   `event_id = '<game_id>:<turn_index>'`, cursor-deduped; payload `{event_id, game_id, turn_index, deadline_utc}`
   — NO board content — header `X-Ludus-Ring-Signature` = sign(checkpoint_sk, `'ludus.ring.v1:'+canonicalJson(payload)`).
   5 consecutive failures → `disabled_at`; success resets.
3. **timeouts**: `POST /tick` to every live room (DO alarms are primary; this is the sweep).
4. **match hook (T8)**: if `src/match/pairing.ts` exports `cronTick(env: ApiEnv)`, it is called; until then the
   step reports "skipped: … no cronTick(env) export yet". **T8: export that to go live.**
5. **witness**: daily window 00:00–00:05 UTC (or `forceWitness`); latest checkpoint + leaderboard hashes via
   T8 `buildWitnessSnapshot`; publisher injectable (`WitnessPublisher`), none configured in this build → logs
   the snapshot sha256.

## Seed-draw purposes

None drawn by T7 (challenges/doorbell challenges use `crypto.getRandomValues` — operational randomness,
not game randomness, deliberately outside the SeedStream audit trail).

## Secrets (A14)

`CHECKPOINT_SK` (Ed25519 hex) via Worker secret / `.dev.vars` only; `.gitignore` covers `.dev.vars` +
`*.secret` (test-enforced, plus a source scan for credential-shaped literals across src/ and configs).
The front door, llms.txt, openapi.json, mcp.json, `/api/official`, and MCP initialize all carry
`NO_KEY_SENTENCE`.

## Integration wishlist for other tracks

- T8: export `cronTick(env)` from `src/match/pairing.ts` (or ask me to point the hook elsewhere); when the
  pairer creates a game, INSERT the `games` row with `seats_json = [{player, agent_id, handle, pubkey_ed25519}]`
  (profile/quota/view code parses exactly that shape — same as replay.ts `ReplaySeat`).
- T6: on end, room should persist `game_log`/`spectator_events`/`private_views` rows to D1 (or T8's factory
  should) so the API fallbacks and checkpoints see data after DO eviction; set `games.status/ended_at/
  result_json/reveal_secret/replay_r2_key` at end.
- T9: `/watch` is served by Workers Assets; `/api/official` names it as the only official window.
