import { Button } from '@orkestra/ui/react/primitives';
import { ShieldAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { acpChatRegistry } from './acp-chat-registry';
import type { AcpChatStore } from './acp-chat-store';
import { useOrchestraWorkerLinks } from './subagent-side-panel';

/**
 * Arka planda çalışan alt ajanların (aynı görevdeki diğer konuşmalar veya Orkestra işçileri)
 * bekleyen izin/komut onaylarını doğrudan ana sohbette gösterir; sekme değiştirmeden onay/red verir.
 */
export const ChildSubagentApprovals = observer(function ChildSubagentApprovals({
  store,
}: {
  store: AcpChatStore;
}) {
  const links = useOrchestraWorkerLinks(store);

  const workerNames = new Map<string, string>();
  for (const [toolCallId, worker] of links.graphWorkers) {
    const summary = links.workerFor(toolCallId);
    if (summary?.workerId) {
      workerNames.set(
        summary.workerId,
        worker.label ?? (summary.title || summary.agentName || 'Alt ajan')
      );
    }
  }
  const convManager = conversationRegistry.get(store.taskId);

  const pending: Array<{
    childStore: AcpChatStore;
    label: string;
    request: AcpChatStore['permissionQueue'][number];
  }> = [];

  const seen = new Set<string>();
  const inspectStore = (candidate: AcpChatStore) => {
    if (candidate.conversationId === store.conversationId) return;
    if (seen.has(candidate.conversationId)) return;
    const isSameTask = candidate.taskId === store.taskId;
    const isLinkedWorker = workerNames.has(candidate.conversationId);
    if (!isSameTask && !isLinkedWorker) return;
    seen.add(candidate.conversationId);

    const first = candidate.permissionQueue[0];
    if (!first) return;
    const convTitle = convManager?.conversations.get(candidate.conversationId)?.data.title;
    const label = workerNames.get(candidate.conversationId) ?? convTitle ?? 'Alt ajan';
    pending.push({ childStore: candidate, label, request: first });
  };

  const taskStores = acpChatRegistry.getAll(store.taskId);
  if (taskStores) {
    for (const s of taskStores.values()) inspectStore(s);
  }
  for (const s of acpChatRegistry.all()) {
    inspectStore(s);
  }

  if (pending.length === 0) return null;

  return (
    <div className="mx-3 mb-1.5 flex flex-col gap-1.5">
      {pending.map(({ childStore, label, request }) => (
        <div
          key={`${childStore.conversationId}:${request.requestId}`}
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/35 bg-amber-500/[0.08] px-3 py-2 text-xs"
        >
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-amber-200">{label} onay bekliyor</span>
                {childStore.permissionQueue.length > 1 && (
                  <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
                    +{childStore.permissionQueue.length - 1} daha
                  </span>
                )}
              </div>
              <p className="truncate text-[11px] text-foreground-muted" title={request.title}>
                {request.title}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {request.options.map((opt) => {
              const isAllow = opt.kind === 'allow_once' || opt.kind === 'allow_always';
              return (
                <Button
                  key={opt.optionId}
                  type="button"
                  size="sm"
                  variant={isAllow ? 'primary' : 'ghost'}
                  onClick={() => childStore.resolvePermission(opt.optionId)}
                >
                  {opt.name}
                </Button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
});
