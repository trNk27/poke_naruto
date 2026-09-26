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
  return { Module, memory: capture.memory };
}
