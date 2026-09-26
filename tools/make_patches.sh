#!/usr/bin/env bash
# Builds the multiplayer ROMs and publishes them as BPS patches against the
# retail LeafGreen ROMs, so players can use their own copy of the game.
#
# The retail ROMs are rebuilt from the unmodified decompilation (the commit
# that imported game/), which reproduces them byte-for-byte.
#
#   tools/make_patches.sh
#
# Requires the toolchain described in game/INSTALL.md (agbcc installed into
# game/tools/agbcc and binutils-arm-none-eabi).
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT="$REPO/web/patches"
JOBS=$(nproc 2>/dev/null || echo 4)
BASELINE_COMMIT=$(git -C "$REPO" log --format=%H --diff-filter=A -- game/Makefile | tail -1)
WORK=$(mktemp -d)
trap 'git -C "$REPO" worktree remove --force "$WORK/baseline" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

echo "Building retail ROMs from $BASELINE_COMMIT..."
git -C "$REPO" worktree add --quiet --detach "$WORK/baseline" "$BASELINE_COMMIT"
cp -a "$REPO/game/tools/agbcc" "$WORK/baseline/game/tools/"
make -C "$WORK/baseline/game" -j"$JOBS" compare_leafgreen compare_leafgreen_rev1 >/dev/null

echo "Building multiplayer ROMs..."
make -C "$REPO/game" -j"$JOBS" leafgreen leafgreen_rev1 >/dev/null

mkdir -p "$OUT"
python3 - "$REPO/tools" "$WORK/baseline/game" "$REPO/game" "$OUT" <<'EOF'
import hashlib, json, sys
sys.path.insert(0, sys.argv[1])
import bps

base_dir, mod_dir, out_dir = sys.argv[2:5]
builds = [
    ('Pokémon LeafGreen (USA)', 'pokeleafgreen.gba', 'leafgreen.bps'),
    ('Pokémon LeafGreen (USA, Rev 1)', 'pokeleafgreen_rev1.gba', 'leafgreen_rev1.bps'),
]
patches = []
for name, rom, patch_file in builds:
    source = open(f'{base_dir}/{rom}', 'rb').read()
    target = open(f'{mod_dir}/{rom}', 'rb').read()
    patch = bps.create(source, target)
    assert bps.apply(source, patch) == target
    open(f'{out_dir}/{patch_file}', 'wb').write(patch)
    patches.append({
        'base': name,
        'baseSha1': hashlib.sha1(source).hexdigest(),
        'file': patch_file,
        'targetSha1': hashlib.sha1(target).hexdigest(),
    })
    print(f'  {patch_file}: {len(patch):,} bytes')
with open(f'{out_dir}/manifest.json', 'w') as f:
    json.dump({'version': 1, 'patches': patches}, f, indent=2, ensure_ascii=False)
    f.write('\n')
EOF
echo "Wrote patches to $OUT"
