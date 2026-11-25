import { homedir } from 'node:os';
import { join } from 'node:path';
import { runtimeResolveErrorAsError } from '@orkestra/core/services/runtime-broker/api';
import type { Scope } from '@orkestra/shared/concurrency';
import { app, BrowserWindow, dialog, protocol } from 'electron';
import type { SshConnectionManager } from '@core/primitives/ssh/api/node/ssh-connection-manager';
import { MEDIA_STREAM_SCHEME } from '../../api/media-stream';
import type { FilesRuntimeBroker } from '../wire-controller';
import { MediaStreamService } from './media-stream-service';
import { createSftpRangeOpener } from './sftp';

/**
 * Ana süreç tarafı: medya akış servisini kurar ve `orkestra-media://` şemasını yalnızca
 * varsayılan oturuma (ana pencere) bağlar. Tarayıcı paneli `session.fromPartition(...)` ile kendi
 * protokol kayıtlarını kullandığından bu şemaya ulaşamaz. Şemanın ayrıcalık kaydı
 * (`stream: true`) uygulama hazır olmadan önce `src/main/host/protocol.ts` içinde yapılır.
 */
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
  protocol.handle(MEDIA_STREAM_SCHEME, (request) => service.handle(request));
  options.scope.add(() => {
    protocol.unhandle(MEDIA_STREAM_SCHEME);
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
