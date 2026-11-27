import type { PendingPrompt } from './conversation-session';

export type OutboxScope = {
  deviceId: string;
  hostId: string;
  conversationId: string;
};

export type MobileImage = {
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
};

export type ComposerDraft = { text: string; attachments: MobileImage[] };

type Snapshot = { draft: ComposerDraft; pending: PendingPrompt[] };

const PREFIX = 'orkestra.mobile-outbox.v1:';
const locks = new Set<string>();

export function outboxKey(scope: OutboxScope): string {
  return PREFIX + JSON.stringify([scope.deviceId, scope.hostId, scope.conversationId]);
}

function emptySnapshot(): Snapshot {
  return { draft: { text: '', attachments: [] }, pending: [] };
}

function read(key: string): Snapshot {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return emptySnapshot();
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return emptySnapshot();
    }
    const rec = parsed as Record<string, unknown>;
    const rawDraft =
      typeof rec['draft'] === 'object' && rec['draft'] !== null && !Array.isArray(rec['draft'])
        ? (rec['draft'] as Record<string, unknown>)
        : {};
    const draft: ComposerDraft = {
      text: typeof rawDraft['text'] === 'string' ? rawDraft['text'] : '',
      attachments: Array.isArray(rawDraft['attachments'])
        ? (rawDraft['attachments'] as MobileImage[])
        : [],
    };
    const pending = Array.isArray(rec['pending']) ? (rec['pending'] as PendingPrompt[]) : [];
    return { draft, pending };
  } catch {
    return emptySnapshot();
  }
}

export function readOutbox(scope: OutboxScope): Snapshot {
  return read(outboxKey(scope));
}

export function updateOutbox(scope: OutboxScope, update: (value: Snapshot) => Snapshot): Snapshot {
  const key = outboxKey(scope);
  const next = update(read(key));
  if (next.pending.length || next.draft.text || next.draft.attachments.length) {
    globalThis.localStorage.setItem(key, JSON.stringify(next));
  } else {
    globalThis.localStorage.removeItem(key);
  }
  return next;
}

export function pendingChats(deviceId: string, hostId: string): string[] {
  const storage = globalThis.localStorage;
  if (!storage) return [];
  const prefix = PREFIX + JSON.stringify([deviceId, hostId]).slice(0, -1) + ',';
  const conversations: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    if (read(key).pending.some((item) => item.state === 'waiting' || item.state === 'sending')) {
      try {
        const [, , conversationId] = JSON.parse(key.slice(PREFIX.length)) as [
          string,
          string,
          string,
        ];
        if (typeof conversationId === 'string' && conversationId) {
          conversations.push(conversationId);
        }
      } catch {
        // Bozuk anahtarı atla.
      }
    }
  }
  return conversations;
}

export function claimOutbox(scope: OutboxScope | undefined): (() => void) | null {
  if (!scope) return () => {};
  const key = outboxKey(scope);
  if (locks.has(key)) return null;
  locks.add(key);
  return () => locks.delete(key);
}

const DEFAULT_MAX_COMPRESSED_BYTES = 240 * 1024;
const COMPRESS_MAX_SIDES = [1600, 1280, 960, 720, 512] as const;
const COMPRESS_QUALITIES = [0.82, 0.7, 0.58, 0.45] as const;

type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup: () => void;
};

async function decodeImageForCanvas(file: File): Promise<DecodedImage | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close(),
      };
    } catch {
      // Image öğesine düş.
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    return null;
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image-load-failed'));
      el.src = objectUrl;
    });
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      cleanup: () => URL.revokeObjectURL(objectUrl),
    };
  } catch {
    URL.revokeObjectURL(objectUrl);
    return null;
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: 'image/webp' | 'image/jpeg',
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), mimeType, quality);
    } catch {
      resolve(null);
    }
  });
}

function replaceImageExtension(name: string, mimeType: string): string {
  const ext = mimeType === 'image/webp' ? '.webp' : '.jpg';
  const base = name.replace(/\.[^./\\]+$/, '') || 'gorsel';
  return `${base}${ext}`;
}

/**
 * 256 KB üstü Android telefon fotoğraflarını HTMLCanvasElement ile otomatik yeniden boyutlandırıp
 * WebP/JPEG olarak `maxBytes` (varsayılan 240 KB) altına sıkıştırır. Canvas desteklemeyen
 * ortamlarda (ör. Node testleri) zarifçe orijinal dosyayı döner.
 */
export async function compressImageIfNeeded(
  file: File,
  maxBytes = DEFAULT_MAX_COMPRESSED_BYTES
): Promise<File> {
  if (file.size === 0 || file.size <= maxBytes) return file;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return file;

  const canvas = document.createElement('canvas');
  if (!canvas || typeof canvas.getContext !== 'function' || typeof canvas.toBlob !== 'function') {
    return file;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;

  const decoded = await decodeImageForCanvas(file);
  if (!decoded || decoded.width <= 0 || decoded.height <= 0) {
    decoded?.cleanup();
    return file;
  }

  let bestBlob: Blob | null = null;
  try {
    for (const maxSide of COMPRESS_MAX_SIDES) {
      const scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height));
      const targetWidth = Math.max(1, Math.round(decoded.width * scale));
      const targetHeight = Math.max(1, Math.round(decoded.height * scale));
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      ctx.clearRect(0, 0, targetWidth, targetHeight);
      ctx.drawImage(decoded.source, 0, 0, targetWidth, targetHeight);

      for (const mimeType of ['image/webp', 'image/jpeg'] as const) {
        for (const quality of COMPRESS_QUALITIES) {
          const blob = await canvasToBlob(canvas, mimeType, quality);
          if (!blob || blob.size === 0) continue;
          if (!bestBlob || blob.size < bestBlob.size) {
            bestBlob = blob;
          }
          if (blob.size <= maxBytes) {
            const outType =
              blob.type === 'image/webp' || blob.type === 'image/jpeg' ? blob.type : mimeType;
            return new File([blob], replaceImageExtension(file.name, outType), { type: outType });
          }
        }
      }
    }
  } finally {
    decoded.cleanup();
  }

  if (bestBlob && bestBlob.size < file.size) {
    const outType =
      bestBlob.type === 'image/webp' || bestBlob.type === 'image/jpeg'
        ? bestBlob.type
        : 'image/jpeg';
    return new File([bestBlob], replaceImageExtension(file.name, outType), { type: outType });
  }
  return file;
}

export async function readMobileImage(file: File): Promise<MobileImage> {
  const prepared = file.size > 256 * 1024 ? await compressImageIfNeeded(file) : file;
  const mimeType = prepared.type;
  if (
    mimeType !== 'image/png' &&
    mimeType !== 'image/jpeg' &&
    mimeType !== 'image/gif' &&
    mimeType !== 'image/webp'
  ) {
    throw new Error('PNG, JPEG, GIF veya WebP biçiminde bir görsel seçin.');
  }
  if (prepared.size === 0 || prepared.size > 256 * 1024) {
    throw new Error('Her görsel en fazla 256 KB olabilir.');
  }
  const bytes = new Uint8Array(await prepared.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const name = prepared.name.replaceAll(/[/\\\u0000-\u001f]/gu, '_').slice(0, 120) || 'Görsel';
  return { name, mimeType, data: btoa(binary) };
}
