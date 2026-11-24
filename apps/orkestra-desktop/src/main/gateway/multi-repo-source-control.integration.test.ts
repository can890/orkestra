import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { gitContract } from '@orkestra/core/runtimes/git/api';
import { createGitController, GitRuntime } from '@orkestra/core/runtimes/git/node';
import type { IWatchService } from '@orkestra/core/services/fs-watch/api';
import { ok } from '@orkestra/shared';
import { client, connect, memoryTransportPair, serve } from '@orkestra/wire/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nestedRepositoryWorkspaceId } from '@core/features/project-repositories/api/nested-repository-id';
import { ProjectRepositoriesService } from '@core/features/project-repositories/api/node/project-repositories-service';
import { createProjectRepositoriesWireController } from '@core/features/project-repositories/node/wire-controller';
import { createSourceControlWireController } from '@core/features/source-control/node/wire-controller';

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

// Çok depolu bir proje: depo olmayan bir klasörün altında iki gerçek Git deposu. Arayüzün
// kullandığı iki denetleyici (çok depo listesi + kaynak kontrolü) gerçek bir Git çalışma
// zamanına karşı çalıştırılır.
describe('multi-repository projects through the source-control services', () => {
  it('reports per-repository status and diffs and commits in one repository only', async () => {
    const { root, repositories, sourceControl } = await makeStack();
    await writeFile(path.join(root, 'api', 'server.ts'), 'export const port = 8080;\n');
    await writeFile(path.join(root, 'web', 'page.tsx'), 'export const title = "Shop!";\n');
    await writeFile(path.join(root, 'web', 'new-file.ts'), 'export {};\n');
    await writeFile(path.join(root, 'notes.md'), 'not in any repository\n');

    const listed = await repositories.call('listRepositories', {
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    });
    expect(listed).toMatchObject({
      status: 'ok',
      rootIsRepository: false,
      truncated: false,
      repositories: [
        {
          relativePath: 'api',
          kind: 'repository',
          branch: 'main',
          remotes: [{ name: 'origin', url: 'https://example.com/shop/api.git' }],
        },
        { relativePath: 'web', kind: 'repository', branch: 'main', remotes: [] },
      ],
    });

    const changes = await repositories.call('listChanges', { workspaceId: 'workspace-1' });
    expect(changes).toMatchObject({ status: 'ok' });
    const byRepository = Object.fromEntries(
      (
        changes as { repositories: Array<{ relativePath: string; files: unknown[] }> }
      ).repositories.map((repository) => [repository.relativePath, repository.files])
    );
    expect(byRepository).toEqual({
      api: [
        {
          path: 'api/server.ts',
          repositoryPath: 'server.ts',
          index: 'unmodified',
          worktree: 'modified',
        },
      ],
      web: [
        {
          path: 'web/new-file.ts',
          repositoryPath: 'new-file.ts',
          index: 'untracked',
          worktree: 'untracked',
        },
        {
          path: 'web/page.tsx',
          repositoryPath: 'page.tsx',
          index: 'unmodified',
          worktree: 'modified',
        },
      ],
    });

    const apiId = nestedRepositoryWorkspaceId('workspace-1', 'api');
    const webId = nestedRepositoryWorkspaceId('workspace-1', 'web');

    await expect(
      sourceControl.call('checkout.getChangedFiles', {
        workspaceId: apiId,
        target: { kind: 'working-vs-head' },
      })
    ).resolves.toMatchObject({
      success: true,
      data: { files: [{ path: 'server.ts', status: 'modified', additions: 1, deletions: 1 }] },
    });

    const hunks = (await sourceControl.call('checkout.getFileHunks', {
      workspaceId: webId,
      path: 'page.tsx',
      scope: 'unstaged',
    })) as { success: boolean; data: { hunks: Array<{ lines: string[] }> } };
    expect(hunks.success).toBe(true);
    expect(hunks.data.hunks[0]?.lines).toEqual([
      '-export const title = "Shop";',
      '+export const title = "Shop!";',
    ]);

    // Yalnızca web deposunda stage + commit; api deposu dokunulmadan kalır.
    await expect(
      sourceControl.call('checkout.model.stageAll', {
        key: { workspaceId: webId },
        input: {},
        mutationId: 'stage-web',
      })
    ).resolves.toMatchObject({ success: true });
    await expect(
      sourceControl.call('checkout.model.commit', {
        key: { workspaceId: webId },
        input: { message: 'web: update title' },
        mutationId: 'commit-web',
      })
    ).resolves.toMatchObject({ success: true });

    expect((await git(path.join(root, 'web'), 'log', '--format=%s')).trim().split('\n')).toEqual([
      'web: update title',
      'initial',
    ]);
    expect((await git(path.join(root, 'api'), 'log', '--format=%s')).trim()).toBe('initial');
    expect((await git(path.join(root, 'api'), 'status', '--porcelain')).trim()).toBe('M server.ts');

    const afterCommit = await repositories.call('listChanges', { workspaceId: 'workspace-1' });
    expect(
      (
        afterCommit as { repositories: Array<{ relativePath: string; files: unknown[] }> }
      ).repositories.map((repository) => [repository.relativePath, repository.files.length])
    ).toEqual([
      ['api', 1],
      ['web', 0],
    ]);
  });

  it('refuses nested ids that do not name a discovered repository', async () => {
    const { sourceControl } = await makeStack();
    for (const relativePath of ['docs', 'missing', 'api/..']) {
      await expect(
        sourceControl.call('checkout.getChangedFiles', {
          workspaceId: nestedRepositoryWorkspaceId('workspace-1', relativePath),
          target: { kind: 'working-vs-head' },
        })
      ).rejects.toThrow();
    }
  });

  it('keeps single-repository workspaces unchanged', async () => {
    const { root, sourceControl } = await makeStack({ workspacePath: 'api' });
    await writeFile(path.join(root, 'api', 'server.ts'), 'export const port = 9090;\n');

    await expect(
      sourceControl.call('checkout.getChangedFiles', {
        workspaceId: 'workspace-1',
        target: { kind: 'working-vs-head' },
      })
    ).resolves.toMatchObject({ success: true, data: { files: [{ path: 'server.ts' }] } });
  });

  it('reports remote hosts as unsupported instead of scanning them', async () => {
    const { repositories } = await makeStack({ remote: true });
    await expect(
      repositories.call('listRepositories', { projectId: 'project-1', workspaceId: 'workspace-1' })
    ).resolves.toEqual({ status: 'unsupported', reason: 'remote-host' });
  });
});

