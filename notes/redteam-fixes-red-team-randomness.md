# Fixes for red team: randomness (RAND-02 / RAND-03 / RAND-04)

Attack suite: `test/redteam/red-team-randomness-{prediction,binding,seedstream}.test.ts`
(74 tests — all green after these fixes; no attack test was edited).
Memo: `test/redteam/red-team-randomness.md` (findings F2/F3/F4 = RAND-02/03/04).

## RAND-02 (F2, high) — honest replays failed verifyReplay (gate A8)

Root cause: T1 and T6 shipped two incompatible conventions for the frozen
illegal-move policy, plus a second drift on the kernel `'#N'` fallback.

- Rooms log the third-illegal penalty as kind `'move'` carrying the REJECTED
  (but signed) third submission plus `forced: 'illegal'`
  (`src/rooms/core.ts` `commitApplied` / `resolveSimultaneous`), applying
  `legal[seed.int('illegal:turn:N', legal.length)]`.
- The verifier re-resolved every `'move'` from `payload.submission`
  (`src/kernel/verify.ts` `resolveMove`) and its header documented a never-
  produced alternative (`'timeout'` entry with purpose `illegal:turn:N`).
- Rooms resolve `'#7'` as `legal_moves[7]` (`src/rooms/core.ts:~590`); the
  verifier passed the raw string to `game.parseMove` and failed.

Fix — the ROOM convention is frozen (it preserves the agent's Ed25519
signature over the rejected submission in the audit log); the VERIFIER moved
(`src/kernel/verify.ts`):

- `resolveMove` now applies the same `'#N'` index fallback as
  `rooms/core.ts` (`/^#(\d+)$/` on the trimmed string, canonical
  `legalMoves` order) before falling back to `parseMove`.
- `recomputation` handles `payload.forced === 'illegal'` on `'move'`
  entries: the signature check over `payload.submission` is unchanged, but
  the applied move is recomputed as
  `legal[seed.int('illegal:turn:N', legal.length)]` from the same stream
  position (the room takes `drawStart` before the penalty draw, so the
  per-entry `draws` slice matches). Unknown `forced` values hard-fail.
- The dead alternate convention was removed: `'timeout'` entries now accept
  only the frozen purpose `timeout:turn:N` (a logged `payload.purpose` must
  equal it). This also removes forger freedom to pick an arbitrary purpose
  string for an unsigned timeout entry.
- Header doc block updated to describe the (single) frozen convention.
- `web/public/watch/verifier.js` + `verify-entry.js` are compiled copies of
  `src/kernel/verify.ts`; regenerated via `bash web/build.sh` (full build,
  no source edits under `web/`) so the browser verifier shares the same
  convention.

## RAND-03 (F3, medium) — hydrate accepted broken commit-reveal bindings

Root cause: `RoomCore.hydrate` (`src/rooms/core.ts:314-331` as found)
replayed `seedDraws` against `snapshot.final_seed` but never re-derived
`makeCommitment(game_id, secret)` or
`deriveFinalSeed(game_id, secret, drand_randomness)`, so storage/DO-layer
tampering (flipped secret, swapped commitment, self-consistent
drand+final_seed+draws reforge) resumed silently into unverifiable games.

Fix (`src/rooms/core.ts` `hydrate`): before rebuilding the stream, re-derive
both values and hard-fail on any mismatch:

- `makeCommitment(snapshot.game_id, snapshot.secret) === snapshot.commitment`
  (also rejects malformed secrets — makeCommitment throws), and
- `deriveFinalSeed(snapshot.game_id, snapshot.secret, snapshot.drand_randomness)
  === snapshot.final_seed`.

The existing draw-replay check (tampered draw → `seed draw mismatch`) is
kept unchanged. Note the residual (inherent) limit: the snapshot necessarily
contains the secret, so an adversary with full snapshot write access can
reforge everything self-consistently; the check turns every *partial*
tamper/corruption into a hard stop instead of an unverifiable game.

## RAND-04 (F4, medium) — no "drand round at or after commitment time"

Root cause: spec `identity_and_integrity.randomness[1]` requires the mixed
quicknet round to be at/after the commitment time — the only thing stopping
the house from grinding `s` against already-public randomness. Neither
`RoomCore.create` nor the DO create handler consulted
`roundTimeMs` (`src/crypto/drand.ts:63-66`); `created_at` is unhashed and
ignored by the verifier, so create time is the only enforcement point.

Fix (`src/rooms/core.ts` `create`): reject when
`roundTimeMs(params.drandRound) < nowMs` (strict, no slack — a caller must
commit to a round emitted at or after the commitment instant). The DO's
create handler already converts the throw into a 400. Single enforcement
point covers both paths named in the finding.

Fixture updates required by the new (spec-mandated) check — these are NOT
red-team files and none weakens any test; they only replace historically-
emitted drand rounds with future ones in harnesses that create rooms at real
`Date.now()`:

- `src/rooms/tests/room-do.test.ts`: `drand_round: 777` →
  `roundAt(Date.now()) + 1_000`.
- `test/e2e/worker.ts`: pseudo-drand `drandRound = 1` →
  `roundAt(Date.now()) + 100`.
- `test/e2e/sizeprobe.ts`: `drandRound: 1` → `roundAt(Date.now()) + 100`.

All other suites (unit + other red teams) create rooms at `nowMs = 1_000_000`
with rounds ≥ 1, and `roundTimeMs(1) ≈ 1.69e12 » 1e6`, so they are unaffected.

## Verification

- `npx vitest run test/redteam/red-team-randomness-*.test.ts` → 74/74 green.
- `npx vitest run test/redteam/` → only pre-existing failures from OTHER red
  teams remain (liveness/injection, 18 tests); confirmed identical with the
  randomness fixes stashed (their fixers own them).
- `npx vitest run src/rooms src/kernel src/agents src/crypto src/api` →
  202/202 green.
- `npx tsc --noEmit --pretty false` → no errors (repo-wide).
- `bash web/build.sh` → full verifier bundle rebuilt OK.
