#!/usr/bin/env python3
"""Applies the Naruto theme (tools/naruto/roster.py) to the decompilation.

    python3 tools/naruto/apply.py

Every file this script manages is regenerated from its unmodified version in
the commit that imported the decompilation, so the script can be re-run after
editing roster.py. Don't hand-edit the managed files (listed in MANAGED);
change roster.py or this script instead.
"""

import glob
import json
import os
import re
import subprocess
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
GAME = os.path.join(REPO, 'game')
sys.path.insert(0, os.path.dirname(__file__))
import roster as R  # noqa: E402

MANAGED = [
    'src/data/pokemon/species_info.h',
    'src/data/text/species_names.h',
    'src/data/pokemon/evolution.h',
    'src/data/pokemon/level_up_learnsets.h',
    'src/data/pokemon/tmhm_learnsets.h',
    'src/data/pokemon/tutor_learnsets.h',
    'src/data/pokemon/pokedex_entries.h',
    'src/data/pokemon/pokedex_text_lg.h',
    'src/data/pokemon/pokedex_text_fr.h',
    'src/battle_main.c',
    'src/data/text/move_names.h',
    'src/data/battle_moves.h',
    'src/data/wild_encounters.json',
    'src/data/trainer_parties.h',
    'src/data/ingame_trades.h',
    'src/battle_setup.c',
    'src/roamer.c',
    'include/constants/species.h',
    'graphics/interface/menu_info.png',
]
MAP_SCRIPTS = sorted(glob.glob(os.path.join(GAME, 'data/maps/*/scripts.inc'))) + \
    sorted(glob.glob(os.path.join(GAME, 'data/scripts/*.inc'))) + [os.path.join(GAME, 'data/event_scripts.s')]


def baseline_commit():
    out = subprocess.check_output(['git', '-C', REPO, 'log', '--format=%H', '--diff-filter=A', '--', 'game/Makefile'], text=True)
    return out.split()[-1]


BASELINE = baseline_commit()


def pristine(path):
    rel = os.path.relpath(path, REPO) if os.path.isabs(path) else os.path.join('game', path)
    return subprocess.check_output(['git', '-C', REPO, 'show', f'{BASELINE}:{rel}'], text=True)


def write(path, text):
    full = path if os.path.isabs(path) else os.path.join(GAME, path)
    with open(full, 'w') as f:
        f.write(text)


def find_block(text, key, start=0):
    """Finds `[KEY] = {...}` and returns (start, end) of the value braces."""
    m = re.compile(r'\[' + re.escape(key) + r'\]\s*=\s*').search(text, start)
    if not m:
        return None
    i = m.end()
    if text[i] != '{':
        raise ValueError(f'{key}: value is not a block')
    depth = 0
    for j in range(i, len(text)):
        if text[j] == '{':
            depth += 1
        elif text[j] == '}':
            depth -= 1
            if depth == 0:
                return m.start(), i, j + 1
    raise ValueError(f'{key}: unbalanced braces')


def replace_block(text, key, new_value):
    found = find_block(text, key)
    if not found:
        raise KeyError(key)
    start, value_start, end = found
    return text[:value_start] + new_value + text[end:]


def replace_value_until(text, key, terminator_regex, new_value):
    """Replaces the value of `[KEY] = value<terminator>`."""
    m = re.compile(r'(\[' + re.escape(key) + r'\]\s*=\s*)').search(text)
    if not m:
        raise KeyError(key)
    t = re.compile(terminator_regex, re.S).search(text, m.end())
    return text[:m.end()] + new_value + text[t.start():]


def c_string(s):
    return s.replace('\\', '\\\\').replace('"', '\\"')


# ---------------------------------------------------------------------------
# Original data (for the species mapping)

