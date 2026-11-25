import { Tooltip } from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useReducer } from 'react';
import { useAgentMetadata } from '@core/features/agents/api/browser/use-agent-metadata';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { taskConversationStats } from '@core/features/conversations/api/browser/conversation-selectors';
import {
  getHandoffProviderChain,
  subscribeHandoffStore,
} from '@core/features/conversations/api/browser/handoff-visibility';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import type { TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import { cn } from '@core/primitives/styling/browser/cn';

const FALLBACK_PROVIDER_NAMES: Record<string, string> = {
  antigravity: 'Antigravity',
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  glm: 'GLM / Z.ai',
  grok: 'Grok',
  kimi: 'Kimi',
  opencode: 'OpenCode',
  orchestra: 'Orkestra',
};

function readConversationCreatedAt(data: object): string | null {
  if ('createdAt' in data && typeof (data as { createdAt?: unknown }).createdAt === 'string') {
    return (data as { createdAt: string }).createdAt;
  }
  return null;
}

/**
 * Bir görevdeki tüm yapay zeka sağlayıcı kimliklerini (sohbetler ve devir zincirleri dahil)
 * kronolojik sırayla ve yinelemesiz olarak toplar.
 */
export function collectTaskProviderIds(task: TaskStore): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const pushUnique = (id: string | undefined | null) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push(id);
  };

  const manager = conversationRegistry.get(task.data.id);
  if (manager && manager.conversations.size > 0) {
    const conversations = [...manager.conversations.values()].sort((a, b) => {
      const aCreated = readConversationCreatedAt(a.data);
      const bCreated = readConversationCreatedAt(b.data);
      if (aCreated && bCreated) return aCreated.localeCompare(bCreated);
      if (aCreated) return -1;
      if (bCreated) return 1;
      if (a.data.isInitialConversation !== b.data.isInitialConversation) {
        return a.data.isInitialConversation ? -1 : 1;
      }
      return 0;
    });

    for (const conv of conversations) {
      for (const id of getHandoffProviderChain(conv.data.id)) {
        pushUnique(id);
      }
      pushUnique(conv.data.providerId);
    }
    return result;
  }

  const stats = taskConversationStats(task);
  if (stats) {
    for (const providerId of Object.keys(stats)) {
      pushUnique(providerId);
    }
  }
  return result;
}

export interface TaskProviderIconsProps {
  task: TaskStore;
  maxIcons?: number;
  className?: string;
}

export const TaskProviderIcons = observer(function TaskProviderIcons({
  task,
  maxIcons = 4,
  className,
}: TaskProviderIconsProps) {
  const [, forceHandoffRefresh] = useReducer((count: number) => count + 1, 0);
  useEffect(() => subscribeHandoffStore(forceHandoffRefresh), []);

  const { data: agents } = useAgentMetadata();
  const providerIds = collectTaskProviderIds(task);
  if (providerIds.length === 0) return null;

  const nameMap = new Map((agents ?? []).map((agent) => [agent.id, agent.name]));
  const formatName = (id: string) => nameMap.get(id) ?? FALLBACK_PROVIDER_NAMES[id] ?? id;
  const tooltipLabel = providerIds.map(formatName).join(' · ');

  const visibleIds = providerIds.slice(0, Math.max(1, maxIcons));
  const overflowCount = providerIds.length - visibleIds.length;

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <span
            className={cn(
              'flex shrink-0 items-center [&>.provider-chip]:ring-1 [&>.provider-chip]:ring-background [&>.provider-chip:not(:first-child)]:-ml-1',
              className
            )}
            aria-label={tooltipLabel}
          >
            {visibleIds.map((id) => (
              <span
                key={id}
                className="provider-chip relative flex h-4 w-4 items-center justify-center overflow-hidden rounded-full bg-background-2"
              >
                <AgentIcon id={id} size={12} />
              </span>
            ))}
            {overflowCount > 0 && (
              <span className="ml-0.5 text-[10px] leading-none font-medium text-foreground-tertiary-muted tabular-nums">
                +{overflowCount}
              </span>
            )}
          </span>
        }
      />
      <Tooltip.Content>{tooltipLabel}</Tooltip.Content>
    </Tooltip.Root>
  );
});
