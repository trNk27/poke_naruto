// Checks the fast-forward button: the game runs about 2x and 3x as fast, and
// drops back to normal speed while a link is open (Cable Club receptionist).
//
//   tests/build-test-rom.sh /tmp/test.gba
//   (cd server && npm start) &
//   node tests/speed-e2e.mjs /tmp/test.gba [screenshot-dir]

import { sleep, startPlayers, until } from './lib/harness.mjs';

const rom = process.argv[2];
const shotDir = process.argv[3] ?? 'e2e-screenshots';
if (!rom) {
  console.error('usage: node tests/speed-e2e.mjs ROM [screenshot-dir]');
  process.exit(2);
}

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const game = await startPlayers({ rom, elf: rom.replace(/\.gba$/, '.elf'), names: ['Speedy'], shotDir });
const [player] = game.players;

/** Game frames per second, measured over two seconds. */
async function fps() {
  const frames = () => player.page.evaluate(() => window.leafgreenOnline.bridge.frameCounter);
  const a = await frames();
  const t = Date.now();
  await sleep(2000);
  return ((await frames()) - a) / ((Date.now() - t) / 1000);
}
const speedLabel = () => player.page.textContent('#speed');

try {
  await player.reachOverworld();
  await sleep(1000);
  await player.pressUntil('B', 'messages to close', async () => !(await player.memory.tasks()).includes('Task_DrawFieldMessageBox'));

  const normal = await fps();
  console.log(`1x: ${normal.toFixed(1)} frames/s`);
  check(normal > 45 && normal < 75, 'the game runs at normal speed');

  await player.page.click('#speed');
  const double = await fps();
  console.log(`${await speedLabel()}: ${double.toFixed(1)} frames/s`);
  check(double > normal * 1.6, 'the speed button doubles the speed');

  await player.page.click('#speed');
  const triple = await fps();
  console.log(`${await speedLabel()}: ${triple.toFixed(1)} frames/s`);
  check(triple > normal * 2.3, 'a second tap triples the speed');

  // Open a link at the Cable Club receptionist (in front of the counter).
  await player.walkTo(10, 4, { verticalFirst: true });
  await player.press('Up');
  await sleep(400);
  await player.pressUntil('A', 'the service menu', () => player.hasTask('Task_MultichoiceMenu_HandleInput'));
  await sleep(300);
  await player.pressUntil('A', 'the link opening', async () => ((await player.state())?.link ?? 0) >= 1,
    { timeout: 60000, gap: 800 });
  const linked = await fps();
  console.log(`linked (${await speedLabel()}): ${linked.toFixed(1)} frames/s`);
  check(linked < normal * 1.3, 'the game runs at normal speed while a link is open');
  await game.screenshots('linked');

  // Cancel the search; the chosen speed comes back.
  await player.pressUntil('B', 'the link to close', async () => ((await player.state())?.link ?? 0) === 0,
    { timeout: 60000, gap: 800 });
  await until('messages to close', async () => {
    await player.press('B');
    return !(await player.memory.tasks()).includes('Task_DrawFieldMessageBox');
  }, { timeout: 30000, interval: 500 });
  const after = await fps();
  console.log(`after the link (${await speedLabel()}): ${after.toFixed(1)} frames/s`);
  check(after > normal * 2.3, 'the chosen speed returns after the link closes');

  await player.page.click('#speed');
  check((await speedLabel()).includes('1×'), 'a third tap goes back to 1×');
} catch (err) {
  console.log(`FAIL ${err.message}`);
  failures++;
  await game.screenshots('failure');
} finally {
  await game.close();
}
process.exit(failures ? 1 : 0);
