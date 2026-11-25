// Sağlayıcı adından türetilen varsayılan sohbet başlıkları ("Claude (1)", "Antigravity (2)").
// Hem tarayıcı (gösterim, yeni başlık seçimi) hem node (otomatik başlık, eşitleme) tarafından
// kullanılır; bu yüzden ortama bağımlılığı yoktur.

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `title`, `providerId` için varsayılan başlık biçimindeyse (`<sağlayıcı> (<n>)`, büyük/küçük
 * harf duyarsız) sıra numarasını döner; değilse `null`.
 */
export function parseDefaultConversationTitleIndex(
  title: string,
  providerId: string
): number | null {
  if (!providerId) return null;
  const match = title
    .trim()
    .match(new RegExp(`^${escapeRegExp(providerId)} \\(([1-9]\\d*)\\)$`, 'i'));
  if (!match) return null;
  const rawIndex = match[1];
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 1) return null;
  if (String(index) !== rawIndex) return null;
  return index;
}

/** `title`, verilen sağlayıcılardan birinin varsayılan sohbet başlığı mı? */
export function isDefaultConversationTitle(
  title: string | null | undefined,
  providerIds: Iterable<string | null | undefined>
): boolean {
  if (!title) return false;
  for (const providerId of providerIds) {
    if (providerId && parseDefaultConversationTitleIndex(title, providerId) !== null) return true;
  }
  return false;
}
