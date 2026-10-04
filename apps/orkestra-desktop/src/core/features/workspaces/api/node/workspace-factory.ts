import type { HostRef } from '@orkestra/core/primitives/host/api';
import type { RuntimeResolveError } from '@orkestra/core/services/runtime-broker/api';
import { ok, type Result } from '@orkestra/shared';
import type { ConversationProvider } from '@core/features/conversations/api/node/types';
import type { TaskSessionLaunchContextSource } from '@core/features/tasks/api/node/task-session-launch-context';
import type { TuiAgentsRuntimeClient } from '@core/services/runtime-broker/api/clients';
import type { FilesClientScope } from '@core/services/runtime-broker/node/files';

export type WorkspaceType = { kind: 'local' } | { kind: 'ssh'; connectionId: string };

export type TaskProviderOpts = {
  host: HostRef;
  files: FilesClientScope;
  tuiAgents: TuiAgentsRuntimeClient;
  projectId: string;
  taskId: string;
  workspaceId: string;
  taskPath: string;
  launchContextSource: TaskSessionLaunchContextSource;
};

export async function buildTaskProviders(
  opts: TaskProviderOpts,
  createConversationProvider: (options: TaskProviderOpts) => ConversationProvider
): Promise<Result<{ conversations: ConversationProvider }, RuntimeResolveError>> {
  return ok({
    conversations: createConversationProvider(opts),
  });
}
