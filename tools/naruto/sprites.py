#!/usr/bin/env python3
"""Turns generated artwork into GBA battle sprites for the ninjas.

    python3 tools/naruto/sprites.py [KEY ...]

Input: tools/naruto/art/<KEY>.png, one image per ninja with the front view
on the left half and the back view on the right half, on a plain light
background (see generate_art.py). Output, for the species slot the ninja
uses (graphics/pokemon/<slot>/): front.png and back.png (64x64, 16 colours
shared through normal.pal), shiny.pal, icon.png (two 32x32 frames in one of
the three shared icon palettes), plus the sprite coordinates and icon
palette index in the source tables.

Requires Pillow and NumPy.
"""

import colorsys
import os
import re
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
GAME = os.path.join(HERE, '..', '..', 'game')
ART = os.path.join(HERE, 'art')
sys.path.insert(0, HERE)
import roster as R  # noqa: E402

SIZE = 64
ICON = 32


def pixels(im):
    # Image.getdata is deprecated in newer Pillow versions.
    return im.get_flattened_data() if hasattr(im, 'get_flattened_data') else im.getdata()


def read_jasc(path):
    lines = open(path).read().split('\n')
    count = int(lines[2])
    return [tuple(int(v) for v in lines[3 + i].split()) for i in range(count)]


def write_jasc(path, colors):
    with open(path, 'w', newline='\r\n') as f:
        f.write(f'JASC-PAL\n0100\n{len(colors)}\n')
        for c in colors:
            f.write(f'{c[0]} {c[1]} {c[2]}\n')


def gba_color(c):
    # 5 bits per channel, the way the GBA stores colours.
    return tuple(min(255, (v >> 3) << 3) for v in c)


def remove_background(im, thresh=40):
    """Makes the flat background transparent by flooding it from the edges."""
    rgb = im.convert('RGB')
    w, h = rgb.size
    px = rgb.load()
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    bg = tuple(sorted(c[i] for c in corners)[1] for i in range(3))
    marker = (255, 0, 254)
    for x, y in [(x, y) for x in range(0, w, 4) for y in (0, h - 1)] + [(x, y) for y in range(0, h, 4) for x in (0, w - 1)]:
        c = px[x, y]
        if c != marker and sum(abs(c[i] - bg[i]) for i in range(3)) <= 60:
            ImageDraw.floodfill(rgb, (x, y), marker, thresh=thresh)
    a = np.asarray(rgb)
    alpha = np.where((a == marker).all(-1), 0, 255).astype(np.uint8)
    out = rgb.convert('RGBA')
    out.putalpha(Image.fromarray(alpha, 'L'))
    return out


def crop_subject(im):
    return im.crop(im.getchannel('A').point(lambda a: 255 if a > 128 else 0).getbbox())


def flat_pixels(im):
    """Colours of pixels inside flat areas (skipping anti-aliased edges)."""
    a = np.asarray(im.convert('RGBA')).astype(np.int16)
    rgb, alpha = a[..., :3], a[..., 3]
    same = (np.abs(rgb[:-1, :-1] - rgb[1:, :-1]).sum(-1) < 24) & (np.abs(rgb[:-1, :-1] - rgb[:-1, 1:]).sum(-1) < 24)
    keep = same & (alpha[:-1, :-1] > 200) & (alpha[1:, :-1] > 200) & (alpha[:-1, 1:] > 200)
    return rgb[:-1, :-1][keep]


def make_palette(views, colors=15):
    """15 colours for the flat areas of all views, darkest (the outline) first."""
    samples = np.concatenate([flat_pixels(v) for v in views]).astype(np.uint8)
    sample = Image.fromarray(samples.reshape(1, -1, 3), 'RGB')
    q = sample.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, kmeans=4)
    pal = [gba_color(tuple(q.getpalette()[i * 3:i * 3 + 3])) for i in range(colors)]
    pal.sort(key=lambda c: 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2])
    return pal


def nearest(rgb, pal):
    """Index into `pal` of the closest colour for every pixel."""
    p = np.array(pal, dtype=np.int32)
    d = ((rgb[..., None, :].astype(np.int32) - p) ** 2).sum(-1)
    return d.argmin(-1)


