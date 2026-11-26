import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { WIDGET_MAX_BYTES } from '@orkestra/core/runtimes/acp/api/client';
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
import { WidgetAgentTools } from './widget-agent-tools';

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
      return {
        name: input.name,
        command: 'node',
        args: ['bridge.cjs'],
        env: { TOKEN: input.token },
      };
    },
  };
  return { host, specs, server: () => registered };
}

const context: ConversationToolContext = {
  conversationId: 'chat-1',
  projectId: 'project-1',
  taskId: 'task-1',
  workspaceId: 'workspace-1',
  host: LOCAL_HOST_REF,
};

const textOf = (result: AgentToolCallResult) =>
  result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');

describe('WidgetAgentTools', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  let tools: ReturnType<typeof createToolsHost>;
  let enabled: boolean;
  let service: WidgetAgentTools;

  beforeEach(() => {
    tools = createToolsHost();
    enabled = true;
    service = new WidgetAgentTools({
      tools: tools.host,
      isEnabled: async () => enabled,
      logger: logger as never,
    });
  });
  afterEach(() => service.dispose());

  const call = async (args: unknown, name = 'show_widget') =>
    (await tools
      .server()!
      .handle('chat-1', 'call', { name, arguments: args })) as AgentToolCallResult;

  it('offers the orkestra-widgets server with a per-conversation token', async () => {
    const [server] = await service.conversationMcpServers(context);
    expect(server).toMatchObject({ name: 'orkestra-widgets' });
    expect(tools.specs[0]).toMatchObject({
      name: 'orkestra-widgets',
      serverId: 'widgets',
      host: LOCAL_HOST_REF,
    });
    const token = tools.specs[0]!.token;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tools.server()!.authenticate(token)).toBe('chat-1');
    expect(tools.server()!.authenticate('other')).toBeNull();
    await service.conversationMcpServers(context);
    await service.conversationMcpServers({ ...context, conversationId: 'chat-2' });
    expect(tools.specs[1]!.token).toBe(token);
    expect(tools.specs[2]!.token).not.toBe(token);
  });

  it('is not attached when the setting is off, and calls are refused if it is turned off later', async () => {
    enabled = false;
    await expect(service.conversationMcpServers(context)).resolves.toEqual([]);
    expect(tools.specs).toHaveLength(0);

    enabled = true;
    await service.conversationMcpServers(context);
    enabled = false;
    const result = await call({ title: 'x', html: '<p/>' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('turned off');
  });

  it('describes the single show_widget tool', async () => {
    const described = (await tools.server()!.handle('chat-1', 'describe', {})) as {
      name: string;
      instructions: string;
      tools: Array<{ name: string; inputSchema: { required: string[] } }>;
    };
    expect(described.name).toBe('orkestra-widgets');
    expect(described.instructions).toContain('--widget-bg');
    expect(described.instructions).toContain('no network');
    expect(described.tools.map((tool) => tool.name)).toEqual(['show_widget', 'preview_widget']);
    expect(described.tools[0]!.inputSchema.required).toEqual(['title']);
  });

  it('tells the agent the widget is shown for valid html and svg', async () => {
    const html = await call({ title: 'Grafik', html: '<p>merhaba</p>' });
    expect(html.isError).toBeUndefined();
    expect(textOf(html)).toContain('Widget "Grafik" is now shown');
    const svg = await call({ title: 'Daire', svg: '<svg viewBox="0 0 1 1"/>' });
    expect(svg.isError).toBeUndefined();
  });

  it('rejects invalid input with a validation error', async () => {
    const cases: unknown[] = [
      {},
      { title: 'x' },
      { title: 'x', html: '<p/>', svg: '<svg/>' },
      { title: '', html: '<p/>' },
      { title: 'a'.repeat(81), html: '<p/>' },
      { title: 'x', html: 'a'.repeat(WIDGET_MAX_BYTES) },
      { title: 'x', html: 5 },
      null,
      'html',
    ];
    for (const args of cases) {
      const result = await call(args);
      expect(result.isError, JSON.stringify(args)?.slice(0, 60)).toBe(true);
      expect(textOf(result)).toContain('Widget rejected');
    }
  });

  it('rejects unknown tools and methods', async () => {
    expect((await call({}, 'other')).isError).toBe(true);
    await expect(tools.server()!.handle('chat-1', 'bogus', {})).rejects.toThrow('Unknown method');
  });
});
