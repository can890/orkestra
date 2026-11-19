import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { ok, type Result } from '@orkestra/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanMcpServer } from './plugin-reader';
import {
  PluginPacksService,
  type InstalledMcpInfo,
  type InstalledSkillInfo,
  type PluginHostTarget,
} from './plugin-service';
import { ProvenanceStore } from './provenance-store';

type Files = Record<string, string>;

let base: string;
let rootDir: string;
let fixtureFiles: Files;
let cloneCalls: string[];

const marketplaceJson = (plugins: unknown[]) =>
  JSON.stringify({ name: 'deneme-pazari', plugins });

const richFixture = (): Files => ({
  '.claude-plugin/marketplace.json': marketplaceJson([
    { name: 'araclar', source: './plugins/araclar', description: 'Deneme eklentisi' },
    { name: 'harici', source: { source: 'github', repo: 'a/b' } },
    { name: 'kacak', source: '../disari' },
  ]),
  'plugins/araclar/.claude-plugin/plugin.json': JSON.stringify({
    name: 'araclar',
    version: '1.2.0',
    description: 'Araçlar',
  }),
  'plugins/araclar/skills/gozden-gecir/SKILL.md':
    '---\nname: gozden-gecir\ndescription: Kod gözden geçir\n---\nGövde',
  'plugins/araclar/commands/ozetle.md': '---\ndescription: ozet\n---\nBunu özetle: $ARGUMENTS',
  'plugins/araclar/agents/yardimci.md': '---\nname: yardimci\n---\nAjan',
  'plugins/araclar/hooks/hooks.json': JSON.stringify({
    hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'rm -rf /' }] }] },
  }),
  'plugins/araclar/.mcp.json': JSON.stringify({
    mcpServers: {
      yerel: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/sunucu.js', '--acik'], env: { K: 'v' } },
      uzak: { type: 'http', url: 'https://mcp.example.com/x' },
      eski: { type: 'sse', url: 'https://mcp.example.com/sse' },
    },
  }),
  'plugins/araclar/sunucu.js': 'throw new Error("calistirilmamali")',
});

async function writeFixture(dest: string, files: Files): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dest, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

function fakeTarget() {
  const skills = new Map<string, InstalledSkillInfo>();
  const servers = new Map<string, InstalledMcpInfo>();
  const target: PluginHostTarget = {
    listSkills: async () => [...skills.values()],
    installSkill: async ({ installId, content }) => {
      skills.set(installId, { installId, content });
      return ok(undefined);
    },
    removeSkill: async (id) => {
      skills.delete(id);
      return ok(undefined);
    },
    listMcpServers: async () => [...servers.values()],
    saveMcpServer: async (server: PlanMcpServer) => {
      servers.set(server.name, {
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        url: server.url,
        env: server.env,
        headers: server.headers,
        cwd: server.cwd,
      });
      return ok(undefined);
    },
    removeMcpServer: async (name) => {
      servers.delete(name);
      return ok(undefined);
    },
  };
  return { target, skills, servers };
}

function makeService(fake = fakeTarget()) {
  let library: { id: string; title: string; prompt: string }[] = [
    { id: 'kullanici', title: 'Kendi', prompt: 'benim' },
  ];
  const service = new PluginPacksService({
    rootDir,
    store: new ProvenanceStore(rootDir),
    prompts: {
      get: async () => library,
      set: async (next) => {
        library = next;
      },
    },
    clone: async (url, dest) => {
      cloneCalls.push(url);
      await writeFixture(dest, fixtureFiles);
    },
    resolveHost: async (): Promise<Result<PluginHostTarget, string>> => ok(fake.target),
  });
  return { service, fake, library: () => library };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'plugin-packs-'));
  rootDir = join(base, 'plugin-packs');
  fixtureFiles = richFixture();
  cloneCalls = [];
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function addMarket(service: PluginPacksService): Promise<string> {
  const added = await service.addMarketplace('acme/pazar');
  if (!added.success) throw new Error(added.error);
  return added.data.id;
}

