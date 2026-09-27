#!/usr/bin/env python3
"""Title screen for the Naruto theme: the logo and the "box art" picture.

    BFL_API_KEY=... python3 tools/naruto/title.py generate
    python3 tools/naruto/title.py convert

The logo (a 176x88 8bpp picture in the top left, up to 256 tiles) and the
box art (a 112x96 16-colour picture on the right) replace LeafGreen's logo and
Venusaur. The logo is drawn here with a font (the image API won't draw the
title); the box art is generated into tools/naruto/art/title_art.png.
"""

import os
import struct
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import generate_art as G  # noqa: E402
import sprites as S  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

TITLE = os.path.join(S.GAME, 'graphics/title_screen/leafgreen')
BOX_ART = os.path.join(G.ART, 'title_art.png')

BOX_PROMPT = (
    'A fierce gigantic orange nine-tailed fox beast roaring, head, chest and front paws, facing left, '
    'nine huge tails fanned out behind it, red eyes with black markings around them, drawn like official '
    'Game Boy Advance box art sprites: bold thick black outline, flat cel shading with two tones per '
    'color, bright saturated colors, on a pure flat white background, nothing else.'
)

# Where the pictures go on the 32x20-tile background maps.
LOGO_TILES = (22, 11)          # columns, rows from the top left
BOX_ORIGIN, BOX_TILES = (16, 6), (14, 12)
BOX_PALETTE = 13


def generate():
    key = os.environ.get('BFL_API_KEY') or sys.exit('Set BFL_API_KEY.')
    if not os.path.exists(BOX_ART):
        print('Generating the box art...', flush=True)
        G.request_image(BOX_PROMPT, key, BOX_ART, width=1024, height=896, seed=9)


def tiles_of(ix, tile_w, tile_h):
    """Splits a palette-index picture into 8x8 tiles (row-major)."""
    return [ix[r * 8:(r + 1) * 8, c * 8:(c + 1) * 8] for r in range(tile_h) for c in range(tile_w)]


def fit(ix, w, h, align_right=False):
    """Pads a picture to w x h pixels (transparent = -1), bottom-aligned."""
    canvas = np.full((h, w), -1, dtype=np.int32)
    ih, iw = ix.shape
    left = w - iw if align_right else (w - iw) // 2
    canvas[h - ih:, left:left + iw] = ix
    return canvas


def build_tileset(tiles, first_blank=True):
    """Deduplicates tiles (no flipping). Returns (unique tiles, index per tile)."""
    unique, index, seen = [], [], {}
    if first_blank:
        blank = np.zeros((8, 8), dtype=np.int32)
        unique.append(blank)
        seen[blank.tobytes()] = 0
    for t in tiles:
        k = t.tobytes()
        if k not in seen:
            seen[k] = len(unique)
            unique.append(t)
        index.append(seen[k])
    return unique, index


