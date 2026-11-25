import { formatHostRef } from '@orkestra/core/primitives/host/api';
import { ModelEffortMenu } from '@orkestra/ui/react/components';
import { Dialog, Field, Select, Switch } from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { AgentSelector } from '@core/features/agents/contributions/browser/agent-selector';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { nextDefaultConversationTitle } from '@core/features/conversations/api/browser/conversation-title-utils';
import { recordLastUsedAgent } from '@core/features/conversations/api/browser/last-used-agent';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { useEffectiveProvider } from '@core/features/conversations/api/browser/use-effective-provider';
import { resolveDefaultPermissionForProvider } from '@core/features/conversations/api/default-permission-mode';
import { providerPreferencesMemento } from '@core/features/conversations/contributions/mementos';
import { nextOrchestraTitle } from '@core/features/orchestra/api/browser/orchestra-client';
import { getWorkflowsClient } from '@core/features/orchestra/api/browser/workflow-client';
import { ORCHESTRA_AGENT_ID } from '@core/features/orchestra/api/orchestra';
import {
  OrchestraConfigFields,
  useOrchestraDraft,
} from '@core/features/orchestra/contributions/browser/orchestra-config-fields';
import {
  useWorkflowStartDraft,
  WorkflowStartFields,
} from '@core/features/orchestra/contributions/browser/workflow-start-fields';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
// TODO(conversations-extraction): Pass task settings into the modal instead of importing task hooks.
import { useTaskSettings } from '@core/features/tasks/api/browser/hooks/useTaskSettings';
import { openModal, useModalController } from '@core/manifests/browser/modal-api';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import { agentSupportsAcp, agentSupportsAutoApprove } from '@core/primitives/agents/api';
import type { ConversationType } from '@core/primitives/conversations/api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { getMementoClient } from '@core/primitives/mementos/browser';
import { useMemento } from '@core/primitives/mementos/react';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import { useLocalStorage } from '@core/primitives/react-hooks/browser/useLocalStorage';
import {
  patchProviderPreference,
  providerPreference,
  providerPreferenceKey,
} from './provider-preferences';

