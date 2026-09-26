// Bridge between the web client and the gNetSync block inside the running
// game. Mirrors `struct NetSync` in game/include/netsync.h; keep both in sync.

export const NETSYNC_VERSION = 1;
export const MAX_REMOTE = 4;
const MAGIC = 'NARUTO-NETSYNC01';
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
const MAGIC_WORD = new DataView(MAGIC_BYTES.buffer).getUint32(0, true);

const OFFSET_VERSION = 0x10;
const OFFSET_FRAME_COUNTER = 0x14;
const OFFSET_OVERWORLD_FRAME = 0x18;
const OFFSET_LOCAL = 0x1c;
const OFFSET_REMOTE = 0x30;
const PLAYER_SIZE = 0x14;
const NAME_LENGTH = 8;

// Field offsets within struct NetSyncPlayer.
const P_ACTIVE = 0x00;
const P_MAP_GROUP = 0x01;
const P_MAP_NUM = 0x02;
const P_FACING = 0x03;
const P_X = 0x04;
const P_Y = 0x06;
const P_ELEVATION = 0x08;
const P_AVATAR_FLAGS = 0x09;
const P_GENDER = 0x0a;
const P_NAME = 0x0c;

/**
 * The emulator does not expose its memory, so capture the WebAssembly.Memory
 * it creates during start-up. Call before instantiating the emulator and call
 * restore() once it has started.
 */
export function captureWasmMemory() {
  const Original = WebAssembly.Memory;
  const captured = [];
  function CapturingMemory(descriptor) {
    const memory = new Original(descriptor);
    captured.push(memory);
    return memory;
  }
  CapturingMemory.prototype = Original.prototype;
  WebAssembly.Memory = CapturingMemory;
  return {
    get memory() {
      // The emulator creates one large memory; ignore any small helpers.
      return captured.reduce((a, b) => (!a || b.buffer.byteLength > a.buffer.byteLength ? b : a), null);
    },
    restore() {
      WebAssembly.Memory = Original;
    },
  };
}

export class NetSyncBridge {
  /** @param {WebAssembly.Memory} memory */
  constructor(memory) {
    this.memory = memory;
    this.base = -1;
    this.candidates = [];
    this.lastScan = 0;
  }

  get bytes() {
    return new Uint8Array(this.memory.buffer);
  }

  get view() {
    return new DataView(this.memory.buffer);
  }

  hasMagicAt(offset) {
    const bytes = this.bytes;
    for (let i = 0; i < MAGIC_BYTES.length; i++) {
      if (bytes[offset + i] !== MAGIC_BYTES[i]) return false;
    }
    return this.view.getUint32(offset + OFFSET_VERSION, true) === NETSYNC_VERSION;
  }

  /** Finds every copy of the magic in emulator memory (4-byte aligned). */
  scan() {
    const words = new Uint32Array(this.memory.buffer);
    const found = [];
    for (let i = 0; i < words.length; i++) {
      if (words[i] === MAGIC_WORD && this.hasMagicAt(i * 4)) found.push(i * 4);
    }
    return found;
  }

  /**
   * Keeps `base` pointing at the live gNetSync block. Save states and similar
   * snapshots also contain the magic, so a candidate is only accepted once its
   * frame counter is seen advancing. Returns true when attached.
   */
  update(now = performance.now()) {
    if (this.base >= 0) {
      if (this.hasMagicAt(this.base)) return true;
      this.base = -1;
    }

    const view = this.view;
    for (const candidate of this.candidates) {
      if (!this.hasMagicAt(candidate.offset)) continue;
      const counter = view.getUint32(candidate.offset + OFFSET_FRAME_COUNTER, true);
      if (counter !== candidate.counter) {
        this.base = candidate.offset;
        this.candidates = [];
        return true;
      }
    }

    if (now - this.lastScan > 1000) {
      this.lastScan = now;
      this.candidates = this.scan().map((offset) => ({
        offset,
        counter: view.getUint32(offset + OFFSET_FRAME_COUNTER, true),
      }));
    }
    return false;
  }

  get attached() {
    return this.base >= 0;
  }

  get frameCounter() {
    return this.view.getUint32(this.base + OFFSET_FRAME_COUNTER, true);
  }

  /** True if the game ran its overworld update within the last few frames. */
  get inOverworld() {
    const view = this.view;
    const frame = view.getUint32(this.base + OFFSET_FRAME_COUNTER, true);
    const overworld = view.getUint32(this.base + OFFSET_OVERWORLD_FRAME, true);
    return ((frame - overworld) >>> 0) <= 2;
  }

  readLocal() {
    return this.readPlayer(this.base + OFFSET_LOCAL);
  }

  readRemote(slot) {
    return this.readPlayer(this.base + OFFSET_REMOTE + slot * PLAYER_SIZE);
  }

  readPlayer(offset) {
    const view = this.view;
    const bytes = this.bytes;
    return {
      active: bytes[offset + P_ACTIVE],
      mapGroup: bytes[offset + P_MAP_GROUP],
      mapNum: bytes[offset + P_MAP_NUM],
      facing: bytes[offset + P_FACING],
      x: view.getInt16(offset + P_X, true),
      y: view.getInt16(offset + P_Y, true),
      elevation: bytes[offset + P_ELEVATION],
      avatarFlags: bytes[offset + P_AVATAR_FLAGS],
      gender: bytes[offset + P_GENDER],
      name: Array.from(bytes.subarray(offset + P_NAME, offset + P_NAME + NAME_LENGTH)),
    };
  }

  /** Shows a remote player in the game, or hides the slot when state is null. */
  writeRemote(slot, state) {
    const offset = this.base + OFFSET_REMOTE + slot * PLAYER_SIZE;
    const view = this.view;
    const bytes = this.bytes;
    if (!state || !state.active) {
      bytes[offset + P_ACTIVE] = 0;
      return;
    }
    // Fields are written before `active` so a newly shown player is complete.
    // (Toggling `active` off while updating would make the game despawn and
    // respawn the object, so an already active entry is updated in place.)
    bytes[offset + P_MAP_GROUP] = state.mapGroup;
    bytes[offset + P_MAP_NUM] = state.mapNum;
    bytes[offset + P_FACING] = state.facing;
    view.setInt16(offset + P_X, state.x, true);
    view.setInt16(offset + P_Y, state.y, true);
    bytes[offset + P_ELEVATION] = state.elevation;
    bytes[offset + P_AVATAR_FLAGS] = state.avatarFlags;
    bytes[offset + P_GENDER] = state.gender;
    for (let i = 0; i < NAME_LENGTH; i++) bytes[offset + P_NAME + i] = state.name?.[i] ?? 0xff;
    bytes[offset + P_ACTIVE] = 1;
  }
}

/** Decodes a name in the game's character set (Latin letters and digits). */
export function decodeGameText(codes) {
  let text = '';
  for (const c of codes) {
    if (c === 0xff) break;
    if (c === 0x00) text += ' ';
    else if (c >= 0xbb && c <= 0xd4) text += String.fromCharCode(65 + c - 0xbb);
    else if (c >= 0xd5 && c <= 0xee) text += String.fromCharCode(97 + c - 0xd5);
    else if (c >= 0xa1 && c <= 0xaa) text += String.fromCharCode(48 + c - 0xa1);
    else if (c === 0xae) text += '-';
    else if (c === 0xad) text += '.';
    else text += '?';
  }
  return text;
}
