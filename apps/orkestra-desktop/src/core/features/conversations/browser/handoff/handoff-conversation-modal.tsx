import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import { ModelEffortMenu } from '@orkestra/ui/react/components';
import { Dialog, Field } from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useCallback, useMemo, useState } from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { AgentSelector } from '@core/features/agents/contributions/browser/agent-selector';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { useEffectiveProvider } from '@core/features/conversations/api/browser/use-effective-provider';
import type { HandoffTurn } from '@core/features/conversations/api/handoff-summary';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
import { useModalController } from '@core/manifests/browser/modal-api';
import { agentSupportsAcp } from '@core/primitives/agents/api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import { startConversationHandoff } from './start-handoff';

export const HandoffConversationModal = observer(function HandoffConversationModal({
  projectId,
  taskId,
  sourceConversationId,
  fallbackTurns,
  initialProviderId,
  sourceWorking,
}: {
  projectId: string;
  taskId: string;
  sourceConversationId: string;
  fallbackTurns?: readonly HandoffTurn[];
  /** Mesaj kutusundaki ajan seçiciden gelindiyse hedef ajan önceden seçili açılır. */
  initialProviderId?: AgentProviderId;
  /** Açıldığı anda kaynak sohbetin bir turu sürüyor muydu. */
  sourceWorking?: boolean;
}) {
  const { complete } = useModalController('handoffConversationModal');
  const connectionId = getProjectSshConnectionId(projectId);
  const { providerId, setProviderOverride, createDisabled } = useEffectiveProvider(
    connectionId,
    initialProviderId
  );
  const { data: agents } = useAgents(hostRefFromConnectionId(connectionId));
  const selectedAgent = agents?.find((agent) => agent.id === providerId);
  const acpSupported = agentSupportsAcp(selectedAgent?.capabilities);
  const sourceProviderId = conversationRegistry.get(taskId)?.conversations.get(sourceConversationId)
    ?.data.providerId;
  const sourceAgent = agents?.find((agent) => agent.id === sourceProviderId);
  const modelsCapability = selectedAgent?.capabilities.models;
  const modelOptions = useMemo(
    () => (modelsCapability?.kind === 'selectable' ? modelsCapability.modelOptions : null),
    [modelsCapability]
  );
  // Model seçimi seçili ajana aittir; ajan değişince varsayılan modele dönülür.
  const [modelChoice, setModelChoice] = useState<{ providerId: string; model: string } | null>(
    null
  );
  const selectedModel =
    modelChoice && modelChoice.providerId === providerId && modelOptions?.[modelChoice.model]
      ? modelChoice.model
      : null;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useCloseGuard(isSubmitting);

  const handleSubmit = useCallback(async () => {
    if (!providerId || createDisabled || !acpSupported || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const { conversationId } = await startConversationHandoff({
        projectId,
        taskId,
        sourceConversationId,
        mode: 'handoff',
        providerId,
        sourceProviderLabel: sourceAgent?.name,
        ...(selectedModel ? { model: selectedModel } : {}),
        fallbackTurns,
      });
      setIsSubmitting(false);
      complete({ conversationId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sohbet devredilemedi');
      setIsSubmitting(false);
    }
  }, [
    providerId,
    createDisabled,
    acpSupported,
    isSubmitting,
    projectId,
    taskId,
    sourceConversationId,
    sourceAgent?.name,
    selectedModel,
    fallbackTurns,
    complete,
  ]);

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>
          {initialProviderId ? 'Başka ajanla devam et' : 'Başka ajana devret'}
        </Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <Field.Group>
          <Field.Root>
            <Field.Label>Ajan</Field.Label>
            <AgentSelector
              autoFocus
              value={providerId}
              onChange={(next: AgentProviderId) => setProviderOverride(next)}
              connectionId={connectionId}
            />
          </Field.Root>
          {modelOptions ? (
            <Field.Root>
              <Field.Label>Model</Field.Label>
              <ModelEffortMenu
                appearance="input"
                allowDefault
                defaultLabel="Varsayılan model"
                models={Object.entries(modelOptions).map(([id, option]) => ({ id, ...option }))}
                selectedModel={selectedModel ?? null}
                onSelectModel={(value) =>
                  setModelChoice(value && providerId ? { providerId, model: value } : null)
                }
              />
            </Field.Root>
          ) : null}
          <p className="text-xs text-foreground-muted">
            Bu sohbetin özeti (kullanıcı mesajları, ajanın son yanıtları ve dokunulan dosyalar) aynı
            görevde yeni bir sohbete eklenir; özet yeni ajana talimat değil, önceki konuşmanın kaydı
            olarak gider. Özet otomatik gönderilmez; ilk mesajınızı yazdığınızda (ya da “Kaldığı
            yerden devam et” düğmesine bastığınızda) birlikte gider. Mevcut sohbet yerinde kalır.
            Otomatik onay yeni sohbete kopyalanmaz.
          </p>
          {sourceWorking ? (
            <p className="text-xs text-foreground-warning" role="status">
              Bu sohbette ajan şu anda çalışıyor ve devir onu durdurmaz. Yeni ajan aynı dosyalar
              üzerinde çalışacağı için değişiklikler çakışabilir; gerekirse önce sohbette “Durdur”a
              basın.
            </p>
          ) : null}
          {providerId && !acpSupported && selectedAgent ? (
            <p className="text-destructive text-xs">
              Bu ajan sohbet arayüzünü (ACP) desteklemiyor; devir yapılamaz.
            </p>
          ) : null}
          {error && <p className="text-destructive text-xs">{error}</p>}
        </Field.Group>
      </Dialog.Body>
      <Dialog.Footer>
        <ConfirmButton
          variant="primary"
          onClick={() => void handleSubmit()}
          disabled={isSubmitting || createDisabled || !providerId || !acpSupported}
        >
          {isSubmitting ? 'Devrediliyor...' : 'Devret'}
        </ConfirmButton>
      </Dialog.Footer>
    </>
  );
});

export const handoffConversationModal = defineModal<{ conversationId: string }>()({
  id: 'handoffConversationModal',
  component: HandoffConversationModal,
  ignoreOutsidePressAfterWindowBlur: true,
});
