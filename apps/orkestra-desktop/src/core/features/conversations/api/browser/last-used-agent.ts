import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import { getAgentsClient, hostRefFromConnectionId, unwrapAgentsResult } from '@core/features/agents/api/browser/client';
import {
  agentSupportsAcp,
  agentSupportsAutoApprove,
  type AgentPayload,
} from '@core/primitives/agents/api';
import type { Conversation } from '@core/primitives/conversations/api';
import { getConversationsClient } from './client';
import { isSupersededConversation } from './handoff-visibility';

const STORAGE_KEY = 'orkestra:last-used-agent:v1';

export type LastUsedAgentRecord = {
  providerId: AgentProviderId;
  model?: string;
  effort?: string;
  updatedAt: number;
};

export type OrderedAgentDescriptor = {
  id: AgentProviderId;
  supportsAcp: boolean;
};

export type PickMostRecentAgentParams = {
  cached: LastUsedAgentRecord | null;
  conversations: readonly Conversation[];
  supersededIds?: ReadonlySet<string>;
  orderedAgents: readonly OrderedAgentDescriptor[];
  installedProviderIds: readonly AgentProviderId[];
  availabilityKnown: boolean;
  defaultAgent?: AgentProviderId | null;
};

export type PickedAgentResult = {
  providerId: AgentProviderId | null;
  model?: string;
  effort?: string;
};

export type ResolvedLastUsedAgent = PickedAgentResult & {
  supportsAcp: boolean;
  supportsAutoApprove: boolean;
};

function sanitizeOptionalOption(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '__default__') return undefined;
  return trimmed;
}

function parseTimestampMs(raw: string | null | undefined): number {
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function readStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function readLastUsedAgent(): LastUsedAgentRecord | null {
  const storage = readStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastUsedAgentRecord> | null;
    if (!parsed || typeof parsed.providerId !== 'string' || !parsed.providerId.trim()) {
      return null;
    }
    const model = sanitizeOptionalOption(parsed.model);
    const effort = sanitizeOptionalOption(parsed.effort);
    const updatedAt =
      typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0;
    return {
      providerId: parsed.providerId.trim() as AgentProviderId,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      updatedAt,
    };
  } catch {
    return null;
  }
}

export function recordLastUsedAgent(input: {
  providerId: AgentProviderId | string | null | undefined;
  model?: string | null;
  effort?: string | null;
}): void {
  const providerId = typeof input.providerId === 'string' ? input.providerId.trim() : '';
  if (!providerId) return;

  const storage = readStorage();
  if (!storage) return;

  const prev = readLastUsedAgent();
  const sameProvider = prev?.providerId === providerId;

  const model =
    input.model === undefined
      ? sameProvider
        ? prev?.model
        : undefined
      : sanitizeOptionalOption(input.model);

  const effort =
    input.effort === undefined
      ? sameProvider
        ? prev?.effort
        : undefined
      : sanitizeOptionalOption(input.effort);

  const next: LastUsedAgentRecord = {
    providerId: providerId as AgentProviderId,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    updatedAt: Date.now(),
  };

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Depolama kotası veya kısıtlı ortamlarda sessizce yok say.
  }
}

