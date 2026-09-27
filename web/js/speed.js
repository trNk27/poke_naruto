// Fast-forward, like a regular emulator: the button cycles 1×, 2× and 3×.
// While a link is open (Cable Club, trade, link battle) the game runs at
// normal speed so both linked games stay in step; the chosen speed returns
// when the link closes.

import { LinkGameState } from './netsync.js';

export const SPEEDS = [1, 2, 3];

export function setupSpeed(emulator, button, link, toast) {
  let chosen = 1;
  let applied = null;

  const apply = () => {
    const linked = link.gameState !== LinkGameState.CLOSED;
    const speed = linked ? 1 : chosen;
    if (speed !== applied) {
      emulator.setFastForwardMultiplier(speed);
      applied = speed;
    }
    button.textContent = `▶▶ ${chosen}×`;
    button.classList.toggle('active', chosen > 1);
    button.classList.toggle('held', linked && chosen > 1);
  };

  const cycle = () => {
    chosen = SPEEDS[(SPEEDS.indexOf(chosen) + 1) % SPEEDS.length];
    apply();
    if (chosen > 1 && link.gameState !== LinkGameState.CLOSED) toast('Normal speed while linked');
  };

  button.addEventListener('click', cycle);
  link.addEventListener('statechange', apply);
  apply();
  return { cycle };
}