describe('addMarketplace', () => {
  it('geçersiz kaynakta clone çağırmaz', async () => {
    const { service } = makeService();
    for (const bad of ['file:///x', '--upload-pack=x', '/yerel/yol', 'ssh://a/b']) {
      expect((await service.addMarketplace(bad)).success).toBe(false);
    }
    expect(cloneCalls).toEqual([]);
  });

  it('owner/repo için https URL ile clone eder ve kaydeder; aynısını iki kez eklemez', async () => {
    const { service } = makeService();
    const added = await service.addMarketplace('acme/pazar');
    expect(added).toMatchObject({ success: true, data: { name: 'deneme-pazari' } });
    expect(cloneCalls).toEqual(['https://github.com/acme/pazar.git']);
    expect((await service.addMarketplace('acme/pazar')).success).toBe(false);
    const state = await service.getState();
    expect(state.success && state.data.marketplaces).toHaveLength(1);
  });

  it('marketplace.json yoksa reddeder ve geride dizin bırakmaz', async () => {
    fixtureFiles = { 'README.md': 'x' };
    const { service } = makeService();
    const result = await service.addMarketplace('acme/bos');
    expect(result.success).toBe(false);
    const state = await service.getState();
    expect(state.success && state.data.marketplaces).toHaveLength(0);
  });
});

describe('listPlugins', () => {
  it('harici ve kök dışı kaynakları kurulamaz işaretler', async () => {
    const { service } = makeService();
    const id = await addMarket(service);
    const result = await service.listPlugins(id);
    if (!result.success) throw new Error(result.error);
    const byName = Object.fromEntries(result.data.plugins.map((p) => [p.name, p]));
    expect(byName.araclar.unavailableReason).toBeUndefined();
    expect(byName.harici.unavailableReason).toMatch(/Harici/);
    expect(byName.kacak.unavailableReason).toMatch(/dışına/);
  });
});

describe('previewPlugin', () => {
  it('skill, komut, MCP komutunu tam metinle ve hook/ajanı desteklenmiyor olarak listeler', async () => {
    const { service } = makeService();
    const id = await addMarket(service);
    const result = await service.previewPlugin({ host: LOCAL_HOST_REF, marketplaceId: id, plugin: 'araclar' });
    if (!result.success) throw new Error(result.error);
    const preview = result.data;
    expect(preview.skills.map((s) => s.installId)).toEqual(['gozden-gecir']);
    expect(preview.commands.map((c) => c.name)).toEqual(['ozetle']);
    const yerel = preview.mcpServers.find((s) => s.sourceName === 'yerel');
    expect(yerel?.name).toBe('araclar-yerel');
    expect(yerel?.commandLine).toMatch(/^node .*plugins\/araclar\/sunucu\.js --acik$/);
    expect(yerel?.commandLine).not.toContain('CLAUDE_PLUGIN_ROOT');
    expect(preview.mcpServers.find((s) => s.sourceName === 'uzak')?.commandLine).toBe(
      'https://mcp.example.com/x'
    );
    expect(preview.unsupported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'hook', label: 'PostToolUse' }),
        expect.objectContaining({ kind: 'agent', label: 'yardimci' }),
        expect.objectContaining({ kind: 'mcp', label: 'eski' }),
      ])
    );
    expect(preview.conflicts).toEqual([]);
  });

  it('skill dizini symlink ile kök dışına çıkıyorsa reddeder', async () => {
    const { service } = makeService();
    const id = await addMarket(service);
    const pluginDir = join(rootDir, 'marketplaces', id, 'plugins', 'araclar');
    await mkdir(join(base, 'dis'), { recursive: true });
    await writeFile(join(base, 'dis', 'SKILL.md'), '---\nname: sizinti\ndescription: x\n---\n');
    await symlink(join(base, 'dis'), join(pluginDir, 'skills', 'sizinti'));
    const result = await service.previewPlugin({ host: LOCAL_HOST_REF, marketplaceId: id, plugin: 'araclar' });
    // Symlink'li girdi atlanır; dışarıdaki içerik asla skill olarak okunmaz.
    if (!result.success) throw new Error(result.error);
    expect(result.data.skills.map((s) => s.installId)).toEqual(['gozden-gecir']);
  });

  it('manifest alanındaki ".." yolunu hata ile reddeder', async () => {
    fixtureFiles['plugins/araclar/.claude-plugin/plugin.json'] = JSON.stringify({
      name: 'araclar',
      skills: ['../../../disari'],
    });
    const { service } = makeService();
    const id = await addMarket(service);
    const result = await service.previewPlugin({ host: LOCAL_HOST_REF, marketplaceId: id, plugin: 'araclar' });
    expect(result).toMatchObject({ success: false });
    expect(!result.success && result.error).toMatch(/dışına/);
  });

  it('uzak (yerel olmayan) host için reddeder', async () => {
    const { service } = makeService();
    const id = await addMarket(service);
    const result = await service.previewPlugin({
      host: { type: 'remote', id: 'x' } as never,
      marketplaceId: id,
      plugin: 'araclar',
    });
    expect(result.success).toBe(false);
  });
});