export function pickMostRecentAvailableAgent({
  cached,
  conversations,
  supersededIds,
  orderedAgents,
  installedProviderIds,
  availabilityKnown,
  defaultAgent,
}: PickMostRecentAgentParams): PickedAgentResult {
  const knownIds = new Set(orderedAgents.map((a) => a.id));
  const installedSet = new Set(installedProviderIds);

  const isAvailable = (providerId: string | null | undefined): providerId is AgentProviderId => {
    if (!providerId) return false;
    if (!knownIds.has(providerId as AgentProviderId)) return false;
    return !availabilityKnown || installedSet.has(providerId as AgentProviderId);
  };

  const candidates = conversations
    .map((conversation, index) => ({ conversation, index }))
    .filter(
      ({ conversation }) =>
        Boolean(conversation.providerId) && !(supersededIds?.has(conversation.id) ?? false)
    )
    .sort((a, b) => {
      const diff =
        parseTimestampMs(b.conversation.lastInteractedAt) -
        parseTimestampMs(a.conversation.lastInteractedAt);
      return diff !== 0 ? diff : b.index - a.index;
    });

  const topTimestamp = candidates[0]
    ? parseTimestampMs(candidates[0].conversation.lastInteractedAt)
    : 0;

  if (cached && cached.updatedAt >= topTimestamp && isAvailable(cached.providerId)) {
    return {
      providerId: cached.providerId,
      ...(cached.model ? { model: cached.model } : {}),
      ...(cached.effort ? { effort: cached.effort } : {}),
    };
  }

  for (const { conversation } of candidates) {
    if (!isAvailable(conversation.providerId)) continue;
    const model = sanitizeOptionalOption(conversation.model);
    const effort = sanitizeOptionalOption(conversation.effort);
    return {
      providerId: conversation.providerId,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
  }

  if (cached && isAvailable(cached.providerId)) {
    return {
      providerId: cached.providerId,
      ...(cached.model ? { model: cached.model } : {}),
      ...(cached.effort ? { effort: cached.effort } : {}),
    };
  }

  if (defaultAgent && isAvailable(defaultAgent)) {
    return { providerId: defaultAgent };
  }

  const firstInstalledAcp = orderedAgents.find((a) => a.supportsAcp && isAvailable(a.id));
  if (firstInstalledAcp) {
    return { providerId: firstInstalledAcp.id };
  }

  const firstInstalled = orderedAgents.find((a) => isAvailable(a.id));
  if (firstInstalled) {
    return { providerId: firstInstalled.id };
  }

  return { providerId: null };
}

export async function resolveLastUsedAgentForHost(params: {
  connectionId?: string;
  defaultAgent?: AgentProviderId | null;
}): Promise<ResolvedLastUsedAgent> {
  const host = hostRefFromConnectionId(params.connectionId);
  const cached = readLastUsedAgent();

  let agents: AgentPayload[] = [];
  let installedProviderIds: AgentProviderId[] = [];
  let availabilityKnown = false;
  let conversations: Conversation[] = [];

  try {
    const agentsClient = await getAgentsClient();
    const [listedAgents, statuses, liveConversations] = await Promise.all([
      unwrapAgentsResult(agentsClient.list({ host })).catch((): AgentPayload[] => []),
      unwrapAgentsResult(agentsClient.listAgentInstallationStatus({ host }))
        .then((list) => ({ ok: true as const, list }))
        .catch(() => ({ ok: false as const, list: [] })),
      getConversationsClient()
        .then((client) => client.getConversations())
        .catch((): Conversation[] => []),
    ]);

    agents = listedAgents;
    if (statuses.ok) {
      availabilityKnown = true;
      installedProviderIds = statuses.list
        .filter((s) => s.status === 'available')
        .map((s) => s.id as AgentProviderId);
    }
    conversations = liveConversations;
  } catch {
    // Bağlantı hatasında önbellek ve varsayılan değerlere düş.
  }

  if (agents.length === 0) {
    const fallbackProvider = cached?.providerId ?? params.defaultAgent ?? null;
    return {
      providerId: fallbackProvider,
      ...(cached && cached.providerId === fallbackProvider && cached.model
        ? { model: cached.model }
        : {}),
      ...(cached && cached.providerId === fallbackProvider && cached.effort
        ? { effort: cached.effort }
        : {}),
      supportsAcp: true,
      supportsAutoApprove: false,
    };
  }

  const supersededIds = new Set<string>();
  for (const conversation of conversations) {
    if (isSupersededConversation(conversation.id)) {
      supersededIds.add(conversation.id);
    }
  }

  const orderedAgents: OrderedAgentDescriptor[] = agents.map((agent) => ({
    id: agent.id as AgentProviderId,
    supportsAcp: agentSupportsAcp(agent.capabilities),
  }));

  const picked = pickMostRecentAvailableAgent({
    cached,
    conversations,
    supersededIds,
    orderedAgents,
    installedProviderIds,
    availabilityKnown,
    defaultAgent: params.defaultAgent,
  });

  const matchedAgent = picked.providerId
    ? agents.find((agent) => agent.id === picked.providerId)
    : undefined;

  return {
    ...picked,
    supportsAcp: agentSupportsAcp(matchedAgent?.capabilities),
    supportsAutoApprove: agentSupportsAutoApprove(matchedAgent?.capabilities),
  };
}
