import { formatHostRef, type HostRef } from '@orkestra/core/primitives/host/api';
import { formatAbsolute, type HostAbsolutePath } from '@orkestra/core/primitives/path/api';
import type { Result } from '@orkestra/shared';
import { hostPathFromNative } from '@core/primitives/desktop-runtime/api';
import {
  MediaSourceError,
  RangeCapabilityCache,
  remoteMediaSource,
  type RemoteFilesFs,
  type SftpRangeReader,
} from './sources';

/**
 * Telefonun `conversations.readMediaPreview` çağrısı için SSH hostundaki bir dosyadan tek bir
 * sınırlı bayt aralığı okur. Masaüstündeki `orkestra-media://` akışıyla aynı kaynakları kullanır
 * (files runtime `offset` okuması → SFTP → sıralı akış); dosyanın tamamı hiçbir zaman belleğe
 * alınmaz, yalnızca istenen aralık (≤ `length`) tutulur.
 */
export type RemoteFileRangeReader = {
  /** Hostun ev dizini (`~/` ile başlayan yollar için). */
  homeDirectory(host: HostRef, signal?: AbortSignal): Promise<string>;
  /** Sembolik bağlantıları çözülmüş gerçek yol, tür ve boyut. */
  resolve(
    host: HostRef,
    path: string,
    signal?: AbortSignal
  ): Promise<{ realPath: string; size: number }>;
  /** `[offset, offset + length)` aralığı; dosya sonunda kısalır. */
  read(
    host: HostRef,
    realPath: string,
    range: { offset: number; length: number },
    signal?: AbortSignal
  ): Promise<Buffer>;
};

type RemoteFilesRuntime = {
  getHomeDir(): Promise<{ path: HostAbsolutePath }>;
  fs: RemoteFilesFs & {
    realPath(
      input: { path: HostAbsolutePath },
      options?: { signal?: AbortSignal }
    ): Promise<Result<{ path: HostAbsolutePath }, { type: string }>>;
  };
};

export type RemoteFileRangeReaderDeps = {
  /** Hostun files runtime yüzeyi; host ulaşılamazsa reddeder. */
  files: (host: HostRef) => Promise<RemoteFilesRuntime>;
  /** Eski workspace-server için SFTP yedeği. */
  sftp?: (connectionId: string) => Promise<SftpRangeReader | undefined>;
  capability?: RangeCapabilityCache;
};

const unavailable = () =>
  new MediaSourceError('unavailable', 'Uzak makinedeki dosya okunamadı. Bağlantıyı kontrol et.');

export function createRemoteFileRangeReader(
  deps: RemoteFileRangeReaderDeps
): RemoteFileRangeReader {
  const capability = deps.capability ?? new RangeCapabilityCache();
  const runtime = async (host: HostRef) => {
    try {
      return await deps.files(host);
    } catch {
      throw new MediaSourceError('unavailable', 'Uzak makineye bağlanılamadı.');
    }
  };
  const source = (host: HostRef, realPath: string) => {
    const hostPath = hostPathFromNative(realPath);
    return remoteMediaSource({
      hostKey: formatHostRef(host),
      path: hostPath,
      nativePath: realPath,
      fs: async () => (await runtime(host)).fs,
      sftp: deps.sftp ? () => deps.sftp!(host.id) : undefined,
      capability,
    });
  };

  return {
    async homeDirectory(host) {
      const files = await runtime(host);
      try {
        return formatAbsolute((await files.getHomeDir()).path);
      } catch {
        throw unavailable();
      }
    },

    async resolve(host, path, signal) {
      let requested: HostAbsolutePath;
      try {
        requested = hostPathFromNative(path);
      } catch {
        throw new MediaSourceError('not-found', 'Geçersiz dosya yolu.');
      }
      const files = await runtime(host);
      const real = await files.fs.realPath({ path: requested }, { signal });
      if (!real.success) {
        throw real.error.type === 'not-found'
          ? new MediaSourceError('not-found', 'Dosya bulunamadı.')
          : unavailable();
      }
      const realPath = formatAbsolute(real.data.path);
      const size = await source(host, realPath).size(signal);
      return { realPath, size };
    },

    async read(host, realPath, range, signal) {
      const length = Math.max(0, range.length);
      if (length === 0) return Buffer.alloc(0);
      const read = await source(host, realPath).read(
        { start: range.offset, end: range.offset + length - 1 },
        signal
      );
      const out = Buffer.alloc(length);
      let filled = 0;
      // Eski sunucu aralığı yok sayıp bayt 0'dan akıtıyorsa baştaki baytlar atlanır.
      let skip = read.ranged ? 0 : range.offset - read.start;
      try {
        for await (const chunk of read.body) {
          let bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
          if (skip > 0) {
            if (bytes.byteLength <= skip) {
              skip -= bytes.byteLength;
              continue;
            }
            bytes = bytes.subarray(skip);
            skip = 0;
          }
          const take = Math.min(bytes.byteLength, length - filled);
          out.set(bytes.subarray(0, take), filled);
          filled += take;
          if (filled >= length) break;
        }
      } finally {
        read.cancel();
      }
      return out.subarray(0, filled);
    },
  };
}
