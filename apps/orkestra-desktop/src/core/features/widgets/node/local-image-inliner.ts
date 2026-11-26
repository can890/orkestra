/**
 * local-image-inliner — Magic-byte-verified local image inliner for HTML widgets.
 * Adapted from T3 Code (MIT License) HtmlRender.ts.
 */

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
const IMG_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi;

export function detectImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii').startsWith('GIF8')) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  const head = bytes.subarray(0, 256).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml';
  }
  return null;
}

export async function inlineLocalImagesInHtml(html: string): Promise<{
  html: string;
  inlinedCount: number;
}> {
  const matches = [...html.matchAll(IMG_SRC_RE)];
  if (matches.length === 0) return { html, inlinedCount: 0 };

  let out = html;
  let inlinedCount = 0;

  for (const match of matches) {
    const full = match[0];
    const prefix = match[1]!;
    const quote = match[2]!;
    const rawSrc = match[3]!;
    if (/^(?:data:|https?:|blob:)/i.test(rawSrc)) continue;

    const filePath = rawSrc.startsWith('file://') ? decodeURI(rawSrc.replace(/^file:\/\//i, '')) : rawSrc;
    if (!isAbsolute(filePath)) continue;

    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size === 0 || info.size > MAX_INLINE_IMAGE_BYTES) continue;
      const bytes = await readFile(filePath);
      const mime = detectImageMime(bytes);
      if (!mime) continue;
      const dataUri = `data:${mime};base64,${bytes.toString('base64')}`;
      out = out.replace(full, `${prefix}${quote}${dataUri}${quote}`);
      inlinedCount += 1;
    } catch {
      // Leave unresolved local paths untouched
    }
  }

  return { html: out, inlinedCount };
}
