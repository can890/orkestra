import { hostRef, LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentToolCallResult,
  ConversationToolContext,
} from '@core/services/agent-tools/api/agent-tools';
import type {
  AgentToolsBridgeHost,
  AgentToolsBridgeServerInput,
  AgentToolServer,
} from '@core/services/agent-tools/node/agent-tools-host';
import type { ComputerUsePermissions } from '../api';
import { ComputerAgentTools } from './computer-agent-tools';
import { ComputerDesktop, type ProcessRunner } from './computer-desktop';
import { ComputerUseState } from './computer-use-state';
import { createComputerUseWireController } from './wire-controller';

const context: ConversationToolContext = {
  conversationId: 'chat-1',
  projectId: 'project-1',
  taskId: 'task-1',
  workspaceId: 'workspace-1',
  host: LOCAL_HOST_REF,
};

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const SECRET_TEXT = 'correct horse battery staple $(id)';

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

describe('ComputerAgentTools', () => {
  let globalEnabled: boolean;
  let permissions: ComputerUsePermissions;
  let processCalls: Array<{ command: string; stdin: string | undefined }>;
  let state: ComputerUseState;
  let tools: ReturnType<typeof createToolsHost>;
  let service: ComputerAgentTools;

  beforeEach(() => {
    globalEnabled = false;
    permissions = { accessibility: true, screenRecording: true };
    processCalls = [];
    // Sahte çalıştırıcı: gerçek olay ya da ekran görüntüsü yok.
    const run: ProcessRunner = async (command, _args, options) => {
      processCalls.push({ command, stdin: options.stdin });
      if (command === 'osascript') {
        const request = JSON.parse(options.stdin ?? '{}') as { action: string };
        const body =
          request.action === 'info'
            ? { ok: true, width: 1000, height: 800, scale: 1 }
            : { ok: true };
        return {
          exitCode: 0,
          stdout: Buffer.from(JSON.stringify(body)),
          stderr: '',
          timedOut: false,
        };
      }
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: '', timedOut: false };
    };
    state = new ComputerUseState({
      isGloballyEnabled: async () => globalEnabled,
      platform: 'darwin',
    });
    tools = createToolsHost();
    service = new ComputerAgentTools({
      tools: tools.host,
      state,
      desktop: new ComputerDesktop({
        run,
        scratch: {
          create: async () => ({
            path: '/scratch/capture.jpg',
            read: async () => Buffer.from('jpeg'),
            dispose: async () => undefined,
          }),
        },
      }),
      permissions: () => permissions,
      logger: logger as never,
    });
  });

  afterEach(() => service.dispose());

  async function call(name: string, args: Record<string, unknown> = {}) {
    return (await tools.server()!.handle('chat-1', 'call', {
      name,
      arguments: args,
    })) as AgentToolCallResult;
  }
  const text = (result: AgentToolCallResult) =>
    result.content.map((item) => (item.type === 'text' ? item.text : `<${item.type}>`)).join('\n');
  const inputRequests = () =>
    processCalls
      .filter((entry) => entry.command === 'osascript')
      .map((entry) => JSON.parse(entry.stdin ?? '{}') as { action: string });

  it('adds no server while either lock is closed', async () => {
    expect(await service.conversationMcpServers(context)).toEqual([]);
    globalEnabled = true; // yalnızca genel ayar yetmez
    expect(await service.conversationMcpServers(context)).toEqual([]);
    globalEnabled = false;
    state.enableConversation('chat-1'); // yalnızca sohbet kilidi yetmez
    expect(await service.conversationMcpServers(context)).toEqual([]);
    expect(tools.specs).toHaveLength(0);
  });

  it('adds the server only when both locks are open, local and macOS', async () => {
    globalEnabled = true;
    state.enableConversation('chat-1');
    const [server] = await service.conversationMcpServers(context);
    expect(server).toMatchObject({ name: 'orkestra-computer' });
    expect(tools.specs[0]).toMatchObject({ serverId: 'computer', host: LOCAL_HOST_REF });
    expect(tools.server()!.authenticate(tools.specs[0]!.token)).toBe('chat-1');

    await expect(
      service.conversationMcpServers({ ...context, host: hostRef('remote', 'conn-1') })
    ).resolves.toEqual([]);

    const other = new ComputerUseState({ isGloballyEnabled: async () => true, platform: 'linux' });
    other.enableConversation('chat-1');
    expect(await other.check('chat-1')).toEqual({ open: false, reason: 'unsupported' });
  });

  it('rejects calls with an error and no side effects while locks are closed', async () => {
    const result = await call('click', { x: 1, y: 1 });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not enabled|turned off/);
    expect(processCalls).toHaveLength(0);
    expect(state.activity('chat-1')[0]).toMatchObject({ tool: 'click', outcome: 'denied' });
  });

  it('stops immediately: the next call errors without running anything', async () => {
    globalEnabled = true;
    state.enableConversation('chat-1');
    expect((await call('mouse_move', { x: 5, y: 5 })).isError).toBeUndefined();
    const before = processCalls.length;

    state.disableConversation('chat-1'); // "Durdur"
    const stopped = await call('mouse_move', { x: 6, y: 6 });
    expect(stopped.isError).toBe(true);
    expect(processCalls).toHaveLength(before);

    state.enableConversation('chat-1');
    globalEnabled = false; // genel ayar kapanınca da anında durur
    expect((await call('screenshot')).isError).toBe(true);
    expect(processCalls).toHaveLength(before);
  });

  it('points to the right System Settings pane when permissions are missing', async () => {
    globalEnabled = true;
    state.enableConversation('chat-1');
    permissions = { accessibility: false, screenRecording: false };
    const click = await call('click', { x: 1, y: 1 });
    expect(click.isError).toBe(true);
    expect(text(click)).toContain('Accessibility');
    expect(text(click)).toContain('cannot grant');
    const shot = await call('screenshot');
    expect(shot.isError).toBe(true);
    expect(text(shot)).toContain('Screen Recording');
    expect(processCalls).toHaveLength(0);
  });

  it('validates arguments before touching the desktop', async () => {
    globalEnabled = true;
    state.enableConversation('chat-1');
    for (const [name, args] of [
      ['click', { x: -1, y: 5 }],
      ['click', { x: 5000, y: 5 }],
      ['click', { x: 'a', y: 5 }],
      ['click', { x: 1, y: 1, button: 'middle' }],
      ['drag', { from_x: 1, from_y: 1, to_x: Number.NaN, to_y: 2 }],
      ['key', { key: 'rm -rf /' }],
      ['key', { key: 'c' }],
      ['type_text', { text: '' }],
      ['nope', {}],
    ] as const) {
      const result = await call(name, { ...args });
      expect(result.isError, name).toBe(true);
    }
    // Yalnızca ekran boyutunu okuyan zararsız "info" istekleri çalışmış olabilir; olay yok.
    expect(inputRequests().every((request) => request.action === 'info')).toBe(true);
  });

  it('performs actions and logs coordinates and lengths, never typed text', async () => {
    globalEnabled = true;
    state.enableConversation('chat-1');
    expect((await call('click', { x: 10, y: 20, double: true })).isError).toBeUndefined();
    expect((await call('type_text', { text: SECRET_TEXT })).isError).toBeUndefined();
    expect((await call('key', { key: 'c', modifiers: ['cmd'] })).isError).toBeUndefined();
    expect(
      (await call('drag', { from_x: 1, from_y: 2, to_x: 30, to_y: 40 })).isError
    ).toBeUndefined();
    const shot = await call('screenshot');
    expect(shot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });

    const requests = inputRequests().filter((request) => request.action !== 'info');
    expect(requests.map((request) => request.action)).toEqual(['click', 'type', 'key', 'drag']);

    const log = state.activity('chat-1');
    expect(log.map((entry) => entry.summary)).toEqual([
      'click left double (10, 20)',
      `type_text (${SECRET_TEXT.length} chars)`,
      'key cmd+c',
      'drag (1, 2) -> (30, 40)',
      'screenshot',
    ]);
    expect(JSON.stringify(log)).not.toContain('horse');
    expect(state.activity('other-chat')).toEqual([]);
  });

  it('exposes no way for an agent to enable computer use', async () => {
    const server = tools.server()!;
    await expect(server.handle('chat-1', 'enable', { conversationId: 'chat-1' })).rejects.toThrow(
      /Unknown method/
    );
    const described = (await server.handle('chat-1', 'describe', {})) as {
      tools: Array<{ name: string }>;
    };
    expect(described.tools.map((tool) => tool.name)).toEqual([
      'screenshot',
      'mouse_move',
      'click',
      'drag',
      'type_text',
      'key',
    ]);
    for (const name of ['enable', 'set_enabled', 'settings', 'grant']) {
      expect((await call(name, { enabled: true })).isError).toBe(true);
    }
    expect(state.isConversationEnabled('chat-1')).toBe(false);
  });
});

