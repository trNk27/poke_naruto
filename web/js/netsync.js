// Bridge between the web client and the gNetSync block inside the running
// game. Mirrors `struct NetSync` in game/include/netsync.h; keep both in sync.

export const NETSYNC_VERSION = 4;
export const MAX_REMOTE = 4;
const MAGIC = 'NARUTO-NETSYNC01';
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
const MAGIC_WORD = new DataView(MAGIC_BYTES.buffer).getUint32(0, true);

const OFFSET_VERSION = 0x10;
const OFFSET_FRAME_COUNTER = 0x14;
const OFFSET_OVERWORLD_FRAME = 0x18;
const OFFSET_LOCAL = 0x1c;
const OFFSET_REMOTE = 0x30;
const OFFSET_SCREEN = 0x80;
const PLAYER_SIZE = 0x14;
const SCREEN_POS_SIZE = 0x08;

// struct NetLink (virtual link cable) at 0xA0.
const OFFSET_LINK = 0xa0;
const L_GAME_STATE = 0x00;
const L_HOST_STATE = 0x01;
const L_IS_MASTER = 0x02;
const L_OUTBOX = 0x04;
const L_INBOX = 0x108;
const RING_HEAD = 0x00;
const RING_TAIL = 0x01;
const RING_PACKETS = 0x04;
export const RING_SIZE = 8;
export const PACKET_WORDS = 16; // u16 cmds[2][8]

// struct NetTalk (players talking to each other) at 0x2AC.
const OFFSET_TALK = 0x2ac;
const T_GAME_STATE = 0x00;
const T_SLOT = 0x01;
const T_KIND = 0x02;
const T_ANSWER = 0x03;
const T_INVITE_SLOT = 0x04;
const T_INVITE_KIND = 0x05;