export const CreateConversationModal = observer(function CreateConversationModal({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const { complete, dismiss } = useModalController('createConversationModal');
  const connectionId = getProjectSshConnectionId(projectId);
  const { providerId, setProviderOverride, createDisabled } = useEffectiveProvider(connectionId);
  const conversationMgr = conversationRegistry.get(taskId);
  const taskSettings = useTaskSettings();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoApproveOverride, setAutoApproveOverride] = useState<boolean | null>(null);
  const [useChatUiPreference, setUseChatUiPreference] = useLocalStorage(
    'initial-conversation:chat-ui-enabled',
    true
  );
  const [providerPreferences, setProviderPreferences] = useMemento(providerPreferencesMemento);
  const [modelOverrides, setModelOverrides] = useState<Record<string, string | null>>({});
  const liveActionDisabledReason = projectAvailabilityUi.getLiveActionDisabledReason(projectId);
  const [orchestraPreferred, setOrchestraPreferred] = useLocalStorage(
    'create-conversation:orchestra-selected',
    false
  );
  const orchestraDraft = useOrchestraDraft(connectionId, taskSettings.autoApproveByDefault);
  // Orkestra has two modes: a conductor LLM decides, or a user-defined deterministic workflow runs.
  const [orchestraMode, setOrchestraMode] = useLocalStorage<'conductor' | 'workflow'>(
    'create-conversation:orchestra-mode',
    'conductor'
  );
  const workflowDraft = useWorkflowStartDraft();
  const workflowMode = orchestraMode === 'workflow';
  const orchestraUnavailableDescription = orchestraDraft.disabledReason;
  const orchestraSelected = orchestraPreferred;
  useCloseGuard(isSubmitting);

  const { data: agents } = useAgents(hostRefFromConnectionId(connectionId));
  const selectedAgent = agents?.find((a) => a.id === providerId);
  const modelsCapability = selectedAgent?.capabilities.models;
  const modelOptions =
    modelsCapability?.kind === 'selectable' ? modelsCapability.modelOptions : null;

  const showAutoApproveToggle = agentSupportsAutoApprove(selectedAgent?.capabilities);
  const showAcpToggle = agentSupportsAcp(selectedAgent?.capabilities);
  const useAcp = showAcpToggle && useChatUiPreference;
  const transport = useAcp ? 'acp' : 'pty';
  const host = formatHostRef(hostRefFromConnectionId(connectionId));
  const preferenceKey = providerId ? providerPreferenceKey(host, providerId, transport) : null;
  const savedPreference = providerId
    ? providerPreference(providerPreferences, host, providerId, transport)
    : undefined;
  const savedModelUnsupported =
    savedPreference?.model !== undefined &&
    modelOptions !== null &&
    modelOptions[savedPreference.model] === undefined;
  const hasModelOverride =
    preferenceKey !== null && Object.prototype.hasOwnProperty.call(modelOverrides, preferenceKey);
  const selectedModel =
    preferenceKey !== null && hasModelOverride
      ? (modelOverrides[preferenceKey] ?? null)
      : savedModelUnsupported
        ? null
        : (savedPreference?.model ?? null);
  const setSelectedModel = useCallback(
    (model: string | null) => {
      if (!preferenceKey) return;
      setModelOverrides((current) => ({ ...current, [preferenceKey]: model }));
    },
    [preferenceKey]
  );
  const defaultPermission = providerId
    ? resolveDefaultPermissionForProvider(providerId, taskSettings.defaultPermissionMode)
    : null;
  const skipPermissions =
    showAutoApproveToggle && (autoApproveOverride ?? defaultPermission?.autoApprove ?? false);
  const resolvedAcpModeId =
    useAcp && providerId
      ? autoApproveOverride === true
        ? resolveDefaultPermissionForProvider(providerId, 'bypass').modeId
        : autoApproveOverride === false
          ? resolveDefaultPermissionForProvider(providerId, 'default').modeId
          : (defaultPermission?.modeId ?? savedPreference?.modeId)
      : undefined;
  const title = providerId
    ? nextDefaultConversationTitle(
        providerId,
        Array.from(
          conversationMgr?.conversations.values() ?? [],
          (conversation) => conversation.data
        )
      )
    : 'Conversation';

  const handleProviderChange = useCallback(
    (next: NonNullable<typeof providerId>) => {
      if (next === ORCHESTRA_AGENT_ID) {
        setOrchestraPreferred(true);
        return;
      }
      setOrchestraPreferred(false);
      setProviderOverride(next);
    },
    [setProviderOverride, setOrchestraPreferred]
  );

  const handleCreateOrchestra = useCallback(async () => {
    const settings = orchestraDraft.settings;
    if (liveActionDisabledReason || isSubmitting || !conversationMgr || !settings) return;
    const id = crypto.randomUUID();
    setIsSubmitting(true);
    setError(null);
    try {
      // Register before the conductor's ACP session attaches; the MCP bridge depends on it.
      await (
        await getConversationsClient()
      ).orchestra.register({ conversationId: id, projectId, taskId, settings });
      await conversationMgr.createConversation({
        projectId,
        taskId,
        id,
        autoApprove: settings.autoApproveWorkers,
        provider: settings.conductorProviderId,
        title: nextOrchestraTitle(
          Array.from(
            conversationMgr.conversations.values(),
            (conversation) => conversation.data.title
          )
        ),
        model: settings.conductorModel ?? undefined,
        type: 'acp',
      });
      setIsSubmitting(false);
      complete({ conversationId: id, type: 'acp' });
    } catch {
      setError('Failed to create the orchestra');
      setIsSubmitting(false);
    }
  }, [
    orchestraDraft.settings,
    liveActionDisabledReason,
    isSubmitting,
    conversationMgr,
    projectId,
    taskId,
    complete,
  ]);

  const handleStartWorkflow = useCallback(async () => {
    const workflow = workflowDraft.selected;
    if (liveActionDisabledReason || isSubmitting || !workflow) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await (
        await getWorkflowsClient()
      ).startRun({
        projectId,
        taskId,
        workflowId: workflow.id,
        input: workflowDraft.input,
        autoApprove: workflowDraft.autoApprove,
        maxConcurrency: workflowDraft.maxConcurrency,
      });
      if (!result.ok) {
        setError(result.errors.join(' '));
        setIsSubmitting(false);
        return;
      }
      setIsSubmitting(false);
      // The run has no conversation of its own: close this modal and show the run view.
      dismiss();
      setTimeout(() => void openModal('workflowRunModal', { runId: result.run.id }), 0);
    } catch {
      setError('Failed to start the workflow');
      setIsSubmitting(false);
    }
  }, [workflowDraft, liveActionDisabledReason, isSubmitting, projectId, taskId, dismiss]);

  const handleCreateConversation = useCallback(async () => {
    if (
      liveActionDisabledReason ||
      createDisabled ||
      isSubmitting ||
      !conversationMgr ||
      !providerId
    ) {
      return;
    }
    const id = crypto.randomUUID();
    setIsSubmitting(true);
    setError(null);
    try {
      const conversationType: ConversationType = useAcp ? 'acp' : 'pty';
      await conversationMgr.createConversation({
        projectId,
        taskId,
        id,
        autoApprove: skipPermissions,
        provider: providerId,
        title,
        model: selectedModel ?? undefined,
        modeId: resolvedAcpModeId,
        effort: conversationType === 'acp' ? savedPreference?.effort : undefined,
        collaborationMode:
          conversationType === 'acp' ? savedPreference?.collaborationMode : undefined,
        type: conversationType,
      });
      try {
        setProviderPreferences((current) =>
          patchProviderPreference(current, host, providerId, conversationType, {
            model: selectedModel,
          })
        );
      } catch (preferenceError) {
        getMementoClient().reportError(preferenceError);
      }
      recordLastUsedAgent({
        providerId,
        model: selectedModel,
        effort: conversationType === 'acp' ? savedPreference?.effort : undefined,
      });
      setIsSubmitting(false);
      complete({ conversationId: id, type: conversationType });
    } catch {
      setError('Failed to create conversation');
      setIsSubmitting(false);
    }
  }, [
    conversationMgr,
    liveActionDisabledReason,
    createDisabled,
    isSubmitting,
    providerId,
    title,
    complete,
    projectId,
    taskId,
    skipPermissions,
    selectedModel,
    useAcp,
    host,
    savedPreference?.effort,
    savedPreference?.collaborationMode,
    resolvedAcpModeId,
    setProviderPreferences,
  ]);

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Create Conversation</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <Field.Group>
          <Field.Root>
            <Field.Label>Agent</Field.Label>
            <AgentSelector
              autoFocus
              value={orchestraSelected ? ORCHESTRA_AGENT_ID : providerId}
              onChange={handleProviderChange}
              connectionId={connectionId}
              orchestra={{ disabledReason: orchestraUnavailableDescription }}
            />
          </Field.Root>
          {orchestraSelected ? (
            <Field.Root>
              <Field.Label>Mod</Field.Label>
              <Select.Root
                value={orchestraMode}
                onValueChange={(value) =>
                  setOrchestraMode(value === 'workflow' ? 'workflow' : 'conductor')
                }
              >
                <Select.Trigger appearance="input" className="w-full">
                  <Select.Value>{workflowMode ? 'İş akışı' : 'Şef (LLM)'}</Select.Value>
                </Select.Trigger>
                <Select.Content align="start" width="trigger">
                  <Select.Item value="conductor">Şef (LLM)</Select.Item>
                  <Select.Item value="workflow">İş akışı</Select.Item>
                </Select.Content>
              </Select.Root>
            </Field.Root>
          ) : null}
          {orchestraSelected && !workflowMode ? (
            <OrchestraConfigFields draft={orchestraDraft} connectionId={connectionId} />
          ) : null}
          {orchestraSelected && workflowMode ? (
            <WorkflowStartFields draft={workflowDraft} connectionId={connectionId} />
          ) : null}
          {!orchestraSelected && modelOptions ? (
            <Field.Root>
              <Field.Label>Model</Field.Label>
              <ModelEffortMenu
                appearance="input"
                allowDefault
                defaultLabel="Varsayılan model"
                models={Object.entries(modelOptions).map(([id, option]) => ({ id, ...option }))}
                selectedModel={selectedModel ?? null}
                onSelectModel={(value) => setSelectedModel(value || null)}
              />
            </Field.Root>
          ) : null}
          {!orchestraSelected && showAutoApproveToggle ? (
            <Field.Root>
              <div className="flex items-center gap-2">
                <Switch
                  checked={skipPermissions}
                  disabled={!providerId || taskSettings.loading || taskSettings.saving}
                  onCheckedChange={setAutoApproveOverride}
                />
                <Field.Label>Auto-approve permissions</Field.Label>
              </div>
            </Field.Root>
          ) : null}
          {!orchestraSelected && showAcpToggle ? (
            <Field.Root>
              <div className="flex items-center gap-2">
                <Switch checked={useAcp} onCheckedChange={setUseChatUiPreference} />
                <Field.Label>Use chat UI</Field.Label>
              </div>
            </Field.Root>
          ) : null}
          {error && <p className="text-destructive text-xs">{error}</p>}
          {liveActionDisabledReason && (
            <p className="text-xs text-foreground-muted" role="note" tabIndex={0}>
              {liveActionDisabledReason}
            </p>
          )}
        </Field.Group>
      </Dialog.Body>
      <Dialog.Footer>
        <ConfirmButton
          variant="primary"
          onClick={() =>
            void (orchestraSelected
              ? workflowMode
                ? handleStartWorkflow()
                : handleCreateOrchestra()
              : handleCreateConversation())
          }
          disabled={
            Boolean(liveActionDisabledReason) ||
            isSubmitting ||
            (orchestraSelected
              ? workflowMode
                ? !workflowDraft.selected
                : !orchestraDraft.settings
              : createDisabled)
          }
        >
          {isSubmitting ? 'Creating...' : orchestraSelected && workflowMode ? 'Çalıştır' : 'Create'}
        </ConfirmButton>
      </Dialog.Footer>
    </>
  );
});

export const createConversationModal = defineModal<{
  conversationId: string;
  type: ConversationType;
}>()({
  id: 'createConversationModal',
  component: CreateConversationModal,
  ignoreOutsidePressAfterWindowBlur: true,
});
