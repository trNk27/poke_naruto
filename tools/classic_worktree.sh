#!/usr/bin/env bash
# Checks out the classic (non-Naruto) game into DIR as a git worktree: game/
# as it was just before the Naruto theme, with the current multiplayer code
# copied in so it speaks the same NetSync protocol as the website.
#
#   tools/classic_worktree.sh DIR      # then: make -C DIR/game leafgreen
#
# Remove it afterwards with: git worktree remove --force DIR
set -euo pipefail
DIR=${1:?usage: tools/classic_worktree.sh DIR}
REPO=$(cd "$(dirname "$0")/.." && pwd)

# The last commit before the Naruto theme (which added tools/naruto/roster.py).
CLASSIC_COMMIT=$(git -C "$REPO" log --format=%H --diff-filter=A -- tools/naruto/roster.py | tail -1)^
# Multiplayer code that must match the website. Add files here when a
# multiplayer change touches more of game/.
MULTIPLAYER_FILES="
  game/include/netsync.h
  game/src/netsync.c
  game/src/link.c
  game/src/cable_club.c
  game/src/event_object_movement.c
  game/src/field_control_avatar.c
  game/data/netsync_scripts.s
"

git -C "$REPO" worktree add --quiet --detach "$DIR" "$CLASSIC_COMMIT"
cp -a "$REPO/game/tools/agbcc" "$DIR/game/tools/"
for file in $MULTIPLAYER_FILES; do cp "$REPO/$file" "$DIR/$file"; done
