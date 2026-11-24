import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LiveSource, LiveSnapshot, LiveUpdate } from '@orkestra/wire/rpc';

/**
 * Mobil uzak erişim çerçeve bütçesi. Eski mobil istemcilerin (4 MiB) ve Cloudflare tünelinin
 * kararlılığı için tüm `loadHistory` ve canlı `session.state` / `activeTurn` yanıtları bu
 * sınırın altında tutulur; büyük inline `data:<mime>;base64,...` görselleri yerel medya
 * önbelleğine yazılıp dosya yoluna çevrilir ve mobil bunları `readMediaPreview` ile kayıpsız
 * parça parça çeker.
 */
export const REMOTE_HISTORY_MAX_BYTES = 2_400_000;
const INLINE_DATA_URI_EXTERNALIZE_THRESHOLD = 32 * 1024;
const MAX_REMOTE_TEXT_FIELD_CHARS = 80_000;
const EMERGENCY_TEXT_FIELD_CHARS = 16_000;

const DATA_URI_RE = /^data:([a-z0-9.+_-]+\/[a-z0-9.+_-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
};

export type RemotePayloadGuardOptions = {
  /** Inline base64 medyalarının dosya olarak yazılacağı önbellek dizini. */
  cacheDir?: string;
  /** `loadHistory` yanıtı için hedef bayt üst sınırı. */
  maxHistoryBytes?: number;
};

const SENSITIVE_REMOTE_LIVE_TOPICS = new Set([
  'conversations.acp.session.state',
  'conversations.acp.session.activeTurn',
]);

export function defaultRemoteMediaCacheDir(): string {
  return path.join(os.homedir(), '.local', 'state', 'orkestra', 'remote-media-cache');
}

function externalizeDataUri(uri: string, cacheDir: string): string {
  if (uri.length < INLINE_DATA_URI_EXTERNALIZE_THRESHOLD) return uri;
  const match = DATA_URI_RE.exec(uri);
  if (!match) return uri;
  const mime = match[1]!.toLowerCase();
  const base64Body = match[2]!.replace(/\s+/g, '');
  const ext = EXT_BY_MIME[mime] ?? '.bin';
  const digest = createHash('sha256').update(mime).update(':').update(base64Body).digest('hex');
  const filePath = path.join(cacheDir, `${digest.slice(0, 32)}${ext}`);
  try {
    if (!existsSync(filePath)) {
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      writeFileSync(filePath, Buffer.from(base64Body, 'base64'));
    }
    return filePath;
  } catch {
    // Diske yazılamazsa en azından çerçeveyi patlatmamak için boş URI yerine kısaltma yapılmaz,
    // ancak üst katmandaki boyut kırpıcısı yanıtı korur.
    return uri;
  }
}

function truncateLongString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const headChars = Math.floor(maxChars * 0.65);
  const tailChars = Math.max(0, maxChars - headChars - 80);
  const omitted = value.length - headChars - tailChars;
  return `${value.slice(0, headChars)}\n\n… [${omitted.toLocaleString('tr-TR')} karakter uzak aktarım için kısaltıldı] …\n\n${value.slice(value.length - tailChars)}`;
}

function sanitizeValue(
  value: unknown,
  cacheDir: string,
  maxTextChars: number,
  depth = 0
): unknown {
  if (depth > 24 || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.startsWith('data:') && value.length >= INLINE_DATA_URI_EXTERNALIZE_THRESHOLD) {
      return externalizeDataUri(value, cacheDir);
    }
    if (value.length > maxTextChars) {
      return truncateLongString(value, maxTextChars);
    }
    return value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = new Array<unknown>(value.length);
    for (let i = 0; i < value.length; i += 1) {
      const next = sanitizeValue(value[i], cacheDir, maxTextChars, depth + 1);
      out[i] = next;
      if (next !== value[i]) changed = true;
    }
    return changed ? out : value;
  }
  const record = value as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const next = sanitizeValue(entry, cacheDir, maxTextChars, depth + 1);
    out[key] = next;
    if (next !== entry) changed = true;
  }
  return changed ? out : value;
}

