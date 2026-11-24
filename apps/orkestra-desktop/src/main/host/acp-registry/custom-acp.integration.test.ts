// Uçtan uca: yerel bir ACP komutunu (depodaki fixture ajanı) kullanıcı ajanı olarak kaydeder,
// gerçek süreçle yoklar ve yerleşik ajanların kullandığı aynı çalışma zamanı yolundan
// (AgentPluginHost → ChildAcpProcessHost → AcpRuntime) bir istem turu çalıştırır.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostDependencyResolver } from '@orkestra/core/primitives/host-dependencies/api';
import { AcpRuntime, ChildAcpProcessHost } from '@orkestra/core/runtimes/acp/node';
import {
  AgentPluginHost,
  createPluginRegistry,
  type CLIAgentPluginProvider,
} from '@orkestra/core/services/agent-plugins/api/plugins';
import { createLocalPluginFs } from '@orkestra/core/services/agent-plugins/api/plugins/helpers';
import type { IExecutionContext } from '@orkestra/core/services/exec/api';
import { createMemorySessionIntentStore } from '@orkestra/core/services/session-intents/api';
import { createDynamicAgentRegistry } from '@orkestra/plugins/agents';
import type { Secret } from '@orkestra/shared';
import { createScope } from '@orkestra/shared/concurrency';
import { noopLogger } from '@orkestra/shared/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomAcpAgentStore } from '@core/features/acp-registry/node/custom-agents-store';
import { probeAcpAgent } from '@core/features/acp-registry/node/probe';
import { AcpRegistryClient } from '@core/features/acp-registry/node/registry-client';
import { AcpRegistryService } from '@core/features/acp-registry/node/service';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';

const FIXTURE_AGENT = join(
  __dirname,
  '../../../core/features/acp-registry/node/fixtures/fixture-acp-agent.mjs'
);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function memorySecrets(): SecretStore {
  const values = new Map<string, string>();
  return {
    async getSecret(key) {
      const value = values.get(key);
      return value === undefined ? null : ({ expose: () => value } as Secret<string>);
    },
    async setSecret(key, secret) {
      values.set(key, secret.expose());
    },
    async deleteSecret(key) {
      values.delete(key);
    },
  };
}

const baseEnv = () => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? tmpdir(),
});

describe('custom local ACP command (integration)', () => {
  it('registers, probes and runs a prompt turn through the built-in ACP runtime path', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orkestra-acp-int-')));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const agentCwd = join(root, 'agent-cwd');
    for (const dir of [home, workspace, agentCwd]) mkdirSync(dir, { recursive: true });
    const agentsFile = join(root, 'acp-registry', 'agents.json');

    // Ana süreçteki gibi: kayıt dosyası + dinamik eklenti kaydı (yerleşik kayıt boş).
    const registry = createDynamicAgentRegistry({
      builtIns: createPluginRegistry<CLIAgentPluginProvider>(),
      filePath: () => agentsFile,
      recheckIntervalMs: 0,
    });
    const secrets = memorySecrets();
    const service = new AcpRegistryService({
      client: new AcpRegistryClient({ cacheDir: root, fetch: vi.fn() }),
      installer: { install: vi.fn() },
      store: new CustomAcpAgentStore(agentsFile, () => registry.reload()),
      secrets,
      toolsDir: join(root, 'tools'),
      builtInProviderIds: () => [],
      probe: (launch) => probeAcpAgent(launch, { timeoutMs: 15_000 }),
      env: async () => baseEnv(),
    });

    // 1) Yerel ACP komutunu ekle (node + fixture ajan betiği).
    const added = await service.addLocal({
      name: 'Fixture Agent',
      command: process.execPath,
      args: [FIXTURE_AGENT],
      env: { FIXTURE_MODE: 'test' },
      cwd: agentCwd,
    });
    if (!added.success) throw new Error(added.error.message);
    const providerId = added.data.providerId;
    expect(providerId).toBe('acp-local-fixture-agent');
    expect(added.data.executableAvailable).toBe(true);
    expect(registry.get(providerId)?.capabilities.acp.kind).toBe('supported');

    // 2) Yokla: initialize + session/new gerçek süreçle.
    const probed = await service.probe(providerId);
    if (!probed.success) throw new Error(probed.error.message);
    expect(probed.data.probe).toMatchObject({
      agentName: 'Fixture Agent',
      agentVersion: '0.0.1',
      loadSession: false,
      models: [
        { id: 'fixture-small', name: 'Fixture Small' },
        { id: 'fixture-large', name: 'Fixture Large' },
      ],
      modes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
      ],
      sessionError: null,
    });
    expect(probed.data.authMethods.map((method) => method.type)).toEqual(['terminal', 'env_var']);
    const provider = registry.get(providerId)!;
    expect(provider.capabilities.models).toMatchObject({ kind: 'selectable' });
    expect(provider.capabilities.auth).toMatchObject({
      kind: 'supported',
      methods: [{ kind: 'cli-login', args: ['login'] }, { kind: 'api-key' }],
    });

    // Kullanıcı API anahtarını sır deposuna kaydeder; oturum env'ine masaüstü ekler.
    const saved = await service.setEnvSecret(providerId, 'FIXTURE_API_KEY', 'sk-fixture');
    expect(saved.success).toBe(true);
    const sessionEnv = await service.envSecretsFor(providerId);

    // 3) Yerleşik ajanlarla aynı çalışma zamanı yolu: AgentPluginHost + gerçek süreç + AcpRuntime.
    const resolve = vi.fn();
    const scope = createScope({ label: 'acp-registry-integration' });
    const agentHost = new AgentPluginHost({
      scope,
      registry,
      exec: { supportsLocalSpawn: false } as unknown as IExecutionContext,
      dependencies: { resolve } as unknown as HostDependencyResolver,
      fs: createLocalPluginFs(home),
      env: async () => baseEnv(),
      homeDir: home,
    });
    const runtime = new AcpRuntime({
      agentHost,
      host: new ChildAcpProcessHost(),
      resolveAttachment: vi.fn(),
      intents: createMemorySessionIntentStore(),
      logger: noopLogger,
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await scope.dispose();
    });

    const launched = await runtime.launchSession({
      conversationId: 'conv-acp-registry',
      providerId,
      cwd: workspace,
      sessionId: null,
      model: null,
      env: sessionEnv,
    });
    expect(launched.success).toBe(true);
    // Sabit çalıştırılabilir dosya bağımlılık çözücüsünü atlar.
    expect(resolve).not.toHaveBeenCalled();

    const sent = await runtime.sendPrompt('conv-acp-registry', { text: 'hello registry' });
    expect(sent.success).toBe(true);
    await vi.waitFor(
      async () => {
        const history = await runtime.loadHistory('conv-acp-registry');
        if (!history.success) throw new Error('history unavailable');
        const texts = history.data.turns
          .flatMap((turn) => turn.items)
          .filter((item) => item.kind === 'message' && item.role === 'assistant')
          .map((item) => (item as { text: string }).text);
        expect(texts.join('\n')).toContain('fixture-agent echo: hello registry');
        expect(texts.join('\n')).toContain('key-set');
        expect(texts.join('\n')).toContain(`cwd=${agentCwd}`);
      },
      { timeout: 15_000, interval: 100 }
    );
    expect(runtime.getSessionState('conv-acp-registry').lifecycle).toBe('ready');
  }, 60_000);
});
