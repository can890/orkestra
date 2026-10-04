import { KeyedMutex } from '@orkestra/shared/concurrency';

/** Aynı konuşmanın başlatılmasını ve görünüm değiştirmesini sıraya koyar. */
export const conversationLifecycleLock = new KeyedMutex();
export const switchingConversations = new Set<string>();

export function assertConversationNotSwitching(conversationId: string): void {
  if (switchingConversations.has(conversationId))
    throw new Error('Konuşmanın görünümü değiştiriliyor. Birazdan tekrar deneyin.');
}
