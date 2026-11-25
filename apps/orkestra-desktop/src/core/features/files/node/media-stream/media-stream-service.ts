import { createWriteStream } from 'node:fs';
import { realpath, rename, stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { formatHostRef, isLocalHostRef, type HostRef } from '@orkestra/core/primitives/host/api';
import {
  absoluteBasename,
  formatAbsolute,
  type HostAbsolutePath,
  type HostFileRef,
} from '@orkestra/core/primitives/path/api';
import { err, ok, type Result } from '@orkestra/shared';
import { log } from '@orkestra/shared/logger';
import {
  MEDIA_STREAM_HOST,
  MEDIA_STREAM_SCHEME,
  mediaStreamUrl,
  type MediaStreamError,
  type MediaStreamHandle,
} from '../../api/media-stream';
import { checkMediaPath } from './path-policy';
import { contentRangeHeader, parseRangeHeader, type ByteRange } from './range';
import {
  localMediaSource,
  MediaSourceError,
  RangeCapabilityCache,
  remoteMediaSource,
  type MediaByteSource,
  type MediaRead,
  type RemoteFilesFs,
  type SftpRangeReader,
} from './sources';
import { MediaTokenRegistry } from './token-registry';

/** Belirtecin işaret ettiği, doğrulanmış (gerçek yolu çözülmüş) dosya. */
export type MediaTarget = {
  host: HostRef;
  hostPath: HostAbsolutePath;
  nativePath: string;
  name: string;
  mimeType: string;
};

export type MediaStreamServiceDeps = {
  /** Uzak hostun files runtime yüzeyi; host ulaşılamazsa reddeder. */
  remoteFs: (host: HostRef) => Promise<RemoteFilesFs & RemoteRealPath>;
  /** Eski workspace-server için SFTP yedeği; yoksa sıralı akışa düşülür. */
  sftp?: (connectionId: string) => Promise<SftpRangeReader | undefined>;
  /** "Kaydet" için hedef yol seçici (ana süreçte kaydetme penceresi). */
  pickSavePath?: (suggestedName: string) => Promise<string | undefined>;
  registry?: MediaTokenRegistry<MediaTarget>;
  capability?: RangeCapabilityCache;
};

type RemoteRealPath = {
  realPath(
    input: { path: HostAbsolutePath },
    options?: { signal?: AbortSignal }
  ): Promise<Result<{ path: HostAbsolutePath }, { type: string }>>;
};

/** Belge, çerçeve ve betik olarak yüklenmeyi reddet: adres yalnızca medya öğesi kaynağıdır. */
const FORBIDDEN_FETCH_DESTS = new Set([
  'document',
  'iframe',
  'frame',
  'embed',
  'object',
  'script',
  'style',
  'worker',
  'sharedworker',
  'serviceworker',
  'manifest',
  'xslt',
  'paintworklet',
  'audioworklet',
]);

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/**
 * Sohbet çıktısı medyasını `orkestra-media://` üzerinden akıtır. Yerel dosyalar doğrudan `fs`
 * ile, SSH hostlarındakiler files runtime (`offset` destekli) veya eski sunucularda SFTP ile
 * okunur. Bayt aralıkları istek başına taze okunur; hiçbir dosya belleğe alınmaz.
 */
export class MediaStreamService {
  private readonly registry: MediaTokenRegistry<MediaTarget>;
  private readonly capability: RangeCapabilityCache;

  constructor(private readonly deps: MediaStreamServiceDeps) {
    this.registry = deps.registry ?? new MediaTokenRegistry<MediaTarget>();
    this.capability = deps.capability ?? new RangeCapabilityCache();
  }

  async open(
    ref: HostFileRef,
    signal?: AbortSignal
  ): Promise<Result<MediaStreamHandle, MediaStreamError>> {
    const target = await this.resolveTarget(ref, signal);
    if (!target.success) return target;
    let size: number;
    try {
      size = await this.sourceFor(target.data).size(signal);
    } catch (error) {
      return err(toMediaError(error));
    }
    const token = this.registry.mint(target.data);
    return ok({
      url: mediaStreamUrl(token),
      token,
      name: target.data.name,
      mimeType: target.data.mimeType,
      size,
    });
  }

  release(token: string): void {
    this.registry.release(token);
  }

  /** `protocol.handle` gövdesi; Electron'dan bağımsız olduğu için doğrudan test edilir. */
  async handle(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return emptyResponse(405, { Allow: 'GET, HEAD' });
    }
    const dest = request.headers.get('sec-fetch-dest');
    if (dest && FORBIDDEN_FETCH_DESTS.has(dest.toLowerCase())) return emptyResponse(403);

    const token = tokenFromUrl(request.url);
    const target = token ? this.registry.resolve(token) : undefined;
    if (!target) return emptyResponse(404);

    const source = this.sourceFor(target);
    let size: number;
    try {
      size = await source.size(request.signal);
    } catch (error) {
      log.warn('media-stream: could not stat media file', { name: target.name, error });
      return errorResponse(error);
    }
    const requested = parseRangeHeader(request.headers.get('range'), size);
    if (requested.kind === 'unsatisfiable') {
      return emptyResponse(416, { 'Content-Range': `bytes */${size}` });
    }

    const headers: Record<string, string> = { ...BASE_HEADERS, 'Content-Type': target.mimeType };
    if (request.method === 'HEAD') {
      if (isLocalHostRef(target.host)) headers['Accept-Ranges'] = 'bytes';
      headers['Content-Length'] = String(size);
      return new Response(null, { status: 200, headers });
    }
    if (size === 0) {
      headers['Content-Length'] = '0';
      return new Response(null, { status: 200, headers });
    }

    const range: ByteRange =
      requested.kind === 'range' ? requested.range : { start: 0, end: size - 1 };
    let read: MediaRead;
    try {
      read = await source.read(range, request.signal);
    } catch (error) {
      log.warn('media-stream: could not open media file for reading', {
        name: target.name,
        range,
        error,
      });
      return errorResponse(error);
    }

    headers['Content-Length'] = String(read.length);
    let status = 200;
    if (read.ranged) {
      headers['Accept-Ranges'] = 'bytes';
      if (requested.kind === 'range') {
        status = 206;
        headers['Content-Range'] = contentRangeHeader(
          { start: read.start, end: read.start + read.length - 1 },
          read.totalSize
        );
      }
    }
    return new Response(toWebStream(read, request.signal), { status, headers });
  }

  /**
   * Dosyanın tamamını kullanıcının seçtiği yere akıtarak kopyalar (bellek kopyası yok). Seçim
   * iptal edilirse `path` boş döner.
   */
  async saveCopy(
    ref: HostFileRef,
    signal?: AbortSignal
  ): Promise<Result<{ path?: string }, MediaStreamError>> {
    const target = await this.resolveTarget(ref, signal);
    if (!target.success) return target;
    if (!this.deps.pickSavePath) {
      return err({ type: 'unsupported', message: 'Kaydetme bu ortamda kullanılamıyor.' });
    }
    const destination = await this.deps.pickSavePath(target.data.name);
    if (!destination) return ok({});
    const source = this.sourceFor(target.data);
    const partial = `${destination}.orkestra-part`;
    try {
      const size = await source.size(signal);
      if (size === 0) {
        await pipeline(Readable.from([]), createWriteStream(partial));
      } else {
        const read = await source.read({ start: 0, end: size - 1 }, signal);
        if (read.start !== 0 || read.length < size) {
          read.cancel();
          return err({
            type: 'incomplete',
            message:
              'Uzak makinedeki Orkestra sürümü bu dosyayı tam aktaramıyor. Dosyayı aç ile indir.',
          });
        }
        await pipeline(Readable.from(read.body), createWriteStream(partial), { signal });
      }
      await rename(partial, destination);
      return ok({ path: destination });
    } catch (error) {
      await unlink(partial).catch(() => undefined);
      return err(toMediaError(error));
    }
  }

  dispose(): void {
    this.registry.clear();
  }

  private sourceFor(target: MediaTarget): MediaByteSource {
    if (isLocalHostRef(target.host)) return localMediaSource(target.nativePath);
    const connectionId = target.host.id;
    return remoteMediaSource({
      hostKey: formatHostRef(target.host),
      path: target.hostPath,
      nativePath: target.nativePath,
      fs: () => this.deps.remoteFs(target.host),
      sftp: this.deps.sftp ? () => this.deps.sftp!(connectionId) : undefined,
      capability: this.capability,
    });
  }

  private async resolveTarget(
    ref: HostFileRef,
    signal?: AbortSignal
  ): Promise<Result<MediaTarget, MediaStreamError>> {
    const requestedPath = formatAbsolute(ref.path);
    const requested = checkMediaPath(requestedPath);
    if (!requested.ok) return err({ type: requested.type, message: requested.message });
    const name = absoluteBasename(ref.path) || requestedPath;

    if (isLocalHostRef(ref.host)) {
      let real: string;
      try {
        real = await realpath(requestedPath);
        if (!(await stat(real)).isFile()) {
          return err({ type: 'not-found', message: 'Hedef bir dosya değil.' });
        }
      } catch {
        return err({ type: 'not-found', message: 'Dosya bulunamadı.' });
      }
      const resolved = checkMediaPath(real);
      if (!resolved.ok) return err({ type: resolved.type, message: resolved.message });
      return ok({
        host: ref.host,
        hostPath: ref.path,
        nativePath: real,
        name,
        mimeType: resolved.mimeType,
      });
    }

    let fs: RemoteFilesFs & RemoteRealPath;
    try {
      fs = await this.deps.remoteFs(ref.host);
    } catch {
      return err({ type: 'unavailable', message: 'Uzak makineye bağlanılamadı.' });
    }
    const real = await fs.realPath({ path: ref.path }, { signal });
    if (!real.success) {
      return err(
        real.error.type === 'not-found'
          ? { type: 'not-found', message: 'Dosya bulunamadı.' }
          : { type: 'unavailable', message: 'Uzak makinedeki dosya okunamadı.' }
      );
    }
    const nativePath = formatAbsolute(real.data.path);
    const resolved = checkMediaPath(nativePath);
    if (!resolved.ok) return err({ type: resolved.type, message: resolved.message });
    return ok({
      host: ref.host,
      hostPath: real.data.path,
      nativePath,
      name,
      mimeType: resolved.mimeType,
    });
  }
}

function tokenFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${MEDIA_STREAM_SCHEME}:` || parsed.hostname !== MEDIA_STREAM_HOST) {
    return undefined;
  }
  if (parsed.search || parsed.username || parsed.password) return undefined;
  const match = /^\/([A-Za-z0-9_-]+)$/.exec(parsed.pathname);
  return match?.[1];
}

function emptyResponse(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...BASE_HEADERS, ...extra } });
}

function toMediaError(error: unknown): MediaStreamError {
  if (error instanceof MediaSourceError) return { type: error.type, message: error.message };
  return { type: 'unavailable', message: 'Dosya okunamadı.' };
}

function errorResponse(error: unknown): Response {
  const mapped = toMediaError(error);
  return emptyResponse(mapped.type === 'not-found' ? 404 : 503);
}

/**
 * Çekme tabanlı akış: tarayıcı veri istedikçe bir parça okunur. İptal (arama/seek, öğenin
 * kaldırılması) kaynak akışı hemen kapatır.
 */
function toWebStream(read: MediaRead, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const iterator = read.body[Symbol.asyncIterator]();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener('abort', finish);
    read.cancel();
    void iterator.return?.()?.catch(() => undefined);
  };
  signal?.addEventListener('abort', finish, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          finished = true;
          signal?.removeEventListener('abort', finish);
          controller.close();
          return;
        }
        controller.enqueue(
          next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value as ArrayBuffer)
        );
      } catch (error) {
        if (!signal?.aborted) log.warn('media-stream: stream failed while serving', { error });
        finish();
        controller.error(error);
      }
    },
    cancel() {
      finish();
    },
  });
}
