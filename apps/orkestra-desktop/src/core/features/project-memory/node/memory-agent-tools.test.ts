import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentToolCallResult,
  ConversationToolContext,
} from '@core/services/agent-tools/api/agent-tools';
import type {
  AgentToolServer,
  AgentToolsBridgeHost,
  AgentToolsBridgeServerInput,
} from '@core/services/agent-tools/node/agent-tools-host';
import { MemoryAgentTools } from './memory-agent-tools';
import { ProjectMemorySettingsStore } from './memory-settings';
import { ProjectMemoryStore } from './memory-store';
import { ProjectMemoryService } from './project-memory-service';

function createToolsHost() {
  let registered: AgentToolServer | null = null;
  const specs: AgentToolsBridgeServerInput[] = [];
  const host: AgentToolsBridgeHost = {
    register: (server) => {
      registered = server;
      return () => {
        registered = null;
      };
    },
    bridgeServer: async (input) => {
      specs.push(input);
      return { name: input.name, command: 'node', args: ['bridge.cjs'] };
    },
  };
  return { host, specs, server: () => registered! };
}

const context = (over: Partial<ConversationToolContext> = {}): ConversationToolContext => ({
  conversationId: 'chat-1',
  projectId: 'project-1',
  taskId: 'task-1',
  workspaceId: 'workspace-1',
  host: LOCAL_HOST_REF,
  ...over,
});

const text = (result: AgentToolCallResult) =>
  result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

describe('MemoryAgentTools', () => {
  let dir: string;
  let memory: ProjectMemoryService;
  let tools: ReturnType<typeof createToolsHost>;
  let service: MemoryAgentTools;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orkestra-memory-tools-'));
    memory = new ProjectMemoryService(
      new ProjectMemoryStore({ rootDir: join(dir, 'memory') }),
      new ProjectMemorySettingsStore(join(dir, 'settings.json'))
    );
    tools = createToolsHost();
    service = new MemoryAgentTools({
      tools: tools.host,
      memory,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
  });

  afterEach(async () => {
    service.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  const call = async (
    conversationId: string,
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<AgentToolCallResult> =>
    (await tools.server().handle(conversationId, 'call', {
      name,
      arguments: args,
    })) as AgentToolCallResult;

  it('adds no server and no tools while the project setting is off (default)', async () => {
    await expect(service.conversationMcpServers(context())).resolves.toEqual([]);
    expect(tools.specs).toHaveLength(0);
    await expect(tools.server().handle('chat-1', 'describe', {})).rejects.toThrow(
      'no access to project memory'
    );
  });

  it('serves the orkestra-memory server once the project enables it', async () => {
    await memory.setEnabled('project-1', true);
    const [server] = await service.conversationMcpServers(context());
    expect(server).toMatchObject({ name: 'orkestra-memory' });
    expect(tools.specs[0]).toMatchObject({ serverId: 'memory' });
    const token = tools.specs[0]!.token;
    expect(tools.server().authenticate(token)).toBe('chat-1');
    expect(tools.server().authenticate('nope')).toBeNull();

    const described = (await tools.server().handle('chat-1', 'describe', {})) as {
      tools: Array<{ name: string; description: string }>;
    };
    expect(described.tools.map((t) => t.name)).toEqual([
      'memory_list',
      'memory_read',
      'memory_write',
      'memory_delete',
    ]);
    expect(described.tools.find((t) => t.name === 'memory_write')!.description).toMatch(
      /NEVER store passwords, tokens, API keys/
    );
  });

  it('is scoped to the conversation project: no project argument is accepted or trusted', async () => {
    await memory.setEnabled('project-1', true);
    await memory.setEnabled('project-2', true);
    await service.conversationMcpServers(context());
    await service.conversationMcpServers(context({ conversationId: 'chat-2', projectId: 'project-2' }));

    expect(text(await call('chat-1', 'memory_write', { name: 'n', description: 'd', content: 'one' }))).toContain(
      'Saved'
    );
    // Aracın projectId alanı yok sayılır; chat-2 yalnızca kendi projesini görür.
    await call('chat-2', 'memory_write', {
      name: 'n2',
      description: 'd',
      content: 'two',
      projectId: 'project-1',
    });
    expect(text(await call('chat-2', 'memory_list'))).toContain('n2');
    expect(text(await call('chat-2', 'memory_list'))).not.toContain('- n (');
    const crossRead = await call('chat-2', 'memory_read', { name: 'n', projectId: 'project-1' });
    expect(crossRead.isError).toBe(true);
    expect(text(await call('chat-1', 'memory_read', { name: 'n' }))).toContain('one');
  });

  it('rejects path traversal and secret-looking content through the tools', async () => {
    await memory.setEnabled('project-1', true);
    await service.conversationMcpServers(context());
    const traversal = await call('chat-1', 'memory_write', {
      name: '../../etc/passwd',
      description: 'x',
      content: 'x',
    });
    expect(traversal.isError).toBe(true);
    const secret = await call('chat-1', 'memory_write', {
      name: 'creds',
      description: 'x',
      content: 'api_key = abcdef123456',
    });
    expect(secret.isError).toBe(true);
    expect(text(secret)).toContain('secret');
    expect(text(await call('chat-1', 'memory_list'))).toContain('No memories');
  });

  it('refuses calls after the setting is turned off mid-session', async () => {
    await memory.setEnabled('project-1', true);
    await service.conversationMcpServers(context());
    await memory.setEnabled('project-1', false);
    const result = await call('chat-1', 'memory_list');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('turned off');
  });

  it('deletes notes', async () => {
    await memory.setEnabled('project-1', true);
    await service.conversationMcpServers(context());
    await call('chat-1', 'memory_write', { name: 'tmp', description: 'd', content: 'x' });
    expect((await call('chat-1', 'memory_delete', { name: 'tmp' })).isError).toBeUndefined();
    expect((await call('chat-1', 'memory_delete', { name: 'tmp' })).isError).toBe(true);
  });
});

describe('ProjectMemoryService', () => {
  it('only produces prompt context when the project enabled memory and has notes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orkestra-memory-svc-'));
    try {
      const memory = new ProjectMemoryService(
        new ProjectMemoryStore({ rootDir: join(dir, 'm') }),
        new ProjectMemorySettingsStore(join(dir, 's.json'))
      );
      await memory.write('p1', { name: 'a', description: 'first note', content: 'SECRET BODY' });
      expect(await memory.promptContext('p1')).toBeNull();
      await memory.setEnabled('p1', true);
      const context = await memory.promptContext('p1');
      expect(context).toContain('- a: first note');
      expect(context).not.toContain('SECRET BODY');
      expect(await memory.promptContext('p2')).toBeNull();

      // Ayar yeniden başlatmadan sonra kalıcıdır.
      const again = new ProjectMemorySettingsStore(join(dir, 's.json'));
      expect(await again.isEnabled('p1')).toBe(true);
      expect(await again.isEnabled('p2')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
