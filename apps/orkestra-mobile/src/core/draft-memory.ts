/**
 * Sohbet başına yazılmakta olan taslak. Ekran değişince, bağlantı kopup yeniden kurulunca ya da
 * sohbet yeniden açılınca kutudaki metin kaybolmasın diye uygulama ömrü boyunca bellekte tutulur.
 */
const drafts = new Map<string, string>();

function key(hostId: string | undefined, conversationId: string): string {
  return `${hostId ?? ''}\u0000${conversationId}`;
}

export function readDraft(hostId: string | undefined, conversationId: string): string {
  return drafts.get(key(hostId, conversationId)) ?? '';
}

export function writeDraft(hostId: string | undefined, conversationId: string, text: string): void {
  if (text === '') drafts.delete(key(hostId, conversationId));
  else drafts.set(key(hostId, conversationId), text);
}

/**
 * Gönderilemeden kapanan mesajları (bağlantı beklerken ya da hata alınca) taslağın sonuna ekler;
 * hiçbir mesaj sessizce düşmez.
 */
export function restoreUnsent(
  hostId: string | undefined,
  conversationId: string,
  texts: readonly string[]
): void {
  if (texts.length === 0) return;
  const current = readDraft(hostId, conversationId);
  const parts = [current, ...texts].filter((part) => part.trim() !== '');
  writeDraft(hostId, conversationId, parts.join('\n\n'));
}
