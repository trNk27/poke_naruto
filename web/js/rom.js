// Turns the player's own LeafGreen ROM into the multiplayer ROM by applying
// the BPS patch published in patches/manifest.json. The ROM never leaves the
// device.

export async function sha1Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function loadManifest() {
  const res = await fetch('patches/manifest.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Could not load patch list');
  return res.json();
}

/**
 * Returns the multiplayer ROM for the given file contents: either the file
 * itself if it is already patched, or the result of patching a supported
 * retail ROM. Throws with a readable message otherwise.
 */
export async function prepareRom(bytes, manifest) {
  const hash = await sha1Hex(bytes);
  for (const patch of manifest.patches) {
    if (hash === patch.targetSha1) return { rom: bytes, sha1: hash };
  }
  const patch = manifest.patches.find((p) => p.baseSha1 === hash);
  if (!patch) {
    const supported = manifest.patches.map((p) => p.base).join(' or ');
    throw new Error(`This ROM isn't supported. Please use an unmodified ${supported} ROM (.gba).`);
  }
  const res = await fetch(`patches/${patch.file}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error('Could not download the multiplayer patch');
  const rom = applyBps(bytes, new Uint8Array(await res.arrayBuffer()));
  const romHash = await sha1Hex(rom);
  if (romHash !== patch.targetSha1) throw new Error('Patching failed (checksum mismatch)');
  return { rom, sha1: romHash };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Applies a BPS patch (https://www.romhacking.net/documents/746/). */
export function applyBps(source, patch) {
  const magic = String.fromCharCode(...patch.subarray(0, 4));
  if (magic !== 'BPS1') throw new Error('Invalid patch file');

  const footer = new DataView(patch.buffer, patch.byteOffset + patch.length - 12, 12);
  const sourceCrc = footer.getUint32(0, true);
  const targetCrc = footer.getUint32(4, true);
  const patchCrc = footer.getUint32(8, true);
  if (crc32(patch.subarray(0, patch.length - 4)) !== patchCrc) throw new Error('Patch file is corrupted');
  if (crc32(source) !== sourceCrc) throw new Error('This patch is for a different ROM');

  let p = 4;
  const decode = () => {
    let data = 0;
    let shift = 1;
    for (;;) {
      const x = patch[p++];
      data += (x & 0x7f) * shift;
      if (x & 0x80) return data;
      shift *= 128;
      data += shift;
    }
  };

  decode(); // source size
  const target = new Uint8Array(decode());
  const metadataSize = decode();
  p += metadataSize;

  const end = patch.length - 12;
  let out = 0;
  let sourceRel = 0;
  let targetRel = 0;
  while (p < end) {
    const data = decode();
    const command = data % 4;
    const length = Math.floor(data / 4) + 1;
    switch (command) {
      case 0: // SourceRead
        target.set(source.subarray(out, out + length), out);
        out += length;
        break;
      case 1: // TargetRead
        target.set(patch.subarray(p, p + length), out);
        p += length;
        out += length;
        break;
      case 2: { // SourceCopy
        const offset = decode();
        sourceRel += (offset & 1 ? -1 : 1) * Math.floor(offset / 2);
        target.set(source.subarray(sourceRel, sourceRel + length), out);
        sourceRel += length;
        out += length;
        break;
      }
      default: { // TargetCopy (may overlap, so copy byte by byte)
        const offset = decode();
        targetRel += (offset & 1 ? -1 : 1) * Math.floor(offset / 2);
        for (let i = 0; i < length; i++) target[out++] = target[targetRel++];
        break;
      }
    }
  }

  if (crc32(target) !== targetCrc) throw new Error('Patching failed (checksum mismatch)');
  return target;
}
