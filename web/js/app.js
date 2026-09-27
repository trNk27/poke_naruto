import { captureKeyboard, onSpeedKey, setupControls } from './controls.js';
import { startEmulator } from './emulator.js';
import { NetClient } from './net.js';
import { LinkManager } from './link.js';
import { LinkGameState, MAX_REMOTE, NetSyncBridge } from './netsync.js';
import { loadManifest, prepareRom } from './rom.js';
import { setupSpeed } from './speed.js';

// The two versions players can choose between. The emulator names the save
// file after the ROM file, so each version keeps its own save. (Naruto keeps
// the original file name so existing saves stay with it.)
const GAMES = {
  naruto: {
    label: 'Naruto',
    romFile: 'leafgreen-online.gba',
    hint: 'LeafGreen with 40 ninjas in place of the Pokémon. Has its own save.',
  },
  classic: {
    label: 'Classic',
    romFile: 'leafgreen-classic.gba',
    hint: 'Regular Pokémon LeafGreen. Has its own save.',
  },
};
const SEND_INTERVAL_MS = 50;
const KEEPALIVE_MS = 2000;

const $ = (id) => document.getElementById(id);
const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private mode etc.; the values are only conveniences.
    }
  },
};

function randomRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => alphabet[b % alphabet.length]).join('');
}

function setStatus(text, isError = false) {
  const el = $('setup-status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

// ---------------------------------------------------------------------------
// Setup screen

const params = new URLSearchParams(location.search);
$('player-name').value = storage.get('name') ?? '';
$('room-code').value = (params.get('room') ?? storage.get('room') ?? randomRoomCode()).toUpperCase();
$('new-room').addEventListener('click', () => { $('room-code').value = randomRoomCode(); });

const gameInputs = document.querySelectorAll('input[name="game"]');
const selectedGame = () => [...gameInputs].find((input) => input.checked)?.value ?? 'naruto';
function showGameHint() {
  $('game-hint').textContent = GAMES[selectedGame()].hint;
}
{
  const initial = [params.get('game'), storage.get('game')].find((id) => id in GAMES) ?? 'naruto';
  for (const input of gameInputs) {
    input.checked = input.value === initial;
    input.addEventListener('change', showGameHint);
  }
  showGameHint();
}

let emulator;
let bridge;
let manifest;
let basePath;

async function init() {
  captureKeyboard();
  try {
    [{ Module: emulator, memory: bridge }, manifest] = await Promise.all([
      startEmulator($('screen')).then(({ Module, memory }) => ({ Module, memory: new NetSyncBridge(memory) })),
      loadManifest(),
    ]);
  } catch (err) {
    console.error(err);
    setStatus(
      typeof SharedArrayBuffer === 'undefined'
        ? 'This browser is missing features the emulator needs. Please use a recent Chrome, Safari or Firefox.'
        : `Could not start the emulator: ${err.message}`,
      true,
    );
    return;
  }

  // Keep a copy of the player's ROM so it only has to be chosen once.
  const FS = emulator.FS;
  const baseDir = `${emulator.filePaths().root}/base`;
  if (!FS.analyzePath(baseDir).exists) FS.mkdir(baseDir);
  basePath = `${baseDir}/rom.gba`;
  const hasSavedRom = FS.analyzePath(basePath).exists;
  $('rom-saved').hidden = !hasSavedRom;
  $('rom-picker').hidden = hasSavedRom;
  $('rom-change').addEventListener('click', () => {
    $('rom-saved').hidden = true;
    $('rom-picker').hidden = false;
  });

  $('start').disabled = false;
  $('start').textContent = 'Play';

  // Handy for debugging from the browser console and for automated tests.
  window.leafgreenOnline = {
    emulator,
    bridge,
    peers,
    get net() { return net; },
    get link() { return link; },
  };
}

$('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('player-name').value.trim() || 'Trainer';
  const room = $('room-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!room) {
    setStatus('Please enter a room code.', true);
    return;
  }
  const gameId = selectedGame();
  storage.set('name', name);
  storage.set('room', room);
  storage.set('game', gameId);

  // Browsers only allow sound after a tap, so resume audio here.
  emulator.SDL2?.audioContext?.resume?.();

  $('start').disabled = true;
  try {
    const file = $('rom-picker').hidden ? null : $('rom-file').files[0];
    let base;
    if (file) {
      base = new Uint8Array(await file.arrayBuffer());
    } else if (emulator.FS.analyzePath(basePath).exists) {
      base = emulator.FS.readFile(basePath);
    } else {
      throw new Error('Please choose your LeafGreen ROM file.');
    }

    setStatus('Preparing game…');
    const { rom } = await prepareRom(base, manifest, gameId);
    if (file) emulator.FS.writeFile(basePath, base);

    const romPath = `${emulator.filePaths().gamePath}/${GAMES[gameId].romFile}`;
    emulator.FS.writeFile(romPath, rom);
    await emulator.FSSync();
    if (!emulator.loadGame(romPath)) throw new Error('The emulator could not load the game.');
  } catch (err) {
    console.error(err);
    setStatus(err.message, true);
    $('start').disabled = false;
    return;
  }

  setStatus('');
  startGame(name, room, gameId);
});

// ---------------------------------------------------------------------------
// Game

/** @type {Map<number, {name: string, state: object|null, slot: number, dirty: boolean}>} */
const peers = new Map();
const slots = new Array(MAX_REMOTE).fill(null);
let net;
let link;

function addPeer(id, name, state = null) {
  if (peers.has(id)) return;
  const slot = slots.indexOf(null);
  if (slot < 0) return; // the game can't show more players
  slots[slot] = id;
  const label = document.createElement('span');
  label.className = 'name-label';
  label.textContent = name;
  label.hidden = true;
  $('labels').append(label);
  peers.set(id, { name, state, slot, dirty: true, label, linkState: state?.link ?? 0 });
  updateHud();
}

function removePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  if (bridge.attached) bridge.writeRemote(peer.slot, null);
  peer.label.remove();
  slots[peer.slot] = null;
  peers.delete(id);
  updateHud();
}

