import { summarizeManagedPolicy, validateManagedPolicy } from '@orkestra/shared/managed-policy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setActiveManagedPolicy } from '@core/primitives/managed-policy/api/node/active-policy';
import { DesktopProjectSettingsAuthority } from './durable-project-settings';
import type { ProjectSettingsStorage, StoredProjectSettings } from './project-settings-storage';

function lockTmux(value: boolean) {
  const result = validateManagedPolicy(
    {
      schemaVersion: 1,
      organization: 'Example Corp',
      settings: { 'project.tmuxByDefault': { value, locked: true } },
    },
    { source: '/test/policy.json' }
  );
  if (!result.success) throw new Error(result.error.reason);
  const meta = { source: '/test/policy.json', fingerprint: 'abc' };
  setActiveManagedPolicy({
    ...meta,
    policy: result.data,
    summary: summarizeManagedPolicy(result.data, meta),
  });
}

function authority() {
  const row: StoredProjectSettings = {
    baseProjectSettingsJson: '{}',
    shareableProjectSettingsJson: '{}',
    legacyConfigMigratedAt: null,
  };
  const storage: ProjectSettingsStorage = {
    get: vi.fn(async () => row),
    insertIfMissing: vi.fn(),
    mutate: vi.fn(async (_projectId, patch) => {
      Object.assign(row, patch(row));
      return row;
    }),
  };
  return { row, storage, authority: new DesktopProjectSettingsAuthority(storage) };
}

afterEach(() => setActiveManagedPolicy(undefined));

describe('project overrides under a managed policy', () => {
  it('refuses a project tmux override when the policy locks project.tmuxByDefault', async () => {
    lockTmux(true);
    const { authority: subject, storage } = authority();
    await expect(
      subject.patch('project-1', { placement: { stored: { tmux: false } } })
    ).resolves.toEqual({
      success: false,
      error: {
        type: 'write-config-failed',
        message: 'Example Corp manages the "project.tmuxByDefault" setting; it cannot be changed.',
      },
    });
    expect(storage.mutate).not.toHaveBeenCalled();
  });

  it('still lets the user clear an old override and patch other domains', async () => {
    lockTmux(true);
    const { authority: subject, row } = authority();
    await expect(
      subject.patch('project-1', { placement: { stored: { tmux: null } } })
    ).resolves.toMatchObject({ success: true });
    await expect(
      subject.patch('project-1', { gitIdentity: { stored: { baseRemote: 'origin' } } })
    ).resolves.toMatchObject({ success: true });
    expect(JSON.parse(row.baseProjectSettingsJson)).toMatchObject({ baseRemote: 'origin' });
  });

  it('allows the override without a policy', async () => {
    const { authority: subject, row } = authority();
    await expect(
      subject.patch('project-1', { placement: { stored: { tmux: false } } })
    ).resolves.toMatchObject({ success: true });
    expect(JSON.parse(row.baseProjectSettingsJson)).toMatchObject({ tmux: false });
  });
});
