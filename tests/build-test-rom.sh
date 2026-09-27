#!/usr/bin/env bash
# Builds the test ROM used by the tests (NEW GAME skips Professor Oak's intro
# and starts in front of a Pokémon Center's Cable Club receptionist with two
# Pokémon) and copies it to the given path, then rebuilds the normal ROM.
#
#   tests/build-test-rom.sh /tmp/test.gba
set -euo pipefail
OUT=${1:?usage: tests/build-test-rom.sh OUTPUT.gba}
GAME=$(cd "$(dirname "$0")/../game" && pwd)
JOBS=$(nproc 2>/dev/null || echo 4)

# make doesn't track compiler flags, so recompile the files that use the switch.
FILES=$(grep -l NETSYNC_QUICK_START "$GAME"/src/*.c)
touch $FILES
make -C "$GAME" -j"$JOBS" leafgreen NETSYNC_QUICK_START=1 >/dev/null
cp "$GAME/pokeleafgreen.gba" "$OUT"
cp "$GAME/pokeleafgreen.elf" "${OUT%.gba}.elf" # symbols for debugging tests
touch $FILES
make -C "$GAME" -j"$JOBS" leafgreen >/dev/null
echo "Test ROM written to $OUT"
