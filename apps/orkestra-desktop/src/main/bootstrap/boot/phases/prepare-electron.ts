import { app } from 'electron';
import devIcon from '@/assets/images/orkestra/orkestra-dev.png?asset';
import {
  deepLinkCoordinator,
  installDeepLinkSources,
  registerDeepLinkProtocolClient,
} from '@main/host/deep-link/deep-link-main';
import { initializeFileLogger, registerProcessErrorLogging } from '@main/host/file-logger';
import { registerAppScheme } from '@main/host/protocol';
import { log } from '@main/lib/logger';
import type { AppConfig } from '../../core/config';
import { step } from '../../core/phase';
import { BootAborted, type BootSignals } from '../types';

export async function prepareElectron(config: AppConfig, signals: BootSignals): Promise<void> {
  // Headless sunucu modunda (ör. Huawei Xvfb) GPU sürecini tamamen kapat;
  // aksi halde Chromium GPU süreci periyodik SIGTRAP ile tüm servisi düşürebilir.
  if (process.env.SOVRA_HEADLESS === '1' || process.env.SOVRA_ALLOW_BASIC_STORAGE === '1') {
    app.disableHardwareAcceleration();
  }
  registerAppScheme();
  initializeFileLogger();
  registerProcessErrorLogging(log);

  installDeepLinkSources(process.argv);

  app.on('second-instance', (_event, argv) => {
    // Windows/Linux: ikinci başlatma bağlantıyı argv ile getirir; yalnızca
    // `orkestra://` ile başlayan tek değer alınır, diğer argümanlar yorumlanmaz.
    deepLinkCoordinator.handleArgv(argv);
    if (signals.windowPhaseReady) void showMainWindow();
  });

  if (!config.isDev && !app.requestSingleInstanceLock()) {
    app.quit();
    throw new BootAborted('Another application instance is already running');
  }

  registerDeepLinkProtocolClient();

  if (config.isDev) {
    try {
      app.dock?.setIcon(devIcon);
    } catch (error) {
      log.warn('Failed to set dock icon:', error);
    }
  }

  app.on('activate', () => {
    if (signals.windowPhaseReady) void showMainWindow();
  });

  // Orkestra remains available from the tray when its main window is destroyed.
  // Explicit quit requests are coordinated through the before-quit handler.
  app.on('window-all-closed', () => {});

  await step('electron-app-ready', () => app.whenReady());

  // OSCrypt keychain service name is already bound during PostCreateMainMessageLoop;
  // apply the visible product name for macOS menus, About panel, and User-Agent.
  app.setName(config.identity.productName);
}

async function showMainWindow(): Promise<void> {
  const windowModule = await import('@main/host/window');
  windowModule.showMainWindow();
}
