import { ipcRenderer } from 'electron';

// Preload is typechecked by tsconfig.node (no DOM lib); declare minimal browser globals.
type GuestEvent = { button?: number };
declare const window: {
  addEventListener(
    type: string,
    listener: (event: GuestEvent) => void,
    options?: { capture?: boolean; passive?: boolean }
  ): void;
};

window.addEventListener(
  'pointerdown',
  () => {
    ipcRenderer.sendToHost('browser:pointer-down');
    ipcRenderer.send('browser:human-input');
  },
  { capture: true, passive: true }
);

window.addEventListener(
  'keydown',
  () => {
    ipcRenderer.send('browser:human-input');
  },
  { capture: true, passive: true }
);

window.addEventListener(
  'mouseup',
  (event) => {
    if (event.button === 3) {
      ipcRenderer.sendToHost('browser:thumb-nav', 'back');
    } else if (event.button === 4) {
      ipcRenderer.sendToHost('browser:thumb-nav', 'forward');
    }
  },
  { capture: true, passive: true }
);
