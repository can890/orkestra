import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { log } from '@core/primitives/logging/browser/logger';

/**
 * Konuşma bir Orkestra şefiyse yönetim kılavuzunu mevcut gizli bağlamın önüne ekler. Şef
 * değilse veya kılavuz okunamazsa mevcut bağlam aynen döner.
 */
export async function withOrchestraConductorContext(
  conversationId: string,
  existing: string | Promise<string | undefined> | undefined
): Promise<string | undefined> {
  const [base, playbook] = await Promise.all([
    existing,
    getConversationsClient()
      .then((client) => client.orchestra.conductorContext({ conversationId }))
      .catch((error: unknown) => {
        log.warn('Orkestra şef bağlamı okunamadı', { conversationId, error: String(error) });
        return null;
      }),
  ]);
  const parts = [playbook, base].filter((part): part is string => Boolean(part?.trim()));
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/** "Orkestra (n)" biçiminde, görevdeki diğer orkestralarla çakışmayan bir başlık üretir. */
export function nextOrchestraTitle(existingTitles: Iterable<string>): string {
  const used = new Set<number>();
  for (const title of existingTitles) {
    const match = /^Orkestra \((\d+)\)$/.exec(title);
    if (match) used.add(Number(match[1]));
  }
  let next = 1;
  while (used.has(next)) next += 1;
  return `Orkestra (${next})`;
}
