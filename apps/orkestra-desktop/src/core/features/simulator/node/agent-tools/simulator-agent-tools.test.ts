import { hostRef, LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentToolCallResult,
  ConversationToolContext,
} from '@core/services/agent-tools/api/agent-tools';
import type {
  AgentToolsBridgeHost,
  AgentToolsBridgeServerInput,
  AgentToolServer,
} from '@core/services/agent-tools/node/agent-tools-host';
import { SimulatorService, type SimctlRunner } from '../simctl';
import { SimulatorAgentTools } from './simulator-agent-tools';
import { SIMULATOR_TOOLS } from './simulator-tool-definitions';

const UDID = 'F2F4E5BE-ABCA-4AF2-8426-A62258DD6EEB';
const OTHER = '2869AB30-816D-4BB8-8180-9D6385D97AE6';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]);

const context: ConversationToolContext = {
  conversationId: 'chat-1',
  projectId: 'project-1',
  taskId: 'task-1',
  workspaceId: 'workspace-1',
  host: LOCAL_HOST_REF,
};

function devicesJson(states: Array<[string, string]>) {
  return JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-2': states.map(([udid, state], index) => ({
        udid,
        name: `iPhone ${index}`,
        state,
        isAvailable: true,
      })),
    },
  });
}

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
      return { name: input.name, command: 'node', args: ['bridge.cjs'], env: { T: input.token } };
    },
  };
  return { host, specs, server: () => registered };
}

describe('SimulatorAgentTools', () => {
  let tools: ReturnType<typeof createToolsHost>;
  let argvs: string[][];
  let deviceStates: Array<[string, string]>;
  let enabled: boolean;
  let platform: NodeJS.Platform;
  let service: SimulatorAgentTools;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  beforeEach(() => {
    tools = createToolsHost();
    argvs = [];
    deviceStates = [[UDID, 'Booted']];
    enabled = true;
    platform = 'darwin';
    const run: SimctlRunner = async (argv) => {
      argvs.push([...argv]);
      if (argv[1] === 'list') return { stdout: Buffer.from(devicesJson(deviceStates)), stderr: '' };
      if (argv[1] === 'io') return { stdout: JPEG, stderr: '' };
      return { stdout: Buffer.from(''), stderr: '' };
    };
    service = new SimulatorAgentTools({
      tools: tools.host,
      simulator: new SimulatorService({ run, platform }),
      isEnabled: async () => enabled,
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

  it('yalnızca açık ayarla, macOS ve yerel görevlerde sunucu ekler', async () => {
    const [server] = await service.conversationMcpServers(context);
    expect(server).toMatchObject({ name: 'orkestra-simulator' });
    expect(tools.specs[0]).toMatchObject({ serverId: 'simulator', host: LOCAL_HOST_REF });
    expect(tools.server()!.authenticate(tools.specs[0]!.token)).toBe('chat-1');

    enabled = false;
    expect(await service.conversationMcpServers({ ...context, conversationId: 'c2' })).toEqual([]);
    enabled = true;
    const remote = { ...context, conversationId: 'c3', host: hostRef('remote', 'conn-1') };
    expect(await service.conversationMcpServers(remote)).toEqual([]);
    expect(tools.specs).toHaveLength(1);
  });

  it('macOS dışında sunucu eklemez', async () => {
    const other = new SimulatorAgentTools({
      tools: createToolsHost().host,
      simulator: new SimulatorService({ platform: 'linux' }),
      isEnabled: async () => true,
      logger: logger as never,
    });
    expect(await other.conversationMcpServers(context)).toEqual([]);
    other.dispose();
  });

  it('sunulmamış konuşmayı ve kapatılan ayarı reddeder', async () => {
    await expect(tools.server()!.handle('chat-1', 'describe', {})).rejects.toThrow('no access');
    await service.conversationMcpServers(context);
    enabled = false;
    await expect(call('list_devices')).rejects.toThrow('disabled');
  });

  it('tüm araçları açıklar', async () => {
    await service.conversationMcpServers(context);
    const described = (await tools.server()!.handle('chat-1', 'describe', {})) as {
      name: string;
      tools: Array<{ name: string }>;
    };
    expect(described.name).toBe('orkestra-simulator');
    expect(described.tools.map((tool) => tool.name)).toEqual(
      SIMULATOR_TOOLS.map((tool) => tool.name)
    );
    expect(described.tools.map((tool) => tool.name)).toEqual([
      'list_devices',
      'screenshot',
      'open_url',
      'install_app',
      'launch_app',
    ]);
  });

  it('cihazları listeler ve udid verilmezse tek açık cihazı kullanır', async () => {
    await service.conversationMcpServers(context);
    const list = await call('list_devices');
    expect(list.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(list)).toContain(UDID);

    const shot = await call('screenshot');
    expect(shot.isError).toBeUndefined();
    expect(shot.content[1]).toEqual({
      type: 'image',
      data: JPEG.toString('base64'),
      mimeType: 'image/jpeg',
    });
    await call('open_url', { url: 'https://example.com' });
    await call('launch_app', { bundle_id: 'com.example.App' });
    expect(argvs.filter((argv) => argv[1] !== 'list')).toEqual([
      ['simctl', 'io', UDID, 'screenshot', '--type=jpeg', '-'],
      ['simctl', 'openurl', UDID, 'https://example.com'],
      ['simctl', 'launch', UDID, 'com.example.App'],
    ]);
  });

  it('açık cihaz yoksa ya da birden çoksa açık hata verir', async () => {
    await service.conversationMcpServers(context);
    deviceStates = [[UDID, 'Shutdown']];
    expect((await call('screenshot')).isError).toBe(true);
    deviceStates = [
      [UDID, 'Booted'],
      [OTHER, 'Booted'],
    ];
    const result = await call('screenshot');
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Several simulators');
  });

  it('ajan değerlerini doğrular; geçersiz girdi süreci başlatmaz', async () => {
    await service.conversationMcpServers(context);
    const before = argvs.length;
    for (const [name, args] of [
      ['screenshot', { udid: 'booted' }],
      ['open_url', { udid: UDID, url: 'javascript:alert(1)' }],
      ['launch_app', { udid: UDID, bundle_id: '--help' }],
      ['install_app', { udid: UDID, app_path: '../x.app' }],
      ['bilinmeyen', {}],
    ] as const) {
      expect((await call(name, args)).isError).toBe(true);
    }
    expect(argvs).toHaveLength(before);
  });
});
