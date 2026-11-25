/**
 * Sohbet çıktılarından medya/dosya (görsel, video, ses, PDF, dosya) çıkarımı ve masaüstünden
 * şifreli Wire üzerinden parçalı önizleme yükleyici. Android'de büyük medya `media-stream.ts`
 * ile yerel vekil üzerinden akıtılır; buradaki tam yükleyici yalnızca küçük metinler ve yerel
 * vekilin olmadığı ortamlar (tarayıcı/test) içindir.
 */
import type { RemoteApi } from './wire-client';

export type MediaArtifact = {
  uri: string;
  name: string;
  mimeType?: string;
};

export type ArtifactKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'file';

export function artifactKind(artifact: MediaArtifact): ArtifactKind {
  const mime = (artifact.mimeType ?? /^data:([^;,]+)/.exec(artifact.uri)?.[1] ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return 'text';
  }
  const clean = (artifact.uri.split(/[?#]/)[0] ?? '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|svg|bmp|heic)$/.test(clean)) return 'image';
  if (/\.(mp4|webm|mov|m4v|ogv|mkv)$/.test(clean)) return 'video';
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/.test(clean)) return 'audio';
  if (/\.pdf$/.test(clean)) return 'pdf';
  if (
    /\.(md|txt|json|csv|html?|xml|ya?ml|toml|ini|log|tsx?|jsx?|mjs|cjs|py|sh|zsh|sql|css|scss|java|kt|swift|go|rs|c|cpp|h|rb|php)$/.test(
      clean
    )
  ) {
    return 'text';
  }
  return 'file';
}

export function safeDirectArtifactUrl(uri: string): string | null {
  if (/^https?:\/\//i.test(uri) || /^blob:/i.test(uri)) return uri;
  if (
    /^data:(?:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf);base64,/i.test(
      uri
    )
  ) {
    return uri;
  }
  return null;
}

/** `file:` adresini düz yola çevirir (`file:///a/b%20c.mp4` → `/a/b c.mp4`); değilse `null`. */
export function filePathFromUri(uri: string): string | null {
  if (!/^file:/i.test(uri)) return null;
  const rest = uri.slice('file:'.length).split(/[?#]/)[0] ?? '';
  // `file:///yol`, `file://localhost/yol` ve `file:/yol` biçimleri.
  const path = rest.startsWith('//') ? rest.replace(/^\/\/(?:localhost)?/i, '') : rest;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Aynı dosya düz yol ya da `file:` adresiyle yazılmış olsa da tek anahtar. */
export function artifactKey(uri: string): string {
  return filePathFromUri(uri) ?? uri;
}

/**
 * Kartta gösterilecek ad. Etiket yoksa ya da bir adresin kendisiyse (ör. `file:///…`,
 * `[file:// bağlantısı](file:///…)`) dosyanın kendi adı kullanılır.
 */
export function artifactDisplayName(uri: string, label?: string): string {
  const trimmed = label?.trim() ?? '';
  const looksLikeAddress =
    /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(trimmed) || /^file:/i.test(trimmed) || trimmed === uri;
  if (trimmed && !looksLikeAddress) return trimmed;
  const path = artifactKey(uri);
  return path.split(/[\\/]/).pop()?.split(/[?#]/)[0] || trimmed || 'Dosya';
}

/** Markdown görselleri, açık dosya bağlantıları ve mutlak medya yollarını çıkarır. */
export function extractArtifactsFromText(text: string): MediaArtifact[] {
  const outputs: MediaArtifact[] = [];
  const seen = new Set<string>();
  const add = (rawUri: string, name?: string, isImage = false, explicitFile = false) => {
    const uri = rawUri.trim();
    if (!uri) return;
    if (/^(?:javascript|data:text|data:application\/html):/i.test(uri)) return;
    const item: MediaArtifact = { uri, name: artifactDisplayName(uri, name) };
    const kind = artifactKind(item);
    const key = artifactKey(uri);
    if (seen.has(key)) return;
    if (!isImage && !explicitFile && kind === 'file') return;
    // Sıradan web linklerini dosya kartına çevirme (görsel/video/ses/pdf değilse).
    if (/^https?:\/\//i.test(uri) && !isImage && kind === 'file') return;
    if (/^https?:\/\//i.test(uri) && !isImage && kind === 'text') return;
    seen.add(key);
    outputs.push(item);
  };

  for (const match of text.matchAll(
    /(!?)\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g
  )) {
    const uri = match[3] ?? match[4] ?? '';
    const isFileUrl = /^file:\/\//i.test(uri);
    const explicitFile =
      isFileUrl ||
      (!/^[A-Za-z][A-Za-z\d+.-]*:/.test(uri) &&
        /\.[A-Za-z\d]{1,10}$/.test(uri.split(/[?#]/)[0] ?? '') &&
        !uri.startsWith('//'));
    add(uri, match[2], match[1] === '!', explicitFile);
  }

  for (const match of text.matchAll(
    /`([^`\n]+\.(?:png|jpe?g|gif|webp|avif|svg|bmp|heic|mp4|webm|mov|m4v|ogv|mkv|mp3|wav|ogg|m4a|aac|flac|pdf|docx?|xlsx?|pptx?|rtf|zip|tar|gz|tgz|7z|rar|epub|apk|csv|txt|md|json|html?|xml|ya?ml|log))`/gi
  )) {
    add(match[1] ?? '', undefined, false, true);
  }

  for (const match of text.matchAll(
    /(?:^|[\s"'])((?:\/|~\/|[A-Za-z]:[\\/])[^\s"'<>`]*\.(?:png|jpe?g|gif|webp|avif|svg|bmp|heic|mp4|webm|mov|m4v|ogv|mkv|mp3|wav|ogg|m4a|aac|flac|pdf|docx?|xlsx?|pptx?|rtf|zip|tar|gz|tgz|7z|rar|epub|apk|csv|txt|md|json|html?|xml|ya?ml|log))(?=$|[\s"'.,;:)])/gim
  )) {
    add(match[1] ?? '', undefined, false, true);
  }

  return outputs;
}

/** Aynı dosyayı (düz yol ya da `file:` adresi) bir kez gösterir; ilk geleni (adı) korunur. */
export function uniqueArtifacts(artifacts: readonly MediaArtifact[]): MediaArtifact[] {
  const seen = new Set<string>();
  const out: MediaArtifact[] = [];
  for (const item of artifacts) {
    const key = artifactKey(item.uri);
    if (!item.uri || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export type LoadedMedia = {
  url: string;
  mimeType: string;
  name: string;
  size: number;
  blob?: Blob;
  textContent?: string;
};

export type PeekedMedia = {
  name: string;
  mimeType: string;
  size: number;
  snippet?: string;
  /** Sunucunun çağrı başı sınırı; yoksa eski masaüstü sürümü (80 MB dosya sınırı). */
  maxChunkBytes?: number;
};

const mediaCache = new Map<string, Promise<LoadedMedia>>();
const peekCache = new Map<string, Promise<PeekedMedia>>();
/** Eski masaüstü sürümleriyle de uyumlu çağrı boyutu (eski üst sınır 1.6 MB). */
const CHUNK_BYTES = 1_400_000;
const PEEK_BYTES = 4_096;

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '';
  const totalSec = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  const ss = `${sec < 10 ? '0' : ''}${sec}`;
  if (hours > 0) return `${hours}:${min < 10 ? '0' : ''}${min}:${ss}`;
  return `${min}:${ss}`;
}

function isTextualMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript'
  );
}

/**
 * Dosyanın yalnızca ilk 4 KB'ını çekerek gerçek boyutunu, MIME türünü ve metin/kod
 * dosyalarında Telegram/WhatsApp tarzı canlı ilk birkaç satırlık önizlemeyi anında getirir.
 */
export function peekMediaMetadata(
  api: RemoteApi,
  conversationId: string,
  artifact: MediaArtifact
): Promise<PeekedMedia> {
  const direct = safeDirectArtifactUrl(artifact.uri);
  if (direct) {
    return Promise.resolve({
      name: artifact.name,
      mimeType: artifact.mimeType ?? 'application/octet-stream',
      size: 0,
    });
  }
  const key = `${conversationId}|${artifact.uri}`;
  const cached = peekCache.get(key);
  if (cached) return cached;

  const task = (async (): Promise<PeekedMedia> => {
    const res = (await api.call('conversations.readMediaPreview', {
      conversationId,
      uri: artifact.uri,
      offset: 0,
      maxBytes: PEEK_BYTES,
    })) as {
      name?: string;
      mimeType?: string;
      size?: number;
      base64?: string;
      maxChunkBytes?: number;
    };
    if (!res) throw new Error('Dosya bilgisi alınamadı.');
    const mimeType = res.mimeType ?? artifact.mimeType ?? 'application/octet-stream';
    const name = res.name ?? artifact.name;
    const size = typeof res.size === 'number' ? res.size : 0;
    let snippet: string | undefined;
    if (
      res.base64 &&
      (isTextualMime(mimeType) || artifactKind({ uri: name, name, mimeType }) === 'text')
    ) {
      try {
        const raw = new TextDecoder('utf-8', { fatal: false }).decode(
          base64ToUint8Array(res.base64)
        );
        const lines = raw
          .replace(/\r\n/g, '\n')
          .split('\n')
          .map((l) => l.trimEnd())
          .filter((l, idx) => l.trim().length > 0 || idx > 0)
          .slice(0, 6);
        const joined = lines.join('\n').trim();
        if (joined) snippet = joined.slice(0, 420);
      } catch {
        snippet = undefined;
      }
    }
    const maxChunkBytes = typeof res.maxChunkBytes === 'number' ? res.maxChunkBytes : undefined;
    return { name, mimeType, size, snippet, ...(maxChunkBytes ? { maxChunkBytes } : {}) };
  })();

  peekCache.set(key, task);
  task.catch(() => {
    peekCache.delete(key);
  });
  return task;
}

export function loadMediaPreview(
  api: RemoteApi,
  conversationId: string,
  artifact: MediaArtifact
): Promise<LoadedMedia> {
  const direct = safeDirectArtifactUrl(artifact.uri);
  if (direct) {
    return Promise.resolve({
      url: direct,
      mimeType: artifact.mimeType ?? 'application/octet-stream',
      name: artifact.name,
      size: 0,
    });
  }

  const cacheKey = `${conversationId}|${artifact.uri}`;
  const cached = mediaCache.get(cacheKey);
  if (cached) return cached;

  const task = (async (): Promise<LoadedMedia> => {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let mimeType = artifact.mimeType ?? 'application/octet-stream';
    let name = artifact.name;
    let size = 0;

    // Sınır yok: dosya sonuna (eof) kadar okunur. Android'de büyük medya bu yolu kullanmaz.
    for (;;) {
      const res = (await api.call('conversations.readMediaPreview', {
        conversationId,
        uri: artifact.uri,
        offset,
        maxBytes: CHUNK_BYTES,
      })) as {
        name?: string;
        mimeType?: string;
        size?: number;
        offset?: number;
        base64?: string;
        eof?: boolean;
      };
      if (!res || typeof res.base64 !== 'string') {
        throw new Error('Medya verisi alınamadı.');
      }
      if (res.mimeType) mimeType = res.mimeType;
      if (res.name) name = res.name;
      if (typeof res.size === 'number') size = res.size;
      const bytes = base64ToUint8Array(res.base64);
      if (bytes.byteLength > 0) {
        chunks.push(bytes);
        offset += bytes.byteLength;
      }
      if (res.eof || bytes.byteLength === 0) break;
    }

    const totalLen = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let pos = 0;
    for (const c of chunks) {
      merged.set(c, pos);
      pos += c.byteLength;
    }

    const blob = new Blob([merged], { type: mimeType });
    const url = URL.createObjectURL(blob);
    let textContent: string | undefined;
    if (
      (mimeType.startsWith('text/') || mimeType === 'application/json') &&
      merged.byteLength <= 250_000
    ) {
      try {
        textContent = new TextDecoder('utf-8').decode(merged);
      } catch {
        textContent = undefined;
      }
    }
    return { url, mimeType, name, size: size || totalLen, blob, textContent };
  })();

  mediaCache.set(cacheKey, task);
  task.catch(() => {
    mediaCache.delete(cacheKey);
  });
  return task;
}
