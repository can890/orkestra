import { Menu, type BrowserWindow } from 'electron';

/** Copy the displayed image through Chromium, including data and blob URLs. */
export function registerImageContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (event, params) => {
    if (params.mediaType !== 'image' || !params.hasImageContents) return;

    event.preventDefault();
    Menu.buildFromTemplate([
      {
        label: 'Görseli kopyala',
        click: () => {
          if (window.isDestroyed() || window.webContents.isDestroyed()) return;
          window.webContents.copyImageAt(params.x, params.y);
        },
      },
    ]).popup({ window, x: params.x, y: params.y });
  });
}