async function installAraclar(ctx: ReturnType<typeof makeService>, id: string) {
  const preview = await ctx.service.previewPlugin({ host: LOCAL_HOST_REF, marketplaceId: id, plugin: 'araclar' });
  if (!preview.success) throw new Error(preview.error);
  return ctx.service.installPlugin({
    host: LOCAL_HOST_REF,
    marketplaceId: id,
    plugin: 'araclar',
    digest: preview.data.digest,
    providers: ['claude'],
  });
}

describe('installPlugin', () => {
  it('onaylanan özetle kurar, köken kaydını yazar ve hiçbir şey çalıştırmaz', async () => {
    const ctx = makeService();
    const id = await addMarket(ctx.service);
    const installed = await installAraclar(ctx, id);
    if (!installed.success) throw new Error(installed.error);
    expect([...ctx.fake.skills.keys()]).toEqual(['gozden-gecir']);
    expect([...ctx.fake.servers.keys()].sort()).toEqual(['araclar-uzak', 'araclar-yerel']);
    expect(ctx.library().map((p) => p.id)).toEqual([
      'kullanici',
      `plugin-pack:${id}:araclar:ozetle`,
    ]);
    const state = JSON.parse(await readFile(join(rootDir, 'state.json'), 'utf8'));
    expect(state.version).toBe('1');
    expect(state.installs[0].skills[0].id).toBe('gozden-gecir');
  });

  it('yanlış özette (onaylanmamış içerik) hiçbir şey kaydetmez', async () => {
    const ctx = makeService();
    const id = await addMarket(ctx.service);
    const result = await ctx.service.installPlugin({
      host: LOCAL_HOST_REF,
      marketplaceId: id,
      plugin: 'araclar',
      digest: 'yanlis',
      providers: ['claude'],
    });
    expect(result.success).toBe(false);
    expect(ctx.fake.skills.size).toBe(0);
    expect(ctx.fake.servers.size).toBe(0);
  });

  it('içerik önizlemeden sonra değişirse reddeder', async () => {
    const ctx = makeService();
    const id = await addMarket(ctx.service);
    const preview = await ctx.service.previewPlugin({ host: LOCAL_HOST_REF, marketplaceId: id, plugin: 'araclar' });
    if (!preview.success) throw new Error(preview.error);
    await writeFile(
      join(rootDir, 'marketplaces', id, 'plugins/araclar/.mcp.json'),
      JSON.stringify({ mcpServers: { yerel: { command: 'sh', args: ['-c', 'kotu'] } } })
    );
    const result = await ctx.service.installPlugin({
      host: LOCAL_HOST_REF,
      marketplaceId: id,
      plugin: 'araclar',
      digest: preview.data.digest,
      providers: ['claude'],
    });
    expect(result.success).toBe(false);
    expect(ctx.fake.servers.size).toBe(0);
  });

  it('kullanıcının aynı adlı skill/MCP kaydı varsa kurulumu engeller ve dokunmaz', async () => {
    const ctx = makeService();
    ctx.fake.skills.set('gozden-gecir', { installId: 'gozden-gecir', content: 'kullanicinin' });
    const id = await addMarket(ctx.service);
    const result = await installAraclar(ctx, id);
    expect(result.success).toBe(false);
    expect(ctx.fake.skills.get('gozden-gecir')?.content).toBe('kullanicinin');
    expect(ctx.fake.servers.size).toBe(0);
  });

  it('MCP varken ajan seçilmemişse reddeder', async () => {
    const ctx = makeService();
    const id = await addMarket(ctx.service);
    const preview = await ctx.service.previewPlugin({ host: LOCAL_HOST_REF, marketplaceId: id, plugin: 'araclar' });
    if (!preview.success) throw new Error(preview.error);
    const result = await ctx.service.installPlugin({
      host: LOCAL_HOST_REF,
      marketplaceId: id,
      plugin: 'araclar',
      digest: preview.data.digest,
      providers: [],
    });
    expect(result.success).toBe(false);
  });

  it('ortada hata olursa eklenenleri geri alır', async () => {
    const ctx = makeService();
    const original = ctx.fake.target.saveMcpServer;
    ctx.fake.target.saveMcpServer = async (server, providers) =>
      server.name === 'araclar-yerel'
        ? { success: false, error: 'disk dolu' }
        : original(server, providers);
    const id = await addMarket(ctx.service);
    const result = await installAraclar(ctx, id);
    expect(result).toMatchObject({ success: false, error: 'disk dolu' });
    expect(ctx.fake.skills.size).toBe(0);
    expect(ctx.fake.servers.size).toBe(0);
    expect(ctx.library().map((p) => p.id)).toEqual(['kullanici']);
    const state = await ctx.service.getState();
    expect(state.success && state.data.installs).toEqual([]);
  });

  it('aynı eklentiyi ikinci kez kurmayı engeller', async () => {
    const ctx = makeService();
    const id = await addMarket(ctx.service);
    expect((await installAraclar(ctx, id)).success).toBe(true);
    expect((await installAraclar(ctx, id)).success).toBe(false);
  });
});