def parse_original_species():
    info = pristine('src/data/pokemon/species_info.h')
    types = {}
    bst = {}
    for m in re.finditer(r'\[SPECIES_(\w+)\]\s*=\s*\{(.*?)\n    \}', info, re.S):
        name, body = m.group(1), m.group(2)
        t = re.search(r'\.types\s*=\s*\{TYPE_(\w+),\s*TYPE_(\w+)\}', body)
        if t:
            types[name] = (t.group(1), t.group(2))
        stats = [int(x) for x in re.findall(r'\.base\w+\s*=\s*(\d+)', body)]
        bst[name] = sum(stats)
    evo = pristine('src/data/pokemon/evolution.h')
    parent = {}
    for m in re.finditer(r'\[SPECIES_(\w+)\]\s*=\s*\{(.*?)\},?\n', evo, re.S):
        for target in re.findall(r'SPECIES_(\w+)\}', m.group(2)):
            parent.setdefault(target, m.group(1))
    return types, bst, parent


def build_species_map():
    types, bst, parent = parse_original_species()
    ninjas = {n['key'] for n in R.ROSTER}
    mapping = {}
    for species, (t1, _t2) in types.items():
        if species in R.OVERRIDES:
            mapping[species] = R.OVERRIDES[species]
            continue
        stage = 0
        s = species
        while s in parent:
            stage += 1
            s = parent[s]
        if stage == 0 and bst.get(species, 0) >= 480:
            stage = 2
        elif stage == 0 and bst.get(species, 0) >= 400:
            stage = 1
        mapping[species] = R.FALLBACK[t1][min(stage, 2)]
    for species, target in mapping.items():
        assert target in ninjas, f'{species} -> unknown ninja {target}'
    return mapping


# ---------------------------------------------------------------------------

def ninja_const(key):
    return f'SPECIES_NJ_{key}'


def type_const(naruto_type):
    return f'TYPE_{R.TYPES[naruto_type]}'


def gender_value(g):
    if g == 'M':
        return 'MON_MALE'
    if g == 'F':
        return 'MON_FEMALE'
    if g is None:
        return 'MON_GENDERLESS'
    return f'PERCENT_FEMALE({g})'


def species_info_block(n):
    hp, atk, df, spe, spa, spd = n['stats']
    types = [type_const(t) for t in n['types']]
    if len(types) == 1:
        types.append(types[0])
    abilities = [f'ABILITY_{a}' for a in n['abilities']] + ['ABILITY_NONE']
    # EV yield: the highest stat.
    stat_names = ['HP', 'Attack', 'Defense', 'Speed', 'SpAttack', 'SpDefense']
    best = max(range(6), key=lambda i: n['stats'][i])
    evs = [0] * 6
    evs[best] = 1 if n['exp'] < 100 else 2 if n['exp'] < 200 else 3
    lines = [
        '{',
        f'        .baseHP = {hp},',
        f'        .baseAttack = {atk},',
        f'        .baseDefense = {df},',
        f'        .baseSpeed = {spe},',
        f'        .baseSpAttack = {spa},',
        f'        .baseSpDefense = {spd},',
        f'        .types = {{{types[0]}, {types[1]}}},',
        f'        .catchRate = {n["catch"]},',
        f'        .expYield = {n["exp"]},',
    ]
    lines += [f'        .evYield_{stat_names[i]} = {evs[i]},' for i in range(6)]
    lines += [
        '        .itemCommon = ITEM_NONE,',
        '        .itemRare = ITEM_NONE,',
        f'        .genderRatio = {gender_value(n["gender"])},',
        '        .eggCycles = 20,',
        '        .friendship = 70,',
        f'        .growthRate = GROWTH_{n["growth"]},',
        '        .eggGroups = {EGG_GROUP_UNDISCOVERED, EGG_GROUP_UNDISCOVERED},',
        f'        .abilities = {{{abilities[0]}, {abilities[1]}}},',
        '        .safariZoneFleeRate = 0,',
        f'        .bodyColor = BODY_COLOR_{n["color"]},',
        '        .noFlip = FALSE,',
        '    }',
    ]
    return '\n'.join(lines)


