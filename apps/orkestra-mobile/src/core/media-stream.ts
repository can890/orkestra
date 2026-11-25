/**
 * Sohbet medyasını (video, ses, görsel, PDF) telefonda boyut sınırı olmadan oynatmak için JS
 * tarafı: Android'deki yerel HTTP vekiline (`SovraNative.mediaStream*`) akış kaydeder ve vekilin
 * istediği bayt aralıklarını şifreli Wire bağlantısı üzerinden masaüstünden
 * (`conversations.readMediaPreview`) getirip base64 olarak geri verir. JS hiçbir zaman dosyanın
 * tamamını tutmaz: bellekte aynı anda yalnızca birkaç blok (≤ 2 MiB) bulunur.
 */
import { WireError } from '@orkestra/wire/rpc';
import { describeCallError, type RemoteApi } from './wire-client';

/** Eski masaüstü sürümlerinin sınırları (dosya 80 MB, konum 40 MB, çağrı 1.6 MB). */
export const LEGACY_HOST_MAX_FILE_BYTES = 80 * 1024 * 1024;
export const LEGACY_HOST_MAX_OFFSET = 40 * 1024 * 1024;
const LEGACY_BLOCK_BYTES = 1024 * 1024;
/** Yeni sunucuda blok (çağrı) boyutu: base64 ile ~2.8 MB çerçeve; tünel/LAN için rahat. */
const STREAM_BLOCK_BYTES = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 90_000;

export const LEGACY_HOST_MESSAGE =
  'Bilgisayardaki Sovra sürümü büyük dosyaları telefona aktaramıyor (eski 80 MB sınırı). Masaüstü uygulamasını güncelleyince oynatılır.';

export type MediaHostInfo = {
  name: string;
  mimeType: string;
  size: number;
  /** Yeni sunucuların çağrı başı sınırı; yoksa eski sunucu. */
  maxChunkBytes?: number;
};

export type MediaProbeResult = {
  durationMs?: number;
  width?: number;
  height?: number;
  thumbnail?: string;
  pageCount?: number;
};

export type MediaSaveMode = 'download' | 'open' | 'share';

export type MediaSaveProgress = { written: number; total: number };

export type MediaSaveJob = {
  jobId: string;
  done: Promise<void>;
  cancel(): void;
};

export type NativeMediaApi = {
  mediaProxyAvailable?: () => boolean;
  mediaStreamOpen?: (json: string) => string;
  mediaRangeResult?: (reqId: string, base64: string, error: string) => void;
  mediaStreamProbe?: (streamId: string, kind: string) => boolean;
  mediaStreamSave?: (streamId: string, mode: string) => string;
  mediaStreamCancelSave?: (jobId: string) => void;
};

export type MediaBridgeEnv = {
  native(): NativeMediaApi | undefined;
  events(): EventTarget | undefined;
};

const browserEnv: MediaBridgeEnv = {
  native: () =>
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as { SovraNative?: NativeMediaApi }).SovraNative,
  events: () => (typeof window === 'undefined' ? undefined : window),
};

export function isLegacyMediaHost(info: Pick<MediaHostInfo, 'maxChunkBytes'>): boolean {
  return typeof info.maxChunkBytes !== 'number';
}

export function streamBlockBytes(info: Pick<MediaHostInfo, 'maxChunkBytes'>): number {
  if (typeof info.maxChunkBytes !== 'number') return LEGACY_BLOCK_BYTES;
  return Math.max(64 * 1024, Math.min(STREAM_BLOCK_BYTES, info.maxChunkBytes));
}

/** Kullanıcıya gösterilecek medya hatası; eski masaüstü sınırlarını açıkça söyler. */
export function describeMediaError(cause: unknown, context: { offset?: number } = {}): string {
  const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  if (/\b80 MB\b/.test(message)) return LEGACY_HOST_MESSAGE;
  if (cause instanceof WireError) {
    if (
      cause.code === 'CONTRACT_MISMATCH' &&
      typeof context.offset === 'number' &&
      context.offset > LEGACY_HOST_MAX_OFFSET
    ) {
      return LEGACY_HOST_MESSAGE;
    }
    if (cause.code === 'HANDLER_ERROR') {
      if (/ENOENT|no such file/i.test(message)) return 'Dosya bilgisayarda bulunamadı.';
      if (/EACCES|EPERM/i.test(message)) return 'Bilgisayarda bu dosyayı okuma izni yok.';
      // Sunucunun kendi Türkçe mesajları (ör. hassas yol, dosya değil) olduğu gibi gösterilir.
      if (message && /[çğıöşüÇĞİÖŞÜ]/.test(message)) return message;
    }
    return describeCallError(cause);
  }
  if (cause instanceof MediaStreamError) return cause.message;
  return describeCallError(cause);
}

