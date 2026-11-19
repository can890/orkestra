import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostRef } from '@orkestra/core/primitives/host/api';
import { err, ok, type Result } from '@orkestra/shared';
import { z } from 'zod';
import { parseMarketplaceSource } from '../api/marketplace-source';
import type {
  InstalledPluginSummary,
  Marketplace,
  MarketplacePlugin,
  PluginPacksState,
  PluginPreview,
  UninstallResult,
} from '../api/schemas';
import type { CloneFn } from './git-clone';
import {
  mcpFingerprint,
  readPluginPlan,
  sanitizeName,
  sha256,
  type PluginEntry,
  type PluginPlan,
  type PlanMcpServer,
} from './plugin-reader';
import type { InstallRecord, MarketplaceRecord, ProvenanceStore } from './provenance-store';
import { PluginPathError, readFileInside, resolveInside } from './safe-path';

const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_MARKETPLACE_PLUGINS = 500;

export type PluginPromptStore = {
  get(): Promise<{ id: string; title: string; prompt: string }[]>;
  set(prompts: { id: string; title: string; prompt: string }[]): Promise<void>;
};

export type InstalledSkillInfo = { installId: string; content?: string };
export type InstalledMcpInfo = {
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  cwd?: string;
};

/** Skills ve MCP servislerinin üstündeki, host başına ince bağdaştırıcı. */
export type PluginHostTarget = {
  listSkills(): Promise<InstalledSkillInfo[]>;
  installSkill(skill: { installId: string; content: string }): Promise<Result<void, string>>;
  removeSkill(installId: string): Promise<Result<void, string>>;
  listMcpServers(): Promise<InstalledMcpInfo[]>;
  saveMcpServer(server: PlanMcpServer, providers: string[]): Promise<Result<void, string>>;
  removeMcpServer(name: string): Promise<Result<void, string>>;
};

export type PluginPacksServiceDeps = {
  /** `<userData>/plugin-packs` */
  rootDir: string;
  store: ProvenanceStore;
  prompts: PluginPromptStore;
  clone: CloneFn;
  resolveHost: (host: HostRef) => Promise<Result<PluginHostTarget, string>>;
  now?: () => number;
};

const marketplaceManifestSchema = z.object({
  name: z.string().min(1).max(100),
  plugins: z
    .array(
      z
        .object({
          name: z.string(),
          source: z.union([z.string(), z.record(z.string(), z.unknown())]),
          description: z.string().optional(),
          version: z.string().optional(),
        })
        .passthrough()
    )
    .max(MAX_MARKETPLACE_PLUGINS),
});

