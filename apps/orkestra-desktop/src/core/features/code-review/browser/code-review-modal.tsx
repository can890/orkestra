import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import {
  Checkbox,
  Dialog,
  Field,
  Label,
  Select,
  Switch,
  Textarea,
} from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgentInstallationStatuses } from '@core/features/agents/api/browser/use-agent-installation-statuses';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { AgentSelector } from '@core/features/agents/contributions/browser/agent-selector';
import {
  REVIEW_FOCUS_AREAS,
  REVIEW_SCOPES,
  isReviewScope,
  type ReviewFocus,
  type ReviewScope,
} from '@core/features/code-review/api/review-model';
import {
  pickDefaultReviewer,
  pickMainConversation,
  type ReviewerCandidate,
} from '@core/features/code-review/api/review-participants';
import { MAX_REVIEW_INSTRUCTIONS_LENGTH } from '@core/features/code-review/api/review-prompt';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
import { useModalController } from '@core/manifests/browser/modal-api';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import { agentSupportsAcp, agentSupportsAutoApprove } from '@core/primitives/agents/api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import { FOCUS_LABELS, SCOPE_LABELS } from './review-labels';
import {
  codeReviewSettingsReady,
  getProjectReviewSettings,
  updateProjectReviewSettings,
} from './review-settings';
import { startCodeReview } from './start-code-review';

const NOT_ACP_REASON = 'Bu ajan sohbet arayüzünü (ACP) desteklemiyor';

