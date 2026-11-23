import { getHandoffStore } from '@core/features/conversations/browser/handoff/handoff-store';

/** Returns true if a conversation was replaced seamlessly by an inline provider switch. */
export function isSupersededConversation(conversationId: string): boolean {
  return getHandoffStore().isSuperseded(conversationId);
}

/** Follows any inline provider switch chain to the newest conversation id. */
export function resolveLatestConversationId(conversationId: string): string {
  return getHandoffStore().resolveLatest(conversationId);
}
