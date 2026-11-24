import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { getHandoffStore } from '@core/features/conversations/browser/handoff/handoff-store';

let attachedHandoffClient: unknown = null;

/** Returns true if a conversation was replaced seamlessly by an inline provider switch. */
export function isSupersededConversation(conversationId: string): boolean {
  return getHandoffStore().isSuperseded(conversationId);
}

/** Follows any inline provider switch chain to the newest conversation id. */
export function resolveLatestConversationId(conversationId: string): string {
  return getHandoffStore().resolveLatest(conversationId);
}

/**
 * Bir sohbetin devir zincirindeki tüm sağlayıcı kimliklerini kronolojik sırayla ve
 * yinelemesiz olarak döndürür.
 */
export function getHandoffProviderChain(conversationId: string): string[] {
  const chain = getHandoffStore().get(conversationId)?.chain;
  if (!chain?.length) return [];
  const ordered = [...chain].sort((a, b) => a.createdAt - b.createdAt);
  const seen = new Set<string>();
  const providers: string[] = [];
  for (const segment of ordered) {
    for (const providerId of [segment.fromProviderId, segment.toProviderId]) {
      if (!providerId || seen.has(providerId)) continue;
      seen.add(providerId);
      providers.push(providerId);
    }
  }
  return providers;
}

/** Devir/çatallama deposundaki değişikliklere abone olur. */
export function subscribeHandoffStore(listener: () => void): () => void {
  return getHandoffStore().subscribe(listener);
}

/**
 * SQLite tabanlı devir ve çatal kalıcılığını bağlar ve kayıtları yükler (tekrarlanabilir).
 * Test ortamlarında eksik ya da sahte wire istemcileriyle sessizce atlar.
 */
export async function initHandoffPersistence(): Promise<void> {
  let client: Awaited<ReturnType<typeof getConversationsClient>> | undefined;
  try {
    client = await getConversationsClient();
  } catch {
    return;
  }
  const handoffClient = client?.handoff;
  if (!handoffClient) return;

  const store = getHandoffStore();
  if (attachedHandoffClient !== handoffClient) {
    store.attachPersistence({
      listAll: () => handoffClient.listAll(),
      put: (conversationId, record) => handoffClient.put({ conversationId, record }),
      remove: (conversationId) => handoffClient.remove({ conversationId }),
      markContextDelivered: (conversationId) =>
        handoffClient.markContextDelivered({ conversationId }),
      clearTargetEffort: (conversationId) => handoffClient.clearTargetEffort({ conversationId }),
      markSuperseded: (oldConversationId, newConversationId) =>
        handoffClient.markSuperseded({ oldConversationId, newConversationId }),
      bulkImport: (input) => handoffClient.bulkImport(input),
    });
    attachedHandoffClient = handoffClient;
  }
  await store.hydrateFromBackend();
}
