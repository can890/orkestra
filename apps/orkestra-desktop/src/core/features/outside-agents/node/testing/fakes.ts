import type { Secret } from '@orkestra/shared';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import type { OutsideAgentsPersistence, StoredOutsideAgentsState } from '../client-registry';
import type {
  OutsideAgentBackend,
  OutsideConversation,
  OutsideProject,
  OutsideProvider,
  OutsideSessionSummary,
  OutsideTranscriptTurn,
  StartConversationInput,
} from '../outside-agent-backend';

// Testler için bellek içi sır deposu, kalıcı durum ve Orkestra arka ucu.

export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, Secret<string>>();
  async getSecret(key: string) {
    return this.values.get(key) ?? null;
  }
  async setSecret(key: string, value: Secret<string>) {
    this.values.set(key, value);
  }
  async deleteSecret(key: string) {
    this.values.delete(key);
  }
}

export class MemoryPersistence implements OutsideAgentsPersistence {
  state: StoredOutsideAgentsState | null = null;
  saves = 0;
  async load() {
    return this.state ? structuredClone(this.state) : null;
  }
  async save(state: StoredOutsideAgentsState) {
    this.saves += 1;
    this.state = structuredClone(state);
  }
}

export class FakeBackend implements OutsideAgentBackend {
  projects: OutsideProject[] = [
    {
      id: 'project-1',
      name: 'Alpha',
      path: '/tmp/alpha',
      location: 'local',
      repositoryWorkspaceId: 'ws-1',
      hostKey: 'local:local',
    },
    {
      id: 'project-2',
      name: 'Beta',
      path: '/tmp/beta',
      location: 'local',
      repositoryWorkspaceId: null,
      hostKey: 'local:local',
    },
  ];
  conversations: OutsideConversation[] = [
    {
      id: 'conv-1',
      projectId: 'project-1',
      taskId: 'task-1',
      providerId: 'claude',
      title: 'Fix the tests',
      type: 'acp',
      model: null,
      lastInteractedAt: '2026-11-20T10:00:00.000Z',
      agentStatus: 'completed',
      hasSession: true,
    },
    {
      id: 'conv-2',
      projectId: 'project-2',
      taskId: 'task-2',
      providerId: 'codex',
      title: 'Write docs',
      type: 'acp',
      model: null,
      lastInteractedAt: '2026-11-21T10:00:00.000Z',
      agentStatus: 'working',
      hasSession: true,
    },
  ];
  summaries: Record<string, OutsideSessionSummary> = {};
  cached: Record<string, OutsideTranscriptTurn[]> = {
    'conv-1': Array.from({ length: 15 }, (_, index) => ({
      seq: index + 1,
      outcome: 'done',
      items: [
        {
          kind: 'message' as const,
          role: 'user' as const,
          text: `question ${index + 1}`,
          createdAt: null,
        },
        { kind: 'tool' as const, title: 'Run tests', status: 'completed' },
        {
          kind: 'message' as const,
          role: 'assistant' as const,
          text: `answer ${index + 1} ${'x'.repeat(500)}`,
          createdAt: null,
        },
      ],
    })),
  };
  providers: OutsideProvider[] = [
    {
      id: 'claude',
      name: 'Claude Code',
      installed: true,
      supportsEffort: true,
      models: [{ id: 'opus', name: 'Opus' }],
    },
    { id: 'codex', name: 'Codex', installed: true, supportsEffort: true, models: [] },
    { id: 'gemini', name: 'Gemini', installed: false, supportsEffort: false, models: [] },
  ];
  started: StartConversationInput[] = [];
  sent: Array<{ conversationId: string; text: string; placement: string }> = [];

  async listProjects() {
    return this.projects;
  }
  async listConversations(projectId?: string) {
    return this.conversations.filter((c) => !projectId || c.projectId === projectId);
  }
  async sessionSummaries() {
    return this.summaries;
  }
  async loadLiveHistory() {
    return null;
  }
  async loadCachedHistory(conversationId: string) {
    return this.cached[conversationId] ?? [];
  }
  async listProviders() {
    return this.providers;
  }
  async startConversation(input: StartConversationInput) {
    this.started.push(input);
    const conversationId = `conv-new-${this.started.length}`;
    this.conversations.push({
      id: conversationId,
      projectId: input.project.id,
      taskId: `task-new-${this.started.length}`,
      providerId: input.provider,
      title: input.title,
      type: 'acp',
      model: input.model ?? null,
      lastInteractedAt: null,
      agentStatus: 'working',
      hasSession: false,
    });
    return { conversationId, taskId: `task-new-${this.started.length}`, started: true };
  }
  async sendMessage(conversationId: string, text: string, placement: 'auto' | 'queue') {
    this.sent.push({ conversationId, text, placement });
    return { queued: false };
  }
}