def apply_species(roster_by_key):
    info = pristine('src/data/pokemon/species_info.h')
    names = pristine('src/data/text/species_names.h')
    for n in R.ROSTER:
        info = replace_block(info, f'SPECIES_{n["slot"]}', species_info_block(n))
        assert len(n['name']) <= 10, n['name']
        names = replace_value_until(names, f'SPECIES_{n["slot"]}', r',\n', f'_("{n["name"]}")')
    write('src/data/pokemon/species_info.h', info)
    write('src/data/text/species_names.h', names)

    # Evolutions: drop the slots' original lines, add the ninjas' lines.
    evo = pristine('src/data/pokemon/evolution.h')
    slots = {f'SPECIES_{n["slot"]}' for n in R.ROSTER}
    kept = []
    for line in evo.split('\n'):
        m = re.match(r'\s*\[(SPECIES_\w+)\]', line)
        if m and m.group(1) in slots:
            continue
        kept.append(line)
    evo = '\n'.join(kept)
    new_lines = []
    for n in R.ROSTER:
        if n.get('evo'):
            level, target = n['evo']
            new_lines.append(f'    [SPECIES_{n["slot"]}] = {{{{EVO_LEVEL, {level}, {ninja_const(target)}}}}},')
    evo = evo.replace('\n};', '\n    // Naruto theme\n' + '\n'.join(new_lines) + '\n};', 1)
    write('src/data/pokemon/evolution.h', evo)


def apply_learnsets():
    pointers = pristine('src/data/pokemon/level_up_learnset_pointers.h')
    learnsets = pristine('src/data/pokemon/level_up_learnsets.h')
    for n in R.ROSTER:
        array = re.search(r'\[SPECIES_' + n['slot'] + r'\]\s*=\s*(\w+),', pointers).group(1)
        body = ',\n'.join(f'    LEVEL_UP_MOVE({lvl}, MOVE_{move})' for lvl, move in n['moves'])
        learnsets = re.sub(r'static const u16 ' + array + r'\[\] = \{.*?\};',
                           f'static const u16 {array}[] = {{\n{body},\n    LEVEL_UP_END\n}};', learnsets, count=1, flags=re.S)
    write('src/data/pokemon/level_up_learnsets.h', learnsets)

    # TMs and HMs: universal ones, the ones matching a ninja's types, and HMs
    # for getting around (every ninja can walk on water, after all).
    items = open(os.path.join(GAME, 'include/constants/items.h')).read()
    machines = re.findall(r'#define ITEM_((?:TM|HM)\d\d_(\w+))\s', items)
    moves = pristine('src/data/battle_moves.h')
    move_types = dict(re.findall(r'\[MOVE_(\w+)\]\s*=\s*\{[^}]*?\.type = TYPE_(\w+)', moves, re.S))
    slot_to_type = {v: k for k, v in R.TYPES.items()}
    type_overrides = {m: t for m, (_n, t) in R.MOVES.items() if t}
    universal = {'HIDDEN_POWER', 'PROTECT', 'RETURN', 'FRUSTRATION', 'DOUBLE_TEAM', 'FACADE',
                 'SECRET_POWER', 'REST', 'ATTRACT', 'TOXIC', 'SUNNY_DAY', 'RAIN_DANCE', 'BRICK_BREAK',
                 'AERIAL_ACE', 'SHADOW_BALL', 'DIG', 'THIEF', 'TORMENT', 'TAUNT'}
    hms = {'CUT', 'SURF', 'STRENGTH', 'FLASH', 'ROCK_SMASH', 'WATERFALL', 'DIVE'}
    tmhm = pristine('src/data/pokemon/tmhm_learnsets.h')
    for n in R.ROSTER:
        chosen = []
        for full, move in machines:
            mtype = type_overrides.get(move) or slot_to_type.get(move_types.get(move, ''), '')
            if move in universal or move in hms or mtype in n['types'] \
                    or (move == 'FLY' and ('FUTON' in n['types'] or n['key'] in ('GAMABUNTA', 'KURAMA', 'JIRAIYA'))):
                chosen.append(full)
        value = 'TMHM_LEARNSET(' + '\n                                        | '.join(f'TMHM({c})' for c in chosen) + ')'
        tmhm = replace_value_until(tmhm, f'SPECIES_{n["slot"]}', r',\n\n|,\n\};', value)
    write('src/data/pokemon/tmhm_learnsets.h', tmhm)

    tutor = pristine('src/data/pokemon/tutor_learnsets.h')
    for n in R.ROSTER:
        tutor = replace_value_until(tutor, f'SPECIES_{n["slot"]}', r',\n\n|,\n\};',
                                    'TUTOR(MOVE_MIMIC) | TUTOR(MOVE_SUBSTITUTE) | TUTOR(MOVE_COUNTER) | TUTOR(MOVE_SEISMIC_TOSS)')
    write('src/data/pokemon/tutor_learnsets.h', tutor)


