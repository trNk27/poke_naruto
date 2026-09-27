#!/usr/bin/env python3
"""Generates artwork for the ninjas with the Black Forest Labs FLUX API.

    BFL_API_KEY=... python3 tools/naruto/generate_art.py [--dry-run] [--ref IMAGE] [KEY ...]

Writes tools/naruto/art/<KEY>.png: the front view on the left half and the
back view on the right half, on a plain background. Ninjas that already have
art are skipped (delete the file to regenerate one). Then run sprites.py to
turn the art into GBA sprites.

--ref passes an existing image as a style reference (costs a little more per
image, but keeps the drawing style of all ninjas the same).

Each image costs API credits, so by default only the listed ninjas are
generated; pass --all to generate every missing one.
"""

import base64
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
MODEL = os.environ.get('BFL_MODEL', 'flux-2-pro')

# The sprites end up about 50 pixels tall, so the art needs bold shapes, a
# thick outline and few colours to survive the downscaling.
PROMPT = (
    'Character sheet of one anime ninja drawn in the style of official Game Boy Advance monster '
    'battle sprites: chibi proportions with a big head, bold thick black outline around the whole '
    'silhouette, flat cel shading with only two tones per color, bright saturated colors, simple '
    'readable shapes and no fine detail. Two views of the same character side by side on a pure '
    'flat white background, full body visible, feet included, nothing cropped, lots of empty white '
    'space around each figure. Left half: front view, facing the viewer and turned slightly to the '
    'left, in a dynamic ready-to-fight pose. Right half: back view of the same character seen from '
    'behind and slightly above, as the player\'s own fighter in a battle. Character: {look}. '
    'No text, no ground shadow, no scenery, no border.'
)
REF_PROMPT = (
    'Draw a new character in exactly the same art style, line thickness, shading, proportions, '
    'layout and white background as the reference image. ' + PROMPT
)


def request(url, key, body=None):
    headers = {'x-key': key, 'accept': 'application/json'}
    data = None
    if body is not None:
        headers['content-type'] = 'application/json'
        data = json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=60) as res:
        return json.loads(res.read())


def generate(ninja, key, ref=None):
    body = {
        'prompt': (REF_PROMPT if ref else PROMPT).format(look=ninja['look']),
        'width': 1024,
        'height': 512,
        'output_format': 'png',
        'seed': sum(map(ord, ninja['key'])),
    }
    if ref:
        body['input_image'] = ref
    job = request(f'{API}/{MODEL}', key, body)
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
    ref = None
    if '--ref' in args:
        path = args[args.index('--ref') + 1]
        args.remove(path)
        with open(path, 'rb') as f:
            ref = base64.b64encode(f.read()).decode()
    keys = {a for a in args if not a.startswith('--')}
    if not keys and not everything:
        sys.exit('Name the ninjas to generate (e.g. NARUTO), or pass --all.')
    os.makedirs(ART, exist_ok=True)
    todo = [n for n in R.ROSTER
            if (everything or n['key'] in keys) and not os.path.exists(os.path.join(ART, f'{n["key"]}.png'))]
    if dry_run:
        for n in todo:
            print(n['key'], '->', (REF_PROMPT if ref else PROMPT).format(look=n['look']))
        return
    key = os.environ.get('BFL_API_KEY')
    if not key:
        sys.exit('Set BFL_API_KEY.')
    for n in todo:
        print(f'Generating {n["key"]}...', flush=True)
        generate(n, key, ref)
    print(f'Done: {len(todo)} image(s).')


if __name__ == '__main__':
    main()
