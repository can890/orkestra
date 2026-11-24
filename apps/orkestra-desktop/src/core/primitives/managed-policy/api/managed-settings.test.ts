import { validateManagedPolicy } from '@orkestra/shared/managed-policy';
import { describe, expect, it } from 'vitest';
import { createManagedSettingsLayer } from './managed-settings';

function layer(document: unknown) {
  const result = validateManagedPolicy(document, { source: '/test/policy.json' });
  if (!result.success) throw new Error(result.error.reason);
  return createManagedSettingsLayer(result.data);
}

const tasks = {
  autoGenerateName: true,
  autoApproveByDefault: true,
  defaultPermissionMode: 'bypass',
  autoTrustWorktrees: true,
  createBranchAndWorktree: true,
  deleteBranchByDefault: false,
  preserveNameCapitalization: false,
  includeIssueContextByDefault: true,
};

describe('createManagedSettingsLayer', () => {
  const managed = layer({
    schemaVersion: 1,
    organization: 'Example Corp',
    settings: {
      'tasks.autoGenerateName': { value: false, locked: true },
      'tasks.deleteBranchByDefault': { value: true, locked: false },
    },
    limits: { maxPermissionMode: 'acceptEdits' },
  });

  it('replaces built-in defaults with unlocked policy defaults only', () => {
    expect(
      managed.applyDefaults('tasks', { ...tasks, deleteBranchByDefault: false })
    ).toMatchObject({ deleteBranchByDefault: true, autoGenerateName: true });
    expect(managed.applyDefaults('updates', { autoDownload: true })).toEqual({
      autoDownload: true,
    });
  });

  it('lays locks and the permission ceiling over the effective value', () => {
    expect(managed.applyLocks('tasks', tasks)).toMatchObject({
      autoGenerateName: false,
      defaultPermissionMode: 'acceptEdits',
      autoApproveByDefault: false,
    });
  });

  it('refuses writes that move a lock or exceed the ceiling', () => {
    const effective = managed.applyLocks('tasks', tasks) as Record<string, unknown>;
    expect(managed.findLockViolation('tasks', effective)).toBeNull();
    expect(managed.findLockViolation('tasks', { ...effective, autoGenerateName: true })).toBe(
      'tasks.autoGenerateName'
    );
    expect(
      managed.findLockViolation('tasks', { ...effective, defaultPermissionMode: 'auto' })
    ).toBe('tasks.defaultPermissionMode');
    expect(managed.findLockViolation('tasks', { ...effective, autoApproveByDefault: true })).toBe(
      'tasks.autoApproveByDefault'
    );
    // Kilitsiz bir varsayılan değiştirilebilir.
    expect(
      managed.findLockViolation('tasks', { ...effective, deleteBranchByDefault: false })
    ).toBeNull();
  });

  it('reports locked paths and segments', () => {
    expect(managed.lockedPaths).toEqual(['tasks.autoGenerateName']);
    expect(managed.lockedSegments('tasks')).toEqual([['autoGenerateName']]);
    expect(managed.lockedSegments('updates')).toEqual([]);
    expect(managed.isLocked('tasks.autoGenerateName')).toBe(true);
    expect(managed.isLocked('tasks.deleteBranchByDefault')).toBe(false);
  });
});
