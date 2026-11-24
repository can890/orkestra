import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCustomAcpAgentsFile, type CustomAcpProbe } from '@orkestra/plugins/agents';
import type { Secret } from '@orkestra/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import { CustomAcpAgentStore } from './custom-agents-store';
import type { AcpRegistryInstaller } from './installer';
import { AcpRegistryClient, type FetchLike } from './registry-client';
import { AcpRegistryService, secretKeyFor } from './service';

const fixture = readFileSync(join(__dirname, 'fixtures/registry-index.fixture.json'), 'utf8');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memorySecrets(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
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

function setup(options: { probe?: CustomAcpProbe } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orkestra-acp-service-'));
  dirs.push(root);
  const toolsDir = join(root, 'tools');
  let body = fixture;
  const fetch = vi.fn<FetchLike>(async () => new Response(body));
  const install = vi.fn<AcpRegistryInstaller['install']>(async (agent) => {
    const installDir = join(toolsDir, agent.id, agent.version);
    mkdirSync(installDir, { recursive: true });
    const command = join(installDir, 'agent');
    writeFileSync(command, '#!/bin/sh\n');
    return { command, installDir };
  });
  const reload = vi.fn();
  const store = new CustomAcpAgentStore(join(root, 'agents.json'), reload);
  const secrets = memorySecrets();
  let now = 1_000;
  const service = new AcpRegistryService({
    client: new AcpRegistryClient({ cacheDir: root, fetch, now: () => now }),
    installer: { install },
    store,
    secrets,
    toolsDir,
    builtInProviderIds: () => ['claude', 'codex', 'kimi', 'glm', 'antigravity', 'grok'],
    probe: vi.fn(async () => options.probe ?? probeResult()),
    env: async () => ({ PATH: '/usr/bin:/bin' }),
    platform: 'darwin',
    arch: 'arm64',
    now: () => now,
  });
  return {
    root,
    service,
    store,
    install,
    reload,
    secrets,
    setBody: (next: string) => (body = next),
    advance: (ms: number) => (now += ms),
  };
}

function probeResult(): CustomAcpProbe {
  return {
    probedAt: 1,
    protocolVersion: 1,
    loadSession: false,
    mcp: { http: false, sse: false },
    authMethods: [
      { id: 'key', name: 'API key', type: 'env_var', vars: [{ name: 'DEMO_API_KEY' }] },
    ],
    models: [],
    modes: [],
  };
}

function unwrap<T>(result: { success: true; data: T } | { success: false; error: unknown }): T {
  if (!result.success) throw new Error(JSON.stringify(result.error));
  return result.data;
}

describe('AcpRegistryService search', () => {
  it('marks built-in agents instead of offering them twice', async () => {
    const { service } = setup();
    const result = unwrap(await service.search(''));
    const byId = new Map(result.agents.map((agent) => [agent.id, agent]));
    expect(byId.get('claude-acp')?.builtInProviderId).toBe('claude');
    expect(byId.get('codex-acp')?.builtInProviderId).toBe('codex');
    expect(byId.get('antigravity-acp')?.builtInProviderId).toBe('antigravity');
    expect(byId.get('kimi')?.builtInProviderId).toBe('kimi');
    expect(byId.get('gemini')?.builtInProviderId).toBeNull();
    expect(result.platformTarget).toBe('darwin-aarch64');
    expect(result.discarded).toBe(2);

    const preview = await service.preview('claude-acp');
    expect(preview).toMatchObject({ success: false, error: { reason: 'invalid_input' } });
  });
});

describe('AcpRegistryService add/remove', () => {
  it('requires the reviewed plan, pins its version and persists the agent', async () => {
    const { service, store, install, reload, root } = setup();
    const plan = unwrap(await service.preview('amp-acp'));
    expect(plan).toMatchObject({
      agentId: 'amp-acp',
      version: '0.13.0',
      distribution: 'binary',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      archiveUrl: expect.stringContaining('darwin-aarch64'),
      installCommand: null,
    });
    expect(plan.launchCommand[0]).toBe(
      join(root, 'tools', 'amp-acp', '0.13.0', 'darwin-aarch64', 'amp-acp')
    );
    // Önizleme hiçbir şey kurmaz.
    expect(install).not.toHaveBeenCalled();

    const wrongDigest = await service.addRegistry({
      agentId: 'amp-acp',
      version: '0.13.0',
      digest: 'x',
    });
    expect(wrongDigest).toMatchObject({ success: false, error: { reason: 'plan_changed' } });
    const wrongVersion = await service.addRegistry({
      agentId: 'amp-acp',
      version: '0.12.0',
      digest: plan.digest,
    });
    expect(wrongVersion).toMatchObject({ success: false, error: { reason: 'plan_changed' } });
    expect(install).not.toHaveBeenCalled();

    const view = unwrap(
      await service.addRegistry({ agentId: 'amp-acp', version: plan.version, digest: plan.digest })
    );
    expect(view).toMatchObject({
      providerId: 'acp-amp-acp',
      source: 'registry',
      registry: { agentId: 'amp-acp', version: '0.13.0', distribution: 'binary' },
      executableAvailable: true,
    });
    expect(reload).toHaveBeenCalled();

    // Ajan eklendikten sonra otomatik çalıştırılmaz (yoklama yok).
    const persisted = parseCustomAcpAgentsFile(readFileSync(store.filePath, 'utf8'));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ id: 'acp-amp-acp', launch: { args: [] } });
    expect(persisted[0]!.probe).toBeUndefined();

    const search = unwrap(await service.search('amp'));
    expect(search.agents.find((agent) => agent.id === 'amp-acp')?.added).toEqual({
      providerId: 'acp-amp-acp',
      version: '0.13.0',
    });
    expect(await service.preview('amp-acp')).toMatchObject({ success: false });

    const installDir = persisted[0]!.registry!.installDir!;
    expect(existsSync(installDir)).toBe(true);
    unwrap(await service.remove('acp-amp-acp'));
    expect(existsSync(installDir)).toBe(false);
    expect(parseCustomAcpAgentsFile(readFileSync(store.filePath, 'utf8'))).toEqual([]);
  });

  it('updates only through an explicit, reviewed replacement', async () => {
    const { service, setBody, advance } = setup();
    const plan = unwrap(await service.preview('gemini'));
    unwrap(
      await service.addRegistry({ agentId: 'gemini', version: plan.version, digest: plan.digest })
    );
    expect(await service.preview('gemini', 'acp-gemini')).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('already the latest') },
    });

    setBody(fixture.replaceAll('0.71.1', '0.72.0'));
    advance(10 * 60 * 1_000);
    const updatePlan = unwrap(await service.preview('gemini', 'acp-gemini'));
    expect(updatePlan).toMatchObject({ version: '0.72.0', replacesProviderId: 'acp-gemini' });
    const updated = unwrap(
      await service.addRegistry({
        agentId: 'gemini',
        version: '0.72.0',
        digest: updatePlan.digest,
        replacesProviderId: 'acp-gemini',
      })
    );
    expect(updated.registry?.version).toBe('0.72.0');
    expect(unwrap(await service.list())).toHaveLength(1);
  });

  it('adds local commands with unique ids and validates input', async () => {
    const { service, store } = setup();
    const first = unwrap(
      await service.addLocal({
        name: 'DeepSeek Harness',
        command: 'dsh',
        args: ['--profile', 'acp'],
        env: { DSH_MODE: 'fast' },
      })
    );
    const second = unwrap(
      await service.addLocal({ name: 'DeepSeek Harness', command: '/opt/dsh', args: [], env: {} })
    );
    expect(first.providerId).toBe('acp-local-deepseek-harness');
    expect(second.providerId).toBe('acp-local-deepseek-harness-2');
    expect(first.launchCommand).toEqual(['dsh', '--profile', 'acp']);
    expect((await store.list()).map((agent) => agent.launch)).toEqual([
      { command: 'dsh', args: ['--profile', 'acp'], env: { DSH_MODE: 'fast' } },
      { command: '/opt/dsh', args: [], env: {} },
    ]);
    expect(
      await service.addLocal({ name: 'x', command: 'x', args: [], env: { 'BAD-NAME': '1' } })
    ).toMatchObject({ success: false, error: { reason: 'invalid_input' } });
    expect(
      await service.addLocal({ name: 'x', command: 'x', args: [], env: {}, cwd: 'relative/dir' })
    ).toMatchObject({ success: false, error: { reason: 'invalid_input' } });
  });

  it('stores advertised API keys in the secret store and removes them with the agent', async () => {
    const { service, secrets } = setup();
    const view = unwrap(
      await service.addLocal({ name: 'Demo', command: 'demo', args: [], env: {} })
    );
    expect(await service.setEnvSecret(view.providerId, 'DEMO_API_KEY', 'k')).toMatchObject({
      success: false,
    });

    const probed = unwrap(await service.probe(view.providerId));
    expect(probed.authMethods[0]).toMatchObject({
      type: 'env_var',
      vars: [{ name: 'DEMO_API_KEY', configured: false }],
    });
    unwrap(await service.setEnvSecret(view.providerId, 'DEMO_API_KEY', 'sk-test'));
    expect(secrets.values.get(secretKeyFor(view.providerId, 'DEMO_API_KEY'))).toBe('sk-test');
    expect(await service.envSecretsFor(view.providerId)).toEqual({ DEMO_API_KEY: 'sk-test' });
    expect(await service.envSecretsFor('claude')).toEqual({});
    expect(unwrap(await service.list())[0]!.authMethods[0]!.vars[0]!.configured).toBe(true);

    unwrap(await service.remove(view.providerId));
    expect(secrets.values.size).toBe(0);
  });
});