async function makeStack(options: { workspacePath?: string; remote?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orkestra-multi-repo-')));
  for (const name of ['api', 'web']) {
    const repo = path.join(root, name);
    await mkdir(repo);
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test User');
    await git(repo, 'config', 'commit.gpgsign', 'false');
  }
  await git(path.join(root, 'api'), 'remote', 'add', 'origin', 'https://example.com/shop/api.git');
  await writeFile(path.join(root, 'api', 'server.ts'), 'export const port = 3000;\n');
  await writeFile(path.join(root, 'web', 'page.tsx'), 'export const title = "Shop";\n');
  await mkdir(path.join(root, 'docs'));
  for (const name of ['api', 'web']) {
    await git(path.join(root, name), 'add', '.');
    await git(path.join(root, name), 'commit', '-m', 'initial');
  }

  const gitRuntime = new GitRuntime({ watcher: new NoopWatcher(), idleTtlMs: 10_000 });
  const pair = memoryTransportPair();
  const gitController = createGitController(gitRuntime);
  const stop = serve(pair.right, gitController);
  const hostClient = { git: client(gitContract, connect(pair.left)) };
  const host = options.remote ? { type: 'remote' as const, id: 'ssh-1' } : LOCAL_HOST_REF;
  const identity = {
    workspaceId: 'workspace-1',
    host,
    path: options.workspacePath ? path.join(root, options.workspacePath) : root,
    projectId: 'project-1',
  };
  const workspaceIdentity = {
    resolve: async (id: string) => (id === 'workspace-1' ? identity : null),
    resolveProject: async (projectId: string) => (projectId === 'project-1' ? identity : null),
  };
  const runtimes = { client: async () => ok(hostClient as never) };
  const sourceControl = createSourceControlWireController({
    runtimes,
    workspaceIdentity,
    projects: { requireAttached: vi.fn() } as never,
    mintOperationCredentials: vi.fn(async () => undefined),
  });
  const repositories = createProjectRepositoriesWireController(
    new ProjectRepositoriesService({ runtimes, workspaceIdentity })
  );
  cleanups.push(async () => {
    stop();
    await gitController.dispose?.();
    await gitRuntime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { root, sourceControl, repositories };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

class NoopWatcher implements IWatchService {
  watch() {
    return { ready: async () => ok(undefined), release: async () => {} };
  }

  async dispose(): Promise<void> {}
}
