// End-to-end test of the virtual link cable: two browsers link up at the
// Cable Club, trade Pokémon in the Trade Center, then battle in the
// Colosseum. The talk-* variants link up by talking to each other instead
// of the receptionist.
//
//   tests/build-test-rom.sh /tmp/test.gba        # also writes /tmp/test.elf
//   (cd server && npm start) &
//   node tests/link-e2e.mjs /tmp/test.gba [trade|battle|all|talk-trade|talk-battle|talk] [screenshot-dir]
//
// Needs Playwright (npm i -g playwright), a Chromium it can launch, and
// arm-none-eabi-nm (to read the game's symbols).

import { sleep, startPlayers, until } from './lib/harness.mjs';

const rom = process.argv[2];
const which = process.argv[3] ?? 'all';
const shotDir = process.argv[4] ?? 'e2e-screenshots';
if (!rom) {
  console.error('usage: node tests/link-e2e.mjs ROM [trade|battle|all|talk-trade|talk-battle|talk] [screenshot-dir]');
  process.exit(2);
}
const elf = rom.replace(/\.gba$/, '.elf');

const SPECIES_BULBASAUR = 1;
const SPECIES_PIDGEY = 16;

function check(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  if (!condition) process.exitCode = 1;
}

// Gen 3 Pokémon data is encrypted and its four substructures are shuffled
// by personality; the species is the first field of the "growth" one.
const SUBSTRUCT_ORDERS = [
  'GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG',
  'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG',
];
async function partySpecies(player) {
  const bytes = await player.memory.read('gPlayerParty', 100 * 6);
  const u32 = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
  const species = [];
  for (let i = 0; i < 6; i++) {
    const base = i * 100;
    const personality = u32(base);
    const otId = u32(base + 4);
    if (!personality && !otId) break;
    const growth = SUBSTRUCT_ORDERS[personality % 24].indexOf('G');
    const word = (u32(base + 32 + growth * 12) ^ otId ^ personality) >>> 0;
    species.push(word & 0xffff);
  }
  return species;
}

// Cursor position in the trade menu (sTradeMenu->cursorPosition); 12 is CANCEL.
const TRADE_CURSOR_OFFSET = 53;
const TRADE_CURSOR_CANCEL = 12;
async function tradeCursor(player) {
  const menu = await player.memory.u32('sTradeMenu');
  return menu ? (await player.memory.read(menu + TRADE_CURSOR_OFFSET, 1))[0] : null;
}

async function linkState(player) {
  return (await player.state())?.link ?? -1;
}

// Talks to the Cable Club receptionist and opens a link to the Trade Center
// (choice 0) or the Colosseum (choice 1, single battle).
async function openLink(player, choice) {
  await player.reachOverworld();
  await sleep(1000);
  // Close any message still on screen (e.g. the goodbye after a trade).
  await player.pressUntil('B', 'messages to close', async () => {
    const tasks = await player.memory.tasks();
    return !tasks.includes('Task_DrawFieldMessageBox') && !tasks.includes('ScriptMovement_MoveObjects');
  });
  // The receptionist stands behind the counter at (10,2); the counter is row 3.
  await player.walkTo(10, 4, { verticalFirst: true });
  await sleep(300);
  await player.press('Up');
  await sleep(400);
  await player.pressUntil('A', 'the service menu', () => player.hasTask('Task_MultichoiceMenu_HandleInput'));
  await sleep(300);
  if (choice === 1) {
    await player.press('Down');
    await sleep(300);
  }
  // Defaults from here on: single battle, save the game.
  await player.pressUntil('A', 'the link opening', async () => (await linkState(player)) >= 1, { timeout: 60000, gap: 800 });
}

async function linkUp(game, choice) {
  const [master, slave] = game.players; // the first player to join leads
  await Promise.all([openLink(master, choice), openLink(slave, choice)]);
  await until('both players to see each other', async () => {
    const tasks = await master.memory.tasks();
    return (await linkState(slave)) >= 1 && tasks.length > 0;
  });
  await sleep(2000);
  await master.pressUntil('A', 'the link to connect', async () => (await linkState(master)) === 2, { timeout: 30000, gap: 900 });
  await until('the partner to connect', async () => (await linkState(slave)) === 2, { timeout: 30000 });
  check(true, 'Link established between both players');
  await until('both players to enter the room', async () =>
    (await master.callback2()) === 'CB2_Overworld' && (await slave.callback2()) === 'CB2_Overworld', { timeout: 60000 });
  await sleep(3000);
}

