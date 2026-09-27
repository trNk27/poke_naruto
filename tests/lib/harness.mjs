// Starts several players in headless browsers, all in one room, running a
// test ROM (see tests/build-test-rom.sh).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { GameMemory, loadSymbols } from './game.mjs';

export async function startPlayers({ rom, elf, names, baseUrl = 'http://localhost:8080', shotDir = 'e2e-screenshots' }) {
  mkdirSync(shotDir, { recursive: true });
  const romBytes = readFileSync(rom);
  const romSha1 = createHash('sha1').update(romBytes).digest('hex');
  const symbols = elf ? loadSymbols(elf) : null;
  const room = `T${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });

  const players = [];
  for (const name of names) {
    const context = await browser.newContext({ viewport: { width: 420, height: 860 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`[${name}] page error:`, e.message));
    // Accept the test ROM as an already patched ROM.
    await page.route('**/patches/manifest.json', async (route) => {
      const res = await route.fetch();
      const manifest = await res.json();
      for (const game of manifest.games) game.patches.push({ base: 'test ROM', baseSha1: 'none', file: 'none', targetSha1: romSha1 });
      await route.fulfill({ response: res, json: manifest });
    });
    await page.goto(`${baseUrl}/?room=${room}&game=${process.env.GAME ?? 'naruto'}`);
    await page.waitForFunction(() => window.leafgreenOnline, null, { timeout: 60000 });
    await page.fill('#player-name', name);
    await page.setInputFiles('#rom-file', { name: 'rom.gba', mimeType: 'application/octet-stream', buffer: romBytes });
    await page.click('#start');
    await page.waitForSelector('#game:not([hidden])', { timeout: 30000 });
    players.push(new Player(name, page, symbols && new GameMemory(page, symbols)));
  }

  let shotCount = 0;
  return {
    browser,
    players,
    room,
    async screenshots(label) {
      shotCount++;
      for (const p of players) {
        await p.page.locator('#screen').screenshot({ path: `${shotDir}/${String(shotCount).padStart(2, '0')}-${label}-${p.name}.png` });
      }
    },
    close: () => browser.close(),
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(what, check, { timeout = 30000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
  }
}

export class Player {
  constructor(name, page, memory) {
    this.name = name;
    this.page = page;
    this.memory = memory;
  }

  async press(button, ms = 120) {
    await this.page.evaluate((b) => window.leafgreenOnline.emulator.buttonPress(b), button);
    await sleep(ms);
    await this.page.evaluate((b) => window.leafgreenOnline.emulator.buttonUnpress(b), button);
  }

  async state() {
    return this.page.evaluate(() => {
      const b = window.leafgreenOnline.bridge;
      if (!b.attached) return null;
      return { inOverworld: b.inOverworld, link: b.linkGameState, local: b.readLocal() };
    });
  }

  /** Presses through the title screen until the player walks the overworld. */
  async reachOverworld() {
    for (let i = 0; i < 200; i++) {
      const s = await this.state();
      if (s?.inOverworld && s.local.active) return s.local;
      await this.press(i % 2 ? 'A' : 'Start');
      await sleep(300);
    }
    throw new Error(`${this.name} did not reach the overworld`);
  }

  callback2() {
    return this.memory.callback2();
  }

  async hasTask(name) {
    return (await this.memory.tasks()).includes(name);
  }

  /** Takes one step per direction, retrying until the player has moved. */
  async walk(directions, { timeout = 30000 } = {}) {
    for (const direction of directions) {
      const start = await this.memory.playerPosition();
      await this.pressUntil(direction, `a step ${direction}`, async () => {
        const pos = await this.memory.playerPosition();
        return pos.x !== start.x || pos.y !== start.y;
      }, { timeout, gap: 400 });
      await sleep(300);
    }
  }

  /** Walks to map coordinates, horizontally first unless `verticalFirst`. */
  async walkTo(x, y, { timeout = 60000, verticalFirst = false } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const pos = await this.memory.playerPosition();
      if (pos.x === x && pos.y === y) return;
      if (Date.now() > deadline) throw new Error(`${this.name}: could not walk to (${x},${y}), stuck at (${pos.x},${pos.y})`);
      const horizontal = pos.x !== x && (!verticalFirst || pos.y === y);
      const direction = horizontal ? (pos.x < x ? 'Right' : 'Left') : (pos.y < y ? 'Down' : 'Up');
      await this.press(direction, 100);
      await sleep(350);
    }
  }

  /** Presses `button` until `check()` is true. */
  async pressUntil(button, what, check, { timeout = 30000, gap = 600 } = {}) {
    const deadline = Date.now() + timeout;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`${this.name}: timed out pressing ${button} until ${what}`);
      await this.press(button);
      await sleep(gap);
    }
  }
}
