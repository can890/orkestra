export function isHtmlArtifactName(name: string): boolean {
  return /\.html?$/i.test(name);
}

export function isImageMime(mimeType: string | undefined): boolean {
  return !!mimeType && /^image\/(png|jpe?g|gif|webp|svg\+xml)$/i.test(mimeType);
}

/** Paylaşımdaki dosya adı: yalnızca son parça, güvenli karakterler. */
export function shareFileName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  const cleaned = last
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 120) || 'artifact';
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Tek dosya HTML dışa aktarma: HTML artifact olduğu gibi, görsel ise gömülü bir sayfa olarak.
 * Diğer türler için null döner (yalnızca yerel ağ bağlantısı sunulur).
 */
export function buildSingleFileHtml(input: {
  name: string;
  mimeType?: string;
  bytes: Uint8Array;
}): string | null {
  if (isHtmlArtifactName(input.name)) return new TextDecoder().decode(input.bytes);
  const mime = input.mimeType ?? '';
  if (!isImageMime(mime)) return null;
  const title = escapeHtml(shareFileName(input.name));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0;display:grid;place-items:center;min-height:100vh"><img alt="${title}" style="max-width:100%" src="data:${mime};base64,${bytesToBase64(input.bytes)}"></body></html>`;
}
