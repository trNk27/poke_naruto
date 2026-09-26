#!/usr/bin/env bash
# Builds the test ROM used by tests/e2e.mjs (NEW GAME skips Professor Oak's
# intro) and copies it to the given path, then rebuilds the normal ROM.
#
#   tests/build-test-rom.sh /tmp/test.gba
set -euo pipefail
OUT=${1:?usage: tests/build-test-rom.sh OUTPUT.gba}
GAME=$(cd "$(dirname "$0")/../game" && pwd)
JOBS=$(nproc 2>/dev/null || echo 4)

# The quick-start switch only affects oak_speech.c; force it to recompile.
touch "$GAME/src/oak_speech.c"
make -C "$GAME" -j"$JOBS" leafgreen NETSYNC_QUICK_START=1 >/dev/null
cp "$GAME/pokeleafgreen.gba" "$OUT"
touch "$GAME/src/oak_speech.c"
make -C "$GAME" -j"$JOBS" leafgreen >/dev/null
echo "Test ROM written to $OUT"