function removeAllPeers() {
  for (const id of [...peers.keys()]) removePeer(id);
}

function updateHud() {
  $('hud-room').textContent = net ? `${net.room} · ${GAMES[net.game]?.label ?? ''}` : '';
  const names = [...peers.values()].map((p) => p.name);
  const connection = net?.connected ? '' : ' · connecting…';
  $('hud-players').textContent = names.length
    ? `with ${names.join(', ')}${connection}`
    : `waiting for friends${connection}`;
}

function startGame(name, room, gameId) {
  $('setup').hidden = true;
  $('game').hidden = false;
  const query = `?room=${encodeURIComponent(room)}&game=${gameId}`;
  history.replaceState(null, '', query);

  setupControls(emulator);
  setupSaving();

  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  net = new NetClient(wsUrl);
  net.addEventListener('welcome', (e) => {
    removeAllPeers();
    for (const peer of e.detail.peers) addPeer(peer.id, peer.name, peer.s);
    lastSentKey = null;
    updateHud();
  });
  net.addEventListener('join', (e) => {
    addPeer(e.detail.id, e.detail.name);
    toast(`${e.detail.name} joined`);
  });
  net.addEventListener('leave', (e) => {
    const peer = peers.get(e.detail.id);
    if (peer) toast(`${peer.name} left`);
    removePeer(e.detail.id);
  });
  net.addEventListener('state', (e) => {
    const peer = peers.get(e.detail.id);
    if (!peer) return;
    peer.state = e.detail.s;
    peer.linkState = e.detail.s.link;
    peer.dirty = true;
  });
  net.addEventListener('disconnected', () => {
    removeAllPeers();
    updateHud();
  });
  net.addEventListener('error', (e) => toast(e.detail.message));
  link = new LinkManager(bridge, net, peers);
  link.addEventListener('paired', (e) => toast(`Connecting to ${e.detail.name}…`));
  link.addEventListener('statechange', (e) => {
    if (e.detail === LinkGameState.ESTABLISHED) toast('Link established');
  });
  const speed = setupSpeed(emulator, $('speed'), link, toast);
  onSpeedKey(speed.cycle);
  net.connect(room, name, gameId);
  updateHud();

  $('share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}${query}`;
    try {
      if (navigator.share) await navigator.share({ title: 'LeafGreen Online', text: `Join my room ${room} (${GAMES[gameId].label})`, url });
      else {
        await navigator.clipboard.writeText(url);
        toast('Invite link copied');
      }
    } catch {
      // Share sheet dismissed.
    }
  });

  setInterval(syncTick, 16);
  requestAnimationFrame(drawLabels);
}

// Names above other players, positioned where the game draws their sprites.
function drawLabels() {
  requestAnimationFrame(drawLabels);
  const inOverworld = bridge.attached && bridge.inOverworld;
  const wrap = $('screen-wrap');
  const scaleX = wrap.clientWidth / 240;
  const scaleY = wrap.clientHeight / 160;
  for (const peer of peers.values()) {
    const pos = inOverworld ? bridge.readScreenPos(peer.slot) : null;
    const show = pos?.visible && pos.x > -16 && pos.x < 256 && pos.y > -8 && pos.y < 160;
    peer.label.hidden = !show;
    if (!show) continue;
    const x = pos.x * scaleX - peer.label.offsetWidth / 2;
    const y = pos.y * scaleY - peer.label.offsetHeight - 2;
    peer.label.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}

let lastSentKey = null;
let lastSentAt = 0;
let lastFrameCounter = 0;
let wasAttached = false;

function syncTick() {
  const now = performance.now();
  if (!bridge.update(now)) {
    wasAttached = false;
    return;
  }

  // After attaching, or when the game soft-resets and clears gNetSync, write
  // every remote player again.
  const frame = bridge.frameCounter;
  if (!wasAttached || frame < lastFrameCounter) {
    for (const peer of peers.values()) peer.dirty = true;
  }
  wasAttached = true;
  lastFrameCounter = frame;

  for (const peer of peers.values()) {
    if (!peer.dirty) continue;
    bridge.writeRemote(peer.slot, peer.state);
    peer.dirty = false;
  }

  link.tick();

  const local = bridge.readLocal();
  if (!local.active) return;
  local.link = bridge.linkGameState;
  const key = `${local.mapGroup}.${local.mapNum}.${local.x}.${local.y}.${local.facing}.${local.elevation}.${local.avatarFlags}.${local.link}`;
  if ((key !== lastSentKey && now - lastSentAt >= SEND_INTERVAL_MS) || now - lastSentAt >= KEEPALIVE_MS) {
    net.sendState(local);
    lastSentKey = key;
    lastSentAt = now;
  }
}

function setupSaving() {
  // In-game saves are written to the emulator's virtual file system; copy
  // them to the browser's persistent storage shortly after each save.
  let timer;
  const sync = () => {
    clearTimeout(timer);
    timer = setTimeout(() => emulator.FSSync(), 500);
  };
  emulator.addCoreCallbacks({ saveDataUpdatedCallback: sync });
  // Ask the browser not to evict saves when storage runs low.
  navigator.storage?.persist?.().catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) emulator.FSSync();
  });
}

init();