function talkState(player) {
  return player.page.evaluate(() => window.leafgreenOnline.bridge.readTalk().gameState);
}
const TALK_IDLE = 0;
const TALK_INVITING = 1;
const TALK_PROMPTING = 2;
const TALK_DECLINED = 4;

// Where the players stand when they talk: Bob at (7,5), Alice east of him.
const TALK_SPOTS = [[8, 5], [7, 5]];

// Alice walks up to Bob, talks to him and picks the Trade Center (choice 0)
// or the Colosseum (choice 1), then saves: her game invites Bob.
async function invite(game, choice) {
  const [alice, bob] = game.players;
  await Promise.all(game.players.map(async (p, i) => {
    await p.reachOverworld();
    await sleep(1000);
    await p.pressUntil('B', 'messages to close', async () => {
      const tasks = await p.memory.tasks();
      return !tasks.includes('Task_DrawFieldMessageBox') && !tasks.includes('ScriptMovement_MoveObjects');
    });
    // Out of the way of each other: Bob first, then Alice.
    if (i === 1) await p.walkTo(...TALK_SPOTS[1], { verticalFirst: true });
  }));
  await alice.walkTo(TALK_SPOTS[0][0], 4);
  await alice.walkTo(...TALK_SPOTS[0]);
  await sleep(1500);
  await alice.press('Left'); // face Bob
  await sleep(400);
  await alice.pressUntil('A', 'the talk menu', () => alice.hasTask('Task_MultichoiceMenu_HandleInput'));
  await sleep(300);
  if (choice === 1) {
    await alice.press('Down');
    await sleep(300);
  }
  // Pick the service and save the game.
  await alice.pressUntil('A', 'the invitation', async () => (await talkState(alice)) === TALK_INVITING, { timeout: 60000, gap: 800 });
}

async function closeMessages(player) {
  await player.pressUntil('B', 'messages to close', async () => {
    const tasks = await player.memory.tasks();
    return (await talkState(player)) !== TALK_PROMPTING && !tasks.includes('Task_DrawFieldMessageBox')
      && !tasks.includes('Task_YesNoMenu_HandleInput') && (await player.memory.read('sGlobalScriptContextStatus', 1))[0] === 2;
  }, { timeout: 30000, gap: 700 });
}

// Bob says no; then Alice invites again and cancels while waiting.
async function testTalkDeclineAndCancel(game) {
  const [alice, bob] = game.players;
  await invite(game, 0);
  await until('Bob to be asked', async () => (await talkState(bob)) === TALK_PROMPTING, { timeout: 30000 });
  await sleep(1500);
  await bob.pressUntil('B', 'Bob to say no', async () => (await talkState(bob)) === TALK_DECLINED, { timeout: 20000, gap: 700 });
  await until('Alice to hear the answer', async () => (await talkState(alice)) === TALK_IDLE, { timeout: 20000 });
  await sleep(1500);
  await game.screenshots('talk-declined');
  check(true, 'Alice is told Bob said no');
  await closeMessages(alice);

  await invite(game, 1);
  await until('Bob to be asked', async () => (await talkState(bob)) === TALK_PROMPTING, { timeout: 30000 });
  await alice.pressUntil('B', 'Alice to stop waiting', async () => (await talkState(alice)) === TALK_IDLE, { timeout: 20000, gap: 700 });
  await sleep(1500);
  await bob.press('A'); // YES, too late
  await sleep(2500);
  await game.screenshots('talk-canceled');
  check((await linkState(bob)) === 0, 'Bob does not link up after Alice canceled');
  await Promise.all([closeMessages(alice), closeMessages(bob)]);
  check(true, 'Both players can move on');
}

