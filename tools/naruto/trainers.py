#!/usr/bin/env python3
"""Trainer portraits for the Naruto theme: gym leaders, rival and others.

    BFL_API_KEY=... python3 tools/naruto/trainers.py generate [--dry-run] [GROUP ...]
    python3 tools/naruto/trainers.py convert

`generate` draws four characters per image (a 2x2 grid, cheaper than one
image each) into tools/naruto/art/trainers_<group>.png; groups that already
have art are skipped. `convert` cuts the grids into 64x64 16-colour trainer
pictures and palettes (graphics/trainers/). The new names of the characters
are applied to the game's texts by apply.py (see TRAINER_NAMES in roster.py).
"""

import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import generate_art as G  # noqa: E402
import sprites as S  # noqa: E402
from PIL import Image  # noqa: E402

GAME = S.GAME
PICS = os.path.join(GAME, 'graphics/trainers/front_pics')
PALETTES = os.path.join(GAME, 'graphics/trainers/palettes')

# group -> four (picture, look) pairs, in reading order of the grid.
GROUPS = {
    'story': [
        ('rival_early', 'a 12-year-old boy with black spiky hair pointing backwards, navy short-sleeved '
         'high-collar shirt with a red and white fan emblem, white shorts, blue forehead protector, '
         'arm warmers, confident smirk, hands in his pockets'),
        ('rival_late', 'a 16-year-old boy with black spiky hair, open white high-collar shirt, dark blue '
         'trousers, thick purple rope belt tied in a bow, a sword on his back, cool stare'),
        ('champion_rival', 'a young man with black hair falling over one eye, long dark grey travelling '
         'cloak, a sword at his hip, one purple ringed eye and one red eye, calm and confident'),
        ('professor_oak', 'a kind elderly village leader with a short grey goatee, wide white and red '
         'conical leader hat, white robe over black armor, holding a smoking pipe, warm smile'),
    ],
    'gyms1': [
        ('leader_brock', 'a tiny elderly man with a big round red nose, white beard and a white hair '
         'topknot, green and red robes, a large green and white hat, arms folded behind his back'),
        ('leader_misty', 'an elegant woman with very long auburn hair, a topknot and bangs over one eye, '
         'long-sleeved dark blue robe down to the ankles, confident smile'),
        ('leader_lt_surge', 'a huge muscular dark-skinned man with slicked-back platinum blond hair and '
         'a moustache, white leader robe over dark armor, gold bracelets, blue lightning around his fists'),
        ('leader_erika', 'a cheerful girl with long platinum blond hair in a high ponytail and bangs over '
         'one eye, purple long-sleeved ninja outfit with trousers, holding a pink flower'),
    ],
    'gyms2': [
        ('leader_koga', 'a teenage girl with brown hair in two round buns, pink sleeveless high-collar '
         'top, dark green trousers, holding a big weapon scroll, kunai in the other hand'),
        ('leader_sabrina', 'a young woman with long wavy black hair and red eyes, white dress made of '
         'wrapped bandages with a red mesh sleeve on one arm, forehead protector, mysterious smile'),
        ('leader_blaine', 'a tall bearded man with short black hair, a cigarette in his mouth, green '
         'flak vest over navy uniform, red waist sash, a trench knife in each hand'),
        ('leader_giovanni', 'a grim young man with spiky orange hair, many metal piercings on his face '
         'and nose, purple eyes with ring patterns, black high-collar cloak with red clouds'),
    ],
    'elite': [
        ('elite_four_lorelei', 'a calm young woman with short blue-violet hair in a bun with a white '
         'paper flower, amber eyes, black high-collar cloak with red clouds, paper butterflies around her'),
        ('elite_four_bruno', 'a tall muscular dark-skinned man with short white hair, sunglasses, a '
         'goatee, a white rope around his neck, seven swords on his back, a horn tattoo on one cheek'),
        ('elite_four_agatha', 'a tiny elderly woman with grey hair in a bun, maroon robe with a white '
         'collar, glowing chakra strings from her fingertips, sly smile'),
        ('elite_four_lance', 'a tall stern man with extremely long spiky black hair covering one eye, '
         'dark red samurai armor over a navy robe, a large round war fan on his back'),
    ],
    'players': [
        ('red', 'a friendly young ninja trainee with spiky brown hair and a blue headband, orange '
         'jacket, black trousers, waving hello'),
        (None, 'a man in a plain grey coat'),
        ('gentleman', 'a dignified old gentleman with a white moustache, dark green haori jacket '
         'over a grey kimono, holding a folded paper fan'),
        ('lady', 'an elegant rich lady with black hair in a bun decorated with hairpins, '
         'embroidered purple kimono, holding a small parasol'),
    ],
    'kids': [
        ('youngster', 'a small academy student boy with a green bandana, green t-shirt and shorts, '
         'holding a paper shuriken toy, big grin'),
        ('bug_catcher', 'a small boy with round dark sunglasses and a big hooded green coat with a high '
         'collar, little beetles buzzing around him'),
        ('camper', 'a small boy scout with a cap, khaki clothes and a big backpack, saluting'),
        ('tuber_f', 'a small child in a yellow raincoat holding a big swim ring, happy'),
    ],
    'village': [
        ('picnicker', 'a young woman with short green hair and a flower hairclip, beige travel '
         'clothes, carrying a picnic basket'),
        ('lass', 'a young woman with long light blue hair, pink kimono-style dress, holding a folded fan'),
        ('aroma_lady', 'a gentle woman with a flower crown, long green dress, holding a bouquet of herbs'),
        ('pokemon_breeder', 'a kind woman with brown hair, an apron over a grey jacket, holding a '
         'basket with three small puppies'),
    ],
    'outdoor': [
        ('bird_keeper', 'a young man with messy black hair and goggles, brown vest, a hawk perched on '
         'his raised arm'),
        ('hiker', 'a big bearded mountain man with a huge backpack, brown clothes and a walking staff'),
        ('fisherman', 'a fisherman with a wide straw hat, rolled-up trousers and a fishing rod over his '
         'shoulder'),
        ('sailor', 'a burly sailor with a white striped sailor shirt and cap, anchor tattoo on his arm'),
    ],
    'fighters': [
        ('swimmer_m', 'a water ninja man in a full dark blue bodysuit, diving goggles pushed up on his '
         'forehead'),
        ('swimmer_f', 'a water ninja woman in a full-body dark blue diving suit, diving goggles on her head'),
        ('black_belt', 'a bald muscular martial artist in a white gi with a black belt, bandaged fists, '
         'fighting stance'),
        ('crush_girl', 'a strong young woman martial artist with short black hair, white gi, fists up'),
    ],
    'oddballs': [
        ('scientist', 'a sinister scientist with round glasses and grey hair in a ponytail, white lab '
         'coat, holding a test tube'),
        ('super_nerd', 'a nerdy young man with thick glasses and a scroll case on his back, reading an '
         'open scroll'),
        ('pokemaniac', 'a large man in a fox mask and baggy orange clothes, excited pose'),
        ('gamer', 'an old man gambler with a green visor, holding dice and playing cards'),
    ],
    'tough': [
        ('cue_ball', 'a tough bald man with a scar, dark sunglasses, black jacket and metal chains'),
        ('juggler', 'a circus performer in a harlequin costume juggling colorful balls'),
        ('tamer', 'a beast tamer man with wild hair, a fur vest and a whip, a big grey wolf beside him'),
        ('ruin_maniac', 'an explorer with a pith helmet and a beard, khaki clothes, holding a pickaxe'),
    ],
    'elites': [
        ('cool_trainer_m', 'an elite ninja man with short spiky blue hair, green flak vest, a katana on '
         'his back'),
        ('cool_trainer_f', 'an elite ninja woman with long red hair, green flak vest, confident smile'),
        ('psychic_m', 'a mysterious illusionist man with a hood and a purple robe, one eye glowing'),
        ('psychic_f', 'an illusionist woman with long purple hair and a purple robe, making a hand seal'),
    ],
    'spirits': [
        ('channeler', 'an old spirit medium woman with long grey hair, white shrine robes, prayer beads'),
        ('beauty', 'a glamorous woman with long wavy blonde hair, elegant long red kimono'),
        ('painter', 'a pale young man with short black hair, black jacket, holding a big ink brush and '
         'an open scroll'),
        ('engineer', 'a builder with a yellow hard hat, orange overalls and a big wooden mallet'),
    ],
    'rangers': [
        ('pokemon_ranger_m', 'a forest ranger man with a green hood and cloak, a bow on his back'),
        ('pokemon_ranger_f', 'a forest ranger woman with a green cloak, holding a wooden staff'),
        ('rocker', 'a rock musician with wild spiky hair, sunglasses, playing a shamisen'),
        ('leaf', 'a young woman ninja with long dark brown hair in a high ponytail, blue forehead '
         'protector, red long-sleeved jacket with white trim, black trousers, friendly smile'),
    ],
    'pairs': [
        ('crush_kin', 'two martial artists side by side, a man and a woman, both in white gi'),
        ('twins', 'two identical little twin girls side by side holding hands, matching blue '
         'dresses, pigtails'),
        ('young_couple', 'a young man and a young woman side by side holding hands, casual village '
         'clothes'),
        ('sis_and_bro', 'a small boy and his older sister side by side, both in summer yukata robes'),
    ],
    'couples': [
        ('cool_couple', 'two stylish elite ninjas side by side, a man and a woman, both in green flak '
         'vests over navy uniforms, confident poses'),
        ('old_couple', 'an elderly man and woman side by side, both in simple brown kimonos, smiling'),
        ('pokefan_m', 'a cheerful chubby man in a green happi coat with a headband, waving a flag'),
        ('pokefan_f', 'a cheerful woman in a pink happi coat with a headband, holding a paper fan'),
    ],
    'rogues': [
        ('rocket_grunt_m', 'a rogue ninja man with a dark cloth mask over his mouth, black long cloak with '
         'a red cloud pattern, a straw hat with hanging white paper strips, arms crossed'),
        ('rocket_grunt_f', 'a rogue ninja woman with a dark cloth mask over her mouth, black long cloak '
         'with a red cloud pattern, short purple hair, a straw hat, hands on her hips'),
        ('burglar', 'a sneaky thief ninja man with a bandana tied over his head and nose, dark grey '
         'outfit, carrying a big cloth sack over his shoulder'),
        ('biker', 'a tough punk ninja man with a spiky red mohawk, sleeveless black leather vest with '
         'metal studs, fingerless gloves, a scarred forehead protector, sneering'),
    ],
}

