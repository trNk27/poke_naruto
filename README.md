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
* Everyone plays their own game with their own save; progress isn't shared.

Not yet: online trading and battling, showing names above players, and players
standing in a neighbouring map across a route border.

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

The memory layout is defined in `game/include/netsync.h` and mirrored in
`web/js/netsync.js`. Keep them in sync and bump `NETSYNC_VERSION` when it
changes.

### Testing

`tests/e2e.mjs` starts two headless browsers in the same room and checks that
each game shows the other player. It uses a test ROM that skips Professor
Oak's introduction:

```sh
make -C game leafgreen NETSYNC_QUICK_START=1
(cd server && npm start) &
node tests/e2e.mjs game/pokeleafgreen.gba
make -C game leafgreen   # rebuild the normal ROM afterwards (touch src/oak_speech.c first)
```

## Legal

This project contains no Nintendo ROM. Players need their own copy of
Pokémon LeafGreen. Pokémon is © Nintendo, Creatures Inc. and GAME FREAK inc.
This is an unofficial fan project and is not affiliated with them. The
emulator is mGBA (MPL 2.0, see `web/vendor/mgba/`).
