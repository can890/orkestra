import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { HostAbsolutePath } from '@orkestra/core/primitives/path/api';
import type { ReadBytesMeta, ReadFileOptions } from '@orkestra/core/runtimes/files/api';
import type { Result } from '@orkestra/shared';
import type { ByteRange } from './range';

/** Bir okuma isteğinin sonucu; gövde tüketilmeli ya da `cancel()` çağrılmalı. */
export type MediaRead = {
  /** `true`: tam olarak istenen aralık sunuluyor. `false`: eski sunucu, bayt 0'dan sıralı akış. */
  ranged: boolean;
  start: number;
  length: number;
  totalSize: number;
  body: AsyncIterable<Uint8Array>;
  cancel(): void;
};

export interface MediaByteSource {
  /** Aralık başlığını boyuta göre çözmek için her istekte taze boyut. */
  size(signal?: AbortSignal): Promise<number>;
  read(range: ByteRange, signal?: AbortSignal): Promise<MediaRead>;
}

export class MediaSourceError extends Error {
  constructor(
    readonly type: 'not-found' | 'unavailable',
    message: string
  ) {
    super(message);
  }
}

const LOCAL_CHUNK_BYTES = 256 * 1024;

/** Bu Mac'teki dosya: doğrudan `fs` akışı, tam Range desteği. */
export function localMediaSource(path: string): MediaByteSource {
  return {
    async size() {
      try {
        const info = await stat(path);
        if (!info.isFile()) throw new MediaSourceError('not-found', 'Hedef bir dosya değil.');
        return info.size;
      } catch (error) {
        if (error instanceof MediaSourceError) throw error;
        throw new MediaSourceError('not-found', 'Dosya bulunamadı.');
      }
    },
    async read(range) {
      const stream = createReadStream(path, {
        start: range.start,
        end: range.end,
        highWaterMark: LOCAL_CHUNK_BYTES,
      });
      try {
        await once(stream, 'open');
      } catch {
        stream.destroy();
        throw new MediaSourceError('not-found', 'Dosya bulunamadı.');
      }
      const info = await stat(path);
      return {
        ranged: true,
        start: range.start,
        length: Math.max(0, Math.min(range.end, info.size - 1) - range.start + 1),
        totalSize: info.size,
        body: stream,
        cancel: () => stream.destroy(),
      };
    },
  };
}

/** Uzak hostun files runtime'ından ihtiyaç duyulan yüzey (yapısal; testte sahtelenebilir). */
export type RemoteFilesFs = {
  readBytes(
    input: { path: HostAbsolutePath; options?: ReadFileOptions },
    options?: { signal?: AbortSignal }
  ): Promise<
    Result<
      { meta: ReadBytesMeta; chunks(): AsyncIterable<Uint8Array>; cancel(): void },
      { type: string }
    >
  >;
  stat(
    input: { path: HostAbsolutePath },
    options?: { signal?: AbortSignal }
  ): Promise<Result<{ type: 'file' | 'directory'; size: number }, { type: string }>>;
};

/** SSH bağlantısı üzerinden SFTP ile rastgele erişim (eski workspace-server için yedek yol). */
export type SftpRangeReader = {
  createReadStream(path: string, options: { start: number; end: number }): Readable;
};

/**
 * Eski workspace-server sürümleri `offset` seçeneğini yok sayar ve yanıtta yankılamaz. Host
 * başına öğrenilen durum, her istekte boşuna bir akış açıp kapatmamak için saklanır; "eski"
 * kararı bir süre sonra yeniden denenir (sunucu bu arada güncellenmiş olabilir).
 */
export class RangeCapabilityCache {
  private readonly legacyUntil = new Map<string, number>();

  constructor(
    private readonly retryMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now
  ) {}

  isLegacy(hostKey: string): boolean {
    const until = this.legacyUntil.get(hostKey);
    if (until === undefined) return false;
    if (this.now() >= until) {
      this.legacyUntil.delete(hostKey);
      return false;
    }
    return true;
  }

