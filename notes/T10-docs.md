# T10 docs-writer — notes

## What I wrote

- `docs/FRONT_DOOR.md` — served-at-`/` content: what Ludus is, join flow
  (keypair -> challenge -> register -> homologate -> lobby_join -> pulse/
  doorbell -> view -> move), no-key statement, content boundary, quotas,
  links.
- `docs/API.md` — every endpoint in spec §api (read + write_signed +
  doorbell), the transport-auth scheme, the move-content signature, the
  response envelope, error codes, quotas, MCP mapping.
- `docs/AGENT_GUIDE.md` — a complete, **executed and verified** runnable
  TypeScript client (see [Verification](#verification-method) below).
- `docs/GAME_RULES/<id>.md` for all twelve games.
- `docs/INTEGRITY_CHARTER.md` — served at `GET /api/official` in spirit
  (commit-reveal, hash chain, checkpoints, homologation, divisions,
  quotas, docket, spectator reveal).
- `docs/RUNBOOK.md` — local dev, secrets, staging deploy (blocked:
  `wrangler` not authenticated, per `PLAN.md`'s build-environment notes),
  cron duties, season rollover, adjudication procedure, incident
  playbook.

## Read-before-writing: I read T7's actual code, not just the spec

`src/doc.ts`, `src/api/handlers.ts`, `src/identity/{auth,register,
homologation,doorbell}.ts` all existed by the time I got to the API docs
(T7 moved fast). Per my instructions ("if src/doc.ts exists read it")
I mirrored the **real, already-built** scheme instead of the PLAN.md
sketch I was given as a fallback. This changed several concrete details
from what a first pass (or the orchestrator's inline instructions) would
have produced — flagging them here because they're exactly the kind of
thing that drifts silently otherwise:

1. **Challenge issuance is a real endpoint, not a client-computed
   timestamp.** `GET /api/auth/challenge?agent=<handle>` returns a
   32-byte random hex challenge, 5-minute TTL, **single-use** (deleted
   from KV the instant it verifies). I initially drafted (before finding
   `src/doc.ts`) a self-generated-timestamp challenge scheme; that draft
   is gone from the shipped docs. Everything in `docs/API.md` and
   `docs/AGENT_GUIDE.md` now reflects the real fetch-then-sign flow.
2. **The signed message's `path` excludes the query string** (pathname
   only). My first draft included the query string; fixed everywhere.
3. **Response envelope is `{ ok, data, metadata }` / `{ ok: false, error:
   { code, message }, data?, metadata }`** (`src/api/http.ts`), not the
   flatter shape I'd guessed. `metadata.boundary` is present on **every**
   response (a fixed constant, `API_BOUNDARY`), separate from
   `ViewObject.boundary` (`CONTENT_BOUNDARY`, a different sentence, from
   `src/kernel/types.ts`). Both sentences are quoted verbatim, and their
   difference is called out explicitly, in `docs/API.md`,
   `docs/FRONT_DOOR.md`, and `docs/INTEGRITY_CHARTER.md`, so a reader
   never assumes they're the same string.
4. **Registration field is `pubkey`, not `pubkey_ed25519`**, and
   `operator_token` is **required** (8-256 char secret, never stored,
   `operator_id` derived deterministically from it) — not optional as
   the spec's prose alone might suggest.
5. **Homologation is per agent, per season — there is no `game` field**
   in the hashed field set or the request body, despite the spec's prose
   describing divisions "per game." One homologation covers every game
   an agent plays that season under that division. I documented this
   explicitly since it's an easy assumption to get backwards.
6. **`POST /api/lobby/join`'s `variant` is a short string key** (e.g.
   `"standard"`, default if omitted), not the raw `VariantConfig` object
   from the kernel contract — a practical simplification for pooling
   lobby entries by string equality; the room resolves it to a real
   config when the game starts.
7. **Two more signed reads exist that weren't obvious from the spec's
   prose alone**: `GET /api/my/games` (the real backing for the
   `my_games` MCP tool — games you're actually seated in) and
   `GET /api/games/:id/legal_moves` (the real backing for the
   `legal_moves` MCP tool — previously I'd assumed both were just facets
   of `/api/pulse` or `/view`; they're their own routes).
8. **Doorbell verification direction**: registering
   (`POST /api/doorbell {url}`) stores a challenge; calling
   `POST /api/doorbell/verify` is what actually makes Ludus **GET the
   agent's URL** (header `X-Ludus-Doorbell-Challenge`), expecting
   `X-Ludus-Doorbell-Signature` back. My first draft had the ping firing
   automatically at registration time; fixed to match the real two-step
   flow. The ring itself (cron -> agent) carries its own
   `X-Ludus-Ring-Signature` over `'ludus.ring.v1:' + canonicalJson(payload)`
   signed with the **checkpoint key**, not the agent's key — the reverse
   direction's proof, distinct from the doorbell-endpoint proof.

## landlord / islanders: real data, not placeholders

Both game tracks (T5) had published real data files
(`src/games/landlord/board.ts`, `src/games/islanders/rules.ts`) before I
reached those two docs, so per my instructions I read them and used the
real names throughout — no placeholders remain in either doc:

- **landlord**: Meridian Bay, 40 spaces, 8 color groups (Umber/Sky/Rose/
  Amber/Crimson/Gold/Jade/Violet), 4 transit lines, 2 utilities
  (Dynamo Power Co., Aqueduct Trust), 2 tax spaces, Detention Yard/
  Constable's Order (jail), Rest Green (free space), two 16-card decks
  ("Harbormaster Dispatches" / "Town Ledger Notices"), Release Writ /
  Constable's Writ cards. Full rent table transcribed from
  `board.ts`'s `STREETS` array. Confirmed against `notation.ts` (`roll,
  buy, decline, end_turn, pay_detention, use_card, pay_debt,
  declare_bankruptcy, auction_bid, build, sell_buildings, mortgage,
  unmortgage, offer, accept, reject, counter`) and against
  `rules.ts` constants (salary 200, detention fine 50, 32/12 house/hotel
  supply, bid step 10, 3 auction rounds, turn limit 150 default,
  end reasons `last_standing`/`turn_limit`).
- **islanders**: 19 hexes lettered A-S + 18 sea hexes a-r, 54 vertices/72
  edges, five resources (palm, coral, reed, taro, obsidian) from terrain
  (grove, reef, marsh, paddy, volcano; `dunes` produces nothing and
  starts the Raider). **Saga cards are named `warrior`, `landmark`,
  `pathfinder`, `bounty`, `tithe`** — these are the game track's real,
  original names and **differ from the spec's own generic labels**
  (`soldier`, `victory point`, `road-building`, `two-of-any`,
  `monopoly`). I used the real code names throughout, per my
  instructions to use real data over inventing/assuming spec labels are
  literal display text; the spec's names read as mechanic descriptions
  given the project's "original names required" IP note, not a literal
  card-text requirement, and T5's choice is consistent with that
  reading. **Flag for integration**: if anyone else (spectator site,
  other docs, a red team) assumes the spec's literal names appear
  in-game, that assumption is wrong — the actual card ids are the ones
  above. Deck composition (14/5/2/2/2 = 25 cards), building costs/supply,
  bank size (19/resource), round limit 100, win at 10 VP, longest-road
  (5+) / largest-army (3+) thresholds at +2 VP each, and the discard-
  half-on-seven mechanic were all confirmed directly against `rules.ts`.

## Risk: `docs/FRONT_DOOR.md` vs. `src/doc.ts#frontDoorText()` will drift

`src/doc.ts` already implements a real, code-generated `frontDoorText()`
— a compact, route-table-driven text, hardcoded in TypeScript, not
sourced from any markdown file at runtime (Workers can't read repo files
at request time without a build step, and none exists here). It is
**not the same text** as `docs/FRONT_DOOR.md`: mine is longer, more
explanatory prose meant to be read start-to-finish; theirs is terser and
mechanically generated from `ROUTES`. Both are now internally accurate
(I fact-checked mine against T7's real endpoints), but they are two
independently-maintained documents that happen to describe the same
thing, and **will silently diverge the moment either one is edited without
the other**. Recommend integration/orchestrator either (a) have `src/doc.ts`
literally embed a trimmed version of `docs/FRONT_DOOR.md`'s content as a
build step, or (b) explicitly designate `src/doc.ts#frontDoorText()` as
the sole source of truth for what's served at `/` and demote
`docs/FRONT_DOOR.md` to "extended companion reading," and say so in both
files. I did not make this call myself since it touches `src/doc.ts`,
which is outside my paths.

Same risk, smaller scale, for `docs/INTEGRITY_CHARTER.md` vs.
`src/doc.ts#officialDoc()` — the latter is a short pointer document
(addresses + the no-key sentence), not a full charter; I treated the
full charter as the more complete companion document rather than
assuming they should be textually identical, and said so in
`docs/INTEGRITY_CHARTER.md`'s closing line.

## Risk: one path string in T7's code looks slightly off

`src/api/handlers.ts#getGameEvents` passes
`['data.events[].event.commentary']` as the `untrusted_fields` path, but
the actual event shape it returns nests a move event's fields under
`event.data` (e.g. `event.data.commentary`), based on the `GameEvent`
shape in `src/kernel/types.ts` (`{ type, data, visibility }`). The path
string may be missing a `.data` segment
(`data.events[].event.data.commentary`). I did not change T7's code (out
of my paths) or silently "correct" the example in `docs/API.md` to hide
the discrepancy — I documented the path exactly as it appears in code
and I'm flagging the possible off-by-one-segment bug here for T7 or the
integration pass to check against a real spectator-events response.

## Endpoints/response shapes documented from reading real handler code

Every example JSON in `docs/API.md` for the following was built by
reading the actual handler, not inferred from the spec alone:
`GET /api/games`, `/:id`, `/:id/events`, `/:id/replay`, `/api/agents/
:handle`, `/api/leaderboards`, `/api/rules/:game`, `/api/docket`,
`/api/checkpoint`, `/api/pulse` (+ auth-enriched), `/api/my/games`,
`/api/games/:id/view`, `/api/games/:id/legal_moves`, `POST /api/agents`,
`/:id/homologate`, `/api/lobby/join`/`leave`, `/api/games/:id/moves`,
`/api/doorbell`, `/verify`, `/disable`. One exception: the exact JSON
shape of the room's move **verdict** (`data.verdict` on
`POST /api/games/:id/moves`) is defined by T6's Durable Object
(`src/rooms/room.ts`), which I did not read in full — I described its
*behavior* (accepted/rejected, restated legal moves on the second
rejection, strikes) from the spec and PLAN.md's frozen policy, but the
exact field names inside `data.verdict` / the error's `data` are T6's
call. `docs/AGENT_GUIDE.md`'s retry logic says so explicitly in a code
comment and searches a couple of plausible nesting spots defensively
rather than assuming one exact shape.

## Verification method

I did not just write the AGENT_GUIDE.md example and hope — I extracted
its code block and ran it twice against small hand-written Node mock
servers (in the scratchpad, not committed) implementing first my
original guessed auth scheme, then (after reading `src/doc.ts`) the
*real* one: challenge-fetch, real field names, real envelope shape. Both
runs used the actual `@noble/curves` `ed25519.verify` server-side to
confirm the client's signatures verify against the documented message
formats — not just that the code runs, but that the crypto is actually
correct. The final run: register -> homologate -> join lobby -> poll
pulse -> fetch view -> submit an illegal move (forced by the mock, no
restated list, per the first-rejection rule) -> retry and succeed ->
three more turns -> resign, all passing real Ed25519 verification at
every signed step. I also hit one real bug this way:
`node --experimental-strip-types` does not support TypeScript
constructor parameter properties (they generate runtime assignment code,
not just type erasure) — `class LudusApiError` was rewritten to use
explicit field assignment instead of `constructor(public code: string,
...)`. Without actually running the example, that would have shipped as
a "runnable" example that doesn't run.

## Cross-checks against the spec (where I didn't have code to read)

For the ten non-landlord/non-islanders games, the spec's `games` section
is the source of truth per my instructions (those game tracks' job is to
match the spec, not the other way around), so `docs/GAME_RULES/*.md` for
tictactoe, connect_drop, chess, checkers, reversi, hex,
nine_mens_morris, go, chinese_checkers, and backgammon were written
directly from spec §games + §game_kernel_contract + the acceptance
tests, without reading those tracks' (T3/T4/T5) in-progress rules code.
If any of those tracks' actual notation or variant defaults end up
differing from what's documented (e.g. a different default board size),
the docs should be corrected to match the spec's fixed rules, and the
divergent code is the bug per `constraints_for_claude_code`: "Game rules
in this spec are fixed."

## Still open / not yet possible to verify

- `schema.sql` landed (T7's territory) partway through my pass — its 14
  tables match spec §data_model.tables exactly, plus one extra `quotas`
  table (a reasonable implementation detail, not spec-mandated).
  `docs/RUNBOOK.md`'s `wrangler d1 execute DB --local --file=schema.sql`
  step is accurate against the real file; I did not execute it myself
  (no live `wrangler dev`/D1 in this pass, and D1/wrangler are outside
  `docs/`).
- I have not seen `src/rooms/room.ts` (T6) or `src/mcp.ts` (T7) in
  detail; the MCP mapping table in `docs/API.md` is built from
  `src/doc.ts`'s `MCP_TOOL_ORDER`/`MCP_ALIASES`/`MCP_READ_ONLY_TOOLS`
  constants (which are real, read directly) but the actual JSON-RPC
  request/response framing over `/mcp` itself is not independently
  verified against running code.
- Staging deploy is genuinely blocked (`wrangler` not authenticated) per
  `PLAN.md`'s own build-environment notes; `docs/RUNBOOK.md` documents
  the command and the blocker honestly rather than claiming it was run.
