import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResolvedTuiProvider } from '#services/agent-plugins/api/plugins';
import { prepareSessionMcp, SESSION_MCP_TEMP_DIR_PREFIX } from './session-mcp';

const server = {
  name: 'orkestra-browser',
  command: '/usr/bin/node',
  args: ['/bridge.js'],
  env: { ORKESTRA_TOOLS_TOKEN: 'secret' },
};

const fileProvider: Pick<ResolvedTuiProvider, 'buildSessionMcp'> = {
  buildSessionMcp: (servers, ctx) => ({
    args: ['--mcp-config', ctx.filePath('mcp.json')],
    files: [{ name: 'mcp.json', contents: JSON.stringify(servers) }],
  }),
};

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

describe('prepareSessionMcp', () => {
  it('writes provider files into a private per-session directory and removes it', async () => {
    const prepared = await prepareSessionMcp({
      servers: [server],
      provider: fileProvider,
      platform: process.platform,
    });
    expect(prepared).not.toBeNull();
    const configPath = prepared!.args[1]!;
    const directory = join(configPath, '..');
    expect(directory.startsWith(join(tmpdir(), SESSION_MCP_TEMP_DIR_PREFIX))).toBe(true);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual([server]);
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    }

    await prepared!.cleanup();
    await prepared!.cleanup();
    expect(await exists(directory)).toBe(false);
  });

  it('returns null without servers or without a provider mechanism', async () => {
    let created = 0;
    const deps = {
      createTempDir: async () => {
        created++;
        return '/unused';
      },
    };
    await expect(
      prepareSessionMcp({ servers: [], provider: fileProvider, platform: 'linux' }, deps)
    ).resolves.toBeNull();
    await expect(
      prepareSessionMcp({ servers: [server], provider: {}, platform: 'linux' }, deps)
    ).resolves.toBeNull();
    expect(created).toBe(0);
  });

  it('drops the directory when the provider needs no files', async () => {
    const removed: string[] = [];
    const prepared = await prepareSessionMcp(
      {
        servers: [server],
        provider: { buildSessionMcp: () => ({ args: ['--inline'], files: [] }) },
        platform: 'linux',
      },
      {
        createTempDir: async () => '/tmp/dir',
        removeTempDir: async (directory) => {
          removed.push(directory);
        },
      }
    );
    expect(prepared?.args).toEqual(['--inline']);
    expect(removed).toEqual(['/tmp/dir']);
    await prepared!.cleanup();
    expect(removed).toEqual(['/tmp/dir']);
  });

  it.each(['../escape.json', 'nested/file.json', '.hidden', ''])(
    'rejects unsafe file name %j and removes the directory',
    async (name) => {
      const removed: string[] = [];
      const written: string[] = [];
      await expect(
        prepareSessionMcp(
          {
            servers: [server],
            provider: {
              buildSessionMcp: () => ({ args: ['--x'], files: [{ name, contents: '{}' }] }),
            },
            platform: 'linux',
          },
          {
            createTempDir: async () => '/tmp/dir',
            writeConfigFile: async (filePath) => {
              written.push(filePath);
            },
            removeTempDir: async (directory) => {
              removed.push(directory);
            },
          }
        )
      ).rejects.toThrow('Invalid session MCP file name');
      expect(written).toEqual([]);
      expect(removed).toEqual(['/tmp/dir']);
    }
  );
});
