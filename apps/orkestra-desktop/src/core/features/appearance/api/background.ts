// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/themeBackground.ts
//
// Arka plan görseli: sohbet yüzeyinin arkasında gösterilir. Metin kontrastını korumak için görsel
// her zaman sohbet zemin renginden yarı saydam bir örtünün ("karartma") altında kalır; örtü
// hiçbir zaman MIN_BACKGROUND_DIM'in altına inemez.

export const BACKGROUND_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const BACKGROUND_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;
export type BackgroundImageMimeType = (typeof BACKGROUND_IMAGE_MIME_TYPES)[number];

export const MIN_BACKGROUND_DIM = 0.55;
export const MAX_BACKGROUND_DIM = 0.97;
export const MAX_BACKGROUND_BLUR_PX = 40;

export type BackgroundSettings = {
  enabled: boolean;
  /** Uygulama verisine kopyalanan görselin dosya adı (özgün yol saklanmaz). */
  fileName: string | null;
  /** Görselin kendi opaklığı (0–1). */
  opacity: number;
  /** Bulanıklık (px). */
  blur: number;
  /** Görselin üstündeki zemin örtüsünün opaklığı (MIN_BACKGROUND_DIM–MAX_BACKGROUND_DIM). */
  dim: number;
};

export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = {
  enabled: false,
  fileName: null,
  opacity: 1,
  blur: 0,
  dim: 0.8,
};

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

/** Değerleri güvenli aralıklara sıkıştırır (kontrast koruması dahil). */
export function normalizeBackground(settings: BackgroundSettings): BackgroundSettings {
  return {
    enabled: settings.enabled && settings.fileName !== null,
    fileName: settings.fileName,
    opacity: clamp(settings.opacity, 0, 1),
    blur: Math.round(clamp(settings.blur, 0, MAX_BACKGROUND_BLUR_PX)),
    dim: clamp(settings.dim, MIN_BACKGROUND_DIM, MAX_BACKGROUND_DIM),
  };
}

export const BACKGROUND_IMAGE_VARIABLE = '--orkestra-background-image';

/**
 * Sohbet yüzeyine uygulanacak CSS. Görsel `::before` sözde öğesinde, sohbet zemini (`--chat-bg`)
 * ise karartma oranında yarı saydam hale gelir; içerik her zaman bu örtünün üstündedir.
 */
export function backgroundStylesheet(settings: BackgroundSettings): string {
  const normalized = normalizeBackground(settings);
  if (!normalized.enabled) return '';
  const dimPercent = Math.round(normalized.dim * 100);
  const blur = normalized.blur;
  return `[data-chat-surface] {
  isolation: isolate;
  --chat-bg: color-mix(in srgb, var(--em-surface-paper) ${dimPercent}%, transparent);
}
[data-chat-surface]::before {
  content: '';
  position: absolute;
  inset: ${blur > 0 ? `-${blur * 2}px` : '0'};
  z-index: 0;
  pointer-events: none;
  background: var(${BACKGROUND_IMAGE_VARIABLE}) center / cover no-repeat;
  opacity: ${normalized.opacity};
  ${blur > 0 ? `filter: blur(${blur}px);` : ''}
}
[data-chat-surface] > * {
  position: relative;
  z-index: 1;
}
`;
}

export function isBackgroundMimeType(value: string): value is BackgroundImageMimeType {
  return (BACKGROUND_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

export function extensionForMimeType(mimeType: BackgroundImageMimeType): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
  }
}

/** Uygulama verisindeki dosya adı biçimi: `background-<özet>.<uzantı>`. */
export const BACKGROUND_FILE_NAME_RE = /^background-[a-f0-9]{8,64}\.(?:jpg|png|webp|gif)$/;
