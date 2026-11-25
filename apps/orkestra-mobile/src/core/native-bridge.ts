/**
 * Android MainActivity (`SovraNative`) köprüsü: dokunsal geri bildirim (haptic) ve yerel
 * bildirimler. Tarayıcı/test ortamında sessizce no-op olur.
 */

export type HapticKind = 'light' | 'medium' | 'success' | 'warning';
export type NativeFileAction = 'open' | 'download' | 'share';

type SovraNativeApi = {
  setSystemBars?: (dark: boolean) => void;
  haptic?: (kind: string) => void;
  notify?: (id: number, title: string, body: string, urgent: boolean) => void;
  beginFileSave?: (fileName: string, mimeType: string) => string;
  appendFileChunk?: (transferId: string, base64Chunk: string) => boolean;
  finishFileSave?: (transferId: string, mode: string) => boolean;
  finishFilePreview?: (transferId: string, kind: string) => string;
  abortFileSave?: (transferId: string) => void;
};

export type NativeFilePreviewResult = {
  thumbnail?: string;
  pageCount?: number;
  durationMs?: number;
};

function nativeApi(): SovraNativeApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { SovraNative?: SovraNativeApi }).SovraNative;
}

export function hasNativeFileBridge(): boolean {
  const api = nativeApi();
  return Boolean(api?.beginFileSave && api?.appendFileChunk && api?.finishFileSave);
}

function bytesToBase64(bytes: Uint8Array): string {
  const step = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += step) {
    const slice = bytes.subarray(i, Math.min(i + step, bytes.byteLength));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

const NATIVE_CHUNK_BYTES = 384 * 1024;

/**
 * Android cihazda dosyayı parça parça yerel önbelleğe yazar ve:
 * - `download`: doğrudan `İndirilenler/Sovra` klasörüne kaydeder.
 * - `open`: `İndirilenler/Sovra` klasörüne kaydedip telefonun yerel PDF/dosya okuyucusunda açar.
 * - `share`: Android paylaşım menüsünü (WhatsApp, Drive, E-posta vb.) açar.
 * Masaüstü tarayıcı/test ortamında `false` döner.
 */
export async function saveOrOpenNativeFile(
  blob: Blob,
  fileName: string,
  mimeType: string,
  mode: NativeFileAction
): Promise<boolean> {
  const api = nativeApi();
  if (!api?.beginFileSave || !api?.appendFileChunk || !api?.finishFileSave) {
    return false;
  }
  const transferId = api.beginFileSave(
    fileName,
    mimeType || blob.type || 'application/octet-stream'
  );
  if (!transferId) return false;
  try {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    for (let offset = 0; offset < bytes.byteLength; offset += NATIVE_CHUNK_BYTES) {
      const slice = bytes.subarray(offset, Math.min(offset + NATIVE_CHUNK_BYTES, bytes.byteLength));
      const ok = api.appendFileChunk(transferId, bytesToBase64(slice));
      if (!ok) {
        api.abortFileSave?.(transferId);
        return false;
      }
    }
    return api.finishFileSave(transferId, mode);
  } catch {
    api.abortFileSave?.(transferId);
    return false;
  }
}

/**
 * Android yerleşik `PdfRenderer` / `MediaMetadataRetriever` ile PDF 1. sayfa önizlemesi,
 * sayfa sayısı, video poster karesi ve süre bilgisini üretir.
 */
export async function generateNativeMediaPreview(
  blob: Blob,
  fileName: string,
  mimeType: string,
  kind: 'pdf' | 'video' | 'audio'
): Promise<NativeFilePreviewResult | null> {
  const api = nativeApi();
  if (!api?.beginFileSave || !api?.appendFileChunk || !api?.finishFilePreview) {
    return null;
  }
  const transferId = api.beginFileSave(
    `preview_${fileName}`,
    mimeType || blob.type || 'application/octet-stream'
  );
  if (!transferId) return null;
  try {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    for (let offset = 0; offset < bytes.byteLength; offset += NATIVE_CHUNK_BYTES) {
      const slice = bytes.subarray(offset, Math.min(offset + NATIVE_CHUNK_BYTES, bytes.byteLength));
      if (!api.appendFileChunk(transferId, bytesToBase64(slice))) {
        api.abortFileSave?.(transferId);
        return null;
      }
    }
    const raw = api.finishFilePreview(transferId, kind);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NativeFilePreviewResult;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    api.abortFileSave?.(transferId);
    return null;
  }
}

export function triggerHaptic(kind: HapticKind = 'light'): void {
  try {
    const api = nativeApi();
    if (api?.haptic) {
      api.haptic(kind);
      return;
    }
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(kind === 'warning' ? 30 : kind === 'medium' ? 18 : 10);
    }
  } catch {
    // Dokunsal geri bildirim desteklenmiyorsa yoksay.
  }
}

let nextNotifId = 1000;

export function showNativeNotification(
  title: string,
  body: string,
  options?: { urgent?: boolean; id?: number }
): void {
  try {
    const api = nativeApi();
    if (!api?.notify) return;
    const id = options?.id ?? nextNotifId++;
    api.notify(id, title.slice(0, 120), body.slice(0, 400), options?.urgent === true);
  } catch {
    // Bildirim izni veya köprü yoksa yoksay.
  }
}
