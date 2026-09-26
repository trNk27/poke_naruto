// On-screen touch controls and keyboard input, forwarded to the emulator.

const KEYBOARD = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  KeyX: 'A',
  KeyZ: 'B',
  Enter: 'Start',
  Backspace: 'Select',
  ShiftRight: 'Select',
  KeyA: 'L',
  KeyS: 'R',
};

export function setupControls(emulator) {
  // Several sources (touch, keyboard) may hold the same button.
  const holds = new Map();
  const press = (button, source) => {
    const set = holds.get(button) ?? new Set();
    if (set.size === 0) emulator.buttonPress(button);
    set.add(source);
    holds.set(button, set);
  };
  const release = (button, source) => {
    const set = holds.get(button);
    if (!set || !set.delete(source)) return;
    if (set.size === 0) emulator.buttonUnpress(button);
  };
  const vibrate = () => navigator.vibrate?.(8);

  // Face, shoulder and menu buttons.
  for (const el of document.querySelectorAll('#controls [data-button]')) {
    const button = el.dataset.button;
    const down = (event) => {
      event.preventDefault();
      el.setPointerCapture?.(event.pointerId);
      el.classList.add('pressed');
      press(button, `pointer${event.pointerId}`);
      vibrate();
    };
    const up = (event) => {
      el.classList.remove('pressed');
      release(button, `pointer${event.pointerId}`);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  // D-pad: the direction follows the finger, including diagonals, so the
  // thumb can slide between directions without lifting.
  const dpad = document.getElementById('dpad');
  const dirEls = {
    Up: dpad.querySelector('.up'),
    Down: dpad.querySelector('.down'),
    Left: dpad.querySelector('.left'),
    Right: dpad.querySelector('.right'),
  };
  const active = new Map(); // pointerId -> Set of directions
  const directionsAt = (event) => {
    const rect = dpad.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const dead = rect.width * 0.12;
    const dirs = new Set();
    if (Math.hypot(dx, dy) < dead) return dirs;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI; // 0 = right, 90 = down
    if (angle > -67.5 && angle < 67.5) dirs.add('Right');
    if (angle > 112.5 || angle < -112.5) dirs.add('Left');
    if (angle > 22.5 && angle < 157.5) dirs.add('Down');
    if (angle < -22.5 && angle > -157.5) dirs.add('Up');
    return dirs;
  };
  const setDirs = (pointerId, next) => {
    const source = `dpad${pointerId}`;
    const prev = active.get(pointerId) ?? new Set();
    for (const d of prev) if (!next.has(d)) release(d, source);
    for (const d of next) if (!prev.has(d)) press(d, source);
    if (next.size > prev.size) vibrate();
    if (next.size) active.set(pointerId, next);
    else active.delete(pointerId);
    const held = new Set([...active.values()].flatMap((s) => [...s]));
    for (const [dir, el] of Object.entries(dirEls)) el.classList.toggle('pressed', held.has(dir));
  };
  dpad.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    dpad.setPointerCapture?.(event.pointerId);
    setDirs(event.pointerId, directionsAt(event));
  });
  dpad.addEventListener('pointermove', (event) => {
    if (active.has(event.pointerId) || event.buttons) setDirs(event.pointerId, directionsAt(event));
  });
  for (const type of ['pointerup', 'pointercancel']) {
    dpad.addEventListener(type, (event) => setDirs(event.pointerId, new Set()));
  }

  // Keyboard.
  window.addEventListener('keydown', (event) => {
    const button = KEYBOARD[event.code];
    if (!button || event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    if (!event.repeat) press(button, `key${event.code}`);
  });
  window.addEventListener('keyup', (event) => {
    const button = KEYBOARD[event.code];
    if (button) release(button, `key${event.code}`);
  });

  // Don't leave buttons stuck when the app goes to the background.
  const releaseAll = () => {
    for (const [button, set] of holds) {
      if (set.size) emulator.buttonUnpress(button);
      set.clear();
    }
    active.clear();
    for (const el of document.querySelectorAll('#controls .pressed')) el.classList.remove('pressed');
  };
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAll();
  });
}
