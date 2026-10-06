import { isNewerRelease, releaseVersionSchema } from '@orkestra/core/workspace-server';

/**
 * Çalışan ve kanalda yayınlanan workspace-server sürümlerinin karşılaştırma sonucu.
 * - `update-available`: kanal sürümü SemVer'e göre daha yeni.
 * - `up-to-date`: çalışan sürüm kanal sürümüne eşit ya da daha yeni.
 * - `dev-build`: taraflardan biri geliştirme yapısı; otomatik güncelleme yapılmaz.
 * - `unknown`: sürümlerden biri eksik ya da geçerli bir sürüm değil.
 */
export type ServerVersionComparison = 'update-available' | 'up-to-date' | 'dev-build' | 'unknown';

/** Geliştirme yapıları `1.2.3-dev.<sha>[.<zaman>]` biçimindedir; SemVer sırası anlamsızdır. */
export function isDevBuildVersion(version: string): boolean {
  return /^[^-+]+-dev(?:[.-]|$)/.test(version);
}

export function compareServerVersions(
  running: string | undefined,
  available: string | undefined
): ServerVersionComparison {
  if (running === undefined || available === undefined) return 'unknown';
  if (isDevBuildVersion(running) || isDevBuildVersion(available)) return 'dev-build';
  if (
    !releaseVersionSchema.safeParse(running).success ||
    !releaseVersionSchema.safeParse(available).success
  ) {
    return 'unknown';
  }
  return isNewerRelease(available, running) ? 'update-available' : 'up-to-date';
}