// Alice invites Bob and Bob accepts. Nobody has to confirm the link.
async function talkUp(game, choice) {
  const [alice, bob] = game.players;
  await invite(game, choice);
  check(true, 'Alice invited Bob by talking to him');
  await until('Bob to be asked', async () => (await talkState(bob)) === TALK_PROMPTING, { timeout: 30000 });
  check(true, 'Bob is asked');
  await sleep(1500);
  await game.screenshots(choice ? 'talk-invite-battle' : 'talk-invite-trade');
  // YES, then save the game.
  await bob.pressUntil('A', 'the link opening', async () => (await linkState(bob)) >= 1, { timeout: 60000, gap: 800 });
  await until('the link to connect', async () => (await linkState(alice)) === 2 && (await linkState(bob)) === 2, { timeout: 30000 });
  check(true, 'Link established between both players');
  await until('both players to enter the room', async () =>
    (await alice.callback2()) === 'CB2_Overworld' && (await bob.callback2()) === 'CB2_Overworld'
    && (await alice.memory.linkPlayerPosition()) && (await bob.memory.linkPlayerPosition()), { timeout: 60000 });
  await sleep(3000);
}

async function checkBackWhereTheyTalked(game) {
  for (const [i, p] of game.players.entries()) {
    const pos = await p.memory.playerPosition();
    check(pos.x === TALK_SPOTS[i][0] && pos.y === TALK_SPOTS[i][1], `${p.name} is back where they talked (${pos.x},${pos.y})`);
    await p.walk(['Up']); // can walk again: no leftover script
  }
}

// Players enter Cable Club rooms on the door tiles; step inside, then walk.
async function walkInRoomTo(player, x, y) {
  const pos = await until(`${player.name} to appear in the room`, () => player.memory.linkPlayerPosition());
  await player.walkTo(pos.x, pos.y - 1);
  await player.walkTo(x, y);
}

// Walks both players out through the doors at (doorX[i], 8), which closes the link.
async function leaveLinkRoom(game, doorX) {
  await Promise.all(game.players.map(async (p, i) => {
    await p.walkTo(doorX[i], 7, { verticalFirst: true });
    // "The link will be terminated if you leave the room. Is that okay?"
    await p.pressUntil('Down', 'the leave prompt', () => p.hasTask('Task_YesNoMenu_HandleInput'), { timeout: 30000, gap: 800 });
    await sleep(300);
    await p.press('Up');
    await sleep(300);
    await p.pressUntil('A', 'the link to close', async () => (await linkState(p)) === 0, { timeout: 60000, gap: 1000 });
  }));
  await sleep(3000);
  for (const p of game.players) {
    if (process.env.DEBUG_LINK) {
      const cb1 = p.memory.functionName(await p.memory.u32('gMain', 0));
      console.log(p.name, 'cb1', cb1, 'state', JSON.stringify(await p.state()), 'tasks', (await p.memory.tasks()).join(','));
    }
    const cb2 = await p.callback2();
    check(cb2 === 'CB2_Overworld', `${p.name} is back in the Pokémon Center without a link error (${cb2})`);
  }
}

