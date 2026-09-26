import { captureKeyboard, setupControls } from './controls.js';
import { startEmulator } from './emulator.js';
import { NetClient } from './net.js';
import { MAX_REMOTE, NetSyncBridge } from './netsync.js';
import { loadManifest, prepareRom } from './rom.js';

const ROM_FILE_NAME = 'leafgreen-online.gba';
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
  window.leafgreenOnline = { emulator, bridge, peers };
}

$('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('player-name').value.trim() || 'Trainer';
  const room = $('room-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!room) {
    setStatus('Please enter a room code.', true);
    return;
  }
  storage.set('name', name);
  storage.set('room', room);

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
    const { rom } = await prepareRom(base, manifest);
    if (file) emulator.FS.writeFile(basePath, base);

    const romPath = `${emulator.filePaths().gamePath}/${ROM_FILE_NAME}`;
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
  startGame(name, room);
});

// ---------------------------------------------------------------------------
// Game

/** @type {Map<number, {name: string, state: object|null, slot: number, dirty: boolean}>} */
const peers = new Map();
const slots = new Array(MAX_REMOTE).fill(null);
let net;

function addPeer(id, name, state = null) {
  if (peers.has(id)) return;
  const slot = slots.indexOf(null);
  if (slot < 0) return; // the game can't show more players
  slots[slot] = id;
  peers.set(id, { name, state, slot, dirty: true });
  updateHud();
}

function removePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  if (bridge.attached) bridge.writeRemote(peer.slot, null);
  slots[peer.slot] = null;
  peers.delete(id);
  updateHud();
}

function removeAllPeers() {
  for (const id of [...peers.keys()]) removePeer(id);
}

function updateHud() {
  $('hud-room').textContent = net?.room ?? '';
  const names = [...peers.values()].map((p) => p.name);
  const connection = net?.connected ? '' : ' · connecting…';
  $('hud-players').textContent = names.length
    ? `with ${names.join(', ')}${connection}`
    : `waiting for friends${connection}`;
}

function startGame(name, room) {
  $('setup').hidden = true;
  $('game').hidden = false;
  history.replaceState(null, '', `?room=${encodeURIComponent(room)}`);

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
    peer.dirty = true;
  });
  net.addEventListener('disconnected', () => {
    removeAllPeers();
    updateHud();
  });
  net.addEventListener('error', (e) => toast(e.detail.message));
  net.connect(room, name);
  updateHud();

  $('share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`;
    try {
      if (navigator.share) await navigator.share({ title: 'LeafGreen Online', text: `Join my room ${room}`, url });
      else {
        await navigator.clipboard.writeText(url);
        toast('Invite link copied');
      }
    } catch {
      // Share sheet dismissed.
    }
  });

  setInterval(syncTick, 16);
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

  const local = bridge.readLocal();
  if (!local.active) return;
  const key = `${local.mapGroup}.${local.mapNum}.${local.x}.${local.y}.${local.facing}.${local.elevation}.${local.avatarFlags}`;
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
