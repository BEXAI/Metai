# T2-crypto notes

Track: crypto-engineer. Owns `src/crypto/` (canonical.ts was frozen in stage 0; untouched).
Status: complete. 64/64 tests green (`npx vitest run src/crypto/tests`), zero tsc errors in `src/crypto/`.

## Exported API (import points for other tracks)

### `src/crypto/ed25519.ts`
- `generateKeypair(): { publicKeyHex, secretKeyHex }` — tests/house agents only; players bring their own keys.
- `signEd25519(secretKeyHex, message: string): string` — 64-byte sig, lowercase hex; message is a UTF-8 string (the frozen `ludus.*.v1:` signing strings). Throws on malformed key.
- `verifyEd25519(pubkeyHex, message, signatureHex): boolean` — NEVER throws; false on any malformed input (safe on raw network input). Accepts uppercase hex (normalized). Uses noble's default ZIP215 verification (deterministic across Node/Workers).

### `src/crypto/commit.ts` (prefixes imported from `src/kernel/replay.ts` — never re-typed)
- `generateSecretHex(): string` — EXTRA export: draws the 32-byte game secret s (T6 needs it; CSPRNG via noble randomBytes).
- `makeCommitment(gameId, secretHex): string` — `sha256('ludus.commit.v1:' + gameId + ':' + secretHex)`.
- `deriveFinalSeed(gameId, secretHex, drandRandomnessHex): string` — `sha256('ludus.seed.v1:' + gameId + ':' + secretHex + ':' + randomness)`; feed straight into `createSeedStream`.
- `verifyCommitment(gameId, secretHex, commitment): boolean` — never throws; one flipped byte anywhere fails (gate A8 test in commit.test.ts).
- Strictness: secret and drand randomness must be exactly 64 chars lowercase hex; gameId non-empty. make/derive throw loudly; verify returns false.

### `src/crypto/chain.ts` (rule imported from `src/kernel/replay.ts`)
- `entryHash(gameId, seq, prevHash, kind, payload): string` — the frozen `ludus.log.v1` rule.
- `appendEntry(gameId, log, kind, payload, signature, createdAt): LogEntry` — pure; computes seq/prev/hash; caller pushes the returned entry. Does not mutate the input log.
- `verifyChain(gameId, log): { ok, badSeq? }` — badSeq is the 0-based position of the first bad entry. Empty log is valid.
- INTEGRATION NOTE (by frozen design): the chain hash covers seq+prev+kind+payload only. `signature` and `created_at` are OUTSIDE the chain; move authenticity comes from the Ed25519 sig over the `ludus.move.v1` message (which hashes the move body). Verifiers must check both chain AND per-move signatures. A truncated prefix of a valid chain also verifies — truncation resistance is the checkpoint/witness layer's job.

### `src/crypto/checkpoint.ts`
- `merkleRoot(leaves: Uint8Array[]): Uint8Array` — RFC 6962 (0x00 leaf / 0x01 node prefixes; MTH([]) = sha256('')).
- `leafHash(leaf)`, `nodeHash(left, right)` — exported for T8/T1 use.
- `inclusionProof(leaves, index): Uint8Array[]` (throws on bad index); `verifyInclusion(leaf, index, treeSize, proof, root): boolean` (never throws) — RFC 9162 §2.1.3.2 algorithm, `leaf` is raw leaf bytes (hashed internally).
- `signCheckpoint(secretKeyHex, treeSize, rootHex, timestamp): string` over `'ludus.checkpoint.v1:' + treeSize + ':' + rootHex + ':' + timestamp`; `verifyCheckpoint(pubkeyHex, treeSize, rootHex, timestamp, signatureHex)`; `checkpointMessage(...)` and `CHECKPOINT_PREFIX` exported.
- SUBTLETY (tested, cross-checked against an independent Python RFC 9162 implementation): an RFC 6962 inclusion proof does not always bind treeSize — some inflated size claims verify against the same root. Size binding comes from the SIGNED checkpoint pair (treeSize, root). Consumers must verify inclusion against the signed checkpoint's size+root, never against an unauthenticated size.

### `src/crypto/drand.ts`
- Constants: `QUICKNET_CHAIN_HASH` (52db9b...84e971), `QUICKNET_GENESIS_UNIX_SECONDS` = 1692803367, `QUICKNET_PERIOD_SECONDS` = 3, `DRAND_API_BASE` = https://api.drand.sh.
- `roundAt(timeMs): number` — round available at wall-clock ms; pre-genesis clamps to 1. `roundTimeMs(round)` — inverse anchor. Live-checked 2026-09-02: `roundAt(Date.now())` === the network's actual latest round (31840338).
- `getRound(fetchFn, round)` / `getLatestRound(fetchFn)` — hit `/v2/chains/<chainhash>/rounds/{n|latest}`. `fetchFn` is injected (`globalThis.fetch` in prod; canned stub in tests — offline fixture uses the real captured round-1 response). Type `DrandFetch` is a structural subset of fetch, so `getRound(fetch, n)` just works.
- `parseDrandRound(body)` / `randomnessMatchesSignature(round)` — v2 API returns `{round, signature}` ONLY; randomness is derived as sha256(signature) (verified equal to what the v1 API publishes for round 1). A v1-style body with a contradicting `randomness` field is rejected.
- OUT OF SCOPE (spec-sanctioned): BLS verification of the drand signature against the quicknet group key. Round + signature + randomness are recorded; sha256(signature)=randomness is checked offline; the signature is independently checkable against api.drand.sh. Comment in drand.ts says the same.

## Decisions / deviations
- No deviations from frozen prefixes/shapes — all imported from `src/kernel/replay.ts`.
- `verifyEd25519` is lenient on hex case (normalizes); sign-side and storage should keep lowercase canonical.
- Extra exports beyond the deliverable list: `generateSecretHex`, `checkpointMessage`, `CHECKPOINT_PREFIX`, `leafHash`, `nodeHash`, `parseDrandRound`, `randomnessMatchesSignature`, `roundTimeMs`, `Keypair`, `DrandRound`, `DrandFetch` types.
- No `node:crypto` anywhere in `src/crypto/*.ts` (tests use it deliberately as an independent recomputation oracle; tests are Node-only).
- Known-answer Merkle vectors are the certificate-transparency Go library reference vectors (1/2/3/4/7/8-leaf roots), recomputed independently before hard-coding.

## Seed-draw purposes
This track draws no game seeds. It produces `final_seed` inputs for `createSeedStream`; purpose-tag conventions belong to the game tracks.

## For integration (T1/T6/T7/T8/T9)
- Room flow: `generateSecretHex()` → `makeCommitment` → log `commitment` entry (with `roundAt(Date.now())`-or-later drand round) → `getRound(fetch, round)` → `deriveFinalSeed` → `createSeedStream` → after `end`, log `reveal`.
- Verifier flow: `verifyCommitment` + recompute `deriveFinalSeed` + `verifyChain` + per-move `verifyEd25519` over the `ludus.move.v1` message + `verifyCheckpoint`/`verifyInclusion` where checkpoints are present.
- Cron (T7/T8): leaves for the 5-minute checkpoint should be the entry `hash` fields as bytes (hex-decoded), ordered; sign with `signCheckpoint(houseSecret, leaves.length, bytesToHex(merkleRoot(leaves)), isoTimestamp)`.
