#!/usr/bin/env bash
# Builds the test ROM used by the tests (NEW GAME skips Professor Oak's intro
# and starts in front of a Pokémon Center's Cable Club receptionist with two
# Pokémon) and copies it to the given path, then rebuilds the normal ROM.
# With "classic", builds it from the classic (non-Naruto) game instead.
#
#   tests/build-test-rom.sh /tmp/test.gba [classic]
set -euo pipefail
OUT=${1:?usage: tests/build-test-rom.sh OUTPUT.gba [classic]}
REPO=$(cd "$(dirname "$0")/.." && pwd)
GAME=$REPO/game
JOBS=$(nproc 2>/dev/null || echo 4)

if [ "${2:-}" = classic ]; then
  WORK=$(mktemp -d)
  trap 'git -C "$REPO" worktree remove --force "$WORK/classic" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
  "$REPO/tools/classic_worktree.sh" "$WORK/classic"
  make -C "$WORK/classic/game" -j"$JOBS" leafgreen NETSYNC_QUICK_START=1 >/dev/null
  cp "$WORK/classic/game/pokeleafgreen.gba" "$OUT"
  cp "$WORK/classic/game/pokeleafgreen.elf" "${OUT%.gba}.elf"
  echo "Classic test ROM written to $OUT"
  exit 0
fi

# make doesn't track compiler flags, so recompile the files that use the switch.
FILES=$(grep -l NETSYNC_QUICK_START "$GAME"/src/*.c)
touch $FILES
make -C "$GAME" -j"$JOBS" leafgreen NETSYNC_QUICK_START=1 >/dev/null
cp "$GAME/pokeleafgreen.gba" "$OUT"
cp "$GAME/pokeleafgreen.elf" "${OUT%.gba}.elf" # symbols for debugging tests
touch $FILES
make -C "$GAME" -j"$JOBS" leafgreen >/dev/null
echo "Test ROM written to $OUT"
