import { open, rename, rm, stat } from 'node:fs/promises';

export type DownloadProgress = {
  bytesPerSecond: number;
  percent: number;
  transferred: number;
  total: number;
};

export type DownloadOptions = {
  url: string;
  /** Tamamlanan dosyanın yolu; indirme sürerken `<yol>.part` kullanılır. */
  destination: string;
  /** GitHub sürüm bilgisindeki boyut; biliniyorsa yarım indirmeler kesin olarak saptanır. */
  expectedSize?: number;
  userAgent: string;
  fetch(url: string, init: RequestInit): Promise<Response>;
  onProgress?(progress: DownloadProgress): void;
  /** Bu süre boyunca hiç veri gelmezse bağlantı kopmuş sayılır. */
  idleTimeoutMs?: number;
  /** İlerleme bildirimleri arasındaki en kısa süre. */
  progressIntervalMs?: number;
  now?(): number;
};

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 250;

class RangeNotSatisfiableError extends Error {}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/**
 * Dosyayı akış hâlinde indirir. Yarım kalan bir `.part` dosyası varsa `Range` isteğiyle
 * kaldığı yerden sürdürür; sunucu aralığı desteklemezse baştan indirir. Dosya ancak beklenen
 * boyuta ulaşınca asıl adına taşınır, bu yüzden yarım bir indirme hiçbir zaman tamamlanmış
 * sayılmaz. Bütünlük denetimi (SHA-256) çağıranın sorumluluğundadır.
 */
export async function downloadFile(options: DownloadOptions): Promise<void> {
  const partPath = `${options.destination}.part`;
  const existing = await fileSize(options.destination);
  if (
    existing !== null &&
    (options.expectedSize === undefined || existing === options.expectedSize)
  ) {
    return;
  }
  if (existing !== null) await rm(options.destination, { force: true });

  let offset = (await fileSize(partPath)) ?? 0;
  if (options.expectedSize !== undefined && offset > options.expectedSize) {
    await rm(partPath, { force: true });
    offset = 0;
  }
  if (options.expectedSize !== undefined && offset > 0 && offset === options.expectedSize) {
    await rename(partPath, options.destination);
    return;
  }

  try {
    await downloadFrom(options, partPath, offset);
  } catch (error) {
    if (!(error instanceof RangeNotSatisfiableError)) throw error;
    await rm(partPath, { force: true });
    await downloadFrom(options, partPath, 0);
  }
  await rename(partPath, options.destination);
}

async function downloadFrom(
  options: DownloadOptions,
  partPath: string,
  requestedOffset: number
): Promise<void> {
  const now = options.now ?? Date.now;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error('zaman aşımı')), idleTimeoutMs);
  };

  const headers: Record<string, string> = {
    Accept: 'application/octet-stream',
    'User-Agent': options.userAgent,
  };
  if (requestedOffset > 0) headers.Range = `bytes=${requestedOffset}-`;

  armIdleTimer();
  let response: Response;
  try {
    response = await options.fetch(options.url, { headers, signal: controller.signal });
  } catch (error) {
    clearTimeout(idleTimer);
    throw new Error(`Güncelleme indirilemedi; bağlantı kurulamadı (${reason(error)}).`);
  }

  if (response.status === 416 && requestedOffset > 0) {
    clearTimeout(idleTimer);
    throw new RangeNotSatisfiableError('range');
  }
  if (!response.ok || !response.body) {
    clearTimeout(idleTimer);
    throw new Error(`Güncelleme indirilemedi (HTTP ${response.status}).`);
  }

  let offset = 0;
  if (response.status === 206 && requestedOffset > 0) {
    const range = response.headers.get('content-range') ?? '';
    if (!range.startsWith(`bytes ${requestedOffset}-`)) {
      clearTimeout(idleTimer);
      await response.body.cancel().catch(() => undefined);
      throw new RangeNotSatisfiableError('range');
    }
    offset = requestedOffset;
  }

  const contentLength = Number(response.headers.get('content-length'));
  const total =
    options.expectedSize ??
    (Number.isFinite(contentLength) && contentLength > 0 ? offset + contentLength : 0);

  const handle = await open(partPath, offset > 0 ? 'a' : 'w');
  const reader = response.body.getReader();
  const startedAt = now();
  const intervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  let transferred = offset;
  let lastReport = 0;
  const report = (force: boolean) => {
    const at = now();
    if (!force && at - lastReport < intervalMs) return;
    lastReport = at;
    const seconds = Math.max((at - startedAt) / 1000, 0.001);
    options.onProgress?.({
      transferred,
      total,
      percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0,
      bytesPerSecond: Math.round((transferred - offset) / seconds),
    });
  };

  try {
    report(true);
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw new Error(
          `Güncelleme indirilirken bağlantı koptu (${reason(error)}). Yeniden denediğinizde kaldığı yerden sürer.`
        );
      }
      if (chunk.done) break;
      armIdleTimer();
      await handle.write(chunk.value);
      transferred += chunk.value.byteLength;
      report(false);
    }
  } finally {
    clearTimeout(idleTimer);
    await handle.close();
  }
  report(true);

  if (total > 0 && transferred !== total) {
    throw new Error(
      `Güncelleme indirmesi yarım kaldı (${transferred} / ${total} bayt). Yeniden denediğinizde kaldığı yerden sürer.`
    );
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