async function testTrade(game, byTalking = false) {
  const [alice, bob] = game.players;
  await (byTalking ? talkUp : linkUp)(game, 0);
  const before = [await partySpecies(alice), await partySpecies(bob)];
  console.log('Parties before:', JSON.stringify(before));
  // Sit down on the chairs at (4,5) and (7,5).
  await Promise.all([walkInRoomTo(alice, 4, 5), walkInRoomTo(bob, 7, 5)]);
  await until('the trade menu', async () =>
    (await alice.callback2()) === 'CB2_TradeMenu' && (await bob.callback2()) === 'CB2_TradeMenu', { timeout: 90000 });
  await sleep(2000);
  await game.screenshots('trade-menu');

  // Alice offers her first Pokémon, Bob his second.
  await bob.press('Right');
  await sleep(400);
  await Promise.all([alice.press('A'), bob.press('A')]);
  await sleep(1000);
  await Promise.all([alice.press('Down'), bob.press('Down')]);
  await sleep(400);
  await Promise.all([alice.press('A'), bob.press('A')]);
  // Confirm "Is this trade okay?" until the trade animation starts.
  await Promise.all([alice, bob].map((p) =>
    p.pressUntil('A', 'the trade to start', async () => (await p.callback2()) !== 'CB2_TradeMenu', { timeout: 60000, gap: 1500 })));
  await sleep(5000);
  await game.screenshots('trading');
  await until('the trade to finish', async () =>
    (await alice.callback2()) === 'CB2_TradeMenu' && (await bob.callback2()) === 'CB2_TradeMenu', { timeout: 180000, interval: 1000 });
  await sleep(3000);
  await game.screenshots('after-trade');

  const after = [await partySpecies(alice), await partySpecies(bob)];
  console.log('Parties after:', JSON.stringify(after));
  check(after[0][0] === before[1][1] && after[0][0] === SPECIES_PIDGEY, 'Alice received Bob\'s Pidgey');
  check(after[1][1] === before[0][0] && after[1][1] === SPECIES_BULBASAUR, 'Bob received Alice\'s Bulbasaur');

  // Leave: move the cursor to CANCEL, select it and confirm.
  for (const p of [alice, bob]) {
    await p.pressUntil('Down', 'the cursor to reach CANCEL', async () => (await tradeCursor(p)) === TRADE_CURSOR_CANCEL, { timeout: 15000 });
    await p.press('A');
    await sleep(1500);
  }
  await Promise.all([alice, bob].map((p) =>
    p.pressUntil('A', 'the trade menu to close', async () => (await p.callback2()) !== 'CB2_TradeMenu', { timeout: 60000, gap: 1500 })));
  await until('both players to return to the Trade Center', async () =>
    (await alice.callback2()) === 'CB2_Overworld' && (await bob.callback2()) === 'CB2_Overworld', { timeout: 60000 });
  await sleep(3000);
  await leaveLinkRoom(game, [5, 6]);
  if (byTalking) await checkBackWhereTheyTalked(game);
}

async function testBattle(game, byTalking = false) {
  const [alice, bob] = game.players;
  await (byTalking ? talkUp : linkUp)(game, 1);
  // Step onto the battle spots at (3,5) and (10,5).
  await Promise.all([walkInRoomTo(alice, 3, 5), walkInRoomTo(bob, 10, 5)]);
  await until('the battle to start', async () =>
    (await alice.callback2()) === 'BattleMainCB2' && (await bob.callback2()) === 'BattleMainCB2', { timeout: 90000 });
  check(true, 'Link battle started');
  await sleep(3000);
  await game.screenshots('battle');

  // Both players keep choosing FIGHT and their first move. When a Pokémon
  // faints, the party menu opens: send out the next one.
  const act = async (p) => {
    const cb2 = await p.callback2();
    if (cb2 === 'CB2_UpdatePartyMenu') {
      await p.press('Down');
      await sleep(300);
      await p.press('A'); // the Pokémon
      await sleep(600);
      await p.press('A'); // SHIFT / SEND OUT
    } else if (cb2 === 'BattleMainCB2') {
      await p.press('A');
    }
  };
  const inBattle = async (p) => ['BattleMainCB2', 'CB2_UpdatePartyMenu'].includes(await p.callback2());
  const deadline = Date.now() + 15 * 60000;
  let turns = 0;
  while ((await inBattle(alice)) || (await inBattle(bob))) {
    if (Date.now() > deadline) throw new Error('battle did not finish');
    await Promise.all([act(alice), act(bob)]);
    await sleep(700);
    if (++turns % 60 === 0) await game.screenshots(`battle-${turns}`);
  }
  check(true, 'Link battle finished');
  await until('both players to return to the Colosseum', async () =>
    (await alice.callback2()) === 'CB2_Overworld' && (await bob.callback2()) === 'CB2_Overworld', { timeout: 120000 });
  await sleep(3000);
  await game.screenshots('after-battle');
  await leaveLinkRoom(game, [6, 7]);
  if (byTalking) await checkBackWhereTheyTalked(game);
}

const game = await startPlayers({ rom, elf, names: ['Alice', 'Bob'], shotDir });
try {
  if (which === 'trade' || which === 'all') await testTrade(game);
  if (which === 'battle' || which === 'all') await testBattle(game);
  if (which === 'talk') await testTalkDeclineAndCancel(game);
  if (which === 'talk-trade' || which === 'talk') await testTrade(game, true);
  if (which === 'talk-battle' || which === 'talk') await testBattle(game, true);
} catch (err) {
  console.log('FAIL', err.message);
  await game.screenshots('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await game.close();
}
