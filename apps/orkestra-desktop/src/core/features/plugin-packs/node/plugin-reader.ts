import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { isValidSkillName, parseFrontmatter } from '@orkestra/core/primitives/skills/api';
import { z } from 'zod';
import type { PluginPreview, PreviewMcpServer } from '../api/schemas';
import { listDirInside, readFileInside, resolveInside } from './safe-path';

const MAX_JSON_BYTES = 1_000_000;
const MAX_SKILL_BYTES = 256_000;
const MAX_COMMAND_BYTES = 64_000;
const MAX_SKILLS = 100;
const MAX_COMMANDS = 200;
const MAX_MCP_SERVERS = 50;
const MAX_HOOK_LINES = 100;

export type PlanSkill = { installId: string; description: string; content: string };
export type PlanCommand = { name: string; promptId: string; title: string; prompt: string };
export type PlanMcpServer = PreviewMcpServer & { transport: 'stdio' | 'http' };

export type PluginPlan = {
  preview: Omit<PluginPreview, 'conflicts'>;
  skills: PlanSkill[];
  commands: PlanCommand[];
  mcpServers: PlanMcpServer[];
};

export type PluginEntry = {
  name: string;
  description?: string;
  version?: string;
  /** Marketplace girdisinden gelen bileşen alanları (plugin.json'u tamamlar). */
  extras?: Record<string, unknown>;
};

const pathListSchema = z.union([z.string(), z.array(z.string())]);

const mcpEntrySchema = z
  .object({
    type: z.string().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sanitizeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'x';
}

export function mcpFingerprint(server: {
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  cwd?: string;
}): string {
  const sorted = (record?: Record<string, string>) =>
    record ? Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))) : null;
  return sha256(
    JSON.stringify([
      server.transport,
      server.command ?? null,
      server.args ?? null,
      server.url ?? null,
      sorted(server.env),
      sorted(server.headers),
      server.cwd ?? null,
    ])
  );
}

export function formatCommandLine(command: string, args: readonly string[] = []): string {
  const quote = (part: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part));
  return [command, ...args].map(quote).join(' ');
}

async function readJson(root: string, rel: string): Promise<unknown | null> {
  const text = await readFileInside(root, rel, MAX_JSON_BYTES);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`JSON okunamadı: ${rel}`);
  }
}

