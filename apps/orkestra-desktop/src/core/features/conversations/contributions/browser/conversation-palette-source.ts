import { getSearchClient, type SearchClient } from '@core/features/search/api/client';
import {
  matchPaletteText,
  type PaletteContext,
  type PaletteProviderMatch,
  type PaletteProviderQuery,
} from '@core/primitives/palette/api';
import type { SearchItem } from '@core/primitives/search/api';

const RECENT_CONVERSATION_LIMIT = 5;
const CONVERSATION_CANDIDATE_LIMIT = 50;

type ConversationSearchClient = Pick<SearchClient, 'searchPaletteEntities'>;
type GetConversationSearchClient = () => Promise<ConversationSearchClient>;

interface ConversationSearchItem extends SearchItem {
  readonly kind: 'conversation';
  readonly projectId: string;
  readonly taskId: string;
}

export interface ConversationPaletteMatch extends PaletteProviderMatch {
  readonly item: ConversationSearchItem;
}

export interface ConversationPaletteSource {
  readonly idle: (context: PaletteContext) => Promise<ConversationPaletteMatch[]>;
  readonly search: (input: PaletteProviderQuery) => Promise<ConversationPaletteMatch[]>;
}

function asContextConversation(item: SearchItem): ConversationSearchItem | undefined {
  if (item.kind !== 'conversation' || !item.projectId || !item.taskId) {
    return undefined;
  }
  return item as ConversationSearchItem;
}

function contextAffinityFor(item: ConversationSearchItem, context: PaletteContext): number {
  if (context.taskId && item.taskId === context.taskId) return 1;
  if (context.projectId && item.projectId === context.projectId) return 0.5;
  return 0;
}

function toIdleMatch(
  item: ConversationSearchItem,
  context: PaletteContext
): ConversationPaletteMatch {
  return {
    id: item.id,
    item,
    title: item.title,
    subtitle: item.subtitle,
    section: 'Recent Conversations',
    relevance: {
      band: 'fuzzy',
      score: 0,
      contextAffinity: contextAffinityFor(item, context),
    },
  };
}

function toTypedMatch(
  item: ConversationSearchItem,
  query: string,
  context: PaletteContext
): ConversationPaletteMatch | undefined {
  const relevance = matchPaletteText(query, { primary: [item.title] });
  if (!relevance) return undefined;
  return {
    id: item.id,
    item,
    title: item.title,
    subtitle: item.subtitle,
    relevance: {
      ...relevance,
      contextAffinity: contextAffinityFor(item, context),
    },
  };
}

export function createConversationPaletteSource(
  getClient: GetConversationSearchClient = getSearchClient
): ConversationPaletteSource {
  return {
    async idle(context) {
      const client = await getClient();
      const candidates =
        (await client.searchPaletteEntities({
          kind: 'conversation',
          query: '',
          context,
          limit: RECENT_CONVERSATION_LIMIT,
        })) ?? [];
      return candidates
        .flatMap((candidate) => {
          const item = asContextConversation(candidate);
          return item ? [toIdleMatch(item, context)] : [];
        })
        .slice(0, RECENT_CONVERSATION_LIMIT);
    },

    async search({ query, context }) {
      const client = await getClient();
      const candidates =
        (await client.searchPaletteEntities({
          kind: 'conversation',
          query,
          context: { ...context, taskId: undefined },
          limit: CONVERSATION_CANDIDATE_LIMIT,
        })) ?? [];
      return candidates.flatMap((candidate) => {
        const item = asContextConversation(candidate);
        if (!item) return [];
        const match = toTypedMatch(item, query, context);
        return match ? [match] : [];
      });
    },
  };
}

export const conversationPaletteSource = createConversationPaletteSource();
