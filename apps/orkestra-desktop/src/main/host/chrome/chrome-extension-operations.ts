import { execFile } from 'node:child_process';
import { app, shell } from 'electron';
import {
  createChromeExtensionOperations,
  type ChromeExtensionOperations,
} from '@core/features/chrome/node/chrome-extension-locator';

// Paketle gelen Chrome uzantısının yerini gösteren ana süreç işlemleri (yalnızca ayar sayfası kullanır).
export function createDesktopChromeExtensionOperations(): ChromeExtensionOperations {
  return createChromeExtensionOperations({
    location: {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    },
    showItemInFolder: (path) => shell.showItemInFolder(path),
    runFile: (file, args) =>
      new Promise<void>((resolve, reject) => {
        execFile(file, [...args], { timeout: 10_000, windowsHide: true }, (error) =>
          error ? reject(error) : resolve()
        );
      }),
    platform: process.platform,
  });
}
