import { z } from 'zod';

/**
 * Sohbet çıktısı medya dosyalarının (video, ses, PDF) bellek kopyası olmadan akıtıldığı özel
 * şema. Adresler yalnızca ana sürecin ürettiği tahmin edilemez belirteçleri taşır; şema sadece
 * varsayılan oturumda (ana pencere) işlenir, tarayıcı bölümleri ona ulaşamaz.
 */
export const MEDIA_STREAM_SCHEME = 'orkestra-media';
export const MEDIA_STREAM_HOST = 'media';

const MEDIA_MIME_TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pdf: 'application/pdf',
};

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Akıtılabilen medya/PDF türü; listede olmayan uzantılar için `undefined`. */
export function mediaMimeTypeForPath(path: string): string | undefined {
  return MEDIA_MIME_TYPES[extensionOf(path)];
}

export function mediaStreamUrl(token: string): string {
  return `${MEDIA_STREAM_SCHEME}://${MEDIA_STREAM_HOST}/${token}`;
}

export const mediaStreamErrorSchema = z.object({
  type: z.enum(['not-found', 'unsupported', 'forbidden', 'unavailable', 'incomplete']),
  message: z.string(),
});

export type MediaStreamError = z.infer<typeof mediaStreamErrorSchema>;

export const mediaStreamHandleSchema = z.object({
  /** `orkestra-media://media/<token>`; yalnızca `<video>`/`<audio>` kaynağı olarak kullanılır. */
  url: z.string(),
  token: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
});

export type MediaStreamHandle = z.infer<typeof mediaStreamHandleSchema>;
