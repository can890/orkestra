import type { HostRef } from '@orkestra/core/primitives/host/api';
import { useMemo } from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgentInstallationStatuses } from '@core/features/agents/api/browser/use-agent-installation-statuses';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { useProviderCapacities } from '@core/features/usage-limits/contributions/browser/use-provider-capacities';
import { agentSupportsAcp } from '@core/primitives/agents/api';
import {
  listHandoffCandidates,
  type HandoffAgentInfo,
  type HandoffCapacities,
} from './handoff-suggestions';

/**
 * Devredilebilecek ajanlar ("Başka ajana devret" penceresiyle aynı kaynak: ajan listesi +
 * kurulum durumu) ve kullanım kapasiteleri. `enabled` false iken kullanım sorgusu yapılmaz.
 */
export function useHandoffAgents(
  connectionId: string | undefined,
  currentProviderId: string | null,
  enabled: boolean
): {
  host: HostRef;
  candidates: HandoffAgentInfo[];
  capacities: HandoffCapacities;
  now: number;
} {
  const host = useMemo(() => hostRefFromConnectionId(connectionId), [connectionId]);
  const { data: agents } = useAgents(host);
  const { data: statuses } = useAgentInstallationStatuses(host);
  const { capacities, now } = useProviderCapacities(host, { enabled });

  const candidates = useMemo(
    () =>
      listHandoffCandidates({
        agents: (agents ?? []).map((agent) => ({
          id: agent.id,
          name: agent.name,
          supportsAcp: agentSupportsAcp(agent.capabilities),
        })),
        installedIds: statuses
          ?.filter((status) => status.status === 'available')
          .map((status) => status.id),
        currentProviderId,
      }),
    [agents, statuses, currentProviderId]
  );

  const handoffCapacities = useMemo<HandoffCapacities>(
    () =>
      Object.fromEntries(
        Object.entries(capacities).map(([id, capacity]) => [
          id,
          { status: capacity.status, resetsAt: capacity.window?.resetsAt },
        ])
      ),
    [capacities]
  );

  return { host, candidates, capacities: handoffCapacities, now };
}
