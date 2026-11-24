import { AgentStatus } from '@orkestra/ui/react/components';
import { Command } from 'cmdk';
import { MessageSquare, Search } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import type { ConversationStore } from '@core/features/conversations/api/browser/conversation-manager';
import { formatConversationTitleForDisplay } from '@core/features/conversations/api/browser/conversation-title-utils';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { requestScrollToMessage } from '@core/features/conversations/browser/acp/message-scroll-bus';
import { getSearchClient } from '@core/features/search/api/client';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import {
  type PaletteProviderDef,
  type PaletteProviderMatch,
  type PaletteProviderRenderProps,
} from '@core/primitives/palette/api';
import type { MessageSearchHit } from '@core/primitives/search/api';
import {
  conversationPaletteSource,
  type ConversationPaletteMatch,
} from './conversation-palette-source';

const PALETTE_ITEM_CLASS =
  'flex cursor-pointer items-center gap-2.5 text-foreground-muted aria-selected:text-foreground rounded-md px-2 py-2 text-sm aria-selected:bg-background-2';

const MESSAGE_SEARCH_LIMIT = 30;

export interface MessagePaletteMatch extends PaletteProviderMatch {
  readonly hit: MessageSearchHit;
}

const ConversationPaletteItem = observer(function ConversationPaletteItem({
  conversation,
  value,
  onSelect,
}: {
  conversation: ConversationStore;
  value: string;
  onSelect: () => void;
}) {
  const title = formatConversationTitleForDisplay(
    conversation.data.providerId,
    conversation.data.title ?? ''
  );
  return (
    <Command.Item value={value} onSelect={onSelect} className={PALETTE_ITEM_CLASS}>
      <AgentIcon id={conversation.data.providerId} size={16} />
      <span className="flex-1 truncate">{title}</span>
      <AgentStatus status={conversation.indicatorStatus} />
    </Command.Item>
  );
});

function ConversationPaletteProviderRow({
  match,
  value,
  onSelect,
}: PaletteProviderRenderProps<ConversationPaletteMatch>) {
  const { navigate } = useNavigate();
  const { item } = match;
  const conversation = conversationRegistry.get(item.taskId)?.conversations.get(item.id);
  const handleSelect = () => {
    getTaskComposition(item.projectId, item.taskId)?.paneLayout.open(
      'conversation',
      { conversationId: item.id },
      { preview: false }
    );
    onSelect();
    navigate(taskViewDef({ projectId: item.projectId, taskId: item.taskId }));
  };

  if (conversation) {
    return (
      <ConversationPaletteItem conversation={conversation} value={value} onSelect={handleSelect} />
    );
  }
  return (
    <Command.Item value={value} onSelect={handleSelect} className={PALETTE_ITEM_CLASS}>
      <MessageSquare size={14} className="shrink-0 text-foreground/40" />
      <span className="flex-1 truncate">{item.title}</span>
    </Command.Item>
  );
}

function renderHighlightedSnippet(snippet: string): ReactNode {
  const parts = snippet.split(/(<mark>[\s\S]*?<\/mark>)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('<mark>') && part.endsWith('</mark>')) {
      return (
        <mark key={idx} className="rounded bg-primary/20 px-0.5 text-foreground">
          {part.slice('<mark>'.length, -'</mark>'.length)}
        </mark>
      );
    }
    return part;
  });
}

function roleLabel(role: string): string {
  if (role === 'user') return 'Kullanıcı';
  if (role === 'assistant') return 'Asistan';
  return role;
}

function MessagePaletteProviderRow({
  match,
  value,
  onSelect,
}: PaletteProviderRenderProps<MessagePaletteMatch>) {
  const { navigate } = useNavigate();
  const { hit } = match;
  const conversation = conversationRegistry.get(hit.taskId)?.conversations.get(hit.conversationId);
  const displayTitle = conversation
    ? formatConversationTitleForDisplay(
        conversation.data.providerId,
        conversation.data.title ?? hit.conversationTitle
      )
    : hit.conversationTitle || 'Sohbet';

  const handleSelect = () => {
    getTaskComposition(hit.projectId, hit.taskId)?.paneLayout.open(
      'acp-chat',
      { conversationId: hit.conversationId },
      { preview: false }
    );
    requestScrollToMessage(hit.conversationId, hit.itemId);
    onSelect();
    navigate(taskViewDef({ projectId: hit.projectId, taskId: hit.taskId }));
  };

  return (
    <Command.Item value={value} onSelect={handleSelect} className={PALETTE_ITEM_CLASS}>
      {conversation ? (
        <AgentIcon id={conversation.data.providerId} size={16} />
      ) : (
        <Search size={14} className="shrink-0 text-foreground/40" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-xs text-foreground/60">
          <span className="truncate font-medium text-foreground/80">{displayTitle}</span>
          <span className="shrink-0 rounded bg-foreground/10 px-1 py-0.5 text-[10px] leading-none">
            {roleLabel(hit.role)}
          </span>
        </span>
        <span className="truncate text-xs text-foreground/50">
          {renderHighlightedSnippet(hit.snippet)}
        </span>
      </span>
    </Command.Item>
  );
}

const typedConversationPaletteProviderDef: PaletteProviderDef<
  'conversations',
  ConversationPaletteMatch
> = {
  kind: 'conversations',
  keyword: '@conversations',
  minQueryLength: 1,
  idle: conversationPaletteSource.idle,
  search: conversationPaletteSource.search,
  render: ConversationPaletteProviderRow,
};

export const conversationPaletteProviderDef: PaletteProviderDef = {
  ...typedConversationPaletteProviderDef,
  render: ({ match, value, onSelect }) => (
    <ConversationPaletteProviderRow
      match={match as ConversationPaletteMatch}
      value={value}
      onSelect={onSelect}
    />
  ),
};

const typedMessagePaletteProviderDef: PaletteProviderDef<
  'messages',
  MessagePaletteMatch
> = {
  kind: 'messages',
  keyword: '@messages',
  minQueryLength: 2,
  search: async ({ query, context }) => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];
    const client = await getSearchClient();
    const hits = await client.searchMessages({
      query: trimmed,
      limit: MESSAGE_SEARCH_LIMIT,
    });
    return hits.map((hit, index) => ({
      id: `${hit.conversationId}:${hit.itemId}`,
      hit,
      title: hit.conversationTitle || 'Sohbet',
      subtitle: hit.snippet.replace(/<\/?mark>/g, ''),
      section: 'Mesajlar',
      relevance: {
        band: 'secondary',
        score: Math.max(0.1, 1 - index * 0.02),
        contextAffinity:
          context.taskId && hit.taskId === context.taskId
            ? 1
            : context.projectId && hit.projectId === context.projectId
              ? 0.5
              : 0,
      },
    }));
  },
  render: MessagePaletteProviderRow,
};

export const messagePaletteProviderDef: PaletteProviderDef = {
  ...typedMessagePaletteProviderDef,
  render: ({ match, value, onSelect }) => (
    <MessagePaletteProviderRow
      match={match as MessagePaletteMatch}
      value={value}
      onSelect={onSelect}
    />
  ),
};

export const conversationsPaletteProviderDefs = [conversationPaletteProviderDef] as const;
