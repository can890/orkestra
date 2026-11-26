import { toast } from '@orkestra/ui/react/primitives';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
import { fetchAppSettingsMeta } from '@core/features/settings/api/browser/app-settings-client';
import { log } from '@core/primitives/logging/browser/logger';
import { resolveDefaultPermissionForProvider } from '../default-permission-mode';
import { getConversationsForTask } from './conversation-selectors';
import { nextDefaultConversationTitle } from './conversation-title-utils';
import { recordLastUsedAgent, resolveLastUsedAgentForHost } from './last-used-agent';

const pendingTasks = new Set<string>();

export async function resolveQuickConversationAgent(connectionId?: string) {
  const [tasks, selection] = await Promise.all([
    fetchAppSettingsMeta('tasks').catch(() => null),
    fetchAppSettingsMeta('defaultAgent')
      .catch(() => null)
      .then((settings) =>
        resolveLastUsedAgentForHost({ connectionId, defaultAgent: settings?.value })
      ),
  ]);
  if (!selection.providerId) {
    throw new Error('Bu ortamda kullanılabilir bir yapay zekâ bulunamadı.');
  }

  const defaultPermissionMode =
    tasks && !('defaultPermissionMode' in tasks.overrides) && tasks.value.autoApproveByDefault
      ? 'bypass'
      : (tasks?.value.defaultPermissionMode ?? 'default');
  const permission = resolveDefaultPermissionForProvider(
    selection.providerId,
    defaultPermissionMode
  );

  return {
    provider: selection.providerId,
    model: selection.model,
    effort: selection.supportsAcp ? selection.effort : undefined,
    modeId: selection.supportsAcp ? permission.modeId : undefined,
    autoApprove: selection.supportsAutoApprove && permission.autoApprove,
    type: selection.supportsAcp ? ('acp' as const) : ('pty' as const),
  };
}

export async function createQuickConversation(params: { projectId: string; taskId: string }) {
  const { projectId, taskId } = params;
  const manager = getConversationsForTask(taskId);
  if (!manager || pendingTasks.has(taskId)) return null;

  pendingTasks.add(taskId);
  try {
    const agent = await resolveQuickConversationAgent(getProjectSshConnectionId(projectId));
    const conversation = await manager.createConversation({
      ...params,
      ...agent,
      id: crypto.randomUUID(),
      title: nextDefaultConversationTitle(
        agent.provider,
        Array.from(manager.conversations.values(), ({ data }) => data)
      ),
    });
    recordLastUsedAgent({ providerId: agent.provider, model: agent.model, effort: agent.effort });
    return conversation;
  } catch (error) {
    log.error('Sohbet başlatılamadı', error);
    toast.error('Sohbet başlatılamadı', {
      description: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    pendingTasks.delete(taskId);
  }
}
