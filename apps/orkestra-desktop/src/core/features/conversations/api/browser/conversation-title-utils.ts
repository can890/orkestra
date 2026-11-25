import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import { parseDefaultConversationTitleIndex } from '@core/features/conversations/api/default-conversation-title';

type ConversationTitleInput = {
  providerId: AgentProviderId;
  title: string;
};

function capitalizeProviderId(providerId: AgentProviderId): string {
  return `${providerId.charAt(0).toUpperCase()}${providerId.slice(1)}`;
}

function parseDefaultTitleIndex(title: string, providerId: AgentProviderId): number | null {
  return parseDefaultConversationTitleIndex(title, providerId);
}

/**
 * Sağlayıcının ilk prompt'tan türettiği başlıklar gizli bağlam bloğunu (çoğu zaman etiketin
 * ortasında kırpılmış halde) taşıyabilir. ACP çözümleyicisi yeni başlıkları temizler
 * (`stripHiddenContextFromTitle`); bu, daha önce kaydedilmiş başlıklar için gösterim tarafındaki
 * karşılığıdır. Görünür bir şey kalmazsa başlık olduğu gibi döner.
 */
export function visibleConversationTitle(title: string): string {
  const visible = title
    .replace(/<orkestra_context>[\s\S]*?<\/orkestra_context>/g, '')
    .replace(/<orkestra_context>[\s\S]*$/, '')
    .trim();
  return visible === '' ? title : visible;
}

export function formatConversationTitleForDisplay(
  providerId: AgentProviderId,
  title: string
): string {
  const index = parseDefaultTitleIndex(title, providerId);
  if (index === null) return visibleConversationTitle(title);
  return `${capitalizeProviderId(providerId)} (${index})`;
}

export function nextDefaultConversationTitle(
  providerId: AgentProviderId,
  conversations: ConversationTitleInput[]
): string {
  const used = new Set<number>();

  for (const conversation of conversations) {
    if (conversation.providerId !== providerId) continue;
    const index = parseDefaultTitleIndex(conversation.title, providerId);
    if (index !== null) used.add(index);
  }

  let next = 1;
  while (used.has(next)) next += 1;

  return `${capitalizeProviderId(providerId)} (${next})`;
}
