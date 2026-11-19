import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import { Dialog, Field } from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { AgentSelector } from '@core/features/agents/contributions/browser/agent-selector';
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
}: {
  projectId: string;
  taskId: string;
  sourceConversationId: string;
  fallbackTurns?: readonly HandoffTurn[];
}) {
  const { complete } = useModalController('handoffConversationModal');
  const connectionId = getProjectSshConnectionId(projectId);
  const { providerId, setProviderOverride, createDisabled } = useEffectiveProvider(connectionId);
  const { data: agents } = useAgents(hostRefFromConnectionId(connectionId));
  const selectedAgent = agents?.find((agent) => agent.id === providerId);
  const acpSupported = agentSupportsAcp(selectedAgent?.capabilities);
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
        providerLabel: selectedAgent?.name,
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
    selectedAgent?.name,
    fallbackTurns,
    complete,
  ]);

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Başka ajana devret</Dialog.Title>
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
          <p className="text-xs text-foreground-muted">
            Bu sohbetin özeti (kullanıcı mesajları, ajanın son yanıtları ve dokunulan dosyalar) aynı
            görevde yeni bir sohbete eklenir. Özet otomatik gönderilmez; ilk mesajınızı yazdığınızda
            birlikte gider. Mevcut sohbet değişmez.
          </p>
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
