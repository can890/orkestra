import { asAgentProviderId, type AgentProviderId } from '@orkestra/plugins/agents/types';
import { Checkbox, Field, Input, Select, Switch, Textarea } from '@orkestra/ui/react/primitives';
import { useMemo } from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgentAvailability } from '@core/features/agents/api/browser/components/agent-selector/use-agent-availability';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { AgentSelector } from '@core/features/agents/contributions/browser/agent-selector';
import type {
  OrchestraSettings,
  OrchestraWorkerAgent,
} from '@core/features/orchestra/api/orchestra';
import { agentSupportsAcp } from '@core/primitives/agents/api';
import { useLocalStorage } from '@core/primitives/react-hooks/browser/useLocalStorage';

type OrchestraPreferences = {
  conductorProviderId: string | null;
  conductorModel: string | null;
  /** Kullanıcının kapattığı işçiler; yeni kurulan ajanlar varsayılan olarak açık gelir. */
  excludedWorkers: string[];
  maxParallel: number;
  autoApproveWorkers: boolean | null;
  routingNotes: string;
};

const DEFAULT_PREFERENCES: OrchestraPreferences = {
  conductorProviderId: null,
  conductorModel: null,
  excludedWorkers: [],
  maxParallel: 0,
  autoApproveWorkers: null,
  routingNotes: '',
};

const PREFERRED_CONDUCTORS = ['claude', 'codex', 'antigravity', 'kimi', 'grok', 'glm'];
const CONDUCTOR_UNSUPPORTED_DESCRIPTION = 'Chat UI (ACP) support is required';

export type OrchestraDraft = ReturnType<typeof useOrchestraDraft>;

