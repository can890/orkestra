export type ScrollToMessageRequest = {
  conversationId: string;
  itemId: string;
};

type ScrollToMessageListener = (req: ScrollToMessageRequest) => void;

const pendingScrolls = new Map<string, string>();
const listeners = new Set<ScrollToMessageListener>();

/**
 * Arama sonuçlarından seçilen mesaja kaydırma isteğini yayınlar ve sekme henüz açık
 * değilse açıldığında tüketilmek üzere bekleyen istek olarak saklar.
 */
export function requestScrollToMessage(conversationId: string, itemId: string): void {
  if (!conversationId || !itemId) return;
  pendingScrolls.set(conversationId, itemId);
  for (const listener of [...listeners]) {
    listener({ conversationId, itemId });
  }
}

/** Belirtilen sohbet için bekleyen mesaj kaydırma hedefini döndürür ve temizler. */
export function consumePendingScrollToMessage(conversationId: string): string | undefined {
  if (!conversationId) return undefined;
  const itemId = pendingScrolls.get(conversationId);
  if (itemId !== undefined) pendingScrolls.delete(conversationId);
  return itemId;
}

/** Anlık mesaj kaydırma isteklerine abone olur. */
export function onScrollToMessageRequest(listener: ScrollToMessageListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
