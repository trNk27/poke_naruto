// End-to-end multiplayer test: two browsers join the same room, start a new
// game and check that each game shows the other player.
//
//   make -C game leafgreen NETSYNC_QUICK_START=1   # skips Oak's intro
//   (cd server && npm start) &
//   node tests/e2e.mjs game/pokeleafgreen.gba [screenshot-dir]
//
// Needs Playwright (npm i -g playwright) and a Chromium it can launch.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const romPath = process.argv[2];
const shotDir = process.argv[3] ?? 'e2e-screenshots';
const baseUrl = process.env.BASE_URL ?? 'http://localhost:8080';
if (!romPath) {
  console.error('usage: node tests/e2e.mjs ROM [screenshot-dir]');
  process.exit(2);
}
mkdirSync(shotDir, { recursive: true });

const rom = readFileSync(romPath);
const romSha1 = createHash('sha1').update(rom).digest('hex');
const room = `E2E${Date.now().toString(36).toUpperCase().slice(-6)}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

async function openPlayer(name) {
  const context = await browser.newContext({ viewport: { width: 420, height: 860 }, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror:`, e.message));
  // Accept the test ROM as an already patched ROM.
  await page.route('**/patches/manifest.json', async (route) => {
    const res = await route.fetch();
    const manifest = await res.json();
    manifest.patches.push({ base: 'test ROM', baseSha1: 'none', file: 'none', targetSha1: romSha1 });
    await route.fulfill({ response: res, json: manifest });
  });
  await page.goto(`${baseUrl}/?room=${room}`);
  await page.waitForFunction(() => window.leafgreenOnline, null, { timeout: 60000 });
  await page.fill('#player-name', name);
  await page.setInputFiles('#rom-file', { name: 'rom.gba', mimeType: 'application/octet-stream', buffer: rom });
  await page.click('#start');
  await page.waitForSelector('#game:not([hidden])', { timeout: 30000 });
  return page;
}

async function press(page, button, ms = 100) {
  await page.evaluate((b) => window.leafgreenOnline.emulator.buttonPress(b), button);
  await page.waitForTimeout(ms);
  await page.evaluate((b) => window.leafgreenOnline.emulator.buttonUnpress(b), button);
}

async function reachOverworld(page, name) {
  const deadline = Date.now() + 90000;
  let i = 0;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const b = window.leafgreenOnline.bridge;
      return b.attached ? { inOverworld: b.inOverworld, local: b.readLocal() } : null;
    });
    if (state?.inOverworld && state.local.active) return state.local;
    await press(page, i++ % 2 ? 'A' : 'Start');
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: `${shotDir}/${name}-stuck.png` });
  throw new Error(`${name} did not reach the overworld`);
}

const local = (page) => page.evaluate(() => window.leafgreenOnline.bridge.readLocal());
const remote = (page, slot) => page.evaluate((s) => window.leafgreenOnline.bridge.readRemote(s), slot);

function check(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  if (!condition) process.exitCode = 1;
}

try {
  const [alice, bob] = await Promise.all([openPlayer('Alice'), openPlayer('Bob')]);
  const [aStart, bStart] = await Promise.all([reachOverworld(alice, 'alice'), reachOverworld(bob, 'bob')]);
  console.log('Alice at', aStart.mapGroup, aStart.mapNum, aStart.x, aStart.y, '| Bob at', bStart.mapGroup, bStart.mapNum, bStart.x, bStart.y);

  // Let the intro fade finish and states propagate.
  await alice.waitForTimeout(3000);
  check((await alice.textContent('#hud-players')).includes('Bob'), 'Alice sees Bob in the room list');
  let bobInAlice = await remote(alice, 0);
  check(bobInAlice.active === 1 && bobInAlice.x === bStart.x && bobInAlice.y === bStart.y, "Bob's position is written into Alice's game");

  // Bob walks left using the keyboard; Alice's copy of Bob should follow.
  await bob.keyboard.down('ArrowLeft');
  await bob.waitForTimeout(600);
  await bob.keyboard.up('ArrowLeft');
  await bob.waitForTimeout(1500);
  const bMoved = await local(bob);
  bobInAlice = await remote(alice, 0);
  console.log('Bob moved to', bMoved.x, bMoved.y);
  check(bMoved.x !== bStart.x || bMoved.y !== bStart.y, 'Bob moved in his own game');
  check(bobInAlice.x === bMoved.x && bobInAlice.y === bMoved.y, "Alice's game received Bob's new position");
  const aliceInBob = await remote(bob, 0);
  check(aliceInBob.active === 1 && aliceInBob.x === aStart.x, "Alice's position is written into Bob's game");

  await alice.screenshot({ path: `${shotDir}/alice.png` });
  await bob.screenshot({ path: `${shotDir}/bob.png` });
  await alice.locator('#screen').screenshot({ path: `${shotDir}/alice-screen.png` });
  await bob.locator('#screen').screenshot({ path: `${shotDir}/bob-screen.png` });

  // When Bob leaves, he disappears from Alice's game.
  await bob.close();
  await alice.waitForTimeout(1500);
  check((await remote(alice, 0)).active === 0, 'Bob is removed from Alice\'s game after leaving');
  await alice.locator('#screen').screenshot({ path: `${shotDir}/alice-after-leave.png` });
} finally {
  await browser.close();
}