def save_tileset(unique, path, palette, tiles_per_row):
    rows = -(-len(unique) // tiles_per_row)
    img = np.zeros((rows * 8, tiles_per_row * 8), dtype=np.uint8)
    for i, t in enumerate(unique):
        r, c = divmod(i, tiles_per_row)
        img[r * 8:(r + 1) * 8, c * 8:(c + 1) * 8] = t
    im = Image.fromarray(img, 'P')
    flat = [v for c in palette for v in c]
    im.putpalette(flat + [0] * (768 - len(flat)))
    im.save(path)


def save_map(entries, path):
    with open(path, 'wb') as f:
        f.write(struct.pack(f'<{len(entries)}H', *entries))


FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'


def draw_text(size, text, font_size, top, colors, outline, stroke):
    """Crisp (not anti-aliased) text with a vertical colour gradient and an outline."""
    w, h = size
    # The largest size up to font_size that fits the width.
    while True:
        font = ImageFont.truetype(FONT, font_size)
        if ImageDraw.Draw(Image.new('L', (1, 1))).textlength(text, font=font) + 2 * stroke + 4 <= w:
            break
        font_size -= 1
    mask = Image.new('L', size, 0)
    d = ImageDraw.Draw(mask)
    d.fontmode = '1'
    left = (w - d.textlength(text, font=font)) // 2
    d.text((left, top), text, font=font, fill=255)
    rim = Image.new('L', size, 0)
    d = ImageDraw.Draw(rim)
    d.fontmode = '1'
    d.text((left, top), text, font=font, fill=255, stroke_width=stroke, stroke_fill=255)
    box = mask.getbbox()
    fill = Image.new('RGBA', size)
    for y in range(h):
        t = min(1, max(0, (y - box[1]) / max(1, box[3] - box[1] - 1)))
        # Few steps, like hand-made pixel art gradients.
        t = round(t * (len(colors) - 1))
        fill.paste(colors[t] + (255,), (0, y, w, y + 1))
    layer = Image.new('RGBA', size, (0, 0, 0, 0))
    layer.paste(outline + (255,), (0, 0), rim)
    layer.paste(fill, (0, 0), mask)
    return layer


def render_logo():
    w, h = LOGO_TILES[0] * 8, LOGO_TILES[1] * 8
    logo = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    title = draw_text((w, h), 'NARUTO', 44, 4,
                      [(255, 236, 96), (255, 204, 48), (255, 164, 32), (240, 120, 16), (208, 88, 8)],
                      (64, 24, 8), 3)
    logo.alpha_composite(title)
    sub = draw_text((w, h), 'LEAF VERSION', 16, 54,
                    [(168, 232, 104), (96, 192, 64), (48, 144, 40)], (16, 48, 16), 2)
    logo.alpha_composite(sub)
    return logo


def convert_logo():
    logo = np.asarray(render_logo())
    solid = logo[..., 3] > 0
    colors = sorted({tuple(c) for c in logo[..., :3][solid]})
    pal = [S.gba_color(c) for c in colors]
    lookup = {c: i + 1 for i, c in enumerate(colors)}  # 0 = transparent, colours from 1
    ix = np.zeros(logo.shape[:2], dtype=np.int32)
    for y, x in zip(*np.nonzero(solid)):
        ix[y, x] = lookup[tuple(logo[y, x, :3])]
    unique, index = build_tileset(tiles_of(ix, *LOGO_TILES))
    assert len(unique) <= 256, len(unique)
    entries = [0] * (32 * 20)
    for i, tile in enumerate(index):
        r, c = divmod(i, LOGO_TILES[0])
        entries[r * 32 + c] = tile
    palette = [(0, 0, 0)] + pal + [(0, 0, 0)] * (13 * 16 - 1 - len(pal))
    save_tileset(unique, os.path.join(TITLE, 'game_title_logo.png'), palette, 32)
    save_map(entries, os.path.join(TITLE, 'game_title_logo.bin'))
    S.write_jasc(os.path.join(TITLE, 'game_title_logo.pal'), palette)
    print(f'Logo: {len(unique)} tiles.')


def convert_box_art():
    art = S.crop_subject(S.remove_background(Image.open(BOX_ART).convert('RGBA'), thresh=60))
    pal = S.make_palette([art])
    w, h = BOX_TILES[0] * 8, BOX_TILES[1] * 8
    ix = fit(S.outline_edges(S.shrink(art, pal, h, w)), w, h, align_right=True) + 1
    unique, index = build_tileset(tiles_of(ix, *BOX_TILES))
    entries = [BOX_PALETTE << 12] * (32 * 20)
    for i, tile in enumerate(index):
        r, c = divmod(i, BOX_TILES[0])
        entries[(BOX_ORIGIN[1] + r) * 32 + BOX_ORIGIN[0] + c] = (BOX_PALETTE << 12) | tile
    palette = [(0, 0, 0)] + pal
    save_tileset(unique, os.path.join(TITLE, 'box_art_mon.png'), palette, 12)
    save_map(entries, os.path.join(TITLE, 'box_art_mon.bin'))
    S.write_jasc(os.path.join(TITLE, 'box_art_mon.pal'), palette)
    print(f'Box art: {len(unique)} tiles.')


if __name__ == '__main__':
    if sys.argv[1:2] == ['generate']:
        generate()
    elif sys.argv[1:2] == ['convert']:
        convert_logo()
        convert_box_art()
    else:
        sys.exit(__doc__)
