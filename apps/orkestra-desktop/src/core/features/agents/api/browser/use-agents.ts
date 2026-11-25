import { hostRefKey, type HostRef } from '@orkestra/core/primitives/host/api';
import type { RuntimeResolveError } from '@orkestra/core/services/runtime-broker/api';
import { useQuery } from '@tanstack/react-query';
import { rememberAgentDisplayNames } from '@core/features/agents/api/browser/agent-display-names';
import { getAgentsClient, unwrapAgentsResult } from '@core/features/agents/api/browser/client';
import type { AgentPayload } from '@core/primitives/agents/api';

export const AGENTS_METADATA_QUERY_KEY = ['agents', 'metadata'] as const;

export function useAgents(host: HostRef) {
  return useQuery<AgentPayload[], RuntimeResolveError>({
    queryKey: [...AGENTS_METADATA_QUERY_KEY, hostRefKey(host)],
    queryFn: async () => {
      const agents = await unwrapAgentsResult((await getAgentsClient()).list({ host }));
      rememberAgentDisplayNames(agents);
      return agents;
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useAgent(id: string, host: HostRef) {
  return useQuery<AgentPayload | null, RuntimeResolveError>({
    queryKey: [...AGENTS_METADATA_QUERY_KEY, hostRefKey(host), id],
    queryFn: async () => unwrapAgentsResult((await getAgentsClient()).get({ host, id })),
    staleTime: 5 * 60 * 1000,
  });
}