export class MediaStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaStreamError';
  }
}

type StreamEntry = {
  api: RemoteApi;
  conversationId: string;
  uri: string;
  size: number;
  lastError: string | null;
  listeners: Set<(message: string) => void>;
};

type RangeRequest = { reqId: string; streamId: string; offset: number; length: number };

function asRangeRequest(detail: unknown): RangeRequest | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const d = detail as Record<string, unknown>;
  if (
    typeof d['reqId'] !== 'string' ||
    typeof d['streamId'] !== 'string' ||
    typeof d['offset'] !== 'number' ||
    typeof d['length'] !== 'number'
  ) {
    return null;
  }
  return {
    reqId: d['reqId'],
    streamId: d['streamId'],
    offset: d['offset'],
    length: d['length'],
  };
}

/** Akış kayıt defteri ve yerel ↔ JS köprüsü. */
export class MediaStreamRegistry {
  private readonly entries = new Map<string, StreamEntry>();
  private readonly probes = new Map<string, Promise<MediaProbeResult | null>>();
  private installedOn: EventTarget | null = null;

  constructor(private readonly env: MediaBridgeEnv = browserEnv) {}

  available(): boolean {
    const native = this.env.native();
    return Boolean(
      native?.mediaStreamOpen && native.mediaRangeResult && native.mediaProxyAvailable?.() !== false
    );
  }

  private install(): void {
    const target = this.env.events();
    if (!target || this.installedOn === target) return;
    this.installedOn = target;
    target.addEventListener('sovra:media-range', (event) => {
      const request = asRangeRequest((event as CustomEvent).detail);
      if (request) void this.handleRange(request);
    });
  }

  /** Akışı kaydeder ve vekil adresini döndürür; yerel vekil yoksa `null`. */
  open(
    api: RemoteApi,
    conversationId: string,
    uri: string,
    info: MediaHostInfo
  ): { streamId: string; url: string } | null {
    const native = this.env.native();
    if (!native?.mediaStreamOpen || !this.available()) return null;
    this.install();
    const raw = native.mediaStreamOpen(
      JSON.stringify({
        key: `${conversationId}|${uri}`,
        name: info.name,
        mimeType: info.mimeType,
        size: info.size,
        blockBytes: streamBlockBytes(info),
      })
    );
    if (!raw) return null;
    let parsed: { streamId?: unknown; url?: unknown };
    try {
      parsed = JSON.parse(raw) as { streamId?: unknown; url?: unknown };
    } catch {
      return null;
    }
    if (typeof parsed.streamId !== 'string' || typeof parsed.url !== 'string') return null;
    const existing = this.entries.get(parsed.streamId);
    this.entries.set(parsed.streamId, {
      api,
      conversationId,
      uri,
      size: info.size,
      lastError: null,
      listeners: existing?.listeners ?? new Set(),
    });
    return { streamId: parsed.streamId, url: parsed.url };
  }

