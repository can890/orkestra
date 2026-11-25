import { homedir } from 'node:os';
import { join } from 'node:path';
import { runtimeResolveErrorAsError } from '@orkestra/core/services/runtime-broker/api';
import type { Scope } from '@orkestra/shared/concurrency';
import { log } from '@orkestra/shared/logger';
import { app, BrowserWindow, dialog, protocol } from 'electron';
import type { SshConnectionManager } from '@core/primitives/ssh/api/node/ssh-connection-manager';
import { MEDIA_STREAM_SCHEME } from '../../api/media-stream';
import type { FilesRuntimeBroker } from '../wire-controller';
import { MediaStreamService } from './media-stream-service';
import { createSftpRangeOpener } from './sftp';

/**
 * Ana süreç tarafı: medya akış servisini kurar ve `orkestra-media://` işleyicisine bağlar. Şema
 * yalnızca varsayılan oturumda (ana pencere) tanımlıdır. Tarayıcı paneli `session.fromPartition(...)` ile kendi
 * protokol kayıtlarını kullandığından bu şemaya ulaşamaz. Şemanın ayrıcalık kaydı
 * (`stream: true`) uygulama hazır olmadan önce `src/main/host/protocol.ts` içinde yapılır.
 */
/** Servis hazır olmadan gelen bir isteğin en fazla bekleyeceği süre. */
const SERVICE_WAIT_MS = 15_000;

let protocolInstalled = false;
let activeService: MediaStreamService | undefined;
const serviceWaiters = new Set<(service: MediaStreamService | undefined) => void>();

function waitForService(): Promise<MediaStreamService | undefined> {
  if (activeService) return Promise.resolve(activeService);
  return new Promise((resolve) => {
    const settle = (service: MediaStreamService | undefined) => {
      clearTimeout(timer);
      serviceWaiters.delete(settle);
      resolve(service);
    };
    const timer = setTimeout(() => settle(undefined), SERVICE_WAIT_MS);
    timer.unref?.();
    serviceWaiters.add(settle);
  });
}

/**
 * `orkestra-media://` işleyicisini kaydeder. Ana pencere URL'sini yüklemeden ÖNCE çağrılmalıdır:
 * Chromium bir belgenin kullanabileceği özel şema yükleyicilerini belge işlenirken (commit) sabitler;
 * işleyici sonradan kaydedilirse o belgedeki `<video>` istekleri sayfa yeniden yüklenene kadar
 * `ERR_UNKNOWN_URL_SCHEME` ile düşer (açılışta geri yüklenen sohbetlerde "video oynatılamadı").
 * İşleyici servise geç bağlanır; servis henüz kurulmadıysa istek kısa süre bekletilir.
 */
export function installMediaStreamProtocol(): void {
  if (protocolInstalled) return;
  protocolInstalled = true;
  protocol.handle(MEDIA_STREAM_SCHEME, async (request) => {
    const service = await waitForService();
    if (!service) {
      log.warn('media-stream: request arrived before the media service was ready');
      return new Response(null, { status: 503 });
    }
    return service.handle(request);
  });
}

export function createDesktopMediaStream(options: {
  runtimes: FilesRuntimeBroker;
  sshManager: Pick<SshConnectionManager, 'getProxy'>;
  scope: Scope;
}): MediaStreamService {
  const service = new MediaStreamService({
    remoteFs: async (host) => {
      const runtime = await options.runtimes.client(host);
      if (!runtime.success) throw runtimeResolveErrorAsError(runtime.error);
      return runtime.data.files.fs;
    },
    sftp: createSftpRangeOpener(options.sshManager),
    pickSavePath: async (suggestedName) => {
      const defaultPath = join(safeDownloadsDir(), suggestedName);
      const window = BrowserWindow.getFocusedWindow();
      const result = window
        ? await dialog.showSaveDialog(window, { defaultPath })
        : await dialog.showSaveDialog({ defaultPath });
      return result.canceled || !result.filePath ? undefined : result.filePath;
    },
  });
  // Normalde işleyici pencere aşamasında çoktan kayıtlıdır; burada yalnızca güvence (testler vb.).
  installMediaStreamProtocol();
  activeService = service;
  for (const settle of [...serviceWaiters]) settle(service);
  options.scope.add(() => {
    if (activeService === service) activeService = undefined;
    service.dispose();
  });
  return service;
}

function safeDownloadsDir(): string {
  try {
    return app.getPath('downloads');
  } catch {
    return join(homedir(), 'Downloads');
  }
}