# The API's content filter is partly random; these seeds got through it.
SEEDS = {}

PROMPT = (
    'Four different anime ninja characters arranged in a 2x2 grid, one character per quadrant, each '
    'standing alone and centered in its own quadrant with empty white space around it, on a pure '
    'flat white background. Drawn in the style of official Game Boy Advance trainer battle '
    'portraits: full body from head to feet, normal anime proportions about five heads tall, facing '
    'the viewer and turned slightly to the left, bold thick black outline around each silhouette, '
    'flat cel shading with two tones per color, bright saturated colors, simple readable shapes. '
    'Top left: {0}. Top right: {1}. Bottom left: {2}. Bottom right: {3}. '
    'No text, no labels, no grid lines, no ground shadow, no scenery.'
)


def art_path(group):
    return os.path.join(G.ART, f'trainers_{group}.png')


def generate(args):
    dry_run = '--dry-run' in args
    names = [a for a in args if not a.startswith('--')] or list(GROUPS)
    todo = [g for g in names if not os.path.exists(art_path(g))]
    key = os.environ.get('BFL_API_KEY')
    if not key and not dry_run:
        sys.exit('Set BFL_API_KEY.')
    for group in todo:
        prompt = PROMPT.format(*(look for _pic, look in GROUPS[group]))
        if dry_run:
            print(group, '->', prompt)
            continue
        print(f'Generating {group}...', flush=True)
        G.request_image(prompt, key, art_path(group), width=1024, height=1024, seed=SEEDS.get(group, sum(map(ord, group))))