  /** Akıştaki aralık hatalarını dinler (ör. oynatma sırasında eski masaüstü sınırı). */
  onError(streamId: string, listener: (message: string) => void): () => void {
    const entry = this.entries.get(streamId);
    if (!entry) return () => {};
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  lastError(streamId: string): string | null {
    return this.entries.get(streamId)?.lastError ?? null;
  }

  async handleRange(request: RangeRequest): Promise<void> {
    const native = this.env.native();
    if (!native?.mediaRangeResult) return;
    const entry = this.entries.get(request.streamId);
    if (!entry) {
      native.mediaRangeResult(request.reqId, '', 'Medya akışı bulunamadı.');
      return;
    }
    try {
      const res = (await entry.api.call('conversations.readMediaPreview', {
        conversationId: entry.conversationId,
        uri: entry.uri,
        offset: request.offset,
        maxBytes: Math.max(1024, request.length),
      })) as { base64?: unknown; size?: unknown } | null;
      if (!res || typeof res.base64 !== 'string') {
        throw new MediaStreamError('Medya verisi alınamadı.');
      }
      if (typeof res.size === 'number' && res.size !== entry.size) {
        throw new MediaStreamError('Dosya bilgisayarda değişmiş; sohbeti yenileyin.');
      }
      native.mediaRangeResult(request.reqId, res.base64, '');
    } catch (cause) {
      const message = describeMediaError(cause, { offset: request.offset });
      entry.lastError = message;
      for (const listener of entry.listeners) listener(message);
      native.mediaRangeResult(request.reqId, '', message);
    }
  }

  /** Poster karesi / süre / en-boy (video, ses) ya da PDF 1. sayfa; desteklenmezse `null`. */
  probe(streamId: string, kind: 'video' | 'audio' | 'pdf'): Promise<MediaProbeResult | null> {
    const key = `${streamId}|${kind}`;
    const cached = this.probes.get(key);
    if (cached) return cached;
    const native = this.env.native();
    const target = this.env.events();
    if (!native?.mediaStreamProbe || !target) return Promise.resolve(null);
    const task = new Promise<MediaProbeResult | null>((resolve) => {
      const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
      const listener = (event: Event) => {
        const detail = (event as CustomEvent).detail as Record<string, unknown> | null;
        if (!detail || detail['streamId'] !== streamId || detail['kind'] !== kind) return;
        if (detail['ok'] !== true) {
          finish(null);
          return;
        }
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
        finish({
          durationMs: num(detail['durationMs']),
          width: num(detail['width']),
          height: num(detail['height']),
          pageCount: num(detail['pageCount']),
          thumbnail: typeof detail['thumbnail'] === 'string' ? detail['thumbnail'] : undefined,
        });
      };
      const finish = (value: MediaProbeResult | null) => {
        clearTimeout(timer);
        target.removeEventListener('sovra:media-probe', listener);
        resolve(value);
      };
      target.addEventListener('sovra:media-probe', listener);
      if (!native.mediaStreamProbe?.(streamId, kind)) finish(null);
    });
    this.probes.set(key, task);
    void task.then((value) => {
      if (!value) this.probes.delete(key);
    });
    return task;
  }

  /** Dosyanın tamamını yerel tarafta akıtarak indirir/açar/paylaşır. */
  save(
    streamId: string,
    mode: MediaSaveMode,
    onProgress?: (progress: MediaSaveProgress) => void
  ): MediaSaveJob | null {
    const native = this.env.native();
    const target = this.env.events();
    if (!native?.mediaStreamSave || !target) return null;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // Yerel olaylar `evaluateJavascript` ile sonraki görevde gelir; kimlik o ana kadar atanmış olur.
    let jobId = '';
    const handle = (detail: Record<string, unknown>) => {
      const state = detail['state'];
      if (state === 'progress') {
        const written = typeof detail['written'] === 'number' ? detail['written'] : 0;
        const total = typeof detail['total'] === 'number' ? detail['total'] : 0;
        onProgress?.({ written, total });
        return;
      }
      target.removeEventListener('sovra:media-save', listener);
      if (state === 'done') resolveDone();
      else {
        const message = typeof detail['error'] === 'string' ? detail['error'] : '';
        rejectDone(
          new MediaStreamError(
            this.lastError(streamId) ?? (message || 'Dosya telefona aktarılamadı.')
          )
        );
      }
    };
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail as Record<string, unknown> | null;
      if (detail && jobId && detail['jobId'] === jobId) handle(detail);
    };
    target.addEventListener('sovra:media-save', listener);
    jobId = native.mediaStreamSave(streamId, mode) || '';
    if (!jobId) {
      target.removeEventListener('sovra:media-save', listener);
      return null;
    }
    return {
      jobId,
      done,
      cancel: () => native.mediaStreamCancelSave?.(jobId),
    };
  }
}

export const mediaStreams = new MediaStreamRegistry();
