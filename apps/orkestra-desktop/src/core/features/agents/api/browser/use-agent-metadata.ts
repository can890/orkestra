import { useQuery } from '@tanstack/react-query';
import { rememberAgentDisplayNames } from '@core/features/agents/api/browser/agent-display-names';
import { getAgentsClient } from '@core/features/agents/api/browser/client';
import type { AgentMetadata } from '@core/primitives/agents/api';

export const AGENT_STATIC_METADATA_QUERY_KEY = ['agents', 'static-metadata'] as const;

/**
 * Static plugin-registry metadata (icons, display names, capabilities schema).
 * Host-independent by construction — use this for display-only consumers so the
 * host-carrying hooks (`useAgents` et al.) can require a host without exceptions.
 */
export function useAgentMetadata() {
  return useQuery<AgentMetadata[]>({
    queryKey: AGENT_STATIC_METADATA_QUERY_KEY,
    queryFn: async () => {
      const agents = await (await getAgentsClient()).listMetadata(undefined);
      rememberAgentDisplayNames(agents);
      return agents;
    },
    staleTime: Infinity,
  });
}

export function useAgentIcon(id: string) {
  const { data: agents } = useAgentMetadata();
  return agents?.find((candidate) => candidate.id === id)?.icon ?? null;
}
