import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CLIAgentPluginProvider } from '@orkestra/core/services/agent-plugins/api/plugins';
import { createPluginRegistry } from '@orkestra/shared/plugins';
import { afterEach, describe, expect, it } from 'vitest';
import { provider as claude } from '../impl/claude';
import { builtInProviderForRegistryAgent } from './builtin-registry-ids';
import { createDynamicAgentRegistry } from './dynamic-registry';
import { createCustomAcpProvider } from './provider';
import {
  parseCustomAcpAgentsFile,
  serializeCustomAcpAgentsFile,
  type CustomAcpAgent,
} from './schema';

function agent(overrides: Partial<CustomAcpAgent> = {}): CustomAcpAgent {
  return {
    id: 'acp-local-dsh',
    source: 'local',
    name: 'DeepSeek Harness',
    description: '',
    launch: { command: '/usr/local/bin/dsh', args: ['--profile', 'acp'], env: { DSH_MODE: '1' } },
    addedAt: 1,
    ...overrides,
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('custom ACP agent file', () => {
  it('round-trips through serialize/parse', () => {
    const agents = [
      agent(),
      agent({
        id: 'acp-registry-gemini',
        source: 'registry',
        name: 'Gemini CLI',
        launch: { command: '/data/tools/gemini/0.71.1/npm/bin/gemini', args: ['--acp'], env: {} },
        registry: {
          agentId: 'gemini',
          version: '0.71.1',
          distribution: 'npx',
          packageSpec: '@google/gemini-cli@0.71.1',
        },
      }),
    ];
    expect(parseCustomAcpAgentsFile(serializeCustomAcpAgentsFile(agents))).toEqual(agents);
  });

  it('skips invalid and duplicate entries but keeps valid ones', () => {
    const text = JSON.stringify({
      version: 1,
      agents: [agent(), { id: 'claude', name: 'x' }, agent({ name: 'Duplicate' })],
    });
    expect(parseCustomAcpAgentsFile(text).map((a) => a.name)).toEqual(['DeepSeek Harness']);
    expect(parseCustomAcpAgentsFile('not json')).toEqual([]);
    expect(parseCustomAcpAgentsFile(JSON.stringify({ version: 2, agents: [] }))).toEqual([]);
  });
});

describe('createCustomAcpProvider', () => {
  it('spawns the configured command through the native ACP behavior', () => {
    const provider = createCustomAcpProvider(agent());
    expect(provider.capabilities.acp.kind).toBe('supported');
    expect(provider.capabilities.prompt.kind).toBe('none');
    expect(provider.behavior.hostDependency?.resolveExecutable?.()).toBe('/usr/local/bin/dsh');
    expect(
      provider.behavior.acp!.buildSpawn({ cwd: '/w', env: {}, cli: '/usr/local/bin/dsh' })
    ).toEqual({
      command: '/usr/local/bin/dsh',
      args: ['--profile', 'acp'],
      env: { DSH_MODE: '1' },
    });
  });

  it('maps advertised ACP auth methods, learned models and load support', () => {
    const provider = createCustomAcpProvider(
      agent({
        probe: {
          probedAt: 1,
          protocolVersion: 1,
          loadSession: true,
          mcp: { http: true, sse: false },
          authMethods: [
            { id: 'login', name: 'Log in', type: 'terminal', args: ['login'] },
            { id: 'key', name: 'API key', type: 'env_var', vars: [{ name: 'DSH_API_KEY' }] },
            { id: 'oauth', name: 'Agent managed', type: 'agent' },
          ],
          models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }],
          modes: [],
        },
      })
    );
    expect(provider.capabilities.auth).toEqual({
      kind: 'supported',
      methods: [
        { kind: 'cli-login', id: 'login', name: 'Log in', args: ['login'] },
        {
          kind: 'api-key',
          id: 'key',
          name: 'API key',
          envVars: [{ name: 'DSH_API_KEY', label: 'DSH_API_KEY' }],
        },
      ],
    });
    expect(provider.behavior.auth?.buildLoginCommand?.({ cli: 'x' }, 'login')).toEqual({
      command: '/usr/local/bin/dsh',
      args: ['login'],
    });
    expect(provider.capabilities.models).toEqual({
      kind: 'selectable',
      modelOptions: { 'deepseek-v4': { name: 'DeepSeek V4' } },
    });
    expect(provider.capabilities.sessions.kind).toBe('resumable');
    expect(provider.capabilities.mcp).toMatchObject({ supportedTransports: ['stdio', 'http'] });
  });
});

describe('createDynamicAgentRegistry', () => {
  it('reads custom agents from the file, reloads on change and never shadows built-ins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orkestra-custom-acp-'));
    tempDirs.push(dir);
    const file = join(dir, 'agents.json');
    const builtIns = createPluginRegistry<CLIAgentPluginProvider>();
    builtIns.register(claude);
    let time = 0;
    const registry = createDynamicAgentRegistry({
      builtIns,
      filePath: () => file,
      now: () => time,
      recheckIntervalMs: 1_000,
    });

    expect(registry.ids()).toEqual(['claude']);

    writeFileSync(file, serializeCustomAcpAgentsFile([agent()]));
    // Aralık dolmadan dosya yeniden okunmaz.
    expect(registry.get('acp-local-dsh')).toBeUndefined();
    time = 2_000;
    expect(registry.get('acp-local-dsh')?.metadata.name).toBe('DeepSeek Harness');

    writeFileSync(
      file,
      serializeCustomAcpAgentsFile([agent({ name: 'Renamed' }), agent({ id: 'acp-x' })])
    );
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    registry.reload();
    expect(registry.get('acp-local-dsh')?.metadata.name).toBe('Renamed');
    expect(registry.ids()).toEqual(['claude', 'acp-local-dsh', 'acp-x']);
    expect(registry.get('claude')).toBe(claude);
  });

  it('has no custom agents when no file is configured', () => {
    const builtIns = createPluginRegistry<CLIAgentPluginProvider>();
    const registry = createDynamicAgentRegistry({ builtIns, filePath: () => undefined });
    expect(registry.getAll()).toEqual([]);
    expect(registry.customAgents()).toEqual([]);
  });
});

describe('builtInProviderForRegistryAgent', () => {
  it('dedupes registry entries Orkestra already supports', () => {
    expect(builtInProviderForRegistryAgent('claude-acp')).toBe('claude');
    expect(builtInProviderForRegistryAgent('codex-acp')).toBe('codex');
    expect(builtInProviderForRegistryAgent('grok-build')).toBe('grok');
    expect(builtInProviderForRegistryAgent('kimi-code')).toBe('kimi');
    expect(builtInProviderForRegistryAgent('gemini')).toBeUndefined();
  });
});
