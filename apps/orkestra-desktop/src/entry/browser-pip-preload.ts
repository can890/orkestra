import { contextBridge, ipcRenderer } from 'electron';

// Preload is typechecked by tsconfig.node (no DOM lib); declare minimal DOM handle.
declare const document: {
  getElementById(id: string): { src?: string } | null;
};

function applyPipFrame(dataUrl: string): void {
  const frameEl = document.getElementById('frame');
  if (frameEl) {
    frameEl.src = dataUrl;
  }
}

ipcRenderer.on('orkestra:pip-frame', (_event, frame: { dataUrl: string }) => {
  if (frame && typeof frame.dataUrl === 'string') {
    applyPipFrame(frame.dataUrl);
  }
});

contextBridge.exposeInMainWorld('orkestraPip', {
  onFrame: (callback: (frame: { dataUrl: string }) => void) => {
    const listener = (_event: unknown, frame: { dataUrl: string }) => callback(frame);
    ipcRenderer.on('orkestra:pip-frame', listener);
    return () => {
      ipcRenderer.removeListener('orkestra:pip-frame', listener);
    };
  },
});
