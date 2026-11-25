import { join } from 'node:path';
import { app } from 'electron';
import { installMediaStreamProtocol } from '@core/features/files/node/media-stream/desktop-media-stream';
import { installDesktopWire } from '@main/gateway/desktop-wire';
import { attachDeepLinkWindow } from '@main/host/deep-link/deep-link-main';
import { setupApplicationMenu } from '@main/host/menu';
import { setupAppProtocol } from '@main/host/protocol';
import { createMainWindow, showMainWindow } from '@main/host/window';
import { registerQuitHandler } from '../../shutdown';
import type { BootSignals } from '../types';

export function bootWindow(signals: BootSignals): void {
  setupAppProtocol(join(app.getAppPath(), 'out', 'renderer'));
  // Belge işlenmeden önce kayıtlı olmalı; aksi halde açılışta geri yüklenen sohbetlerdeki video
  // istekleri "bilinmeyen şema" hatası alır (bkz. installMediaStreamProtocol).
  installMediaStreamProtocol();
  setupApplicationMenu();
  // The renderer requests its wire port as soon as it boots, which under the
  // window-first boot happens long before controllers exist. The port handler
  // must be live before loadURL; traffic queues until controllers register.
  installDesktopWire();
  createMainWindow();
  registerQuitHandler();
  attachDeepLinkWindow(() => void showMainWindow());
  signals.windowPhaseReady = true;
}
