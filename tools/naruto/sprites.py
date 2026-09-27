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

Requires Pillow.
"""

import colorsys
import os
import re
import sys

from PIL import Image, ImageFilter

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
        f.write('JASC-PAL\n0100\n16\n')
        for c in colors:
            f.write(f'{c[0]} {c[1]} {c[2]}\n')


def gba_color(c):
    # 5 bits per channel, the way the GBA stores colours.
    return tuple(min(255, (v >> 3) << 3) for v in c)


def remove_background(im):
    """Makes the flat background transparent by flooding it from the edges."""
    im = im.convert('RGBA')
    w, h = im.size
    px = im.load()
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    bg = tuple(sorted(c[i] for c in corners)[1] for i in range(3))
    tolerance = 60

    def is_bg(c):
        return sum(abs(c[i] - bg[i]) for i in range(3)) <= tolerance

    seen = bytearray(w * h)
    stack = [(x, y) for x in range(w) for y in (0, h - 1)] + [(x, y) for y in range(h) for x in (0, w - 1)]
    while stack:
        x, y = stack.pop()
        i = y * w + x
        if seen[i]:
            continue
        seen[i] = 1
        if not is_bg(px[x, y]):
            continue
        px[x, y] = (0, 0, 0, 0)
        if x > 0: stack.append((x - 1, y))
        if x < w - 1: stack.append((x + 1, y))
        if y > 0: stack.append((x, y - 1))
        if y < h - 1: stack.append((x, y + 1))
    return im


def fit(im, target_height, max_width=SIZE - 2):
    """Crops to the subject and scales it to `target_height`, feet at the bottom."""
    box = im.getchannel('A').point(lambda a: 255 if a > 128 else 0).getbbox()
    im = im.crop(box)
    scale = min(target_height / im.height, max_width / im.width)
    w, h = max(1, round(im.width * scale)), max(1, round(im.height * scale))
    small = im.resize((w, h), Image.LANCZOS)
    canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(small, ((SIZE - w) // 2, SIZE - 1 - h), small)
    # Hard edges: GBA sprites have no partial transparency.
    alpha = canvas.getchannel('A').point(lambda a: 255 if a >= 110 else 0)
    canvas.putalpha(alpha)
    return canvas


def add_outline(im):
    """A 1-pixel dark outline around the silhouette, like the original sprites."""
    alpha = im.getchannel('A')
    grown = alpha.filter(ImageFilter.MaxFilter(3))
    outline = Image.new('RGBA', im.size, (24, 24, 32, 255))
    result = Image.new('RGBA', im.size, (0, 0, 0, 0))
    result.paste(outline, (0, 0), grown)
    result.paste(im, (0, 0), alpha)
    return result


def quantize_pair(front, back):
    """Gives both sprites one 16-colour palette (index 0 = transparent)."""
    both = Image.new('RGBA', (SIZE * 2, SIZE))
    both.paste(front, (0, 0))
    both.paste(back, (SIZE, 0))
    opaque = [p[:3] for p in pixels(both) if p[3]]
    sample = Image.new('RGB', (len(opaque), 1))
    sample.putdata(opaque)
    q = sample.quantize(colors=15, method=Image.Quantize.MEDIANCUT)
    colors = [gba_color(tuple(q.getpalette()[i * 3:i * 3 + 3])) for i in range(15)]
    palette = [(128, 160, 128)] + colors  # index 0: transparent

    def to_indexed(im):
        out = Image.new('P', (SIZE, SIZE), 0)
        out.putpalette([v for c in palette for v in c] + [0] * (768 - 48))
        src, dst = im.load(), out.load()
        cache = {}
        for y in range(SIZE):
            for x in range(SIZE):
                p = src[x, y]
                if not p[3]:
                    continue
                c = p[:3]
                if c not in cache:
                    cache[c] = 1 + min(range(15), key=lambda i: sum((c[k] - colors[i][k]) ** 2 for k in range(3)))
                dst[x, y] = cache[c]
        return out

    return palette, to_indexed(front), to_indexed(back)


def shiny_palette(palette):
    out = [palette[0]]
    for c in palette[1:]:
        h, l, s = colorsys.rgb_to_hls(*(v / 255 for v in c))
        r, g, b = colorsys.hls_to_rgb((h + 0.5) % 1.0, l, s)
        out.append(gba_color((int(r * 255), int(g * 255), int(b * 255))))
    return out


def make_icon(front_rgba):
    """Two 32x32 frames (the second one hop higher) in the best shared icon palette."""
    box = front_rgba.getchannel('A').getbbox()
    subject = front_rgba.crop(box)
    scale = min(28 / subject.height, 30 / subject.width)
    small = subject.resize((max(1, round(subject.width * scale)), max(1, round(subject.height * scale))), Image.LANCZOS)
    small.putalpha(small.getchannel('A').point(lambda a: 255 if a >= 110 else 0))
    best = None
    for index in range(3):
        pal = read_jasc(os.path.join(GAME, f'graphics/pokemon/icon_palettes/icon_palette_{index}.pal'))
        error = 0
        mapped = {}
        for p in pixels(small):
            if not p[3]:
                continue
            c = p[:3]
            if c not in mapped:
                i = 1 + min(range(15), key=lambda i: sum((c[k] - pal[1 + i][k]) ** 2 for k in range(3)))
                mapped[c] = i
            error += sum((c[k] - pal[mapped[c]][k]) ** 2 for k in range(3))
        if best is None or error < best[0]:
            best = (error, index, pal, mapped)
    _error, index, pal, mapped = best
    icon = Image.new('P', (ICON, ICON * 2), 0)
    icon.putpalette([v for c in pal for v in c] + [0] * (768 - 48))
    dst = icon.load()
    src = small.load()
    ox = (ICON - small.width) // 2
    for frame, oy in ((0, ICON - 1 - small.height), (1, ICON - 2 - small.height)):
        for y in range(small.height):
            for x in range(small.width):
                p = src[x, y]
                if p[3]:
                    dst[ox + x, frame * ICON + oy + y] = mapped[p[:3]]
    return icon, index


def target_height(ninja):
    h = ninja['height']
    return 34 if h <= 5 else 46 if h <= 12 else 58 if h <= 20 else 62


def set_coords(text, slot, box):
    width = -(-(box[2] - box[0]) // 8) * 8
    height = -(-(box[3] - box[1]) // 8) * 8
    y_offset = SIZE - box[3]
    new = f'{{\n        .size = MON_COORDS_SIZE({width}, {height}),\n        .y_offset = {y_offset},\n    }}'
    return re.sub(r'(\[SPECIES_' + slot + r'\] =\s*)\{.*?\}', lambda m: m.group(1) + new, text, count=1, flags=re.S)


def slot_dir(slot):
    return os.path.join(GAME, 'graphics/pokemon', slot.lower())


def process(ninja):
    sheet = Image.open(os.path.join(ART, f'{ninja["key"]}.png')).convert('RGBA')
    w, h = sheet.size
    views = [sheet.crop((0, 0, w // 2, h)), sheet.crop((w // 2, 0, w, h))]
    views = [remove_background(v) for v in views]
    front, back = (add_outline(fit(v, target_height(ninja))) for v in views)
    palette, front_p, back_p = quantize_pair(front, back)
    d = slot_dir(ninja['slot'])
    front_p.save(os.path.join(d, 'front.png'))
    back_p.save(os.path.join(d, 'back.png'))
    write_jasc(os.path.join(d, 'normal.pal'), palette)
    write_jasc(os.path.join(d, 'shiny.pal'), shiny_palette(palette))
    icon, icon_palette = make_icon(front)
    icon.save(os.path.join(d, 'icon.png'))
    return front_p.getbbox(), back_p.getbbox(), icon_palette


def main():
    keys = set(sys.argv[1:])
    front_coords_path = os.path.join(GAME, 'src/data/pokemon_graphics/front_pic_coordinates.h')
    back_coords_path = os.path.join(GAME, 'src/data/pokemon_graphics/back_pic_coordinates.h')
    icon_path = os.path.join(GAME, 'src/pokemon_icon.c')
    front_coords, back_coords, icons = (open(p).read() for p in (front_coords_path, back_coords_path, icon_path))
    done = []
    for ninja in R.ROSTER:
        if keys and ninja['key'] not in keys:
            continue
        if not os.path.exists(os.path.join(ART, f'{ninja["key"]}.png')):
            continue
        front_box, back_box, icon_palette = process(ninja)
        front_coords = set_coords(front_coords, ninja['slot'], front_box)
        back_coords = set_coords(back_coords, ninja['slot'], back_box)
        icons = re.sub(r'(gMonIconPaletteIndices\[\] = \{.*?\[SPECIES_' + ninja['slot'] + r'\]\s*=\s*)\d',
                       lambda m: m.group(1) + str(icon_palette), icons, count=1, flags=re.S)
        done.append(ninja['key'])
    for path, text in ((front_coords_path, front_coords), (back_coords_path, back_coords), (icon_path, icons)):
        with open(path, 'w') as f:
            f.write(text)
    print(f'Sprites written for {len(done)} ninjas: {", ".join(done)}')


if __name__ == '__main__':
    main()
