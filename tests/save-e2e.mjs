// End-to-end test of exporting and importing saves: one browser plays, saves
// in the game and exports the save; a second browser (another device)
// imports it and continues from it.
//
//   tests/build-test-rom.sh /tmp/test.gba        # also writes /tmp/test.elf
//   (cd server && npm start) &
//   node tests/save-e2e.mjs /tmp/test.gba [screenshot-dir]
//
// Uses the version chosen with GAME= (default naruto).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { GameMemory, loadSymbols } from './lib/game.mjs';
import { Player, sleep, until } from './lib/harness.mjs';

const romPath = process.argv[2];
const shotDir = process.argv[3] ?? 'e2e-screenshots';
if (!romPath) {
  console.error('usage: node tests/save-e2e.mjs ROM [screenshot-dir]');
  process.exit(2);
}
const baseUrl = 'http://localhost:8080';
const game = process.env.GAME ?? 'naruto';
const rom = readFileSync(romPath);
const romSha1 = createHash('sha1').update(rom).digest('hex');
const symbols = loadSymbols(romPath.replace(/\.gba$/, '.elf'));
const room = `S${Date.now().toString(36).toUpperCase().slice(-6)}`;
const SAVE_SIZE = 0x20000;
const SAVED_SPOT = [7, 5]; // away from where a new game starts (10,4)
mkdirSync(shotDir, { recursive: true });

function check(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  if (!condition) process.exitCode = 1;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

async function openSetup(context, name) {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] page error:`, e.message));
  page.on('dialog', (d) => d.accept());
  // Accept the test ROM as an already patched ROM.
  await page.route('**/patches/manifest.json', async (route) => {
    const res = await route.fetch();
    const manifest = await res.json();
    for (const g of manifest.games) g.patches.push({ base: 'test ROM', baseSha1: 'none', file: 'none', targetSha1: romSha1 });
    await route.fulfill({ response: res, json: manifest });
  });
  await page.goto(`${baseUrl}/?room=${room}&game=${game}`);
  await page.waitForFunction(() => window.leafgreenOnline && !document.getElementById('save-export').disabled, null, { timeout: 60000 });
  await page.fill('#player-name', name);
  return page;
}

async function play(page, name) {
  if (await page.isVisible('#rom-file')) {
    await page.setInputFiles('#rom-file', { name: 'rom.gba', mimeType: 'application/octet-stream', buffer: rom });
  }
  await page.click('#start');
  await page.waitForSelector('#game:not([hidden])', { timeout: 30000 });
  return new Player(name, page, new GameMemory(page, symbols));
}

const status = (page) => page.textContent('#setup-status');

try {
  // Device 1: play, move away from the start and save in the game.
  const device1 = await browser.newContext({ viewport: { width: 420, height: 860 }, acceptDownloads: true });
  let page = await openSetup(device1, 'Alice');
  await page.click('#save-export');
  check((await status(page)).includes('no'), 'Exporting before any save explains there is none');
  const alice = await play(page, 'Alice');
  await alice.reachOverworld();
  await sleep(1500);
  await alice.pressUntil('B', 'messages to close', async () => !(await alice.memory.tasks()).includes('Task_DrawFieldMessageBox'));
  await alice.walkTo(...SAVED_SPOT, { verticalFirst: true });
  await sleep(500);
  // START menu: the cursor wraps, so SAVE is three up from the top (…, SAVE, OPTION, EXIT).
  await alice.press('Start');
  await sleep(800);
  for (let i = 0; i < 3; i++) {
    await alice.press('Up');
    await sleep(300);
  }
  await alice.page.locator('#screen').screenshot({ path: `${shotDir}/save-menu.png` });
  const romFile = game === 'classic' ? 'leafgreen-classic' : 'leafgreen-online';
  const saveSize = () => page.evaluate((f) => {
    const { FS } = window.leafgreenOnline.emulator;
    const path = `/data/saves/${f}.sav`;
    return FS.analyzePath(path).exists ? FS.stat(path).size : 0;
  }, romFile);
  const hasGameData = () => page.evaluate((f) => {
    const { FS } = window.leafgreenOnline.emulator;
    const path = `/data/saves/${f}.sav`;
    if (!FS.analyzePath(path).exists) return false;
    const bytes = FS.readFile(path);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < 28; i++) if (view.getUint32(i * 0x1000 + 0xff8, true) === 0x08012025) return true;
    return false;
  }, romFile);
  await alice.pressUntil('A', 'the game to be saved', hasGameData, { timeout: 60000, gap: 1200 });
  await sleep(3000);
  await alice.pressUntil('B', 'messages to close', async () => !(await alice.memory.tasks()).includes('Task_DrawFieldMessageBox'));
  check((await saveSize()) === SAVE_SIZE, 'Saving in the game writes a 128 KB save');
  await sleep(2000); // let the save reach the browser's storage

  // Back on the setup screen (reload), export it.
  await page.close();
  page = await openSetup(device1, 'Alice');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#save-export')]);
  const exportedPath = await download.path();
  const exported = readFileSync(exportedPath);
  check(exported.length === SAVE_SIZE, `Export downloads the save (${download.suggestedFilename()}, ${exported.length} bytes)`);
  await device1.close();

  // Device 2: reject files that aren't saves, then import the save and continue.
  const device2 = await browser.newContext({ viewport: { width: 420, height: 860 } });
  page = await openSetup(device2, 'Alice');
  await page.setInputFiles('#save-file', { name: 'game.ss1', mimeType: 'application/octet-stream', buffer: Buffer.alloc(300) });
  await until('the error', async () => (await status(page)).length > 0);
  check((await status(page)).includes("can't be imported"), 'A save state is rejected with an explanation');
  await page.setInputFiles('#save-file', { name: 'junk.sav', mimeType: 'application/octet-stream', buffer: Buffer.alloc(SAVE_SIZE) });
  await until('the error', async () => (await status(page)).includes("doesn't look like"));
  check(true, 'A file without LeafGreen save data is rejected');
  // With a few extra bytes at the end, as some emulators write them.
  await page.setInputFiles('#save-file', { name: 'LeafGreen.sav', mimeType: 'application/octet-stream', buffer: Buffer.concat([exported, Buffer.alloc(16)]) });
  await until('the import', async () => (await status(page)).includes('imported'));
  check(true, 'The save is imported');
  await page.screenshot({ path: `${shotDir}/save-imported.png` });
  const bob = await play(page, 'Alice');
  await bob.reachOverworld(); // presses A on CONTINUE
  await sleep(1000);
  const pos = await bob.memory.playerPosition();
  check(pos.x === SAVED_SPOT[0] && pos.y === SAVED_SPOT[1], `The imported save continues where it was saved (${pos.x},${pos.y})`);
  await device2.close();
} catch (err) {
  console.log('FAIL', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