export class PluginPacksService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PluginPacksServiceDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private marketplaceDir(id: string): string {
    return join(this.deps.rootDir, 'marketplaces', id);
  }

  async getState(): Promise<Result<PluginPacksState, string>> {
    return this.guard(async () => {
      const state = await this.deps.store.read();
      return {
        marketplaces: state.marketplaces,
        installs: state.installs.map(toSummary),
      };
    });
  }

  async addMarketplace(source: string): Promise<Result<Marketplace, string>> {
    const parsed = parseMarketplaceSource(source);
    if (!parsed.success) return err(parsed.error);
    const id = `${sanitizeName(parsed.data.label).toLowerCase().slice(0, 40)}-${sha256(parsed.data.url).slice(0, 8)}`;
    return this.guard(async () => {
      const existing = (await this.deps.store.read()).marketplaces.find((m) => m.id === id);
      if (existing) throw new UserError('Bu marketplace zaten ekli.');

      const marketplacesDir = join(this.deps.rootDir, 'marketplaces');
      await mkdir(marketplacesDir, { recursive: true });
      const tmp = join(marketplacesDir, `.tmp-${randomBytes(6).toString('hex')}`);
      try {
        await this.deps.clone(parsed.data.url, tmp);
        const manifest = await readMarketplaceManifest(tmp);
        await rm(this.marketplaceDir(id), { recursive: true, force: true });
        await rename(tmp, this.marketplaceDir(id));
        const record: MarketplaceRecord = {
          id,
          name: manifest.name,
          label: parsed.data.label,
          url: parsed.data.url,
          addedAt: this.now,
        };
        await this.deps.store.update((state) => ({
          state: { ...state, marketplaces: [...state.marketplaces, record] },
          result: undefined,
        }));
        return record;
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  }

  async removeMarketplace(id: string): Promise<Result<void, string>> {
    return this.guard(async () => {
      const state = await this.deps.store.read();
      if (!state.marketplaces.some((m) => m.id === id)) throw new UserError('Marketplace bulunamadı.');
      if (state.installs.some((i) => i.marketplaceId === id)) {
        throw new UserError('Bu marketplace\'ten kurulu eklentiler var; önce onları kaldırın.');
      }
      await this.deps.store.update((s) => ({
        state: { ...s, marketplaces: s.marketplaces.filter((m) => m.id !== id) },
        result: undefined,
      }));
      await rm(this.marketplaceDir(id), { recursive: true, force: true });
    });
  }

  async listPlugins(marketplaceId: string): Promise<Result<{ plugins: MarketplacePlugin[] }, string>> {
    return this.guard(async () => {
      const state = await this.deps.store.read();
      const dir = this.requireMarketplace(state.marketplaces, marketplaceId);
      const manifest = await readMarketplaceManifest(dir);
      const plugins: MarketplacePlugin[] = [];
      for (const entry of manifest.plugins) {
        if (!PLUGIN_NAME.test(entry.name)) continue;
        const location = await locatePlugin(dir, entry.source).catch((error: unknown) =>
          error instanceof Error ? error : new Error(String(error))
        );
        plugins.push({
          name: entry.name,
          description: entry.description,
          version: entry.version,
          unavailableReason: location instanceof Error ? location.message : undefined,
          installed: state.installs.some(
            (i) => i.marketplaceId === marketplaceId && i.plugin === entry.name
          ),
        });
      }
      return { plugins };
    });
  }

  async previewPlugin(input: {
    host: HostRef;
    marketplaceId: string;
    plugin: string;
  }): Promise<Result<PluginPreview, string>> {
    return this.guard(async () => {
      const { plan, target } = await this.buildPlan(input);
      return { ...plan.preview, conflicts: await this.findConflicts(plan, target, input) };
    });
  }

  async installPlugin(input: {
    host: HostRef;
    marketplaceId: string;
    plugin: string;
    digest: string;
    providers: string[];
  }): Promise<Result<InstalledPluginSummary, string>> {
    return this.guard(async () => {
      const { plan, target } = await this.buildPlan(input);
      if (plan.preview.digest !== input.digest) {
        throw new UserError('Eklenti içeriği onaylanan özetten farklı; önizlemeyi yenileyin.');
      }
      const conflicts = await this.findConflicts(plan, target, input);
      if (conflicts.length > 0) {
        throw new UserError(`Kurulum engellendi, çakışma var: ${conflicts.join(', ')}`);
      }
      if (plan.mcpServers.length > 0) {
        if (input.providers.length === 0) {
          throw new UserError('MCP sunucuları için en az bir ajan seçin.');
        }
        if (!input.providers.every((id) => PROVIDER_ID.test(id))) {
          throw new UserError('Geçersiz ajan kimliği.');
        }
      }

      const added = { skills: [] as string[], mcp: [] as string[], prompts: [] as string[] };
      try {
        for (const skill of plan.skills) {
          const result = await target.installSkill({
            installId: skill.installId,
            content: skill.content,
          });
          if (!result.success) throw new UserError(result.error);
          added.skills.push(skill.installId);
        }
        for (const server of plan.mcpServers) {
          const result = await target.saveMcpServer(server, input.providers);
          if (!result.success) throw new UserError(result.error);
          added.mcp.push(server.name);
        }
        if (plan.commands.length > 0) {
          const library = await this.deps.prompts.get();
          await this.deps.prompts.set([
            ...library,
            ...plan.commands.map((c) => ({ id: c.promptId, title: c.title, prompt: c.prompt })),
          ]);
          added.prompts.push(...plan.commands.map((c) => c.promptId));
        }
      } catch (error) {
        await this.rollback(target, added);
        throw error;
      }

      const record: InstallRecord = {
        marketplaceId: input.marketplaceId,
        plugin: input.plugin,
        hostKey: hostKey(input.host),
        installedAt: this.now,
        skills: plan.skills.map((s) => ({ id: s.installId, hash: sha256(s.content) })),
        mcpServers: plan.mcpServers.map((s) => ({ id: s.name, hash: mcpFingerprint(s) })),
        prompts: plan.commands.map((c) => ({ id: c.promptId, hash: sha256(c.prompt) })),
      };
      try {
        await this.deps.store.update((state) => ({
          state: { ...state, installs: [...state.installs, record] },
          result: undefined,
        }));
      } catch (error) {
        await this.rollback(target, added);
        throw error;
      }
      return toSummary(record);
    });
  }

  async uninstallPlugin(input: {
    host: HostRef;
    marketplaceId: string;
    plugin: string;
  }): Promise<Result<UninstallResult, string>> {
    return this.guard(async () => {
      const target = await this.requireTarget(input.host);
      const key = hostKey(input.host);
      const state = await this.deps.store.read();
      const record = state.installs.find(
        (i) =>
          i.marketplaceId === input.marketplaceId && i.plugin === input.plugin && i.hostKey === key
      );
      if (!record) throw new UserError('Bu eklenti için köken kaydı yok; hiçbir şey silinmedi.');

      const removed: string[] = [];
      const kept: string[] = [];

      const skills = new Map((await target.listSkills()).map((s) => [s.installId, s]));
      for (const item of record.skills) {
        const current = skills.get(item.id);
        if (!current) continue;
        if (current.content !== undefined && sha256(current.content) !== item.hash) {
          kept.push(`Skill: ${item.id} (sonradan değiştirilmiş)`);
          continue;
        }
        const result = await target.removeSkill(item.id);
        if (!result.success) throw new UserError(result.error);
        removed.push(`Skill: ${item.id}`);
      }

      const servers = new Map((await target.listMcpServers()).map((s) => [s.name, s]));
      for (const item of record.mcpServers) {
        const current = servers.get(item.id);
        if (!current) continue;
        if (mcpFingerprint(current) !== item.hash) {
          kept.push(`MCP: ${item.id} (sonradan değiştirilmiş)`);
          continue;
        }
        const result = await target.removeMcpServer(item.id);
        if (!result.success) throw new UserError(result.error);
        removed.push(`MCP: ${item.id}`);
      }

      if (record.prompts.length > 0) {
        const library = await this.deps.prompts.get();
        const drop = new Set<string>();
        for (const item of record.prompts) {
          const current = library.find((p) => p.id === item.id);
          if (!current) continue;
          if (sha256(current.prompt) !== item.hash) {
            kept.push(`Komut: ${item.id} (sonradan değiştirilmiş)`);
            continue;
          }
          drop.add(item.id);
          removed.push(`Komut: ${item.id}`);
        }
        if (drop.size > 0) await this.deps.prompts.set(library.filter((p) => !drop.has(p.id)));
      }

      await this.deps.store.update((s) => ({
        state: {
          ...s,
          installs: s.installs.filter(
            (i) =>
              !(
                i.marketplaceId === record.marketplaceId &&
                i.plugin === record.plugin &&
                i.hostKey === record.hostKey
              )
          ),
        },
        result: undefined,
      }));
      return { removed, kept };
    });
  }

  private async rollback(
    target: PluginHostTarget,
    added: { skills: string[]; mcp: string[]; prompts: string[] }
  ): Promise<void> {
    for (const id of added.skills) await target.removeSkill(id).catch(() => undefined);
    for (const name of added.mcp) await target.removeMcpServer(name).catch(() => undefined);
    if (added.prompts.length > 0) {
      const drop = new Set(added.prompts);
      const library = await this.deps.prompts.get().catch(() => null);
      if (library) await this.deps.prompts.set(library.filter((p) => !drop.has(p.id))).catch(() => undefined);
    }
  }

  private requireMarketplace(marketplaces: MarketplaceRecord[], id: string): string {
    if (!marketplaces.some((m) => m.id === id)) throw new UserError('Marketplace bulunamadı.');
    return this.marketplaceDir(id);
  }

  private async requireTarget(host: HostRef): Promise<PluginHostTarget> {
    if (host.type !== 'local') {
      throw new UserError('Eklentiler yalnızca bu bilgisayara (yerel host) kurulabilir.');
    }
    const target = await this.deps.resolveHost(host);
    if (!target.success) throw new UserError(target.error);
    return target.data;
  }

  private async buildPlan(input: {
    host: HostRef;
    marketplaceId: string;
    plugin: string;
  }): Promise<{ plan: PluginPlan; target: PluginHostTarget }> {
    const target = await this.requireTarget(input.host);
    if (!PLUGIN_NAME.test(input.plugin)) throw new UserError('Geçersiz eklenti adı.');
    const state = await this.deps.store.read();
    const dir = this.requireMarketplace(state.marketplaces, input.marketplaceId);
    const manifest = await readMarketplaceManifest(dir);
    const entry = manifest.plugins.find((p) => p.name === input.plugin);
    if (!entry) throw new UserError('Eklenti marketplace içinde bulunamadı.');
    const { source: _source, name: _name, description, version, ...extras } = entry;
    const pluginRoot = await locatePlugin(dir, entry.source);
    const pluginEntry: PluginEntry = { name: entry.name, description, version, extras };
    const plan = await readPluginPlan({
      marketplaceId: input.marketplaceId,
      pluginRoot,
      entry: pluginEntry,
    });
    return { plan, target };
  }

  private async findConflicts(
    plan: PluginPlan,
    target: PluginHostTarget,
    input: { host: HostRef; marketplaceId: string; plugin: string }
  ): Promise<string[]> {
    const conflicts: string[] = [];
    const state = await this.deps.store.read();
    if (
      state.installs.some(
        (i) =>
          i.marketplaceId === input.marketplaceId &&
          i.plugin === input.plugin &&
          i.hostKey === hostKey(input.host)
      )
    ) {
      conflicts.push('Eklenti zaten kurulu');
    }
    const skills = new Set((await target.listSkills()).map((s) => s.installId));
    for (const skill of plan.skills) if (skills.has(skill.installId)) conflicts.push(`Skill: ${skill.installId}`);
    const servers = new Set((await target.listMcpServers()).map((s) => s.name));
    for (const server of plan.mcpServers) if (servers.has(server.name)) conflicts.push(`MCP: ${server.name}`);
    const prompts = new Set((await this.deps.prompts.get()).map((p) => p.id));
    for (const command of plan.commands) if (prompts.has(command.promptId)) conflicts.push(`Komut: ${command.name}`);
    return conflicts;
  }

  /** Tüm işlemler sıraya girer: eşzamanlı kurulumlar çakışma denetimini atlatamaz. */
  private async guard<T>(work: () => Promise<T>): Promise<Result<T, string>> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    try {
      return ok(await run);
    } catch (error) {
      if (error instanceof UserError || error instanceof PluginPathError) return err(error.message);
      return err(error instanceof Error ? error.message : String(error));
    }
  }
}

class UserError extends Error {}

export function hostKey(host: HostRef): string {
  return `${host.type}:${host.id}`;
}

function toSummary(record: InstallRecord): InstalledPluginSummary {
  return {
    marketplaceId: record.marketplaceId,
    plugin: record.plugin,
    hostKey: record.hostKey,
    installedAt: record.installedAt,
    skills: record.skills.map((s) => s.id),
    mcpServers: record.mcpServers.map((s) => s.id),
    prompts: record.prompts.map((p) => p.id),
  };
}

async function readMarketplaceManifest(dir: string): Promise<z.infer<typeof marketplaceManifestSchema>> {
  const text = await readFileInside(dir, '.claude-plugin/marketplace.json', 1_000_000);
  if (text === null) throw new UserError('Depoda .claude-plugin/marketplace.json bulunamadı.');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UserError('marketplace.json okunamadı (bozuk JSON).');
  }
  const parsed = marketplaceManifestSchema.safeParse(json);
  if (!parsed.success) throw new UserError('marketplace.json geçersiz.');
  return parsed.data;
}

/** Marketplace girdisinin eklenti dizinini (marketplace kökü içinde) bulur. */
async function locatePlugin(
  marketplaceDir: string,
  source: string | Record<string, unknown>
): Promise<string> {
  if (typeof source !== 'string') {
    throw new UserError('Harici (github/url) eklenti kaynakları desteklenmiyor.');
  }
  const rel = source.replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  const resolved = await resolveInside(marketplaceDir, rel);
  if (!resolved) throw new UserError(`Eklenti dizini bulunamadı: ${source}`);
  if (!(await stat(resolved)).isDirectory()) throw new UserError('Eklenti kaynağı dizin değil.');
  return resolved;
}