export const LinkGameState = { CLOSED: 0, SEARCHING: 1, ESTABLISHED: 2 };
export const LinkHostState = { NO_PARTNER: 0, PARTNER_SEARCHING: 1, PARTNER_ESTABLISHED: 2, PARTNER_LOST: 3 };
export const TalkKind = { TRADE: 1, BATTLE: 2 };
export const TalkGameState = { IDLE: 0, INVITING: 1, PROMPTING: 2, ACCEPTED: 3, DECLINED: 4 };
export const TalkAnswer = { NONE: 0, ACCEPTED: 1, DECLINED: 2, BUSY: 3, CANCELED: 4 };
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
    this.lastCounter = 0;
    this.lastCounterChange = 0;
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
   * Keeps `base` pointing at the live gNetSync block. Save states and other
   * snapshots of the game's memory also contain the magic, so a candidate is
   * only accepted once its frame counter has advanced steadily, like a
   * running game's, over several checks. Returns true when attached.
   */
  update(now = performance.now()) {
    const view = this.view;
    if (this.base >= 0) {
      const counter = this.hasMagicAt(this.base) ? view.getUint32(this.base + OFFSET_FRAME_COUNTER, true) : null;
      if (counter !== null && counter !== this.lastCounter) {
        this.lastCounter = counter;
        this.lastCounterChange = now;
      }
      // Detach if the block vanished or stopped counting for long (a copy
      // rather than the running game; a paused game is found again later).
      if (counter !== null && now - this.lastCounterChange < 10000) return true;
      this.base = -1;
    }

    for (const c of this.candidates) {
      if (now - c.time < 50) continue;
      if (!this.hasMagicAt(c.offset)) {
        c.dead = true;
        continue;
      }
      const counter = view.getUint32(c.offset + OFFSET_FRAME_COUNTER, true);
      const frames = (counter - c.counter) >>> 0;
      const expected = ((now - c.time) / 1000) * 60;
      // A running game advances by about one per frame; allow slowdowns and
      // fast-forward (see speed.js).
      c.hits = frames > 0 && frames <= expected * 4 + 10 ? c.hits + 1 : 0;
      c.counter = counter;
      c.time = now;
      if (c.hits >= 3) {
        this.base = c.offset;
        this.lastCounter = counter;
        this.lastCounterChange = now;
        this.candidates = [];
        return true;
      }
    }
    this.candidates = this.candidates.filter((c) => !c.dead);

    if (now - this.lastScan > 1000) {
      this.lastScan = now;
      const known = new Map(this.candidates.map((c) => [c.offset, c]));
      this.candidates = this.scan().map((offset) => known.get(offset) ?? {
        offset,
        counter: view.getUint32(offset + OFFSET_FRAME_COUNTER, true),
        time: now,
        hits: 0,
      });
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

  get linkGameState() {
    return this.bytes[this.base + OFFSET_LINK + L_GAME_STATE];
  }

  /** Tells the game about its link partner (see NETLINK_HOST_* in netsync.h). */
  setLinkHostState(state, isMaster) {
    const bytes = this.bytes;
    bytes[this.base + OFFSET_LINK + L_IS_MASTER] = isMaster ? 1 : 0;
    bytes[this.base + OFFSET_LINK + L_HOST_STATE] = state;
  }

  /** Takes every packet the game queued for its link partner. */
  takeOutbox() {
    const ring = this.base + OFFSET_LINK + L_OUTBOX;
    const bytes = this.bytes;
    const view = this.view;
    const packets = [];
    let tail = bytes[ring + RING_TAIL];
    const head = bytes[ring + RING_HEAD];
    while (tail !== head) {
      const offset = ring + RING_PACKETS + (tail % RING_SIZE) * PACKET_WORDS * 2;
      const packet = new Array(PACKET_WORDS);
      for (let i = 0; i < PACKET_WORDS; i++) packet[i] = view.getUint16(offset + i * 2, true);
      packets.push(packet);
      tail = (tail + 1) & 0xff;
    }
    bytes[ring + RING_TAIL] = tail;
    return packets;
  }

  /** Queues packets from the link partner for the game; returns how many fit. */
  fillInbox(packets) {
    const ring = this.base + OFFSET_LINK + L_INBOX;
    const bytes = this.bytes;
    const view = this.view;
    let head = bytes[ring + RING_HEAD];
    const tail = bytes[ring + RING_TAIL];
    let count = 0;
    for (const packet of packets) {
      if (((head - tail) & 0xff) >= RING_SIZE) break;
      const offset = ring + RING_PACKETS + (head % RING_SIZE) * PACKET_WORDS * 2;
      for (let i = 0; i < PACKET_WORDS; i++) view.setUint16(offset + i * 2, packet[i], true);
      head = (head + 1) & 0xff;
      count++;
    }
    // Publish the packets only after their contents are written.
    bytes[ring + RING_HEAD] = head;
    return count;
  }

  /** The game's side of a conversation with another player (see TalkManager). */
  readTalk() {
    const bytes = this.bytes;
    const offset = this.base + OFFSET_TALK;
    return {
      gameState: bytes[offset + T_GAME_STATE],
      slot: bytes[offset + T_SLOT],
      kind: bytes[offset + T_KIND],
    };
  }

  /** Answers the game's invitation, or tells it the inviter went away. */
  setTalkAnswer(answer) {
    this.bytes[this.base + OFFSET_TALK + T_ANSWER] = answer;
  }

  /** Passes another player's invitation to the game; slot -1 withdraws it. */
  setInvite(slot, kind = 0) {
    const bytes = this.bytes;
    const offset = this.base + OFFSET_TALK;
    bytes[offset + T_INVITE_KIND] = kind;
    bytes[offset + T_INVITE_SLOT] = slot + 1;
  }

  /** Where remote player `slot` is drawn, in GBA screen pixels. */
  readScreenPos(slot) {
    const offset = this.base + OFFSET_SCREEN + slot * SCREEN_POS_SIZE;
    const view = this.view;
    return {
      x: view.getInt16(offset, true),
      y: view.getInt16(offset + 2, true),
      visible: this.bytes[offset + 4] !== 0,
    };
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