def convert():
    for group, entries in GROUPS.items():
        if not os.path.exists(art_path(group)):
            continue
        sheet = Image.open(art_path(group)).convert('RGBA')
        w, h = sheet.size
        for i, (pic, _look) in enumerate(entries):
            if pic is None:  # a filler figure
                continue
            x, y = (i % 2) * w // 2, (i // 2) * h // 2
            # A higher threshold also clears background enclosed by thin pale lines
            # (chakra strings); the thick black outlines still stop the fill.
            figure = S.crop_subject(S.remove_background(sheet.crop((x, y, x + w // 2, y + h // 2)), thresh=100))
            pal = S.make_palette([figure])
            # Trainer pictures fill the frame down to the bottom row, like the originals.
            ix = S.place(S.outline_edges(S.shrink(figure, pal, 62, S.SIZE - 4)))
            S.to_png(ix, pal).save(os.path.join(PICS, f'{pic}_front_pic.png'))
            S.write_jasc(os.path.join(PALETTES, f'{pic}.pal'), [(115, 197, 164)] + pal)
        print(f'Trainer pictures written for {group}: {", ".join(p for p, _ in entries if p)}')


# The new-game scene shows bigger 64x96 pictures of the professor, the rival
# and the player: (picture, group, quadrant, first palette index). They are
# 8bpp backgrounds whose 32 colours sit at a fixed place in the palette.
INTRO = [
    ('oak', 'story', 3, 96),
    ('rival', 'story', 0, 96),
    ('red', 'players', 0, 64),
    ('leaf', 'rangers', 3, 64),
]


def convert_intro():
    for name, group, quadrant, base in INTRO:
        if not os.path.exists(art_path(group)):
            continue
        sheet = Image.open(art_path(group)).convert('RGBA')
        w, h = sheet.size
        x, y = (quadrant % 2) * w // 2, (quadrant // 2) * h // 2
        figure = S.crop_subject(S.remove_background(sheet.crop((x, y, x + w // 2, y + h // 2)), thresh=100))
        pal = S.make_palette([figure], colors=31)
        ix = S.outline_edges(S.shrink(figure, pal, 80, 58))
        canvas = np.full((96, 64), -1, dtype=np.int32)
        ih, iw = ix.shape
        canvas[93 - ih:93, (64 - iw) // 2:(64 - iw) // 2 + iw] = ix
        # Index 0 is transparent; colour i of the picture is palette entry base + 1 + i.
        pixels = np.where(canvas >= 0, canvas + base + 1, 0).astype(np.uint8)
        full = [(0, 0, 0)] * 256
        full[base + 1:base + 32] = pal
        im = Image.fromarray(pixels, 'P')
        im.putpalette([v for c in full for v in c])
        d = os.path.join(GAME, 'graphics/oak_speech', name)
        im.save(os.path.join(d, 'pic.png'))
        S.write_jasc(os.path.join(d, 'pal.pal'), [(0, 0, 0)] + pal)
    print('New-game scene pictures written.')


if __name__ == '__main__':
    if sys.argv[1:2] == ['generate']:
        generate(sys.argv[2:])
    elif sys.argv[1:2] == ['convert']:
        convert()
        convert_intro()
    else:
        sys.exit(__doc__)