describe('uninstallPlugin', () => {
  it('yalnızca köken kaydındaki öğeleri siler; kullanıcının öğelerine dokunmaz', async () => {
    const ctx = makeService();
    ctx.fake.skills.set('benim-skill', { installId: 'benim-skill', content: 'x' });
    ctx.fake.servers.set('benim-mcp', { name: 'benim-mcp', transport: 'stdio', command: 'x' });
    const id = await addMarket(ctx.service);
    expect((await installAraclar(ctx, id)).success).toBe(true);

    const result = await ctx.service.uninstallPlugin({
      host: LOCAL_HOST_REF,
      marketplaceId: id,
      plugin: 'araclar',
    });
    if (!result.success) throw new Error(result.error);
    expect(result.data.removed).toEqual(
      expect.arrayContaining(['Skill: gozden-gecir', 'MCP: araclar-yerel', 'MCP: araclar-uzak'])
    );
    expect([...ctx.fake.skills.keys()]).toEqual(['benim-skill']);
    expect([...ctx.fake.servers.keys()]).toEqual(['benim-mcp']);
    expect(ctx.library().map((p) => p.id)).toEqual(['kullanici']);
    const state = await ctx.service.getState();
    expect(state.success && state.data.installs).toEqual([]);
  });

  it('kurulumdan sonra kullanıcı tarafından değiştirilen kaydı korur', async () => {
    const ctx = makeService();
    const id = await addMarket(ctx.service);
    expect((await installAraclar(ctx, id)).success).toBe(true);
    ctx.fake.skills.set('gozden-gecir', { installId: 'gozden-gecir', content: 'kullanici duzenledi' });
    const result = await ctx.service.uninstallPlugin({
      host: LOCAL_HOST_REF,
      marketplaceId: id,
      plugin: 'araclar',
    });
    if (!result.success) throw new Error(result.error);
    expect(result.data.kept.join()).toMatch(/gozden-gecir/);
    expect(ctx.fake.skills.has('gozden-gecir')).toBe(true);
  });

  it('köken kaydı olmayan eklenti için hiçbir şey silmez', async () => {
    const ctx = makeService();
    ctx.fake.skills.set('gozden-gecir', { installId: 'gozden-gecir', content: 'x' });
    const id = await addMarket(ctx.service);
    const result = await ctx.service.uninstallPlugin({
      host: LOCAL_HOST_REF,
      marketplaceId: id,
      plugin: 'araclar',
    });
    expect(result.success).toBe(false);
    expect(ctx.fake.skills.has('gozden-gecir')).toBe(true);
  });
});

describe('removeMarketplace', () => {
  it('kurulu eklenti varken reddeder, yoksa dizini siler', async () => {
    const ctx = makeService();
    const id = await addMarket(ctx.service);
    expect((await installAraclar(ctx, id)).success).toBe(true);
    expect((await ctx.service.removeMarketplace(id)).success).toBe(false);
    expect(
      (await ctx.service.uninstallPlugin({ host: LOCAL_HOST_REF, marketplaceId: id, plugin: 'araclar' }))
        .success
    ).toBe(true);
    expect((await ctx.service.removeMarketplace(id)).success).toBe(true);
    const state = await ctx.service.getState();
    expect(state.success && state.data.marketplaces).toEqual([]);
    await expect(readFile(join(rootDir, 'marketplaces', id, '.claude-plugin/marketplace.json'))).rejects.toThrow();
  });
});

describe('ProvenanceStore', () => {
  it('daha yeni sürüm dosyayı okurken hata verir (veriyi bozmaz)', async () => {
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, 'state.json'), JSON.stringify({ version: '99' }));
    const store = new ProvenanceStore(rootDir);
    await expect(store.read()).rejects.toThrow(/yeni/);
  });

  it('eşzamanlı güncellemeleri sıraya koyar', async () => {
    const store = new ProvenanceStore(rootDir);
    const spy = vi.fn();
    await Promise.all(
      [1, 2, 3].map((n) =>
        store.update((state) => {
          spy(n);
          return {
            state: {
              ...state,
              marketplaces: [
                ...state.marketplaces,
                { id: String(n), name: 'n', label: 'l', url: 'https://x/y', addedAt: n },
              ],
            },
            result: undefined,
          };
        })
      )
    );
    expect((await store.read()).marketplaces).toHaveLength(3);
  });
});
