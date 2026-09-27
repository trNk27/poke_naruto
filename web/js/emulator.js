// Starts the mGBA core and captures its memory for the NetSync bridge.
import mGBA from '../vendor/mgba/mgba.js';
import { captureWasmMemory } from './netsync.js';

export async function startEmulator(canvas) {
  const capture = captureWasmMemory();
  let Module;
  try {
    Module = await mGBA({ canvas });
  } finally {
    capture.restore();
  }
  await Module.FSInit();
  if (!capture.memory) throw new Error('Could not access emulator memory');
  // Progress is kept by saving in the game. Rewind and automatic save states
  // would keep snapshots of the game's memory around (confusing the NetSync
  // bridge), cost battery, and could restore a snapshot from an older ROM
  // version after an update.
  Module.setCoreSettings({ rewindEnable: false, autoSaveStateEnable: false, restoreAutoSaveStateOnLoad: false });
  return { Module, memory: capture.memory };
}