export const CodeReviewModal = observer(function CodeReviewModal({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const { complete } = useModalController('codeReviewModal');
  const connectionId = getProjectSshConnectionId(projectId);
  const host = hostRefFromConnectionId(connectionId);
  const { data: agents } = useAgents(host);
  const { data: statuses } = useAgentInstallationStatuses(host);
  const manager = conversationRegistry.get(taskId);
  const liveActionDisabledReason = projectAvailabilityUi.getLiveActionDisabledReason(projectId);

  const [settingsLoaded, setSettingsLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void codeReviewSettingsReady()
      .catch(() => {})
      .then(() => {
        if (!cancelled) setSettingsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const saved = getProjectReviewSettings(projectId);

  const main = pickMainConversation(
    Array.from(manager?.conversations.values() ?? [], (conversation) => conversation.data)
  );
  const mainProviderId = main?.providerId ?? null;
  const mainModel = main?.model ?? null;

  // Kurulu ve ACP destekleyen ajanlar inceleyici adayıdır.
  const candidates = useMemo<ReviewerCandidate[]>(() => {
    const installed = new Set(
      (statuses ?? []).filter((status) => status.status === 'available').map((status) => status.id)
    );
    return (agents ?? [])
      .filter((agent) => agentSupportsAcp(agent.capabilities))
      .filter((agent) => installed.size === 0 || installed.has(agent.id))
      .map((agent) => ({
        providerId: agent.id,
        models:
          agent.capabilities.models.kind === 'selectable'
            ? Object.keys(agent.capabilities.models.modelOptions)
            : [],
      }));
  }, [agents, statuses]);

  // Kaydedilen inceleyici ana konuşmadan farklıysa korunur; değilse farklı bir ajan/model seçilir.
  const defaultReviewer = useMemo(() => {
    const savedProvider = saved.providerId;
    if (
      savedProvider !== null &&
      savedProvider !== mainProviderId &&
      candidates.some((candidate) => candidate.providerId === savedProvider)
    ) {
      return { providerId: savedProvider, model: saved.model };
    }
    return pickDefaultReviewer(
      candidates,
      mainProviderId ? { providerId: mainProviderId, model: mainModel } : null
    );
  }, [candidates, mainProviderId, mainModel, saved.providerId, saved.model]);

  const [providerOverride, setProviderOverride] = useState<string | null>(null);
  const [modelOverride, setModelOverride] = useState<{ value: string | null } | null>(null);
  const [scopeOverride, setScopeOverride] = useState<ReviewScope | null>(null);
  const [focusOverride, setFocusOverride] = useState<ReviewFocus[] | null>(null);
  const [instructionsOverride, setInstructionsOverride] = useState<string | null>(null);
  const [autoApproveOverride, setAutoApproveOverride] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useCloseGuard(submitting);

  const providerId = providerOverride ?? defaultReviewer?.providerId ?? null;
  const agent = agents?.find((candidate) => candidate.id === providerId);
  const modelOptions =
    agent?.capabilities.models.kind === 'selectable'
      ? agent.capabilities.models.modelOptions
      : null;
  const defaultModel =
    providerOverride === null && defaultReviewer?.model && modelOptions?.[defaultReviewer.model]
      ? defaultReviewer.model
      : null;
  const model = modelOverride ? modelOverride.value : defaultModel;
  const scope = scopeOverride ?? saved.scope;
  const focus = focusOverride ?? saved.focus;
  const instructions = instructionsOverride ?? saved.instructions;
  const showAutoApprove = agentSupportsAutoApprove(agent?.capabilities);
  const autoApprove = showAutoApprove && (autoApproveOverride ?? saved.autoApprove);
  const sameAsMain = main !== null && providerId === mainProviderId && model === mainModel;

  const currentSelection = () => ({
    providerId,
    model,
    scope,
    focus,
    instructions,
    autoApprove,
  });

  const toggleFocus = (area: ReviewFocus, checked: boolean) => {
    const next = checked ? [...new Set([...focus, area])] : focus.filter((item) => item !== area);
    setFocusOverride(REVIEW_FOCUS_AREAS.filter((item) => next.includes(item)));
  };

  const setAutoReview = (enabled: boolean) => {
    updateProjectReviewSettings(projectId, { ...currentSelection(), autoReview: enabled });
  };

  const disabledReason =
    liveActionDisabledReason ??
    (!manager ? 'Görev henüz hazır değil.' : null) ??
    (!providerId ? 'İnceleme için sohbet arayüzünü destekleyen kurulu bir ajan gerekli.' : null);

  const submit = async () => {
    if (disabledReason || submitting || !providerId) return;
    setSubmitting(true);
    setError(null);
    try {
      updateProjectReviewSettings(projectId, currentSelection());
      const { conversationId } = await startCodeReview({
        projectId,
        taskId,
        providerId: providerId as AgentProviderId,
        model,
        scope,
        focus,
        instructions,
        autoApprove,
        open: true,
      });
      setSubmitting(false);
      complete({ conversationId });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSubmitting(false);
    }
  };

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Değişiklikleri incele</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <Field.Group>
          <Field.Root>
            <Field.Label>İnceleyici ajan</Field.Label>
            <AgentSelector
              autoFocus
              value={providerId as AgentProviderId | null}
              onChange={(next) => {
                setProviderOverride(next);
                setModelOverride(null);
              }}
              connectionId={connectionId}
              installable={false}
              getDisabledReason={(candidate) =>
                agentSupportsAcp(candidate.capabilities) ? null : NOT_ACP_REASON
              }
            />
          </Field.Root>
          {modelOptions ? (
            <Field.Root>
              <Field.Label>Model</Field.Label>
              <Select.Root
                value={model ?? ''}
                onValueChange={(value) => setModelOverride({ value: value || null })}
              >
                <Select.Trigger appearance="input" className="w-full">
                  <Select.Value placeholder="Varsayılan model">
                    {model ? (modelOptions[model]?.name ?? model) : 'Varsayılan model'}
                  </Select.Value>
                </Select.Trigger>
                <Select.Content align="start" width="trigger">
                  <Select.Item value="">Varsayılan model</Select.Item>
                  {Object.entries(modelOptions).map(([id, option]) => (
                    <Select.Item key={id} value={id}>
                      {option.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Field.Root>
          ) : null}
          {sameAsMain ? (
            <p className="text-xs text-foreground-muted" role="note">
              İnceleyici, görevin ana konuşmasıyla aynı ajan ve modeli kullanıyor; bağımsız bir göz
              için farklı bir ajan seçebilirsiniz.
            </p>
          ) : null}
          <Field.Root>
            <Field.Label>Kapsam</Field.Label>
            <Select.Root
              value={scope}
              onValueChange={(value) => {
                if (isReviewScope(value)) setScopeOverride(value);
              }}
            >
              <Select.Trigger appearance="input" className="w-full">
                <Select.Value>{SCOPE_LABELS[scope]}</Select.Value>
              </Select.Trigger>
              <Select.Content align="start" width="trigger">
                {REVIEW_SCOPES.map((item) => (
                  <Select.Item key={item} value={item}>
                    {SCOPE_LABELS[item]}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Field.Root>
          <Field.Root>
            <Field.Label>Odak</Field.Label>
            <div className="flex flex-wrap gap-4">
              {REVIEW_FOCUS_AREAS.map((area) => (
                <Label key={area} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={focus.includes(area)}
                    onCheckedChange={(checked) => toggleFocus(area, checked === true)}
                  />
                  {FOCUS_LABELS[area]}
                </Label>
              ))}
            </div>
          </Field.Root>
          <Field.Root>
            <Field.Label>Ek talimatlar (isteğe bağlı)</Field.Label>
            <Textarea
              value={instructions}
              maxLength={MAX_REVIEW_INSTRUCTIONS_LENGTH}
              rows={3}
              placeholder="Ör. SSH kaçışlarına ve hata yollarına özellikle bak."
              onChange={(event) => setInstructionsOverride(event.target.value)}
            />
          </Field.Root>
          {showAutoApprove ? (
            <Field.Root>
              <div className="flex items-center gap-2">
                <Switch checked={autoApprove} onCheckedChange={setAutoApproveOverride} />
                <Field.Label>İzinleri otomatik onayla</Field.Label>
              </div>
            </Field.Root>
          ) : null}
          <Field.Root>
            <div className="flex items-center gap-2">
              <Switch
                checked={saved.autoReview}
                disabled={!settingsLoaded || !providerId}
                onCheckedChange={setAutoReview}
              />
              <Field.Label>Ajan turu bitince otomatik incele (bu proje)</Field.Label>
            </div>
            <p className="text-xs text-foreground-muted">
              Ana konuşmanın turu değişiklik üreterek bittiğinde bu ayarlarla bir inceleme
              başlatılır. Görev başına aynı anda en fazla bir inceleme çalışır.
            </p>
          </Field.Root>
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
          {disabledReason ? (
            <p className="text-xs text-foreground-muted" role="note">
              {disabledReason}
            </p>
          ) : null}
        </Field.Group>
      </Dialog.Body>
      <Dialog.Footer>
        <ConfirmButton
          variant="primary"
          onClick={() => void submit()}
          disabled={Boolean(disabledReason) || submitting}
        >
          {submitting ? 'Başlatılıyor…' : 'İncelemeyi başlat'}
        </ConfirmButton>
      </Dialog.Footer>
    </>
  );
});

export const codeReviewModal = defineModal<{ conversationId: string }>()({
  id: 'codeReviewModal',
  component: CodeReviewModal,
  ignoreOutsidePressAfterWindowBlur: true,
});