/** Orkestra modal durumunu ve kurulu, ACP destekli ajanlardan türetilen ayarları yönetir. */
export function useOrchestraDraft(connectionId: string | undefined, autoApproveDefault: boolean) {
  const [preferences, setPreferences] = useLocalStorage<OrchestraPreferences>(
    'orchestra:preferences',
    DEFAULT_PREFERENCES
  );
  const { data: agents } = useAgents(hostRefFromConnectionId(connectionId));
  const { groups } = useAgentAvailability({ connectionId, value: null });

  const candidates = useMemo<OrchestraWorkerAgent[]>(() => {
    const installed = groups.find((group) => group.value === 'installed')?.items ?? [];
    return installed
      .filter((item) => item.supportsAcp && !item.disabled)
      .map((item) => {
        const agent = agents?.find((candidate) => candidate.id === item.agentId);
        const models = agent?.capabilities.models;
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

  const conductor =
    candidates.find((candidate) => candidate.providerId === preferences.conductorProviderId) ??
    PREFERRED_CONDUCTORS.map((id) => candidates.find((c) => c.providerId === id)).find(Boolean) ??
    candidates[0] ??
    null;
  const conductorModel =
    conductor && conductor.models.some((model) => model.id === preferences.conductorModel)
      ? preferences.conductorModel
      : null;
  const excluded = new Set(preferences.excludedWorkers);
  const workers = candidates.filter((candidate) => !excluded.has(candidate.providerId));
  const autoApproveWorkers = preferences.autoApproveWorkers ?? autoApproveDefault;

  const settings: OrchestraSettings | null =
    conductor && workers.length > 0
      ? {
          conductorProviderId: conductor.providerId,
          conductorModel,
          workers,
          maxParallel: preferences.maxParallel,
          autoApproveWorkers,
          routingNotes: preferences.routingNotes,
        }
      : null;

  const disabledDescription =
    candidates.length === 0
      ? 'Install at least one agent with chat UI support to use the orchestra'
      : workers.length === 0
        ? 'Select at least one worker agent'
        : null;

  const update = (patch: Partial<OrchestraPreferences>) =>
    setPreferences((current) => ({ ...current, ...patch }));

  return {
    candidates,
    conductor,
    conductorModel,
    workers,
    excluded,
    autoApproveWorkers,
    preferences,
    settings,
    disabledReason: disabledDescription,
    setConductor: (providerId: AgentProviderId) =>
      update({ conductorProviderId: providerId, conductorModel: null }),
    setConductorModel: (model: string | null) => update({ conductorModel: model }),
    toggleWorker: (providerId: string, enabled: boolean) =>
      update({
        excludedWorkers: enabled
          ? preferences.excludedWorkers.filter((id) => id !== providerId)
          : [...new Set([...preferences.excludedWorkers, providerId])],
      }),
    setMaxParallel: (value: number) => update({ maxParallel: value }),
    setAutoApproveWorkers: (value: boolean) => update({ autoApproveWorkers: value }),
    setRoutingNotes: (value: string) => update({ routingNotes: value }),
  };
}

export function OrchestraConfigFields({
  draft,
  connectionId,
}: {
  draft: OrchestraDraft;
  connectionId: string | undefined;
}) {
  const { conductor, conductorModel } = draft;
  const conductorModelLabel = conductorModel
    ? (conductor?.models.find((model) => model.id === conductorModel)?.name ?? conductorModel)
    : 'Default model';
  const parallelLabel = 'Max parallel workers (0 = unlimited)';
  const notesPlaceholder =
    'e.g. Use Codex for backend and tests, Antigravity for UI, Claude for final review.';

  return (
    <>
      <p className="text-xs text-foreground-muted">
        A decision-maker agent plans the work, picks the best agent and model for each subtask, runs
        them in parallel and verifies the results. Every worker appears as its own conversation.
      </p>
      <Field.Root>
        <Field.Label>Decision-maker</Field.Label>
        <AgentSelector
          value={conductor ? asAgentProviderId(conductor.providerId) : null}
          onChange={draft.setConductor}
          connectionId={connectionId}
          installable={false}
          getDisabledReason={(agent) =>
            agentSupportsAcp(agent.capabilities) ? null : CONDUCTOR_UNSUPPORTED_DESCRIPTION
          }
        />
      </Field.Root>
      {conductor && conductor.models.length > 0 ? (
        <Field.Root>
          <Field.Label>Decision-maker model</Field.Label>
          <Select.Root
            value={conductorModel ?? ''}
            onValueChange={(value) => draft.setConductorModel(value || null)}
          >
            <Select.Trigger appearance="input" className="w-full">
              <Select.Value placeholder="Default model">{conductorModelLabel}</Select.Value>
            </Select.Trigger>
            <Select.Content align="start" width="trigger">
              <Select.Item value="">Default model</Select.Item>
              {conductor.models.map((model) => (
                <Select.Item key={model.id} value={model.id}>
                  {model.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Field.Root>
      ) : null}
      <Field.Root>
        <Field.Label>Worker agents</Field.Label>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          {draft.candidates.map((candidate) => (
            <label
              key={candidate.providerId}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <Checkbox
                checked={!draft.excluded.has(candidate.providerId)}
                onCheckedChange={(checked) =>
                  draft.toggleWorker(candidate.providerId, Boolean(checked))
                }
              />
              <AgentIcon id={candidate.providerId} size={14} className="rounded-sm" />
              <span className="truncate">{candidate.name}</span>
            </label>
          ))}
        </div>
      </Field.Root>
      <Field.Root>
        <Field.Label>{parallelLabel}</Field.Label>
        <Input
          type="number"
          min={0}
          max={1000}
          value={String(draft.preferences.maxParallel)}
          onChange={(event) => {
            const value = Number.parseInt(event.target.value, 10);
            draft.setMaxParallel(Number.isFinite(value) ? Math.min(1000, Math.max(0, value)) : 0);
          }}
        />
      </Field.Root>
      <Field.Root>
        <Field.Label>Routing preferences (optional)</Field.Label>
        <Textarea
          rows={3}
          value={draft.preferences.routingNotes}
          placeholder={notesPlaceholder}
          onChange={(event) => draft.setRoutingNotes(event.target.value)}
        />
      </Field.Root>
      <Field.Root>
        <div className="flex items-center gap-2">
          <Switch
            checked={draft.autoApproveWorkers}
            onCheckedChange={draft.setAutoApproveWorkers}
          />
          <Field.Label>Auto-approve agent permissions</Field.Label>
        </div>
      </Field.Root>
    </>
  );
}