function utf8JsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fitHistoryPageToBudget(
  page: Record<string, unknown>,
  cacheDir: string,
  maxBytes: number
): Record<string, unknown> {
  let candidate = sanitizeValue(page, cacheDir, MAX_REMOTE_TEXT_FIELD_CHARS) as Record<
    string,
    unknown
  >;
  if (utf8JsonBytes(candidate) <= maxBytes) return candidate;

  const turns = Array.isArray(candidate['turns']) ? [...candidate['turns']] : null;
  if (turns && turns.length > 1) {
    // En eski turları sırayla çıkar; istemci kalan en eski turun seq'i ile daha eskileri
    // sayfalı (`loadOlder`) olarak çekmeye devam edebilir.
    while (turns.length > 1 && utf8JsonBytes({ ...candidate, turns }) > maxBytes) {
      turns.shift();
    }
    const oldest = turns[0];
    const nextCursor =
      isRecord(oldest) && typeof oldest['seq'] === 'number'
        ? oldest['seq']
        : candidate['nextCursor'];
    const coverage = isRecord(candidate['coverage'])
      ? { ...candidate['coverage'], fromSeq: nextCursor }
      : candidate['coverage'];
    candidate = {
      ...candidate,
      turns,
      nextCursor,
      ...(coverage !== undefined ? { coverage } : {}),
    };
  }

  if (utf8JsonBytes(candidate) > maxBytes) {
    candidate = sanitizeValue(candidate, cacheDir, EMERGENCY_TEXT_FIELD_CHARS) as Record<
      string,
      unknown
    >;
  }
  return candidate;
}

/**
 * `conversations.acp.loadHistory` sonucunu (`Result<HistoryPage, E>` veya düz `HistoryPage`)
 * mobil çerçeve sınırını asla aşmayacak şekilde hafifletir.
 */
export function sanitizeRemoteHistoryResult(
  result: unknown,
  options: RemotePayloadGuardOptions = {}
): unknown {
  if (!isRecord(result)) return result;
  const cacheDir = options.cacheDir ?? defaultRemoteMediaCacheDir();
  const maxBytes = options.maxHistoryBytes ?? REMOTE_HISTORY_MAX_BYTES;

  if (result['success'] === true && isRecord(result['data'])) {
    const fitted = fitHistoryPageToBudget(result['data'], cacheDir, maxBytes);
    return fitted === result['data'] ? result : { ...result, data: fitted };
  }
  if (Array.isArray(result['turns'])) {
    return fitHistoryPageToBudget(result, cacheDir, maxBytes);
  }
  return sanitizeValue(result, cacheDir, MAX_REMOTE_TEXT_FIELD_CHARS);
}

export function shouldSanitizeRemoteTopic(topic: string): boolean {
  const index = topic.indexOf('|');
  const refId = index === -1 ? topic : topic.slice(0, index);
  return SENSITIVE_REMOTE_LIVE_TOPICS.has(refId);
}

/**
 * Canlı `session.state` ve `session.activeTurn` yayınlarında büyük inline base64 görsellerini
 * diske alır; böylece ajan büyük görsel ürettiğinde veya okuduğunda canlı yayın asla
 * `SERIALIZATION / Response too large` ile kopmaz.
 */
export function wrapLiveSourceForRemote(
  topic: string,
  source: LiveSource,
  options: RemotePayloadGuardOptions = {}
): LiveSource {
  if (!shouldSanitizeRemoteTopic(topic)) return source;
  const cacheDir = options.cacheDir ?? defaultRemoteMediaCacheDir();
  const maxBytes = options.maxHistoryBytes ?? REMOTE_HISTORY_MAX_BYTES;

  const sanitizeLiveObject = (payload: unknown): unknown => {
    const first = sanitizeValue(payload, cacheDir, MAX_REMOTE_TEXT_FIELD_CHARS);
    if (utf8JsonBytes(first) <= maxBytes) return first;
    return sanitizeValue(first, cacheDir, EMERGENCY_TEXT_FIELD_CHARS);
  };

  return {
    async snapshot(): Promise<LiveSnapshot<unknown>> {
      const snap = await source.snapshot();
      const nextData = sanitizeLiveObject(snap.data);
      return nextData === snap.data ? snap : { ...snap, data: nextData };
    },
    subscribe(cb, subscribeOptions) {
      return source.subscribe((update: LiveUpdate) => {
        const nextDelta = sanitizeLiveObject(update.delta);
        cb(nextDelta === update.delta ? update : { ...update, delta: nextDelta });
      }, subscribeOptions);
    },
  };
}
