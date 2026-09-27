// Reads the running game's memory by symbol name, for tests and debugging.
// Symbols (including static ones) come from the ELF file of the ROM under
// test, via arm-none-eabi-nm.

import { execFileSync } from 'node:child_process';

export function loadSymbols(elfPath) {
  const byName = {};
  const out = execFileSync('arm-none-eabi-nm', [elfPath], { encoding: 'utf8', maxBuffer: 64 << 20 });
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]{8}) \w (\w+)$/);
    if (m && !(m[2] in byName)) byName[m[2]] = parseInt(m[1], 16);
  }
  const byAddress = new Map(Object.entries(byName).map(([name, addr]) => [addr, name]));
  return { byName, byAddress };
}

const TASK_SIZE = 0x28;
const NUM_TASKS = 16;

export class GameMemory {
  constructor(page, symbols) {
    this.page = page;
    this.symbols = symbols;
  }

  address(name) {
    const addr = this.symbols.byName[name];
    if (addr === undefined) throw new Error(`unknown symbol ${name}`);
    return addr;
  }

  /** Reads `length` bytes at a symbol (or address) in EWRAM or IWRAM. */
  async read(nameOrAddr, length) {
    const addr = typeof nameOrAddr === 'number' ? nameOrAddr : this.address(nameOrAddr);
    return this.page.evaluate(({ addr, length, netsync, marker }) => {
      const b = window.leafgreenOnline.bridge;
      const mem = new Uint8Array(b.memory.buffer);
      // IWRAM is found through the debug marker the game keeps there.
      if (window.__iwramBase === undefined) {
        const text = 'NARUTO-IWRAM-DBG';
        const first = text.charCodeAt(0) | (text.charCodeAt(1) << 8) | (text.charCodeAt(2) << 16) | (text.charCodeAt(3) << 24);
        const words = new Uint32Array(b.memory.buffer);
        for (let i = 0; i < words.length; i++) {
          if (words[i] !== first) continue;
          let match = true;
          for (let j = 4; j < 16 && match; j++) match = mem[i * 4 + j] === text.charCodeAt(j);
          if (match) {
            window.__iwramBase = i * 4 - (marker - 0x03000000);
            break;
          }
        }
      }
      const ewramBase = b.base - (netsync - 0x02000000);
      const offset = addr >= 0x03000000 ? window.__iwramBase + (addr - 0x03000000) : ewramBase + (addr - 0x02000000);
      return Array.from(mem.subarray(offset, offset + length));
    }, { addr, length, netsync: this.address('gNetSync'), marker: this.address('gNetSyncIwramMarker') });
  }

  async u32(name, offset = 0) {
    const b = await this.read(this.address(name) + offset, 4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  /** The player's map coordinates. */
  async playerPosition() {
    const s16 = (b, o) => ((b[o] | (b[o + 1] << 8)) << 16) >> 16;
    const linked = await this.linkPlayerPosition();
    if (linked) return linked;
    const b = await this.read(await this.u32('gSaveBlock1Ptr'), 4);
    return { x: s16(b, 0), y: s16(b, 2) };
  }

  /**
   * In Cable Club rooms players are "link player" objects and the save block
   * position isn't updated. Returns null outside those rooms.
   */
  async linkPlayerPosition() {
    const s16 = (b, o) => ((b[o] | (b[o + 1] << 8)) << 16) >> 16;
    const linkObjects = await this.read('gLinkPlayerObjectEvents', 16);
    const localId = (await this.read('gLink', 3))[2];
    for (let i = 0; i < 4; i++) {
      const [active, linkPlayerId, objEventId] = linkObjects.slice(i * 4, i * 4 + 3);
      if (active && linkPlayerId === localId) {
        const obj = await this.read(this.address('gObjectEvents') + objEventId * 0x24 + 0x10, 4);
        return { x: s16(obj, 0) - 7, y: s16(obj, 2) - 7 }; // minus MAP_OFFSET
      }
    }
    return null;
  }

  functionName(addr) {
    return this.symbols.byAddress.get(addr & ~1) ?? `0x${addr.toString(16)}`;
  }

  /** Name of the current main callback (which screen the game is on). */
  async callback2() {
    return this.functionName(await this.u32('gMain', 4));
  }

  /** Names of the active tasks. */
  async tasks() {
    const bytes = await this.read('gTasks', TASK_SIZE * NUM_TASKS);
    const names = [];
    for (let i = 0; i < NUM_TASKS; i++) {
      const o = i * TASK_SIZE;
      if (!bytes[o + 4]) continue;
      const func = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
      names.push(this.functionName(func));
    }
    return names;
  }
}
