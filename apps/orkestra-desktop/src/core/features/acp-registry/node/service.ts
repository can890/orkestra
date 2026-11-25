// ACP Registry ve yerel ACP komutu özelliğinin ana süreç servisi: arama, kurulum planı (onay
// özeti), kurulum, yerel komut ekleme, yoklama, kaldırma ve ortam değişkeni anahtarları.
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  builtInProviderForRegistryAgent,
  customAcpAgentSchema,
  type CustomAcpAgent,
  type CustomAcpProbe,
} from '@orkestra/plugins/agents';
import { err, ok, secret, type Result } from '@orkestra/shared';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import {
  packageManagerFor,
  resolveAcpRegistryDistribution,
  resolveAcpRegistryPlatformTarget,
  normalizeRegistryCommandPath,
  type AcpRegistryPlatformTarget,
  type ResolvedAcpRegistryDistribution,
} from '../api/distribution';
import { acpRegistrySearchRank, type AcpRegistryAgent } from '../api/registry-schema';
import type {
  AcpRegistryError,
  AcpRegistryErrorReason,
  AddLocalAgentInput,
  CustomAgentView,
  RegistryInstallPlan,
  RegistrySearchAgent,
  RegistrySearchResult,
} from '../api/schemas';
import type { CustomAcpAgentStore } from './custom-agents-store';
import {
  agentVersionRoot,
  AcpInstallError,
  findExecutable,
  packageInstallCommand,
  type AcpRegistryInstaller,
} from './installer';
import { AcpProbeError, type ProbeLaunch } from './probe';
import {
  AcpRegistryAgentNotFoundError,
  AcpRegistryUnavailableError,
  type AcpRegistryClient,
} from './registry-client';

const SEARCH_LIMIT = 100;

export type AcpRegistryServiceDeps = {
  client: Pick<AcpRegistryClient, 'load' | 'findAgent' | 'iconDataUri'>;
  installer: Pick<AcpRegistryInstaller, 'install'>;
  store: CustomAcpAgentStore;
  secrets: SecretStore;
  toolsDir: string;
  builtInProviderIds: () => string[];
  probe: (launch: ProbeLaunch) => Promise<CustomAcpProbe>;
  /** Yoklama ve PATH araması için kullanıcı kabuk ortamı. */
  env: () => Promise<Record<string, string>>;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => number;
};

type ServiceResult<T> = Promise<Result<T, AcpRegistryError>>;

function fail(reason: AcpRegistryErrorReason, message: string): Result<never, AcpRegistryError> {
  return err({ type: 'acp-registry', reason, message });
}

function toError(
  error: unknown,
  fallback: AcpRegistryErrorReason
): Result<never, AcpRegistryError> {
  if (error instanceof AcpInstallError) return fail(error.reason, error.message);
  if (error instanceof AcpRegistryUnavailableError)
    return fail('registry_unavailable', error.message);
  if (error instanceof AcpRegistryAgentNotFoundError) return fail('agent_not_found', error.message);
  if (error instanceof AcpProbeError) return fail('probe_failed', error.message);
  return fail(fallback, error instanceof Error ? error.message : String(error));
}

export function secretKeyFor(providerId: string, name: string): string {
  return `acp-agent:${providerId}:${name}`;
}