  markLegacy(hostKey: string): void {
    this.legacyUntil.set(hostKey, this.now() + this.retryMs);
  }

  markRanged(hostKey: string): void {
    this.legacyUntil.delete(hostKey);
  }
}

export type RemoteMediaSourceDeps = {
  hostKey: string;
  /** files runtime'daki gerçek yol ve SFTP için aynı yolun dize hali. */
  path: HostAbsolutePath;
  nativePath: string;
  fs: () => Promise<RemoteFilesFs>;
  sftp?: () => Promise<SftpRangeReader | undefined>;
  capability: RangeCapabilityCache;
};

/**
 * SSH hostundaki dosya. Sıra: (1) files runtime `offset` okuması (yeni workspace-server),
 * (2) sunucu yankılamazsa SFTP ile aralık okuması, (3) o da olmazsa bayt 0'dan sıralı akış.
 * Hiçbir yolda dosya belleğe alınmaz ve boyut sınırı konmaz.
 */
export function remoteMediaSource(deps: RemoteMediaSourceDeps): MediaByteSource {
  const failure = (error: { type: string }) =>
    new MediaSourceError(
      error.type === 'not-found' ? 'not-found' : 'unavailable',
      error.type === 'not-found'
        ? 'Dosya bulunamadı.'
        : 'Uzak makinedeki dosya okunamadı. Bağlantıyı kontrol et.'
    );

  const size = async (signal?: AbortSignal) => {
    const fs = await deps.fs();
    const result = await fs.stat({ path: deps.path }, { signal });
    if (!result.success) throw failure(result.error);
    if (result.data.type !== 'file') {
      throw new MediaSourceError('not-found', 'Hedef bir dosya değil.');
    }
    return result.data.size;
  };

  return {
    size,
    async read(range, signal) {
      const fs = await deps.fs();
      let sequential:
        | { meta: ReadBytesMeta; chunks(): AsyncIterable<Uint8Array>; cancel(): void }
        | undefined;

      if (!deps.capability.isLegacy(deps.hostKey)) {
        const result = await fs.readBytes(
          {
            path: deps.path,
            options: { stream: true, offset: range.start, length: range.end - range.start + 1 },
          },
          { signal }
        );
        if (!result.success) throw failure(result.error);
        if (result.data.meta.offset === range.start) {
          deps.capability.markRanged(deps.hostKey);
          return {
            ranged: true,
            start: range.start,
            length: result.data.meta.size ?? range.end - range.start + 1,
            totalSize: result.data.meta.totalSize,
            body: result.data.chunks(),
            cancel: () => result.data.cancel(),
          };
        }
        // Yankı yok: eski sunucu `offset`'i atıp bayt 0'dan akıtıyor.
        deps.capability.markLegacy(deps.hostKey);
        sequential = result.data;
      }

      const sftp = deps.sftp ? await deps.sftp().catch(() => undefined) : undefined;
      if (sftp) {
        try {
          const stream = sftp.createReadStream(deps.nativePath, {
            start: range.start,
            end: range.end,
          });
          try {
            await once(stream, 'open');
          } catch (error) {
            stream.destroy();
            throw error;
          }
          sequential?.cancel();
          const totalSize = sequential?.meta.totalSize ?? (await size(signal));
          return {
            ranged: true,
            start: range.start,
            length: Math.max(0, Math.min(range.end, totalSize - 1) - range.start + 1),
            totalSize,
            body: stream,
            cancel: () => stream.destroy(),
          };
        } catch {
          // SFTP alt sistemi kapalı veya bağlantı yok: sıralı akışa düş.
        }
      }

      if (!sequential) {
        const result = await fs.readBytes(
          { path: deps.path, options: { stream: true } },
          { signal }
        );
        if (!result.success) throw failure(result.error);
        sequential = result.data;
      }
      const download = sequential;
      return {
        ranged: false,
        start: 0,
        length: download.meta.size ?? download.meta.totalSize,
        totalSize: download.meta.totalSize,
        body: download.chunks(),
        cancel: () => download.cancel(),
      };
    },
  };
}