function toRelativeList(value: unknown): string[] {
  const parsed = pathListSchema.safeParse(value);
  if (!parsed.success) return [];
  return (Array.isArray(parsed.data) ? parsed.data : [parsed.data]).map((entry) =>
    entry.replace(/^\.\//, '').replace(/\/+$/, '')
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Eklenti kökünü okuyup kurulacakları çıkarır. Hiçbir şey çalıştırılmaz ve yazılmaz. */
export async function readPluginPlan(input: {
  marketplaceId: string;
  pluginRoot: string;
  entry: PluginEntry;
}): Promise<PluginPlan> {
  const { pluginRoot, entry, marketplaceId } = input;
  const unsupported: PluginPreview['unsupported'] = [];

  const manifestRaw = await readJson(pluginRoot, '.claude-plugin/plugin.json');
  const manifest =
    manifestRaw && typeof manifestRaw === 'object' ? (manifestRaw as Record<string, unknown>) : {};
  const field = (key: string): unknown => manifest[key] ?? entry.extras?.[key];
  const rootReal = (await resolveInside(pluginRoot, '.')) ?? pluginRoot;

  const skills = await readSkills(pluginRoot, field('skills'), unsupported);
  const commands = await readCommands(pluginRoot, entry.name, field('commands'), marketplaceId, unsupported);
  await listAgents(pluginRoot, field('agents'), unsupported);
  await listHooks(pluginRoot, field('hooks'), unsupported);
  const mcpServers = await readMcp(pluginRoot, rootReal, entry.name, field('mcpServers'), unsupported);

  const version = typeof manifest.version === 'string' ? manifest.version : entry.version;
  const description =
    typeof manifest.description === 'string' ? manifest.description : entry.description;

  const preview: Omit<PluginPreview, 'conflicts'> = {
    marketplaceId,
    plugin: entry.name,
    version,
    description,
    skills: skills.map((skill) => ({
      installId: skill.installId,
      description: skill.description,
      bytes: Buffer.byteLength(skill.content),
    })),
    commands: commands.map((command) => ({
      name: command.name,
      promptId: command.promptId,
      bytes: Buffer.byteLength(command.prompt),
    })),
    mcpServers,
    unsupported,
    digest: sha256(JSON.stringify({ marketplaceId, plugin: entry.name, skills, commands, mcpServers })),
  };
  return { preview, skills, commands, mcpServers };
}

async function readSkills(
  root: string,
  extra: unknown,
  unsupported: PluginPreview['unsupported']
): Promise<PlanSkill[]> {
  const dirs: string[] = [];
  for (const base of unique(['skills', ...toRelativeList(extra)])) {
    if (await resolveInside(root, `${base}/SKILL.md`)) {
      dirs.push(base);
      continue;
    }
    const entries = await listDirInside(root, base);
    for (const item of entries ?? []) if (item.isDir) dirs.push(item.rel);
  }

  const out: PlanSkill[] = [];
  const seen = new Set<string>();
  for (const dir of unique(dirs)) {
    if (out.length >= MAX_SKILLS) {
      unsupported.push({ kind: 'skill', label: dir, detail: `En fazla ${MAX_SKILLS} skill okunur.` });
      continue;
    }
    const content = await readFileInside(root, `${dir}/SKILL.md`, MAX_SKILL_BYTES);
    if (content === null) continue;
    const { frontmatter } = parseFrontmatter(content);
    const candidates = [frontmatter.name, basename(dir)].filter(Boolean);
    const installId = candidates.find((name) => isValidSkillName(name));
    if (!installId) {
      unsupported.push({ kind: 'skill', label: dir, detail: 'Geçerli bir skill adı yok.' });
      continue;
    }
    if (seen.has(installId)) {
      unsupported.push({ kind: 'skill', label: dir, detail: `"${installId}" adı tekrar ediyor.` });
      continue;
    }
    seen.add(installId);
    out.push({ installId, description: frontmatter.description, content });
  }
  return out.sort((a, b) => a.installId.localeCompare(b.installId));
}

async function readCommands(
  root: string,
  plugin: string,
  extra: unknown,
  marketplaceId: string,
  unsupported: PluginPreview['unsupported']
): Promise<PlanCommand[]> {
  const files: string[] = [];
  for (const base of unique(['commands', ...toRelativeList(extra)])) {
    if (base.endsWith('.md')) {
      files.push(base);
      continue;
    }
    const entries = await listDirInside(root, base);
    for (const item of entries ?? []) if (item.isFile && item.name.endsWith('.md')) files.push(item.rel);
  }

  const out: PlanCommand[] = [];
  const seen = new Set<string>();
  for (const file of unique(files)) {
    const name = basename(file, '.md');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || seen.has(name)) {
      unsupported.push({ kind: 'command', label: file, detail: 'Komut adı geçersiz ya da tekrar ediyor.' });
      continue;
    }
    if (out.length >= MAX_COMMANDS) {
      unsupported.push({ kind: 'command', label: file, detail: `En fazla ${MAX_COMMANDS} komut okunur.` });
      continue;
    }
    const content = await readFileInside(root, file, MAX_COMMAND_BYTES);
    if (content === null) continue;
    const prompt = parseFrontmatter(content).body.trim();
    if (!prompt) {
      unsupported.push({ kind: 'command', label: file, detail: 'Komut gövdesi boş.' });
      continue;
    }
    seen.add(name);
    out.push({
      name,
      promptId: `plugin-pack:${marketplaceId}:${plugin}:${name}`,
      title: `${plugin}:${name}`,
      prompt,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function listAgents(
  root: string,
  extra: unknown,
  unsupported: PluginPreview['unsupported']
): Promise<void> {
  for (const base of unique(['agents', ...toRelativeList(extra)])) {
    const entries = await listDirInside(root, base);
    for (const item of entries ?? []) {
      if (item.isFile && item.name.endsWith('.md')) {
        unsupported.push({
          kind: 'agent',
          label: basename(item.name, '.md'),
          detail: 'Alt ajan tanımları desteklenmiyor; kaydedilmez.',
        });
      }
    }
  }
}

async function listHooks(
  root: string,
  inline: unknown,
  unsupported: PluginPreview['unsupported']
): Promise<void> {
  let config: unknown = null;
  if (inline && typeof inline === 'object' && !Array.isArray(inline)) config = inline;
  else if (typeof inline === 'string') config = await readJson(root, inline.replace(/^\.\//, ''));
  else config = await readJson(root, 'hooks/hooks.json');
  if (!config || typeof config !== 'object') return;

  const events = (config as { hooks?: unknown }).hooks ?? config;
  if (!events || typeof events !== 'object') return;
  let lines = 0;
  for (const [event, matchers] of Object.entries(events as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const hooks = (matcher as { hooks?: unknown })?.hooks;
      if (!Array.isArray(hooks)) continue;
      for (const hook of hooks) {
        if (lines >= MAX_HOOK_LINES) return;
        lines++;
        const command = typeof (hook as { command?: unknown })?.command === 'string'
          ? ((hook as { command: string }).command)
          : undefined;
        unsupported.push({
          kind: 'hook',
          label: event,
          detail: `${command ?? 'komut yok'} (çalıştırılmaz, desteklenmiyor)`,
        });
      }
    }
  }
}

async function readMcp(
  root: string,
  rootReal: string,
  plugin: string,
  inline: unknown,
  unsupported: PluginPreview['unsupported']
): Promise<PlanMcpServer[]> {
  const sources: unknown[] = [];
  const dotMcp = await readJson(root, '.mcp.json');
  if (dotMcp) sources.push(dotMcp);
  if (typeof inline === 'string') {
    const fromFile = await readJson(root, inline.replace(/^\.\//, ''));
    if (fromFile) sources.push(fromFile);
  } else if (inline && typeof inline === 'object') {
    sources.push(inline);
  }

  const substitute = (value: string) => value.split('${CLAUDE_PLUGIN_ROOT}').join(rootReal);
  const out: PlanMcpServer[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const map =
      source && typeof source === 'object' && 'mcpServers' in source
        ? (source as { mcpServers: unknown }).mcpServers
        : source;
    if (!map || typeof map !== 'object') continue;
    for (const [sourceName, raw] of Object.entries(map as Record<string, unknown>)) {
      const parsed = mcpEntrySchema.safeParse(raw);
      if (!parsed.success) {
        unsupported.push({ kind: 'mcp', label: sourceName, detail: 'Sunucu tanımı geçersiz.' });
        continue;
      }
      const name = `${sanitizeName(plugin)}-${sanitizeName(sourceName)}`.slice(0, 64);
      if (seen.has(name) || out.length >= MAX_MCP_SERVERS) {
        unsupported.push({ kind: 'mcp', label: sourceName, detail: 'Tekrar eden ad ya da sınır aşıldı.' });
        continue;
      }
      const entryValue = parsed.data;
      const mapRecord = (record?: Record<string, string>) =>
        record
          ? Object.fromEntries(Object.entries(record).map(([key, val]) => [key, substitute(val)]))
          : undefined;

      if (entryValue.command) {
        const command = substitute(entryValue.command);
        const args = entryValue.args?.map(substitute);
        seen.add(name);
        out.push({
          name,
          sourceName,
          transport: 'stdio',
          commandLine: formatCommandLine(command, args),
          command,
          args,
          env: mapRecord(entryValue.env),
          cwd: entryValue.cwd ? substitute(entryValue.cwd) : undefined,
        });
      } else if (entryValue.url && (entryValue.type === undefined || entryValue.type === 'http')) {
        const url = substitute(entryValue.url);
        if (!/^https?:\/\//i.test(url)) {
          unsupported.push({ kind: 'mcp', label: sourceName, detail: 'URL http(s) değil.' });
          continue;
        }
        seen.add(name);
        out.push({
          name,
          sourceName,
          transport: 'http',
          commandLine: url,
          url,
          headers: mapRecord(entryValue.headers),
        });
      } else {
        unsupported.push({
          kind: 'mcp',
          label: sourceName,
          detail: `Taşıma türü desteklenmiyor${entryValue.type ? ` (${entryValue.type})` : ''}.`,
        });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