export class AcpRegistryService {
  private readonly platform: NodeJS.Platform;
  private readonly platformTarget: AcpRegistryPlatformTarget | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: AcpRegistryServiceDeps) {
    this.platform = deps.platform ?? process.platform;
    this.platformTarget = resolveAcpRegistryPlatformTarget(
      this.platform,
      deps.arch ?? process.arch
    );
    this.now = deps.now ?? Date.now;
  }

  async search(query: string, refresh = false): ServiceResult<RegistrySearchResult> {
    try {
      const load = await this.deps.client.load({ refresh });
      const added = await this.deps.store.list();
      const env = await this.deps.env();
      const runnerAvailable = new Map<string, boolean>();
      const ranked: Array<{ agent: RegistrySearchAgent; rank: number }> = [];
      for (const agent of load.index.agents) {
        const rank = acpRegistrySearchRank(agent, query);
        if (rank === undefined) continue;
        const distribution = resolveAcpRegistryDistribution({
          agent,
          platformTarget: this.platformTarget,
        });
        // Bu makinede çalışamayacak ajanlar listelenmez (T3 ile aynı).
        if (!distribution) continue;
        const runner = packageManagerFor(distribution.kind) ?? null;
        if (runner && !runnerAvailable.has(runner)) {
          runnerAvailable.set(runner, (await findExecutable(runner, env)) !== undefined);
        }
        const existing = added.find((candidate) => candidate.registry?.agentId === agent.id);
        ranked.push({
          rank,
          agent: {
            id: agent.id,
            name: agent.name,
            version: agent.version,
            description: agent.description,
            authors: agent.authors ?? [],
            license: agent.license ?? null,
            website: agent.website ?? null,
            repository: agent.repository ?? null,
            hasIcon: agent.icon !== undefined,
            distribution: distribution.kind,
            integrity:
              distribution.kind === 'binary' && distribution.binaryTarget?.sha256
                ? 'sha256'
                : 'registry',
            runner,
            runnerAvailable: runner ? runnerAvailable.get(runner) === true : true,
            builtInProviderId:
              builtInProviderForRegistryAgent(agent.id, this.deps.builtInProviderIds()) ?? null,
            added: existing
              ? { providerId: existing.id, version: existing.registry?.version ?? '' }
              : null,
          },
        });
      }
      ranked.sort(
        (a, b) =>
          a.rank - b.rank ||
          compare(a.agent.name.toLowerCase(), b.agent.name.toLowerCase()) ||
          compare(a.agent.id, b.agent.id)
      );
      return ok({
        agents: ranked.slice(0, SEARCH_LIMIT).map((entry) => entry.agent),
        fetchedAt: load.fetchedAt,
        offline: load.offline,
        stale: load.stale,
        offlineReason: load.offlineReason,
        platformTarget: this.platformTarget ?? null,
        discarded: load.index.discarded,
      });
    } catch (error) {
      return toError(error, 'registry_unavailable');
    }
  }

  async icon(agentId: string): ServiceResult<{ dataUri: string | null }> {
    try {
      const { agent } = await this.deps.client.findAgent(agentId);
      return ok({ dataUri: await this.deps.client.iconDataUri(agent) });
    } catch (error) {
      return toError(error, 'registry_unavailable');
    }
  }

  async preview(agentId: string, replacesProviderId?: string): ServiceResult<RegistryInstallPlan> {
    try {
      const { agent } = await this.deps.client.findAgent(agentId);
      const checked = await this.checkRegistryAgent(agent, replacesProviderId);
      if (!checked.success) return checked;
      return ok(this.buildPlan(agent, checked.data, replacesProviderId ?? null));
    } catch (error) {
      return toError(error, 'registry_unavailable');
    }
  }

  async addRegistry(input: {
    agentId: string;
    version: string;
    digest: string;
    replacesProviderId?: string;
  }): ServiceResult<CustomAgentView> {
    try {
      const { agent } = await this.deps.client.findAgent(input.agentId);
      if (agent.version !== input.version) {
        return fail(
          'plan_changed',
          `The registry now lists ${agent.name} ${agent.version} instead of the confirmed ${input.version}. Review the agent again.`
        );
      }
      const checked = await this.checkRegistryAgent(agent, input.replacesProviderId);
      if (!checked.success) return checked;
      const plan = this.buildPlan(agent, checked.data, input.replacesProviderId ?? null);
      if (plan.digest !== input.digest) {
        return fail(
          'plan_changed',
          'The registry entry changed after review. Review the agent again.'
        );
      }
      const installed = await this.deps.installer.install(agent, checked.data);
      const iconDataUri = await this.deps.client.iconDataUri(agent).catch(() => null);
      const providerId = input.replacesProviderId ?? registryProviderId(agent.id);
      let previousInstallDir: string | undefined;
      const stored = await this.deps.store.update((agents) => {
        const previous = agents.find((candidate) => candidate.id === providerId);
        if (previous && !input.replacesProviderId) {
          throw new AcpInstallError(
            'invalid_input',
            `An agent with id '${providerId}' already exists.`
          );
        }
        previousInstallDir = previous?.registry?.installDir;
        const next = customAcpAgentSchema.parse({
          id: providerId,
          source: 'registry',
          name: agent.name,
          description: agent.description,
          ...(iconDataUri ? { iconDataUri } : {}),
          launch: {
            command: installed.command,
            args: checked.data.args,
            env: checked.data.env,
          },
          registry: {
            agentId: agent.id,
            version: agent.version,
            distribution: checked.data.kind,
            ...(checked.data.packageSpec ? { packageSpec: checked.data.packageSpec } : {}),
            ...(checked.data.binaryTarget
              ? {
                  archiveUrl: checked.data.binaryTarget.archive,
                  ...(checked.data.binaryTarget.sha256
                    ? { sha256: checked.data.binaryTarget.sha256.toLowerCase() }
                    : {}),
                }
              : {}),
            ...(agent.website ? { website: agent.website } : {}),
            ...(agent.repository ? { repository: agent.repository } : {}),
            ...(agent.license ? { license: agent.license } : {}),
            installDir: installed.installDir,
          },
          // Sürüm değişince eski yoklama sonuçları güvenilmez; yeniden yoklanmalı.
          addedAt: previous?.addedAt ?? this.now(),
        });
        return {
          agents: previous
            ? agents.map((candidate) => (candidate.id === providerId ? next : candidate))
            : [...agents, next],
          result: next,
        };
      });
      if (previousInstallDir && previousInstallDir !== installed.installDir) {
        await this.removeManagedDir(previousInstallDir);
      }
      return ok(await this.toView(stored));
    } catch (error) {
      return toError(error, 'install_failed');
    }
  }

  async addLocal(input: AddLocalAgentInput): ServiceResult<CustomAgentView> {
    const name = input.name.trim();
    const command = input.command.trim();
    if (/[\r\n]/u.test(command))
      return fail('invalid_input', 'The command must be a single executable.');
    if (input.cwd?.trim() && !isAbsolute(input.cwd.trim())) {
      return fail('invalid_input', 'The working directory must be an absolute path.');
    }
    if (this.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command)) {
      return fail(
        'invalid_input',
        'Local ACP commands launch without a shell. Configure the underlying executable instead of a batch wrapper.'
      );
    }
    for (const key of Object.keys(input.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
        return fail('invalid_input', `Invalid environment variable name '${key}'.`);
      }
    }
    try {
      const stored = await this.deps.store.update((agents) => {
        const id = uniqueId(
          localProviderId(name),
          new Set([...agents.map((agent) => agent.id), ...this.deps.builtInProviderIds()])
        );
        const next = customAcpAgentSchema.parse({
          id,
          source: 'local',
          name,
          description: '',
          launch: {
            command,
            args: input.args,
            env: input.env,
            ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
          },
          addedAt: this.now(),
        });
        return { agents: [...agents, next], result: next };
      });
      return ok(await this.toView(stored));
    } catch (error) {
      return toError(error, 'invalid_input');
    }
  }

  async list(): ServiceResult<CustomAgentView[]> {
    try {
      const agents = await this.deps.store.list();
      return ok(await Promise.all(agents.map((agent) => this.toView(agent))));
    } catch (error) {
      return toError(error, 'io');
    }
  }

  /** Kullanıcı isteğiyle ajanı kısa süre başlatıp yeteneklerini okur ve kaydeder. */
  async probe(providerId: string): ServiceResult<CustomAgentView> {
    const agent = await this.deps.store.get(providerId);
    if (!agent) return fail('not_found', `Agent '${providerId}' was not found.`);
    try {
      const env = {
        ...(await this.deps.env()),
        ...agent.launch.env,
        ...(await this.envSecretsFor(providerId)),
      };
      const probe = await this.deps.probe({
        command: agent.launch.command,
        args: agent.launch.args,
        env,
        ...(agent.launch.cwd ? { cwd: agent.launch.cwd } : {}),
      });
      const stored = await this.deps.store.update((agents) => {
        const current = agents.find((candidate) => candidate.id === providerId);
        if (!current) throw new Error(`Agent '${providerId}' was removed.`);
        const next = { ...current, probe };
        return {
          agents: agents.map((candidate) => (candidate.id === providerId ? next : candidate)),
          result: next,
        };
      });
      return ok(await this.toView(stored));
    } catch (error) {
      return toError(error, 'probe_failed');
    }
  }

  async remove(providerId: string): ServiceResult<void> {
    try {
      const removed = await this.deps.store.update((agents) => ({
        agents: agents.filter((agent) => agent.id !== providerId),
        result: agents.find((agent) => agent.id === providerId),
      }));
      if (!removed) return fail('not_found', `Agent '${providerId}' was not found.`);
      for (const name of envVarNames(removed)) {
        await this.deps.secrets.deleteSecret(secretKeyFor(providerId, name)).catch(() => undefined);
      }
      if (removed.registry?.installDir) await this.removeManagedDir(removed.registry.installDir);
      return ok();
    } catch (error) {
      return toError(error, 'io');
    }
  }

  async setEnvSecret(providerId: string, name: string, value: string | null): ServiceResult<void> {
    const agent = await this.deps.store.get(providerId);
    if (!agent) return fail('not_found', `Agent '${providerId}' was not found.`);
    if (!envVarNames(agent).includes(name)) {
      return fail('invalid_input', `${agent.name} does not declare the variable '${name}'.`);
    }
    try {
      const key = secretKeyFor(providerId, name);
      if (value === null || value.length === 0) await this.deps.secrets.deleteSecret(key);
      else await this.deps.secrets.setSecret(key, secret(value, `${agent.name} ${name}`));
      return ok();
    } catch (error) {
      return toError(error, 'io');
    }
  }

  /** Oturum başlatırken ajana verilecek, sır deposundaki ortam değişkenleri. */
  async envSecretsFor(providerId: string): Promise<Record<string, string>> {
    if (!providerId.startsWith('acp-')) return {};
    const agent = await this.deps.store.get(providerId);
    if (!agent) return {};
    const env: Record<string, string> = {};
    for (const name of envVarNames(agent)) {
      const stored = await this.deps.secrets
        .getSecret(secretKeyFor(providerId, name))
        .catch(() => null);
      if (stored) env[name] = stored.expose();
    }
    return env;
  }

  private async checkRegistryAgent(
    agent: AcpRegistryAgent,
    replacesProviderId: string | undefined
  ): Promise<Result<ResolvedAcpRegistryDistribution, AcpRegistryError>> {
    const builtIn = builtInProviderForRegistryAgent(agent.id, this.deps.builtInProviderIds());
    if (builtIn) {
      return fail(
        'invalid_input',
        `${agent.name} is built into Orkestra. Enable it under Agents instead.`
      );
    }
    const distribution = resolveAcpRegistryDistribution({
      agent,
      platformTarget: this.platformTarget,
    });
    if (!distribution) {
      return fail(
        this.platformTarget ? 'unsupported_distribution' : 'unsupported_platform',
        `${agent.name} has no distribution for ${this.platform}-${this.deps.arch ?? process.arch}.`
      );
    }
    if (
      distribution.kind === 'binary' &&
      !normalizeRegistryCommandPath(distribution.binaryTarget!.cmd)
    ) {
      return fail('archive_invalid', `${agent.name} declares an unsafe command path.`);
    }
    const added = await this.deps.store.list();
    if (replacesProviderId) {
      const current = added.find((candidate) => candidate.id === replacesProviderId);
      if (!current || current.registry?.agentId !== agent.id) {
        return fail(
          'not_found',
          `Agent '${replacesProviderId}' is not an installed copy of ${agent.name}.`
        );
      }
      if (current.registry.version === agent.version) {
        return fail(
          'invalid_input',
          `${agent.name} ${agent.version} is already the latest version.`
        );
      }
    } else if (added.some((candidate) => candidate.registry?.agentId === agent.id)) {
      return fail('invalid_input', `${agent.name} is already added.`);
    }
    return ok(distribution);
  }

  private buildPlan(
    agent: AcpRegistryAgent,
    distribution: ResolvedAcpRegistryDistribution,
    replacesProviderId: string | null
  ): RegistryInstallPlan {
    const versionRoot = agentVersionRoot(this.deps.toolsDir, agent.id, agent.version);
    let launchCommand: string[];
    if (distribution.kind === 'binary') {
      const segments = normalizeRegistryCommandPath(distribution.binaryTarget!.cmd)!;
      launchCommand = [
        join(versionRoot, distribution.platformTarget!, ...segments),
        ...distribution.args,
      ];
    } else if (distribution.kind === 'npx') {
      launchCommand = [
        `${join(versionRoot, 'npm', 'bin')}/<${distribution.packageSpec} command>`,
        ...distribution.args,
      ];
    } else {
      launchCommand = [
        `${join(versionRoot, 'python', 'bin')}/<${distribution.packageSpec} command>`,
        ...distribution.args,
      ];
    }
    const archiveUrl = distribution.binaryTarget?.archive ?? null;
    const sha256 = distribution.binaryTarget?.sha256?.toLowerCase() ?? null;
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          agentId: agent.id,
          version: agent.version,
          kind: distribution.kind,
          packageSpec: distribution.packageSpec ?? null,
          archiveUrl,
          sha256,
          cmd: distribution.binaryTarget?.cmd ?? null,
          args: distribution.args,
          env: distribution.env,
          platformTarget: distribution.platformTarget ?? null,
        })
      )
      .digest('hex');
    return {
      agentId: agent.id,
      name: agent.name,
      version: agent.version,
      distribution: distribution.kind,
      packageSpec: distribution.packageSpec ?? null,
      archiveUrl,
      sha256,
      installCommand: packageInstallCommand(distribution, versionRoot),
      installDir: versionRoot,
      launchCommand,
      launchEnv: distribution.env,
      license: agent.license ?? null,
      repository: agent.repository ?? null,
      website: agent.website ?? null,
      digest,
      replacesProviderId,
    };
  }

  /** Yalnızca Orkestra'nın araç dizini içindeki kurulumları siler. */
  private async removeManagedDir(dir: string): Promise<void> {
    const rel = relative(this.deps.toolsDir, dir);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async toView(agent: CustomAcpAgent): Promise<CustomAgentView> {
    const env = await this.deps.env().catch(() => ({}) as Record<string, string>);
    const configured = new Set<string>();
    for (const name of envVarNames(agent)) {
      const stored = await this.deps.secrets
        .getSecret(secretKeyFor(agent.id, name))
        .catch(() => null);
      if (stored) configured.add(name);
    }
    return {
      providerId: agent.id,
      source: agent.source,
      name: agent.name,
      description: agent.description,
      iconDataUri: agent.iconDataUri ?? null,
      launchCommand: [agent.launch.command, ...agent.launch.args],
      launchEnvNames: Object.keys(agent.launch.env),
      cwd: agent.launch.cwd ?? null,
      executableAvailable: (await findExecutable(agent.launch.command, env)) !== undefined,
      registry: agent.registry
        ? {
            agentId: agent.registry.agentId,
            version: agent.registry.version,
            distribution: agent.registry.distribution,
            packageSpec: agent.registry.packageSpec ?? null,
            archiveUrl: agent.registry.archiveUrl ?? null,
            sha256: agent.registry.sha256 ?? null,
          }
        : null,
      probe: agent.probe
        ? {
            probedAt: agent.probe.probedAt,
            protocolVersion: agent.probe.protocolVersion,
            agentName: agent.probe.agentName ?? null,
            agentVersion: agent.probe.agentVersion ?? null,
            loadSession: agent.probe.loadSession,
            models: agent.probe.models,
            modes: agent.probe.modes,
            sessionError: agent.probe.sessionError ?? null,
          }
        : null,
      authMethods: (agent.probe?.authMethods ?? []).map((method) => ({
        id: method.id,
        name: method.name,
        description: method.description ?? null,
        type: method.type,
        args: method.args ?? [],
        vars: (method.vars ?? []).map((variable) => ({
          name: variable.name,
          label: variable.label ?? variable.name,
          configured: configured.has(variable.name),
        })),
        link: method.link ?? null,
      })),
      addedAt: agent.addedAt,
    };
  }
}

function envVarNames(agent: CustomAcpAgent): string[] {
  const names = new Set<string>();
  for (const method of agent.probe?.authMethods ?? []) {
    if (method.type !== 'env_var') continue;
    for (const variable of method.vars ?? []) names.add(variable.name);
  }
  return [...names];
}

export function registryProviderId(agentId: string): string {
  return `acp-${agentId}`.slice(0, 96);
}

// NFKD ile ayrışmayan harfler (Türkçe noktasız ı, ß, ø…) için ASCII karşılıkları.
const SLUG_LETTERS: Record<string, string> = {
  ı: 'i',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ł: 'l',
  þ: 'th',
};

/**
 * Yeni bir yerel ajanın kimliği. Yalnızca eklenirken bir kez üretilir ve dosyaya yazılır; kayıtlı
 * ajanların kimliği (ve onlara bağlı sohbetler/ayarlar) bu işlev değişse de aynı kalır.
 */
export function localProviderId(name: string): string {
  const slug = name
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[ıßæœøđłþ]/gu, (letter) => SLUG_LETTERS[letter] ?? letter)
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60);
  return `acp-local-${slug || 'agent'}`;
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