def shrink(im, pal, height, max_width, outline=0.35):
    """Scales `im` down to `height` pixels. Each output pixel takes the most
    common palette colour of the source pixels it covers, so flat areas stay
    flat instead of blending; outline pixels win once they cover a good part
    of the block, so lines survive. Returns palette indices, -1 = transparent."""
    a = np.asarray(im.convert('RGBA'))
    h, w = a.shape[:2]
    scale = min(height / h, max_width / w)
    oh, ow = max(1, round(h * scale)), max(1, round(w * scale))
    idx = nearest(a[..., :3], pal) + 1
    idx[a[..., 3] < 128] = 0
    by = np.minimum((np.arange(h) * oh) // h, oh - 1)
    bx = np.minimum((np.arange(w) * ow) // w, ow - 1)
    counts = np.zeros((oh, ow, len(pal) + 1), dtype=np.int32)
    np.add.at(counts, (by[:, None], bx[None, :], idx), 1)
    total = counts.sum(-1)
    opaque = total - counts[..., 0]
    out = counts[..., 1:].argmax(-1)
    out[counts[..., 1] >= outline * np.maximum(opaque, 1)] = 0
    out[counts[..., 0] * 2 > total] = -1
    return out


def outline_edges(ix):
    """Gives the silhouette a closed outline in the darkest colour."""
    solid = ix >= 0
    padded = np.pad(solid, 1)
    edge = solid & ~(padded[:-2, 1:-1] & padded[2:, 1:-1] & padded[1:-1, :-2] & padded[1:-1, 2:])
    ix = ix.copy()
    ix[edge] = 0
    return ix


def place(ix, size=SIZE):
    """Centres the sprite horizontally with its feet at the bottom of the canvas."""
    canvas = np.full((size, size), -1, dtype=np.int32)
    h, w = ix.shape
    top, left = size - h, (size - w) // 2
    canvas[top:top + h, left:left + w] = ix
    return canvas


def to_png(canvas, pal):
    im = Image.fromarray((canvas + 1).astype(np.uint8), 'P')
    im.putpalette([v for c in [(128, 160, 128)] + pal for v in c] + [0] * (768 - 3 * (len(pal) + 1)))
    return im


def bbox(canvas):
    ys, xs = np.nonzero(canvas >= 0)
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1


def shiny_palette(palette):
    out = [palette[0]]
    for c in palette[1:]:
        h, l, s = colorsys.rgb_to_hls(*(v / 255 for v in c))
        r, g, b = colorsys.hls_to_rgb((h + 0.5) % 1.0, l, s)
        out.append(gba_color((int(r * 255), int(g * 255), int(b * 255))))
    return out


ICON_PALETTES = os.path.join(GAME, 'graphics/pokemon/icon_palettes')
FIXED_ICON_PALETTES = 3  # the game's own palettes (0-2); 3-5 are made for the ninjas


def icon_error(colors, counts, icon_pal):
    d = ((colors[:, None, :].astype(np.int32) - np.array(icon_pal, dtype=np.int32)) ** 2).sum(-1)
    return int((d.min(-1) * counts).sum())


def design_icon_palettes(icons, rounds=6):
    """Picks three extra 15-colour icon palettes that suit the ninjas and
    assigns every ninja the best of all six palettes. `icons` maps a key to
    (colors, counts) of its icon. Returns (palettes, assignment)."""
    fixed = [read_jasc(os.path.join(ICON_PALETTES, f'icon_palette_{i}.pal'))[1:16] for i in range(FIXED_ICON_PALETTES)]
    keys = sorted(icons)

    def hue(k):
        colors, counts = icons[k]
        bright = colors.max(-1) > 80
        c = (colors[bright] * counts[bright, None]).sum(0) / max(1, counts[bright].sum())
        return colorsys.rgb_to_hsv(*(c / 255))[0]
    by_hue = sorted(keys, key=hue)
    assign = {k: FIXED_ICON_PALETTES + i * 3 // len(by_hue) for i, k in enumerate(by_hue)}
    palettes = list(fixed)
    for _ in range(rounds):
        palettes = list(fixed)
        for p in range(3):
            members = [k for k in keys if assign[k] == FIXED_ICON_PALETTES + p] or by_hue[p::3]
            pixels = np.concatenate([np.repeat(icons[k][0], icons[k][1], axis=0) for k in members]).astype(np.uint8)
            q = Image.fromarray(pixels.reshape(1, -1, 3), 'RGB').quantize(colors=15, method=Image.Quantize.MEDIANCUT, kmeans=4)
            pal = [gba_color(tuple(q.getpalette()[i * 3:i * 3 + 3])) for i in range(15)]
            palettes.append(pal)
        assign = {k: min(range(len(palettes)), key=lambda i: icon_error(*icons[k], palettes[i])) for k in keys}
    return palettes, assign


def icon_colors(ix, pal):
    used, counts = np.unique(ix[ix >= 0], return_counts=True)
    return np.array([pal[i] for i in used]), counts


def make_icon(ix, pal, icon_pal):
    """Two 32x32 frames, the second one a hop higher."""
    mapping = nearest(np.array(pal), icon_pal)
    mapped = np.where(ix >= 0, mapping[np.maximum(ix, 0)], -1)
    frames = np.full((ICON * 2, ICON), -1, dtype=np.int32)
    h, w = mapped.shape
    left = (ICON - w) // 2
    frames[ICON - 1 - h:ICON - 1, left:left + w] = mapped
    frames[2 * ICON - 2 - h:2 * ICON - 2, left:left + w] = mapped
    return to_png(frames, icon_pal)


def target_height(ninja):
    h = ninja['height']
    # Children are a bit smaller than adults; giant summons fill the frame.
    return 36 if h <= 5 else 46 if h <= 12 else 52 if h <= 16 else 56 if h <= 20 else 62


def set_coords(text, slot, box):
    width = -(-(box[2] - box[0]) // 8) * 8
    height = -(-(box[3] - box[1]) // 8) * 8
    y_offset = SIZE - box[3]
    new = f'{{\n        .size = MON_COORDS_SIZE({width}, {height}),\n        .y_offset = {y_offset},\n    }}'
    return re.sub(r'(\[SPECIES_' + slot + r'\] =\s*)\{.*?\}', lambda m: m.group(1) + new, text, count=1, flags=re.S)


def slot_dir(slot):
    return os.path.join(GAME, 'graphics/pokemon', slot.lower())


def load_views(ninja):
    sheet = Image.open(os.path.join(ART, f'{ninja["key"]}.png')).convert('RGBA')
    w, h = sheet.size
    front, back = (crop_subject(remove_background(sheet.crop(box)))
                   for box in ((0, 0, w // 2, h), (w // 2, 0, w, h)))
    return front, back, make_palette([front, back])


def write_sprites(ninja, front, back, pal):
    height = target_height(ninja)
    front_ix = place(outline_edges(shrink(front, pal, height, SIZE - 2)))
    # The player's own fighter is seen up close, so the back view is larger.
    back_ix = place(outline_edges(shrink(back, pal, min(SIZE, round(height * 1.15)), SIZE - 2)))
    d = slot_dir(ninja['slot'])
    to_png(front_ix, pal).save(os.path.join(d, 'front.png'))
    to_png(back_ix, pal).save(os.path.join(d, 'back.png'))
    palette = [(128, 160, 128)] + pal
    write_jasc(os.path.join(d, 'normal.pal'), palette)
    write_jasc(os.path.join(d, 'shiny.pal'), shiny_palette(palette))
    return bbox(front_ix), bbox(back_ix)


def main():
    keys = set(sys.argv[1:])
    front_coords_path = os.path.join(GAME, 'src/data/pokemon_graphics/front_pic_coordinates.h')
    back_coords_path = os.path.join(GAME, 'src/data/pokemon_graphics/back_pic_coordinates.h')
    icon_path = os.path.join(GAME, 'src/pokemon_icon.c')
    front_coords, back_coords, icons = (open(p).read() for p in (front_coords_path, back_coords_path, icon_path))
    done = []
    icon_data = {}
    ninjas = [n for n in R.ROSTER if os.path.exists(os.path.join(ART, f'{n["key"]}.png'))]
    for ninja in ninjas:
        front, back, pal = load_views(ninja)
        # Icons are always redone for every ninja: they share the palettes.
        ix = outline_edges(shrink(front, pal, 28, 30))
        icon_data[ninja['key']] = (ix, pal)
        if keys and ninja['key'] not in keys:
            continue
        front_box, back_box = write_sprites(ninja, front, back, pal)
        front_coords = set_coords(front_coords, ninja['slot'], front_box)
        back_coords = set_coords(back_coords, ninja['slot'], back_box)
        done.append(ninja['key'])

    palettes, assign = design_icon_palettes({k: icon_colors(ix, pal) for k, (ix, pal) in icon_data.items()})
    for i in range(FIXED_ICON_PALETTES, len(palettes)):
        write_jasc(os.path.join(ICON_PALETTES, f'icon_palette_{i}.pal'), [(98, 156, 131)] + palettes[i])
    for ninja in ninjas:
        ix, pal = icon_data[ninja['key']]
        index = assign[ninja['key']]
        make_icon(ix, pal, palettes[index]).save(os.path.join(slot_dir(ninja['slot']), 'icon.png'))
        icons = re.sub(r'(gMonIconPaletteIndices\[\] = \{.*?\[SPECIES_' + ninja['slot'] + r'\]\s*=\s*)\d',
                       lambda m: m.group(1) + str(index), icons, count=1, flags=re.S)

    for path, text in ((front_coords_path, front_coords), (back_coords_path, back_coords), (icon_path, icons)):
        with open(path, 'w') as f:
            f.write(text)
    print(f'Sprites written for {len(done)} ninjas: {", ".join(done)}')
    print(f'Icons written for {len(ninjas)} ninjas; palette use:',
          {i: sum(1 for v in assign.values() if v == i) for i in range(len(palettes))})


if __name__ == '__main__':
    main()