def apply_pokedex():
    entries = pristine('src/data/pokemon/pokedex_entries.h')
    texts = {p: pristine(p) for p in ('src/data/pokemon/pokedex_text_lg.h', 'src/data/pokemon/pokedex_text_fr.h')}
    for n in R.ROSTER:
        found = find_block(entries, f'NATIONAL_DEX_{n["slot"]}')
        start, value_start, end = found
        block = entries[value_start:end]
        assert len(n['category']) <= 11, n['category']
        block = re.sub(r'\.categoryName = _\(".*?"\)', f'.categoryName = _("{n["category"]}")', block)
        block = re.sub(r'\.height = \d+', f'.height = {n["height"]}', block)
        block = re.sub(r'\.weight = \d+', f'.weight = {n["weight"]}', block)
        entries = entries[:value_start] + block + entries[end:]
        text_symbol = re.search(r'\.description = (\w+),', block).group(1)
        lines = n['dex'].split('\n')
        body = '\n'.join(f'    "{c_string(line)}\\n"' if i < len(lines) - 1 else f'    "{c_string(line)}"'
                         for i, line in enumerate(lines))
        for path in texts:
            new_text = f'const u8 {text_symbol}[] = _(\n{body});'
            texts[path] = re.sub(r'const u8 ' + text_symbol + r'\[\] = _\(.*?\);',
                                 lambda _m: new_text, texts[path], count=1, flags=re.S)
    write('src/data/pokemon/pokedex_entries.h', entries)
    for path, text in texts.items():
        write(path, text)


def apply_types_and_moves():
    battle = pristine('src/battle_main.c')
    # Type names.
    names_body = '\n'.join(f'    [{type_const(t)}] = _("{R.TYPE_NAMES[t]}"),' for t in R.TYPES)
    names_body += '\n    [TYPE_MYSTERY] = _("???"),'
    battle = re.sub(r'(const u8 gTypeNames\[NUMBER_OF_MON_TYPES\]\[TYPE_NAME_LENGTH \+ 1\] =\n\{\n).*?(\n\};)',
                    lambda m: m.group(1) + names_body + m.group(2), battle, count=1, flags=re.S)
    # Type chart.
    mult = {SUPER: 'TYPE_MUL_SUPER_EFFECTIVE', HALF: 'TYPE_MUL_NOT_EFFECTIVE', NONE: 'TYPE_MUL_NO_EFFECT'}
    rows = []
    for attacker, defenders in R.TYPE_CHART.items():
        for defender, m in defenders.items():
            rows.append(f'    {type_const(attacker)}, {type_const(defender)}, {mult[m]},')
    chart = '\n'.join(rows) + '\n    TYPE_FORESIGHT, TYPE_FORESIGHT, TYPE_MUL_NO_EFFECT,\n    TYPE_ENDTABLE, TYPE_ENDTABLE, TYPE_MUL_NO_EFFECT'
    battle = re.sub(r'(const u8 gTypeEffectiveness\[\d+\] =\n\{\n).*?(\n\};)',
                    lambda m: m.group(1) + chart + m.group(2), battle, count=1, flags=re.S)
    # Not part of the theme, but this file is regenerated from the original:
    # keep the online link race fix (see NETLINK_LINK_FIXES in config.h).
    fix = '#if REVISION >= 0xA\n        if (IsLinkTaskFinished() && !gPaletteFade.active)'
    assert battle.count(fix) == 1
    battle = battle.replace(fix, fix.replace('0xA\n', '0xA || NETLINK_LINK_FIXES\n'))
    write('src/battle_main.c', battle)

    names = pristine('src/data/text/move_names.h')
    moves = pristine('src/data/battle_moves.h')
    for move, (name, new_type) in R.MOVES.items():
        assert len(name) <= 12, name
        names = replace_value_until(names, f'MOVE_{move}', r',\n', f'_("{c_string(name)}")')
        if new_type:
            start, value_start, end = find_block(moves, f'MOVE_{move}')
            block = re.sub(r'\.type = TYPE_\w+', f'.type = {type_const(new_type)}', moves[value_start:end])
            moves = moves[:value_start] + block + moves[end:]
    write('src/data/text/move_names.h', names)
    write('src/data/battle_moves.h', moves)


