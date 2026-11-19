import { useMemo } from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgentAvailability } from '@core/features/agents/api/browser/components/agent-selector/use-agent-availability';
import { useAgents } from '@core/features/agents/api/browser/use-agents';

export type WorkflowAgentOption = {
  providerId: string;
  name: string;
  models: Array<{ id: string; name: string }>;
};

/** Kurulu ve sohbet arayüzü (ACP) destekleyen ajanlar; iş akışı adımları yalnızca bunları kullanır. */
export function useWorkflowAgents(connectionId: string | undefined): WorkflowAgentOption[] {
  const { data: agents } = useAgents(hostRefFromConnectionId(connectionId));
  const { groups } = useAgentAvailability({ connectionId, value: null });
  return useMemo(() => {
    const installed = groups.find((group) => group.value === 'installed')?.items ?? [];
    return installed
      .filter((item) => item.supportsAcp && !item.disabled)
      .map((item) => {
        const models = agents?.find((candidate) => candidate.id === item.agentId)?.capabilities
          .models;
        return {
          providerId: item.agentId,
          name: item.label,
          models:
            models?.kind === 'selectable'
              ? Object.entries(models.modelOptions).map(([id, option]) => ({
                  id,
                  name: option.name,
                }))
              : [],
        };
      });
  }, [agents, groups]);
}
