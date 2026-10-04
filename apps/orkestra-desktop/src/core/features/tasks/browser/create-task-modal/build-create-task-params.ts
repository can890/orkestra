import { nextDefaultConversationTitle } from '@core/features/conversations/api/browser/conversation-title-utils';
import type { InitialConversationState } from '@core/features/tasks/contributions/browser/task-config/initial-conversation-section';
import { extractIssueMentionTargets } from '@core/primitives/issues/api';
import type { TaskConfig } from '@core/primitives/tasks/api';
import type { TaskLifecycleStatus } from '@core/primitives/tasks/api';
import type { PullRequest } from '@core/services/pull-requests/api';
import { buildFinalPrompt } from './initial-conversation-text';
import type { LinkedType } from './use-create-task-state';

function buildInitialQueue(state: InitialConversationState) {
  const text = state.prompt.trim();
  if (!text) return undefined;

  const hiddenContextParts: string[] = [];
  if (state.issueContext?.trim()) {
    hiddenContextParts.push(state.issueContext.trim());
  }

  const targets = extractIssueMentionTargets(state.prompt);
  for (const target of targets) {
    const context = state.issueMentionContexts[target.token];
    if (context?.trim()) hiddenContextParts.push(context.trim());
  }

  const hiddenContext = hiddenContextParts.join('\n\n').trim();
  return [
    {
      text: state.prompt,
      ...(hiddenContext && { hiddenContext }),
    },
  ];
}

export function buildInitialConversation(
  state: InitialConversationState
): NonNullable<TaskConfig['initialConversation']> | undefined {
  const orchestraSettings = state.orchestra?.selected ? state.orchestra.draft.settings : null;
  if (orchestraSettings) {
    // Şef, karar verici sağlayıcıyla açılan bir ACP sohbetidir; kayıt görev oluşturulmadan önce yapılır.
    return {
      id: crypto.randomUUID(),
      provider: orchestraSettings.conductorProviderId,
      title: 'Orkestra (1)',
      initialQueue: buildInitialQueue(state),
      autoApprove: orchestraSettings.autoApproveWorkers,
      model: orchestraSettings.conductorModel ?? undefined,
      type: 'acp',
    };
  }
  const { provider } = state;
  if (!provider) return undefined;
  const type = state.useChatUi ? 'acp' : 'pty';

  return {
    id: crypto.randomUUID(),
    provider,
    title: nextDefaultConversationTitle(provider, []),
    ...(type === 'acp'
      ? { initialQueue: buildInitialQueue(state) }
      : state.initialPromptSupported
        ? { initialPrompt: buildFinalPrompt(state.issueContext, state.prompt) }
        : {}),
    autoApprove: state.autoApprove,
    model: state.model ?? undefined,
    type,
  };
}

export function deriveInitialStatus(
  linkedType: LinkedType,
  linkedPR: PullRequest | null
): TaskLifecycleStatus | undefined {
  if (linkedType !== 'pr' || !linkedPR) return undefined;
  return linkedPR.status === 'open' && !linkedPR.isDraft ? 'review' : undefined;
}
