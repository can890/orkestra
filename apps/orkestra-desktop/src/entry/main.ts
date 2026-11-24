import { app, dialog } from 'electron';
import { SAFE_STORAGE_APP_NAME } from '@core/primitives/app-identity/api/app-identity';
import { configureChromiumCommandLine } from '@main/host/chromium-command-line';

// Packaged Electron does not set NODE_ENV, so environment-keyed defaults (such
// as the wire validation policy) would otherwise resolve to their development
// behavior. Set it before any other module loads so spawned workers inherit it.
if (app.isPackaged && !process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

// Electron consumes Chromium switches during initialization. Keep this call
// synchronous at module scope, before bootstrap's dynamic import crosses an
// event-loop boundary and `ready` may be emitted.
configureChromiumCommandLine({ commandLine: app.commandLine });

// Preserve the existing "Orkestra Safe Storage" OS keychain binding before
// Electron's PostCreateMainMessageLoop snapshots app.getName() into OSCrypt.
// prepareElectron switches app.setName(PRODUCT_NAME) right after app.whenReady().
app.setName(SAFE_STORAGE_APP_NAME);

async function start(): Promise<void> {
  try {
    const { main } = await import('@main/bootstrap');
    await main();
  } catch (error) {
    try {
      const { enterSafeMode } = await import('@main/bootstrap/core/recovery');
      await enterSafeMode(error);
    } catch (recoveryError) {
      await app.whenReady();
      dialog.showErrorBox(
        'Something went wrong',
        `Sovra could not start recovery mode.\n\n${
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        }`
      );
    }
  }
}

void start();
