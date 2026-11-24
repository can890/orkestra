import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostRef, LOCAL_HOST_REF, type HostRef } from '@orkestra/core/primitives/host/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MEDIA_PROVIDERS_SETTINGS,
  mediaProvidersSettingsSchema,
  type MediaProvidersSettings,
} from '@core/features/media-providers/api/media-providers-model';
import { MediaProvidersService, nodeMediaCliRunner } from './media-providers-service';

/**
 * Geçici HOME/.local/bin altında sahte `higgsfield` ve `gflow`: argv'yi kaydeder, `--help`
 * çıktısından alınmış sürüm biçimini basar ve oturum denetiminde ayarlanan çıkış koduyla döner.
 */
async function fakeCli(
  bin: string,
  name: string,
  log: string,
  version: string,
  statusCode: number
) {
  const path = join(bin, name);
  await writeFile(
    path,
    `#!/bin/sh
printf '%s %s\\n' "${name}" "$*" >> "${log}"
case "$1" in
  --version) echo "${version}";;
  *) exit ${statusCode};;
esac
`
  );
  await chmod(path, 0o755);
}

describe('MediaProvidersService', () => {
  let home: string;
  let log: string;
  let settings: MediaProvidersSettings;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'orkestra-media-providers-'));
    const bin = join(home, '.local', 'bin');
    await mkdir(bin, { recursive: true });
    log = join(home, 'calls.log');
    await fakeCli(bin, 'higgsfield', log, 'higgsfield 1.1.26 (abc) built 2026-09-18', 0);
    await fakeCli(bin, 'gflow', log, 'gflow, version 0.106.0', 1);
    settings = DEFAULT_MEDIA_PROVIDERS_SETTINGS;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const create = (adapters = true) =>
    new MediaProvidersService({
      settings: async () => settings,
      run: nodeMediaCliRunner,
      env: () => ({ PATH: '/usr/bin:/bin' }),
      adapterPath: (file) => (adapters ? `/app/out/main/adapters/${file}` : null),
      nodeExecutable: '/app/Orkestra',
      home,
      now: () => 42,
    });

  const context = (host: HostRef = LOCAL_HOST_REF, workspacePath: string | null = '/w/task') => ({
    conversationId: 'c1',
    projectId: 'p1',
    taskId: 't1',
    workspaceId: 'w1',
    host,
    workspacePath,
  });

  it('defaults to both providers off with confirmation on', () => {
    expect(mediaProvidersSettingsSchema.parse(DEFAULT_MEDIA_PROVIDERS_SETTINGS)).toEqual({
      higgsfield: { enabled: false, requireConfirmation: true },
      flow: { enabled: false, requireConfirmation: true },
    });
  });

  it('detects each CLI, its version and sign-in state with harmless commands only', async () => {
    const statuses = await create().status(true);
    expect(statuses).toEqual([
      {
        id: 'higgsfield',
        enabled: false,
        requireConfirmation: true,
        checkedAt: 42,
        cli: {
          available: true,
          path: join(home, '.local', 'bin', 'higgsfield'),
          version: 'higgsfield 1.1.26 (abc) built 2026-09-18',
        },
        signedIn: true,
        message: null,
      },
      expect.objectContaining({
        id: 'flow',
        cli: expect.objectContaining({ available: true, version: 'gflow, version 0.106.0' }),
        signedIn: false,
        message: expect.stringContaining('Not signed in'),
      }),
    ]);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').sort();
    expect(calls).toEqual([
      'gflow --version',
      'gflow auth status',
      'higgsfield --version',
      'higgsfield account status --json',
    ]);
  });

  it('reports a missing CLI', async () => {
    await rm(join(home, '.local', 'bin', 'gflow'));
    const flow = (await create().status(true)).find((status) => status.id === 'flow')!;
    expect(flow.cli).toEqual({ available: false, path: null, version: null });
    expect(flow.message).toContain('gflow CLI was not found');
  });

  it('adds no tool servers while the providers are off', async () => {
    expect(await create().conversationMcpServers(context())).toEqual([]);
  });

  it('adds enabled providers to local conversations with output dir and confirmation flag', async () => {
    settings = {
      higgsfield: { enabled: true, requireConfirmation: true },
      flow: { enabled: true, requireConfirmation: false },
    };
    const servers = await create().conversationMcpServers(context());
    expect(servers.map((server) => server.name)).toEqual(['orkestra-higgsfield', 'orkestra-flow']);
    expect(servers[0]).toMatchObject({
      command: '/app/Orkestra',
      args: ['/app/out/main/adapters/higgsfield-mcp.mjs'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ORKESTRA_MEDIA_CLI: join(home, '.local', 'bin', 'higgsfield'),
        ORKESTRA_MEDIA_OUTPUT_DIR: '/w/task/orkestra-media',
        ORKESTRA_MEDIA_REQUIRE_CONFIRMATION: '1',
      },
    });
    expect(servers[1]!.env!.ORKESTRA_MEDIA_REQUIRE_CONFIRMATION).toBe('0');

    const remote = await create().conversationMcpServers(context(hostRef('remote', 'conn-1')));
    expect(remote).toEqual([]);
    expect(await create(false).conversationMcpServers(context())).toEqual([]);
    const noWorkspace = await create().conversationMcpServers(context(LOCAL_HOST_REF, null));
    expect(noWorkspace[0]!.env!.ORKESTRA_MEDIA_OUTPUT_DIR).toBeUndefined();
  });
});
