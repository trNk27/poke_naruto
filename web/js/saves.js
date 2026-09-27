// Importing and exporting in-game saves, so players can back them up, move
// them to another device, or bring a save from another emulator.
//
// LeafGreen saves to 128 KiB of flash memory: 32 sectors of 4 KiB, each
// ending in a footer with a signature. The emulator keeps it as a raw .sav
// file named after the ROM file (see GAMES in app.js).

const SAVE_SIZE = 0x20000;
const SECTOR_SIZE = 0x1000;
const SIGNATURE_OFFSET = 0xff8;
const SIGNATURE = 0x08012025;
const GAME_SECTORS = 28; // two copies of the 14-sector game data

function hasGameData(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < GAME_SECTORS; i++) {
    if (view.getUint32(i * SECTOR_SIZE + SIGNATURE_OFFSET, true) === SIGNATURE) return true;
  }
  return false;
}

/**
 * Checks that `bytes` is a LeafGreen/FireRed save and returns it as the
 * emulator stores it. Throws with a readable message otherwise.
 */
export function normalizeSave(bytes) {
  if (bytes.length < SAVE_SIZE) {
    throw new Error(
      bytes.length < 0x1000
        ? "This doesn't look like a save file. Save states (.ss1, .sgm, …) can't be imported; save in the game and use its .sav file."
        : "This save file is too small. LeafGreen saves are 128 KB; please export the save from your emulator again.",
    );
  }
  // Some emulators append extra data (e.g. a clock) after the save itself.
  const save = bytes.slice(0, SAVE_SIZE);
  if (!hasGameData(save)) throw new Error("This doesn't look like a Pokémon LeafGreen save.");
  return save;
}

export function savePath(emulator, romFile) {
  return `${emulator.filePaths().savePath}/${romFile.replace(/\.gba$/, '.sav')}`;
}

export function readSave(emulator, romFile) {
  const path = savePath(emulator, romFile);
  return emulator.FS.analyzePath(path).exists ? emulator.FS.readFile(path) : null;
}

export async function writeSave(emulator, romFile, bytes) {
  emulator.FS.writeFile(savePath(emulator, romFile), bytes);
  await emulator.FSSync();
}

/** Offers `bytes` to the player as a file to keep. */
export function downloadSave(bytes, fileName) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
