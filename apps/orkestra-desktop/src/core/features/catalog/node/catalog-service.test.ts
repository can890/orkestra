import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

vi.mock('@orkestra/shared/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

describe('CatalogService', () => {
  beforeEach(async () => {
    userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orkestra-catalog-'));
  });

  afterEach(async () => {
    await fs.promises.rm(userDataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('loads bundled skills as raw catalog entries without installed state merging', async () => {
    const { CatalogService } = await import('./catalog-service');
    const service = new CatalogService();

    const catalog = await service.getSkillsCatalog();

    expect(catalog.skills.length).toBeGreaterThan(0);
    expect(catalog.skills.every((skill) => skill.installed === false)).toBe(true);
  });

  it('resolves a cached skill to an agent-config install payload', async () => {
    const catalogDir = path.join(userDataDir, 'catalog');
    await fs.promises.mkdir(catalogDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(catalogDir, 'skills-catalog-index.json'),
      JSON.stringify({
        version: 2,
        lastUpdated: '2026-01-01T00:00:00.000Z',
        skills: [
          {
            id: 'cached-skill',
            displayName: 'Cached Skill',
            description: 'Cached description',
            source: 'openai',
            frontmatter: { name: 'cached-skill', description: 'Cached description' },
            installed: false,
            skillMdContent:
              '---\nname: cached-skill\ndescription: Cached description\n---\nUse it.\n',
          },
        ],
      })
    );
    const { CatalogService } = await import('./catalog-service');
    const service = new CatalogService();

    const payload = await service.resolveSkillInstall('cached-skill');

    expect(payload).toMatchObject({
      id: 'cached-skill',
      installId: 'cached-skill',
      source: 'openai',
    });
    expect(payload.skillMdContent).toContain('---');
  });

  it('returns the curated in-source MCP catalog by default', async () => {
    const { CatalogService } = await import('./catalog-service');
    const service = new CatalogService();

    const catalog = await service.getMcpCatalog();

    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.find((entry) => entry.key === 'playwright')).toMatchObject({
      name: 'Playwright',
      defaultConfig: { command: 'npx' },
    });
  });
});

describe('MCP registry connection payloads', () => {
  it('keeps publisher namespaces distinct and resolves repository documentation', async () => {
    const { registryServerToCatalogEntry } = await import('./catalog-service');
    const make = (name: string) =>
      registryServerToCatalogEntry({
        name,
        repository: { url: 'https://github.com/vendor/mcp' },
        remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
      });
    expect(make('com.first/service')?.key).not.toEqual(make('com.second/service')?.key);
    expect(make('com.first/service')?.docsUrl).toBe('https://github.com/vendor/mcp');
  });

  it('preserves remote headers and distinguishes required credentials from optional defaults', async () => {
    const { registryServerToCatalogEntry } = await import('./catalog-service');
    const entry = registryServerToCatalogEntry({
      name: 'com.vendor/test',
      remotes: [
        {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          headers: [
            { name: 'Authorization', isRequired: true, isSecret: true },
            { name: 'Region', default: 'eu' },
          ],
        },
      ],
    });
    expect(entry?.defaultConfig).toMatchObject({
      type: 'http',
      headers: { Authorization: 'YOUR_VALUE', Region: 'eu' },
    });
    expect(entry?.credentialKeys).toEqual([
      { key: 'Authorization', required: true },
      { key: 'Region', required: false },
    ]);
  });

  it('converts current npm and PyPI packages to pinned native launch commands', async () => {
    const { registryServerToCatalogEntry } = await import('./catalog-service');
    const entry = registryServerToCatalogEntry({
      name: 'com.vendor/npm',
      packages: [
        {
          registryType: 'npm',
          identifier: '@vendor/server',
          version: '1.2.3',
          environmentVariables: [{ name: 'API_KEY', isRequired: true }],
          packageArguments: [{ type: 'named', name: '--region', value: 'eu' }],
        },
      ],
    });
    expect(entry?.defaultConfig).toMatchObject({
      command: 'npx',
      args: ['-y', '@vendor/server@1.2.3', '--region', 'eu'],
      env: { API_KEY: 'YOUR_VALUE' },
    });
    const python = registryServerToCatalogEntry({
      name: 'com.vendor/python',
      packages: [{ registryType: 'pypi', identifier: 'workspace-mcp', version: '2.0.0' }],
    });
    expect(python?.defaultConfig).toMatchObject({ command: 'uvx', args: ['workspace-mcp==2.0.0'] });
  });

  it('does not offer incomplete endpoint templates or unsupported runtime arguments as ready connections', async () => {
    const { registryServerToCatalogEntry } = await import('./catalog-service');
    expect(
      registryServerToCatalogEntry({
        name: 'com.vendor/template',
        remotes: [{ url: 'https://{tenant}.example.com/mcp' }],
      })
    ).toBeNull();
    expect(
      registryServerToCatalogEntry({
        name: 'com.vendor/runtime',
        packages: [
          { registryType: 'npm', identifier: 'server', runtimeArguments: [{ value: '--special' }] },
        ],
      })
    ).toBeNull();
  });
});

describe('MCP registry pagination', () => {
  it('reads wrapped latest active servers on every page and caches only complete results', async () => {
    const { CatalogService } = await import('./catalog-service');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          servers: [
            {
              server: {
                name: 'com.vendor/page-one',
                remotes: [{ url: 'https://example.com/one' }],
              },
            },
          ],
          metadata: { nextCursor: 'page:2' },
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          servers: [
            {
              server: {
                name: 'com.vendor/page-two',
                remotes: [{ url: 'https://example.com/two' }],
              },
            },
            {
              server: { name: 'com.vendor/old', remotes: [{ url: 'https://example.com/old' }] },
              _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: false } },
            },
          ],
          metadata: {},
        })
      );
    const service = new CatalogService(fetch);
    const entries = await service.getMcpCatalog({ featuredOnly: false, search: 'page' });
    expect(entries.map((entry) => entry.key)).toEqual([
      'com.vendor_page-one',
      'com.vendor_page-two',
    ]);
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get('cursor')).toBe('page:2');
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get('version')).toBe('latest');
    await service.getMcpCatalog({ featuredOnly: false, search: 'page' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports registry failure instead of pretending an empty successful search', async () => {
    const { CatalogService } = await import('./catalog-service');
    const service = new CatalogService(vi.fn().mockRejectedValue(new Error('offline')));
    await expect(
      service.getMcpCatalog({ featuredOnly: false, search: 'anything' })
    ).rejects.toThrow('MCP kataloğuna ulaşılamadı');
  });
});
