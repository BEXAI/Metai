#!/usr/bin/env bash
# Bundles the offline verifier for the browser (spec §spectator, replay page).
# Safe to re-run at any time — that's the point: while T1 (src/kernel/verify.ts)
# and the game tracks are mid-flight, this falls back to a hash-chain-only
# "partial verify" so the replay page still works, and prints a clear notice
# to re-run once those land. See notes/T9.md.
#
# Usage: bash web/build.sh   (from anywhere; resolves paths relative to itself)

set -u
cd "$(dirname "$0")/.." || exit 1
mkdir -p web/public/watch

FULL_OK=1
ESBUILD="npx --yes esbuild"

echo "[web/build.sh] bundling src/kernel/verify.ts -> web/public/watch/verifier.js"
if $ESBUILD src/kernel/verify.ts --bundle --format=esm --platform=browser --outfile=web/public/watch/verifier.js 2>web/.build-verifier.log; then
  echo "[web/build.sh]   OK"
else
  FULL_OK=0
  echo "[web/build.sh]   src/kernel/verify.ts not buildable yet — writing a placeholder verifier.js"
  echo "[web/build.sh]   (see web/.build-verifier.log for the esbuild error)"
  cat > web/public/watch/verifier.js <<'PLACEHOLDER'
// Placeholder: src/kernel/verify.ts was not present/buildable when
// web/build.sh last ran. Re-run web/build.sh once T1 lands it.
export function verifyReplay() {
  return {
    ok: false,
    checks: [
      { name: 'kernel-verifier-available', ok: false, detail: 'src/kernel/verify.ts was not buildable at web/build.sh time' },
    ],
  };
}
PLACEHOLDER
fi

echo "[web/build.sh] bundling web/verify-entry.ts -> web/public/watch/verify-entry.js"
if $ESBUILD web/verify-entry.ts --bundle --format=esm --platform=browser --outfile=web/public/watch/verify-entry.js 2>web/.build-entry.log; then
  echo "[web/build.sh]   OK (full verify: hash chain + game-state recomputation via GAMES)"
else
  FULL_OK=0
  echo "[web/build.sh]   full verify-entry bundle failed — falling back to web/partial-verify-entry.ts"
  echo "[web/build.sh]   (see web/.build-entry.log for the esbuild error)"
  if ! $ESBUILD web/partial-verify-entry.ts --bundle --format=esm --platform=browser --outfile=web/public/watch/verify-entry.js 2>>web/.build-entry.log; then
    echo "[web/build.sh]   ERROR: even the partial verifier failed to bundle. Check web/.build-entry.log."
    cat web/.build-entry.log
    exit 1
  fi
  echo "[web/build.sh]   OK (partial verify: hash chain only, no game-state recomputation)"
fi

rm -f web/.build-verifier.log web/.build-entry.log

if [ "$FULL_OK" -eq 1 ]; then
  echo "[web/build.sh] full verifier build complete — nothing to re-run."
else
  echo "[web/build.sh] PARTIAL build: some upstream modules were missing (expected while other tracks are mid-flight)."
  echo "[web/build.sh] Integration must re-run 'bash web/build.sh' once src/kernel/verify.ts and the game tracks land,"
  echo "[web/build.sh] then verify web/public/watch/verify-entry.js no longer sets window.ludusVerifyPartial = true."
fi
