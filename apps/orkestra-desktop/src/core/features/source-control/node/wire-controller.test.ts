import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { err, ok } from '@orkestra/shared';
import type { LiveSource } from '@orkestra/wire/rpc';
import { encodeTopic } from '@orkestra/wire/rpc';
import { describe, expect, it, vi } from 'vitest';
import { hostPathFromNative } from '@core/primitives/desktop-runtime/api';
import { sourceControlContract } from '../api';
import {
  sourceControlGitRuntimeContract as gitContract,
  type SourceControlRuntimeResolveError as RuntimeResolveError,
} from '../api/runtime-adapter';
import { createSourceControlWireController } from './wire-controller';

const projectIdentity = {
  projectId: 'project-1',
  workspaceId: 'repository-workspace-1',
  host: LOCAL_HOST_REF,
  path: '/repo',
} as const;

const checkoutIdentity = {
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  host: LOCAL_HOST_REF,
  path: '/repo/worktree',
} as const;

function attachedProjects(project: unknown) {
  return { requireAttached: vi.fn(() => ok(project as never)) };
}

describe('createSourceControlWireController', () => {
  it('resolves repository ids and clients for attached state', async () => {
    const source = liveSource({ kind: 'ready', branches: [], tags: [], remoteHeads: [] });
    const state = vi.fn(() => ({ asLiveSource: () => source }));
    const client = vi.fn();
    const resolveProject = vi.fn(async () => projectIdentity);
    const projects = attachedProjects({
      git: { repository: { model: { state } } },
      repository: { repository: hostPathFromNative(projectIdentity.path) },
    });
    const controller = createSourceControlWireController({
      runtimes: { client } as never,
      workspaceIdentity: {
        resolve: vi.fn(async () => checkoutIdentity),
        resolveProject,
      },
      projects,
      mintOperationCredentials: vi.fn(async () => undefined),
    });

    expect(client).not.toHaveBeenCalled();
    const topic = encodeTopic(sourceControlContract.repository.model.states.refs.id, {
      projectId: projectIdentity.projectId,
    });
    const lease = controller.acquireLive(topic);
    await expect(lease?.ready()).resolves.toBe(source);

    expect(projects.requireAttached).toHaveBeenCalledWith(projectIdentity.projectId);
    expect(resolveProject).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
    expect(state).toHaveBeenCalledWith(
      { repository: hostPathFromNative(projectIdentity.path) },
      'refs'
    );

    await lease?.release();
  });

  it('resolves a runtime client for each checkout procedure call', async () => {
    const getLog = vi.fn(async () => ok({ commits: [], totalCount: 0 }));
    const client = vi.fn(async () => ok({ git: { checkout: { getLog } } }));
    const resolve = vi.fn(async () => checkoutIdentity);
    const controller = createSourceControlWireController({
      runtimes: { client } as never,
      workspaceIdentity: { resolve, resolveProject: vi.fn(async () => projectIdentity) },
      projects: attachedProjects({}),
      mintOperationCredentials: vi.fn(async () => undefined),
    });

    await controller.call('checkout.getLog', { workspaceId: checkoutIdentity.workspaceId });
    await controller.call('checkout.getLog', { workspaceId: checkoutIdentity.workspaceId });

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(client).toHaveBeenCalledTimes(2);
    expect(getLog).toHaveBeenCalledWith(
      { checkout: hostPathFromNative(checkoutIdentity.path) },
      {}
    );
  });

  it('reads and marks only the current review file in a registered project repository', async () => {
    const repositoryUrl = 'https://github.com/org/repo';
    const url = repositoryUrl + '/pull/8';
    const revision = {
      repositoryUrl,
      number: 8,
      baseRefOid: 'a'.repeat(40),
      headRefOid: 'b'.repeat(40),
    };
    const pr = { ...revision, url, identifier: '#8', title: 'PR', status: 'open' };
    const pullRequests = {
      listPullRequests: vi.fn(async () => ok({ prs: [pr] })),
      getPullRequestByUrl: vi.fn(async (input: { url: string }) =>
        ok({ pr: input.url === url ? pr : null })
      ),
      getPullRequestFileViews: vi.fn(async () =>
        ok({
          account: 'test-provider-account',
          marks: [{ path: 'src/main.ts', revision: 'reviewed-content' }],
        })
      ),
      setPullRequestFileViewed: vi.fn(async () => ok(undefined)),
    };
    const file = {
      path: 'src/main.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      diffRevision: 'reviewed-content',
    };
    const getChangedFiles = vi.fn(async () => ok({ files: [file] }));
    const getFileHunks = vi.fn(async () => ok({ hunks: [] }));
    const controller = createSourceControlWireController({
      runtimes: {
        client: vi.fn(async () => ok({ git: { checkout: { getChangedFiles, getFileHunks } } })),
      } as never,
      workspaceIdentity: {
        resolve: vi.fn(async () => checkoutIdentity),
        resolveProject: vi.fn(async () => projectIdentity),
      },
      projects: attachedProjects({
        git: {
          repository: {
            model: {
              state: () => ({
                snapshot: async () => ({
                  data: { remotes: [{ name: 'origin', url: 'git@github.com:org/repo.git' }] },
                }),
              }),
            },
          },
        },
        repository: { repository: hostPathFromNative(projectIdentity.path) },
      }),
      mintOperationCredentials: vi.fn(async () => undefined),
      getPullRequests: async () => pullRequests as never,
    });
    const scope = { workspaceId: checkoutIdentity.workspaceId, url };
    await expect(
      controller.call('review.list', { workspaceId: scope.workspaceId })
    ).resolves.toEqual(ok({ prs: [{ url, number: 8, title: 'PR' }] }));
    const files = (await controller.call('review.files', scope)) as { data: { account: string } };
    expect(files).toMatchObject(
      ok({
        account: expect.stringMatching(/^[a-f0-9]{64}$/),
        files: [{ path: file.path, revision: file.diffRevision, viewed: true }],
      })
    );
    const selection = { ...scope, path: file.path, revision: file.diffRevision };
    await expect(controller.call('review.hunks', selection)).resolves.toEqual(ok({ hunks: [] }));
    expect(getFileHunks).toHaveBeenCalledWith(
      expect.objectContaining({
        path: file.path,
        range: {
          base: { kind: 'commit', sha: revision.baseRefOid },
          head: { kind: 'commit', sha: revision.headRefOid },
        },
      }),
      {}
    );

    for (const invalid of [
      {
        ...selection,
        url: 'https://github.com/other/repo/pull/8',
        account: files.data.account,
        viewed: false,
      },
      { ...selection, revision: 'outdated-content', account: files.data.account, viewed: false },
      { ...selection, account: 'a'.repeat(64), viewed: false },
    ]) {
      await expect(controller.call('review.setViewed', invalid)).resolves.toMatchObject({
        success: false,
      });
    }
    expect(pullRequests.setPullRequestFileViewed).not.toHaveBeenCalled();
    await expect(
      controller.call('review.setViewed', {
        ...selection,
        account: files.data.account,
        viewed: false,
      })
    ).resolves.toEqual(ok(undefined));
    expect(pullRequests.setPullRequestFileViewed).toHaveBeenCalledWith(
      {
        ...revision,
        account: 'test-provider-account',
        path: file.path,
        diffRevision: file.diffRevision,
        viewed: false,
      },
      {}
    );
  });

  it('translates mutation selectors and cursors back to project identities', async () => {
    const mutate = vi.fn(async (_name, envelope) =>
      ok({
        data: undefined,
        cursors: [
          {
            model: gitContract.repository.model.states.remotes.id,
            key: envelope.key,
            cursor: { generation: 1, sequence: 2 },
          },
        ],
      })
    );
    const controller = createSourceControlWireController({
      runtimes: {
        client: async () =>
          ok({ git: { repository: { model: { def: gitContract.repository.model, mutate } } } }),
      } as never,
      workspaceIdentity: {
        resolve: vi.fn(async () => checkoutIdentity),
        resolveProject: vi.fn(async () => projectIdentity),
      },
      projects: attachedProjects({
        git: {
          repository: {
            model: { def: gitContract.repository.model, mutate },
          },
        },
        repository: { repository: hostPathFromNative(projectIdentity.path) },
      }),
      mintOperationCredentials: vi.fn(async () => undefined),
    });
    const key = { projectId: projectIdentity.projectId };

    const result = await controller.call('repository.model.addRemote', {
      key,
      input: { name: 'upstream', url: 'git@example.com:org/repo.git' },
      mutationId: 'mutation-1',
    });

    expect(mutate).toHaveBeenCalledWith('addRemote', {
      key: { repository: hostPathFromNative(projectIdentity.path) },
      input: { name: 'upstream', url: 'git@example.com:org/repo.git' },
      mutationId: 'mutation-1',
    });
    expect(result).toEqual(
      ok({
        data: undefined,
        cursors: [
          {
            model: sourceControlContract.repository.model.states.remotes.id,
            key,
            cursor: { generation: 1, sequence: 2 },
          },
        ],
      })
    );
  });

  it('returns RuntimeResolveError from fallible procedures and mutations', async () => {
    const resolveError: RuntimeResolveError = {
      type: 'host-unavailable',
      host: LOCAL_HOST_REF,
      reason: 'runtime-unavailable',
      message: 'Runtime unavailable',
    };
    const controller = createSourceControlWireController({
      runtimes: {
        client: async () => err(resolveError),
      } as never,
      workspaceIdentity: {
        resolve: vi.fn(async () => checkoutIdentity),
        resolveProject: vi.fn(async () => projectIdentity),
      },
      projects: {
        requireAttached: vi.fn(() => err(resolveError)),
      },
      mintOperationCredentials: vi.fn(async () => undefined),
    });

    await expect(
      controller.call('checkout.getLog', { workspaceId: checkoutIdentity.workspaceId })
    ).resolves.toEqual(err(resolveError));
    await expect(
      controller.call('repository.model.addRemote', {
        key: { projectId: projectIdentity.projectId },
        input: { name: 'upstream', url: 'git@example.com:org/repo.git' },
        mutationId: 'mutation-1',
      })
    ).resolves.toEqual(err(resolveError));
  });

  it('preserves typed attachment races for repository operations', async () => {
    const unavailable = {
      type: 'attachment-unavailable' as const,
      host: LOCAL_HOST_REF,
      phase: 'waiting' as const,
    };
    const controller = createSourceControlWireController({
      runtimes: { client: vi.fn() } as never,
      workspaceIdentity: {
        resolve: vi.fn(async () => checkoutIdentity),
        resolveProject: vi.fn(async () => projectIdentity),
      },
      projects: {
        requireAttached: vi.fn(() => err(unavailable)),
      },
      mintOperationCredentials: vi.fn(async () => undefined),
    });

    await expect(
      controller.call('repository.model.addRemote', {
        key: { projectId: 'project-1' },
        input: { name: 'upstream', url: 'git@example.com:org/repo.git' },
        mutationId: 'mutation-1',
      })
    ).resolves.toEqual(err(unavailable));
  });
});

function liveSource(data: unknown): LiveSource {
  return {
    snapshot: async () => ({ generation: 1, sequence: 0, timestamp: 0, data }),
    subscribe: () => () => {},
  };
}
