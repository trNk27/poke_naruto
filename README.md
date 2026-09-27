# LeafGreen Online

Play Pokémon LeafGreen in the browser, on Android, iPhone or a computer, and
explore Kanto together: everyone in the same room sees the other players
walking around in their game.

It is made of three parts:

| Folder | What it is |
| --- | --- |
| `game/` | The [pret/pokefirered](https://github.com/pret/pokefirered) decompilation of FireRed/LeafGreen, with multiplayer hooks added (`src/netsync.c`). |
| `web/` | The website: an mGBA emulator (WebAssembly), touch controls, and the code that connects the game to the server. |
| `server/` | A small Node.js server that hosts the website and relays player positions between players in the same room. |

## How to play

1. Open the website on your phone (see **Hosting** below for how to get it online).
2. Enter your name and a room code, or tap **New** for a random one.
3. Choose your own **Pokémon LeafGreen (USA)** ROM file (`.gba`). The original
   release and Rev 1 are both supported. The website patches it on your
   device; the ROM is never uploaded. You only have to choose it once.
4. Tap **Play**, then **Invite** to send the room link to your friends.

Tips:

* **Add to Home Screen** (Safari: Share → Add to Home Screen; Chrome: ⋮ → Add
  to Home screen) for a full-screen, app-like experience.
* Turn your phone sideways for a bigger screen.
* On a computer: arrow keys, **X** = A, **Z** = B, **Enter** = Start,
  **Backspace** = Select, **A**/**S** = L/R.
* Your save lives in the browser on that device. Save in the game as usual.
  Clearing the browser's website data deletes it.

### What works

* See up to 4 friends walking and running on the same map as you. Biking and
  surfing show the matching sprite (tested less than walking so far).
* Friends appear when they're on your screen and disappear when they leave the
  map or the room.
* Names are shown above other players.
* **Trading and battling** each other, using the game's own Cable Club (see
  below).
* Everyone plays their own game with their own save; progress isn't shared.

Not yet: players standing in a neighbouring map across a route border.

### Trading and battling

Works exactly like with a link cable, just over the internet:

1. Both players go upstairs in any Pokémon Center (it doesn't have to be the
   same one) and talk to the **receptionist on the right**. You need the
   Pokédex from Professor Oak first.
2. Both choose the same service: **Trade Center** or **Colosseum** (battle),
   and save when asked.
3. The player who joined the room first confirms with **A** when the game says
   everyone is ready; the other player just waits.
4. Walk to the chairs (trade) or the marked spots (battle). When you're done,
   leave through the door; the link closes.

With more than two players waiting at the receptionist at the same time,
players are paired in the order they joined the room.

## Naruto theme

The Pokémon are replaced by **40 ninjas** with new types, stats, jutsu and
Pokédex entries. The starters are **Naruto**, **Sasuke** and **Sakura**, each
evolving twice; wild areas have Academy Students, ninja dogs, toads, snakes and
slugs, and famous ninjas appear as rare encounters and on trainers' teams
(Brock, for example, now uses Gaara).

**Types.** Fire → Katon, Water → Suiton, Electric → Raiton, Ground → Doton,
Flying → Futon, Ice → Hyoton, Grass → Mokuton (wood), Psychic → Genjutsu,
Dark → Yin, Dragon → Yang, Fighting → Taijutsu, Normal → Ninja, Poison → Buki
(weapons), Rock → Puppet, Bug → Beast, Ghost → Biju (tailed beasts),
Steel → Sage. Each keeps the mechanics of the type it replaces (for example
rain boosts Suiton). The five chakra natures beat each other in a circle as in
the series: Katon > Futon > Raiton > Doton > Suiton > Katon. The full chart is in
`tools/naruto/roster.py`.

**Characters.** Gym leaders, the Elite Four, the rival and the other trainers
have Naruto-style portraits, and the story characters are renamed: the
professor is the HOKAGE, the rival SASUKE (a suggested name), and the leaders
are ONOKI, MEI, RAIKAGE, INO, TENTEN, KURENAI, ASUMA and PAIN (the boss), with
KONAN, BEE, CHIYO and MADARA as the Elite Four. Team Rocket's grunts wear
rogue-ninja cloaks, and the player wears orange.

Everything comes from `tools/naruto/roster.py`; after editing it run
`python3 tools/naruto/apply.py`, rebuild and regenerate the patches.
The battle sprites and menu icons come from artwork in `tools/naruto/art/`
(one image per ninja: front view on the left, back view on the right), made
with Black Forest Labs' FLUX.2 [pro] by `tools/naruto/generate_art.py` (about
3 credits per image; needs `BFL_API_KEY`). `python3 tools/naruto/sprites.py`
turns the artwork into 64×64 16-colour sprites, a shiny palette, the menu
icons (with three extra icon palettes made for the ninjas) and the sprite
positions. To redo a ninja, delete its artwork, run both scripts and rebuild.
`tools/naruto/trainers.py` does the same for the trainer portraits (four
characters per generated image) and the pictures in the new-game scene, and
`tools/naruto/title.py` makes the title screen (a NARUTO logo drawn with a
font, and Kurama in place of Venusaur).

## Hosting

The server needs Node.js 18 or later.

**Render (free):** create an account at [render.com](https://render.com),
choose **New → Blueprint**, and select this repository. `render.yaml`
configures everything. Free services go to sleep when unused, so the first
visit after a while takes about a minute to load.

**Any other host / your own computer:**

```sh
cd server
npm ci
PORT=8080 npm start
```

Phones need **HTTPS** to run the emulator, except on `localhost`. Most hosts
provide it automatically. The emulator needs a recent browser (Safari 15.2+,
Chrome 92+ or Firefox 79+).

## Development

### Building the ROM

Install the toolchain described in `game/INSTALL.md` (on Debian/Ubuntu:
`binutils-arm-none-eabi`, `libpng-dev`, and [agbcc](https://github.com/pret/agbcc)
installed into `game/`), then:

```sh
make -C game leafgreen        # builds game/pokeleafgreen.gba
```

The first commit contains the unmodified decompilation;
`make -C game compare_leafgreen` there reproduces the retail ROM exactly.

### Publishing a new version

After changing the game, regenerate the patches the website uses:

```sh
tools/make_patches.sh
```

This rebuilds the retail ROMs from the unmodified decompilation, builds the
modified ROMs, and writes `web/patches/*.bps` and `manifest.json`. Commit
them with your change.

### How the multiplayer works

The game has no network access, so the website talks to it through memory:

1. `game/src/netsync.c` keeps a small block of memory (`gNetSync`) that begins
   with a marker string. Each frame in the overworld it writes the player's
   map, position, facing direction and bike/surf state there.
2. The website (`web/js/netsync.js`) finds that block in the emulator's memory
   by its marker, reads the local player, and sends it to the server.
3. The server relays it to everyone else in the room, and their websites
   write it into the `remote` slots of their own game's `gNetSync`.
4. The game shows each remote player on the current map as a character that
   walks to the latest position.

Trading and battling reuse the game's link cable code. The GBA serial
hardware is replaced by a "virtual cable" (the NetLink section of
`game/src/link.c`): the game puts its link commands into small queues inside
`gNetSync`, and `web/js/link.js` pairs two players and relays the queues
between them. Like the real cable, one game (the one whose player joined the
room first) drives each transfer, so both games process exactly the same
sequence of commands. Everything above the hardware layer (Cable Club, trade
menu, link battles) runs unchanged.

The memory layout is defined in `game/include/netsync.h` and mirrored in
`web/js/netsync.js`. Keep them in sync and bump `NETSYNC_VERSION` when it
changes.

### Testing

The tests start two headless browsers in the same room and play through the
game. They use a test ROM that skips Professor Oak's introduction and starts
in front of a Cable Club receptionist with two Pokémon:

```sh
tests/build-test-rom.sh /tmp/test.gba   # also writes /tmp/test.elf (symbols)
(cd server && npm start) &
node tests/e2e.mjs /tmp/test.gba        # players see each other, names
node tests/link-e2e.mjs /tmp/test.gba   # link up, trade, battle
```

They need Playwright (`npm i -g playwright`) and, for `link-e2e.mjs`,
`arm-none-eabi-nm` to read the game's symbols (`tests/lib/game.mjs`).

## Legal

This project contains no Nintendo ROM. Players need their own copy of
Pokémon LeafGreen. Pokémon is © Nintendo, Creatures Inc. and GAME FREAK inc.
This is an unofficial fan project and is not affiliated with them. The
emulator is mGBA (MPL 2.0, see `web/vendor/mgba/`).