describe('createComputerUseWireController', () => {
  function setup(globalEnabled: boolean, platform: NodeJS.Platform = 'darwin') {
    const state = new ComputerUseState({ isGloballyEnabled: async () => globalEnabled, platform });
    const opened: string[] = [];
    const controller = createComputerUseWireController({
      state,
      permissions: () => ({ accessibility: true, screenRecording: false }),
      openPermissionSettings: async (pane) => {
        opened.push(pane);
      },
    });
    return { state, controller, opened };
  }

  it('refuses to enable a conversation while the global setting is off', async () => {
    const { state, controller } = setup(false);
    const result = await controller.call('setConversationEnabled', {
      conversationId: 'chat-1',
      enabled: true,
    });
    expect(result).toMatchObject({ success: false });
    expect(state.isConversationEnabled('chat-1')).toBe(false);
  });

  it('enables on an explicit UI call and stops with one call', async () => {
    const { state, controller } = setup(true);
    await controller.call('setConversationEnabled', { conversationId: 'chat-1', enabled: true });
    expect(state.isConversationEnabled('chat-1')).toBe(true);
    expect(await controller.call('getState', { conversationId: 'chat-1' })).toMatchObject({
      supported: true,
      globalEnabled: true,
      conversationEnabled: true,
      permissions: { accessibility: true, screenRecording: false },
    });
    await controller.call('stop', { conversationId: 'chat-1' });
    expect(state.isConversationEnabled('chat-1')).toBe(false);
  });

  it('is inert on other platforms and only opens fixed permission panes', async () => {
    const other = setup(true, 'linux');
    expect(
      await other.controller.call('setConversationEnabled', { conversationId: 'c', enabled: true })
    ).toMatchObject({ success: false });
    expect(other.state.isConversationEnabled('c')).toBe(false);
    expect(await other.controller.call('getState', { conversationId: 'c' })).toMatchObject({
      supported: false,
      globalEnabled: false,
    });

    const mac = setup(true);
    await mac.controller.call('openPermissionSettings', { pane: 'screen-recording' });
    expect(mac.opened).toEqual(['screen-recording']);
    await expect(
      mac.controller.call('openPermissionSettings', { pane: 'file:///etc/passwd' })
    ).rejects.toThrow();
  });
});
