import { describe, expect, it } from 'vitest';
import {
  buildQuickTaskWorkspaceConfig,
  pickPlaceholderTaskName,
} from './quick-create-task';

describe('pickPlaceholderTaskName', () => {
  it('returns Yeni sohbet when unused and appends incrementing numbers on collision', () => {
    expect(pickPlaceholderTaskName([])).toBe('Yeni sohbet');
    expect(pickPlaceholderTaskName(['Auth Hatası Düzelt'])).toBe('Yeni sohbet');
    expect(pickPlaceholderTaskName(['Yeni sohbet'])).toBe('Yeni sohbet (2)');
    expect(pickPlaceholderTaskName(['yeni sohbet', 'Yeni sohbet (2)', 'Yeni sohbet (3)'])).toBe(
      'Yeni sohbet (4)'
    );
  });
});

describe('buildQuickTaskWorkspaceConfig', () => {
  const defaultBranch = { type: 'local' as const, branch: 'main' };

  it('creates a new-worktree config using the ASCII branch slug when repository is ready', () => {
    const config = buildQuickTaskWorkspaceConfig({
      hasRepository: true,
      isUnborn: false,
      defaultBranch,
      repositoryWorkspaceId: 'ws-repo',
      createBranchAndWorktree: true,
      pushOnCreate: true,
      canPublish: true,
      branchSlug: 'clean-river-flow',
      suffix: 'ab12c',
      appendRandomSuffix: true,
      existingLocalBranches: ['refs/heads/main'],
    });

    expect(config).toEqual({
      version: '2',
      git: {
        kind: 'create-branch',
        branchName: 'clean-river-flow-ab12c',
        fromBranch: defaultBranch,
        pushBranch: true,
      },
      workspace: { kind: 'new-worktree' },
    });
  });

  it('avoids local branch name collisions when generating quick worktree branches', () => {
    const config = buildQuickTaskWorkspaceConfig({
      hasRepository: true,
      isUnborn: false,
      defaultBranch,
      repositoryWorkspaceId: 'ws-repo',
      createBranchAndWorktree: true,
      pushOnCreate: false,
      canPublish: false,
      branchSlug: 'clean-river-flow',
      appendRandomSuffix: false,
      existingLocalBranches: ['refs/heads/clean-river-flow', 'refs/heads/clean-river-flow-2'],
    });

    expect(config.git).toMatchObject({
      kind: 'create-branch',
      branchName: 'clean-river-flow-3',
      pushBranch: false,
    });
  });

  it('falls back to repo-root for non-git, unborn, or createBranchAndWorktree=false projects', () => {
    expect(
      buildQuickTaskWorkspaceConfig({
        hasRepository: false,
        isUnborn: false,
        defaultBranch,
        repositoryWorkspaceId: 'ws-repo',
        createBranchAndWorktree: true,
        pushOnCreate: true,
        canPublish: true,
        branchSlug: 'clean-river-flow',
      })
    ).toEqual({
      version: '2',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance', workspaceId: 'ws-repo' },
    });

    expect(
      buildQuickTaskWorkspaceConfig({
        hasRepository: true,
        isUnborn: true,
        defaultBranch: undefined,
        repositoryWorkspaceId: 'ws-repo',
        createBranchAndWorktree: true,
        pushOnCreate: true,
        canPublish: true,
        branchSlug: 'clean-river-flow',
      })
    ).toEqual({
      version: '2',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance', workspaceId: 'ws-repo' },
    });

    expect(
      buildQuickTaskWorkspaceConfig({
        hasRepository: true,
        isUnborn: false,
        defaultBranch,
        repositoryWorkspaceId: 'ws-repo',
        createBranchAndWorktree: false,
        pushOnCreate: true,
        canPublish: true,
        branchSlug: 'clean-river-flow',
      })
    ).toEqual({
      version: '2',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance', workspaceId: 'ws-repo' },
    });
  });
});
