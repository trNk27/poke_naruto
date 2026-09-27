#!/usr/bin/env python3
"""Generates artwork for the ninjas with the Black Forest Labs FLUX API.

    BFL_API_KEY=... python3 tools/naruto/generate_art.py [--dry-run] [KEY ...]

Writes tools/naruto/art/<KEY>.png: the front view on the left half and the
back view on the right half, on a plain background. Ninjas that already have
art are skipped (delete the file to regenerate one). Then run sprites.py to
turn the art into GBA sprites.

Each image costs API credits, so by default only the listed ninjas are
generated; pass --all to generate every missing one.
"""

import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(HERE, 'art')
sys.path.insert(0, HERE)
import roster as R  # noqa: E402

API = 'https://api.bfl.ai/v1'
MODEL = os.environ.get('BFL_MODEL', 'flux-pro-1.1')

PROMPT = (
    'Pixel art battle sprites for a Game Boy Advance monster-collecting RPG, in the style of '
    '2004 handheld games. Two views of the same single character side by side on a plain flat '
    'white background, each view centered in its half of the image with empty space around it. '
    'Left half: full body front view, facing the viewer and turned slightly to the left, in a '
    'confident ready-to-fight pose. Right half: the same character seen from behind, full body back '
    'view. Character: {look}. Anime ninja style, chibi proportions, clean dark outlines, flat cel '
    'shading, limited color palette, no text, no ground shadow, no scenery.'
)


def request(url, key, body=None):
    headers = {'x-key': key, 'accept': 'application/json'}
    data = None
    if body is not None:
        headers['content-type'] = 'application/json'
        data = json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=60) as res:
        return json.loads(res.read())


def generate(ninja, key):
    prompt = PROMPT.format(look=ninja['look'])
    job = request(f'{API}/{MODEL}', key, {
        'prompt': prompt,
        'width': 1024,
        'height': 512,
        'output_format': 'png',
        'seed': sum(map(ord, ninja['key'])),
    })
    polling_url = job.get('polling_url') or f'{API}/get_result?id={job["id"]}'
    for _ in range(120):
        time.sleep(2)
        result = request(polling_url, key)
        status = result.get('status')
        if status == 'Ready':
            with urllib.request.urlopen(result['result']['sample'], timeout=120) as res:
                image = res.read()
            with open(os.path.join(ART, f'{ninja["key"]}.png'), 'wb') as f:
                f.write(image)
            return
        if status not in ('Pending', 'Queued', 'Processing'):
            raise RuntimeError(f'{ninja["key"]}: {status}: {result}')
    raise RuntimeError(f'{ninja["key"]}: timed out')


def main():
    args = sys.argv[1:]
    dry_run = '--dry-run' in args
    everything = '--all' in args
    keys = {a for a in args if not a.startswith('--')}
    if not keys and not everything:
        sys.exit('Name the ninjas to generate (e.g. NARUTO), or pass --all.')
    os.makedirs(ART, exist_ok=True)
    todo = [n for n in R.ROSTER
            if (everything or n['key'] in keys) and not os.path.exists(os.path.join(ART, f'{n["key"]}.png'))]
    if dry_run:
        for n in todo:
            print(n['key'], '->', PROMPT.format(look=n['look']))
        return
    key = os.environ.get('BFL_API_KEY')
    if not key:
        sys.exit('Set BFL_API_KEY.')
    for n in todo:
        print(f'Generating {n["key"]}...', flush=True)
        generate(n, key)
    print(f'Done: {len(todo)} image(s).')


if __name__ == '__main__':
    main()