SUPER, HALF, NONE = R.SUPER, R.HALF, R.NONE

# Tile offsets of the type labels in graphics/interface/menu_info.png (see
# sMenuInfoIcons in src/list_menu.c). Each label is 32x12 pixels.
TYPE_ICON_OFFSETS = {
    'NORMAL': 0x20, 'FIGHTING': 0x64, 'FLYING': 0x60, 'POISON': 0x80, 'GROUND': 0x48,
    'ROCK': 0x44, 'BUG': 0x6C, 'GHOST': 0x68, 'STEEL': 0x88, 'FIRE': 0x24, 'WATER': 0x28,
    'GRASS': 0x2C, 'ELECTRIC': 0x40, 'PSYCHIC': 0x84, 'ICE': 0x4C, 'DRAGON': 0xA0, 'DARK': 0x8C,
}
ICON_TEXT, ICON_SHADOW = 0x1F, 0x1E


def apply_type_icons():
    """Redraws the type labels with the new names, reusing the game's font."""
    import io
    from PIL import Image
    raw = subprocess.check_output(['git', '-C', REPO, 'show', f'{BASELINE}:game/graphics/interface/menu_info.png'])
    im = Image.open(io.BytesIO(raw))
    px = im.load()

    def origin(slot):
        off = TYPE_ICON_OFFSETS[slot]
        return (off % 16) * 8, (off // 16) * 8

    # Collect glyphs (text pixels, rows 2-8) from the original labels.
    glyphs = {}
    for slot, original in [('NORMAL', 'NORMAL'), ('FIRE', 'FIRE'), ('WATER', 'WATER'), ('GRASS', 'GRASS'),
                           ('ROCK', 'ROCK'), ('GROUND', 'GROUND'), ('FLYING', 'FLYING'), ('FIGHTING', 'FIGHT'),
                           ('BUG', 'BUG'), ('POISON', 'POISON'), ('DARK', 'DARK')]:
        x0, y0 = origin(slot)
        cols = [x for x in range(32) if any(px[x0 + x, y0 + y] == ICON_TEXT for y in range(12))]
        runs = []
        for c in cols:
            if runs and c == runs[-1][-1] + 1:
                runs[-1].append(c)
            else:
                runs.append([c])
        assert len(runs) == len(original), original
        for ch, run in zip(original, runs):
            glyphs.setdefault(ch, [[px[x0 + x, y0 + y] == ICON_TEXT for x in run] for y in range(2, 9)])
    glyphs['J'] = [[c == '#' for c in row] for row in ('...#', '...#', '...#', '...#', '...#', '#..#', '.##.')]

    for naruto_type, slot in R.TYPES.items():
        text = R.TYPE_NAMES[naruto_type]
        x0, y0 = origin(slot)
        for y in range(12):
            plate = px[x0, y0 + y]  # plates can be two-tone; column 0 has no text
            for x in range(32):
                if px[x0 + x, y0 + y] in (ICON_TEXT, ICON_SHADOW):
                    px[x0 + x, y0 + y] = plate
        width = sum(len(glyphs[ch][0]) + 1 for ch in text)
        x = x0 + (32 - width) // 2 + 1
        for ch in text:
            g = glyphs[ch]
            for gy, row in enumerate(g):
                for gx, on in enumerate(row):
                    if on:
                        px[x + gx, y0 + 2 + gy] = ICON_TEXT
                        for sx, sy in ((1, 0), (0, 1), (1, 1)):
                            tx, ty = x + gx + sx, y0 + 2 + gy + sy
                            if px[tx, ty] != ICON_TEXT:
                                px[tx, ty] = ICON_SHADOW
            x += len(g[0]) + 1
    im.save(os.path.join(GAME, 'graphics/interface/menu_info.png'))


def remap_species(text, mapping, pattern=r'SPECIES_(\w+)'):
    def sub(m):
        name = m.group(1)
        if name in mapping:
            return ninja_const(mapping[name])
        return m.group(0)
    return re.sub(pattern, sub, text)


def scale_dex_requirements(text):
    """Halves the Pokédex counts that aides and Oak ask for (10..60): with
    only 40 ninjas, of which one save can own about 34, the originals would
    be out of reach."""
    text = re.sub(r'(\.equ REQUIRED_(?:SEEN|CAUGHT|OWNED)_MONS, )(\d+)', lambda m: m.group(1) + str(int(m.group(2)) // 2), text)
    return text.replace('goto_if_lt VAR_0x8009, 60,', 'goto_if_lt VAR_0x8009, 30,')


def apply_species_map(mapping):
    # Aliases so data files can say SPECIES_NJ_NARUTO.
    lines = ['#ifndef GUARD_CONSTANTS_NINJAS_H', '#define GUARD_CONSTANTS_NINJAS_H', '',
             '// Generated by tools/naruto/apply.py: each ninja reuses a species slot.', '']
    lines += [f'#define {ninja_const(n["key"])} SPECIES_{n["slot"]}' for n in R.ROSTER]
    lines += ['', '#endif // GUARD_CONSTANTS_NINJAS_H', '']
    write('include/constants/ninjas.h', '\n'.join(lines))
    species_h = pristine('include/constants/species.h')
    species_h = species_h.replace('#endif  // GUARD_CONSTANTS_SPECIES_H', '#include "constants/ninjas.h"\n\n#endif  // GUARD_CONSTANTS_SPECIES_H')
    assert 'constants/ninjas.h' in species_h
    write('include/constants/species.h', species_h)

    exclude = r'SPECIES_(?!NONE\b|EGG\b|NJ_)(\w+)'
    for path in ('src/data/wild_encounters.json', 'src/data/trainer_parties.h', 'src/data/ingame_trades.h'):
        write(path, remap_species(pristine(path), mapping, exclude))
    for path in MAP_SCRIPTS:
        rel = os.path.relpath(path, GAME)
        text = remap_species(pristine(rel), mapping, exclude)
        write(path, scale_dex_requirements(text))

    # C code that names specific species for special battles.
    setup = pristine('src/battle_setup.c')
    setup = setup.replace('CreateMonWithGenderNatureLetter(gEnemyParty, SPECIES_MAROWAK,',
                          f'CreateMonWithGenderNatureLetter(gEnemyParty, {ninja_const(mapping["MAROWAK"])},')
    legend_cases = re.search(r'    case SPECIES_MOLTRES:\n    case SPECIES_ARTICUNO:\n    case SPECIES_ZAPDOS:\n    case SPECIES_HO_OH:\n    case SPECIES_LUGIA:\n', setup)
    legends = sorted({mapping[s] for s in ('MOLTRES', 'ARTICUNO', 'ZAPDOS', 'SNORLAX')} - {mapping['MEWTWO'], mapping['DEOXYS']})
    setup = setup.replace(legend_cases.group(0), ''.join(f'    case {ninja_const(k)}:\n' for k in legends))
    setup = setup.replace('    case SPECIES_MEWTWO:\n', f'    case {ninja_const(mapping["MEWTWO"])}:\n', 1)
    setup = setup.replace('    case SPECIES_DEOXYS:\n', f'    case {ninja_const(mapping["DEOXYS"])}:\n', 1)
    write('src/battle_setup.c', setup)
    roamer = pristine('src/roamer.c')
    for s in ('RAIKOU', 'ENTEI', 'SUICUNE'):
        roamer = roamer.replace(f'SPECIES_{s}', ninja_const(mapping[s]))
    write('src/roamer.c', roamer)


def report(mapping):
    wild = json.load(open(os.path.join(GAME, 'src/data/wild_encounters.json')))
    text = json.dumps(wild) + ''.join(open(p).read() for p in MAP_SCRIPTS)
    found = set(re.findall(r'SPECIES_NJ_(\w+)', text))
    evolved_from = {n['evo'][1] for n in R.ROSTER if n.get('evo')} | {'NARUTO', 'SASUKE', 'SAKURA'}  # starters
    missing = [n['key'] for n in R.ROSTER if n['key'] not in found and n['key'] not in evolved_from]
    print(f'{len(mapping)} species mapped onto {len(R.ROSTER)} ninjas.')
    print('Not obtainable in the wild, as a gift or by evolving:', ', '.join(missing) or 'none')


STRING = re.compile(r'"(?:[^"\\\n]|\\.)*"')
TEXT_LINE_BREAK = re.compile(r'\\[nlp]')


def rename_in_strings(text, names, too_long=None):
    """Replaces names inside string literals only (never in identifiers).
    Lines that grow past what fits a message box are added to `too_long`."""
    if not names:
        return text
    # Not part of a longer word or of a {CONSTANT_NAME} control code.
    pattern = re.compile(r'(?<![A-Z_])(' + '|'.join(re.escape(old) for old, _new in names) + r')(?![A-Z_])')
    new_names = dict(names)

    def fix(m):
        old = m.group(0)
        new = pattern.sub(lambda n: new_names[n.group(1)], old)
        if new != old and too_long is not None:
            def width(line):
                return len(re.sub(r'\{[^}]*\}|["$]', '', line))
            limit = max(36, max(width(line) for line in TEXT_LINE_BREAK.split(old)))
            too_long.extend(line for line in TEXT_LINE_BREAK.split(new) if width(line) > limit)
        return new
    return STRING.sub(fix, text)


def apply_trainer_names(already_written):
    """Renames the story characters in every text string of the game."""
    names = R.TRAINER_NAMES
    olds = '|'.join(re.escape(old) for old, _new in names)
    files = subprocess.check_output(['git', '-C', REPO, 'grep', '-lE', olds, BASELINE, '--', 'game/data', 'game/src'],
                                    text=True).split()
    changed, too_long = [], []
    for entry in files:
        rel = entry.split(':', 1)[1][len('game/'):]
        if not rel.endswith(('.inc', '.c', '.h', '.s')):
            continue
        text = open(os.path.join(GAME, rel)).read() if rel in already_written else pristine(rel)
        new = rename_in_strings(text, names, too_long)
        if new != text:
            write(rel, new)
            changed.append(rel)
    for rel, old, new in R.TEXT_FIXUPS:
        text = open(os.path.join(GAME, rel)).read()
        assert old in text, (rel, old)
        write(rel, text.replace(old, new))
    final = ''.join(open(os.path.join(GAME, rel)).read() for rel in changed)
    too_long = [line for line in too_long if line in final]  # not fixed up by hand
    intro = pristine('data/text/new_game_intro.inc')
    for old, new in R.NAME_CHOICES.items():
        intro = intro.replace(f'.string "{old}$"', f'.string "{new}$"')
    write('data/text/new_game_intro.inc', intro)
    print(f'Story characters renamed in {len(changed)} files.')
    for line in too_long:
        print('  check line length:', line)
    return changed


def apply_player_colors():
    for path, changes in R.PLAYER_COLORS.items():
        lines = pristine(path).replace('\r', '').split('\n')
        for index, color in changes.items():
            lines[3 + index] = ' '.join(str(v) for v in color)
        with open(os.path.join(GAME, path), 'w', newline='\r\n') as f:
            f.write('\n'.join(lines))


def main():
    roster_by_key = {n['key']: n for n in R.ROSTER}
    assert len(roster_by_key) == len(R.ROSTER)
    for n in R.ROSTER:
        if n.get('evo'):
            assert n['evo'][1] in roster_by_key, n['evo']
    mapping = build_species_map()
    apply_species(roster_by_key)
    apply_learnsets()
    apply_pokedex()
    apply_types_and_moves()
    apply_type_icons()
    apply_species_map(mapping)
    written = set(MANAGED) | {os.path.relpath(p, GAME) for p in MAP_SCRIPTS}
    apply_trainer_names(written)
    apply_player_colors()
    report(mapping)


if __name__ == '__main__':
    main()
