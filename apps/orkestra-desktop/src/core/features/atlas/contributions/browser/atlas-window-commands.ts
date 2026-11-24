import { toast } from '@orkestra/ui/react/primitives';
import { getAtlasClient } from '@core/features/atlas/api/browser/client';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { disabled, enabled, hidden } from '@core/primitives/view-scopes/api';

/** Görevin odaktaki bölmesinde açık olan sohbetin kimliği (ACP ya da TUI sohbet sekmesi). */
export function activeConversationId(
  projectId: string | undefined,
  taskId: string | undefined
): string | null {
  if (!projectId || !taskId) return null;
  const entry = getTaskComposition(projectId, taskId)?.activePane.activeEntry;
  if (!entry || (entry.kind !== 'acp-chat' && entry.kind !== 'conversation')) return null;
  const state = entry.state as { conversationId?: unknown } | undefined;
  return typeof state?.conversationId === 'string' ? state.conversationId : null;
}

async function writeCard(conversationId: string): Promise<void> {
  const result = await (await getAtlasClient()).writeCard({ conversationId });
  if (result.success) {
    toast.success('Atlas card written', {
      description: `${result.data.title} — ${result.data.tags.join(', ')}`,
    });
    return;
  }
  toast.error('Atlas card not written', { description: result.error.message });
}

async function toggleSkip(conversationId: string): Promise<void> {
  const client = await getAtlasClient();
  const current = await client.conversationState({ conversationId });
  await client.setSkipped({ conversationId, skipped: !current.skipped });
  toast.success(
    current.skipped
      ? 'Automatic Atlas card enabled for this conversation'
      : 'No automatic Atlas card will be written for this conversation'
  );
}

/**
 * Pencere kapsamındaki Atlas komutlarının uygulaması. Görev görünümünde odaktaki sohbet
 * sekmesine uygulanır; sohbet açık değilse komut devre dışıdır.
 */
export function atlasWindowCommandImpls(projectId: string | undefined, taskId: string | undefined) {
  const availability = () => {
    if (!projectId || !taskId) return hidden;
    return activeConversationId(projectId, taskId)
      ? enabled
      : disabled('Open a conversation in this task first');
  };
  const run = (action: (conversationId: string) => Promise<void>) => () => {
    const conversationId = activeConversationId(projectId, taskId);
    if (!conversationId) return;
    void action(conversationId).catch((error: unknown) =>
      toast.error('Atlas request failed', { description: String(error) })
    );
  };
  return {
    'atlas.writeCard': () => ({ availability, execute: run(writeCard) }),
    'atlas.toggleSkipCard': () => ({ availability, execute: run(toggleSkip) }),
  } as const;
}
