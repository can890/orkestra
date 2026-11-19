import { app } from 'electron';
import { desktopHostEvents } from '@core/features/workbench/node';
import { DEEP_LINK_SCHEME } from '@core/primitives/app-identity/api/app-identity';
import { log } from '@main/lib/logger';
import { DeepLinkCoordinator } from './deep-link-coordinator';

/** Süreç boyunca tek sıra: soğuk başlatmada pencere hazır olmadan gelen bağlantılar burada bekler. */
export const deepLinkCoordinator = new DeepLinkCoordinator(DEEP_LINK_SCHEME);

/**
 * Bağlantı kaynaklarını erken (app ready öncesi) bağlar: macOS `open-url` ve ilk
 * argv (Windows/Linux soğuk başlatma). `second-instance` argv'si çağıran tarafta
 * `deepLinkCoordinator.handleArgv` ile iletilir.
 */
export function installDeepLinkSources(argv: readonly string[]): void {
  app.on('open-url', (event, url) => {
    // Yalnızca şemamıza ait bağlantıyı biz ele alırız; geçersizse sessizce yok sayılır.
    event.preventDefault();
    deepLinkCoordinator.handleUrl(url);
  });
  deepLinkCoordinator.handleArgv(argv);
}

/**
 * İşletim sistemine bu uygulamayı şemanın işleyicisi olarak tanıtır. Yalnızca
 * paketlenmiş uygulamada yapılır: geliştirme çalıştırması kullanıcının kurulu
 * sürümünün kaydını ezmemelidir.
 */
export function registerDeepLinkProtocolClient(): void {
  if (!app.isPackaged) return;
  try {
    if (!app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)) {
      log.warn('deep-link: protocol client registration was refused', { scheme: DEEP_LINK_SCHEME });
    }
  } catch (error) {
    log.warn('deep-link: protocol client registration failed', { error });
  }
}

/** Pencere aşaması hazır olunca bağlanır; sırada bekleyen bağlantı varsa arayüze haber verilir. */
export function attachDeepLinkWindow(focusWindow: () => void): void {
  deepLinkCoordinator.attach({
    notifyPending: () => desktopHostEvents.emit(undefined, { type: 'deep-link-pending' }),
    focusWindow,
  });
}
