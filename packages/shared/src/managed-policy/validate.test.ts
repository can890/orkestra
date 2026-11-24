import { describe, expect, it } from 'vitest';
import { clampPermissionMode, isManagedProviderAllowed, isPermissionModeAbove } from './schema';
import { isLockedSettingPath } from './settings-catalog';
import { validateManagedPolicy } from './validate';

const source = '/etc/orkestra/policy.json';
const known = ['claude', 'codex', 'gemini'];

function check(raw: unknown) {
  return validateManagedPolicy(raw, { source, knownProviderIds: known });
}

function reason(raw: unknown): string {
  const result = check(raw);
  if (result.success) throw new Error('expected the policy to be rejected');
  return result.error.reason;
}

describe('validateManagedPolicy', () => {
  it('accepts a complete policy and splits locks from defaults', () => {
    const result = check(
      JSON.stringify({
        schemaVersion: 1,
        organization: 'Example Corp',
        supportUrl: 'https://it.example.com/orkestra',
        settings: {
          'tasks.defaultPermissionMode': { value: 'default', locked: true },
          'updates.autoDownload': { value: false, locked: false },
        },
        limits: {
          maxPermissionMode: 'acceptEdits',
          providers: { allowed: ['claude', 'codex'] },
          remoteAccess: false,
          devicePairing: false,
          outsideAgents: false,
          updates: { mode: 'off' },
        },
      })
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect([...result.data.lockedSettings]).toEqual([['tasks.defaultPermissionMode', 'default']]);
    expect([...result.data.defaultSettings]).toEqual([['updates.autoDownload', false]]);
  });

  it('accepts the minimal policy', () => {
    expect(check({ schemaVersion: 1, organization: 'Org' }).success).toBe(true);
  });

  it('rejects text that is not JSON', () => {
    expect(reason('{ nope')).toMatch(/not valid JSON/);
  });

  it('rejects a non-object document', () => {
    expect(reason('[]')).toMatch(/must be a JSON object/);
  });

  it('rejects unknown top-level and nested keys (fail-closed)', () => {
    expect(reason({ schemaVersion: 1, organization: 'Org', telemetry: false })).toMatch(
      /does not match the policy schema.*telemetry/
    );
    expect(
      reason({ schemaVersion: 1, organization: 'Org', limits: { clients: ['desktop'] } })
    ).toMatch(/limits.*clients/);
    expect(
      reason({
        schemaVersion: 1,
        organization: 'Org',
        settings: { 'tasks.autoGenerateName': { value: true, locked: true, note: 'x' } },
      })
    ).toMatch(/note/);
  });

  it('explains a policy written for a newer schema version', () => {
    expect(reason({ schemaVersion: 2, organization: 'Org' })).toMatch(
      /newer Orkestra \(schemaVersion 2\).*supports schemaVersion 1/
    );
  });

  it('rejects a missing or unsupported version and a missing organization', () => {
    expect(reason({ organization: 'Org' })).toMatch(/schemaVersion/);
    expect(reason({ schemaVersion: 0, organization: 'Org' })).toMatch(/schemaVersion/);
    expect(reason({ schemaVersion: 1, organization: '  ' })).toMatch(/organization/);
  });

  it('rejects settings it cannot manage and values of the wrong type', () => {
    expect(
      reason({
        schemaVersion: 1,
        organization: 'Org',
        settings: { 'theme.mode': { value: 'dark', locked: true } },
      })
    ).toMatch(/"settings.theme.mode" is not a setting a policy can manage/);
    expect(
      reason({
        schemaVersion: 1,
        organization: 'Org',
        settings: { 'tasks.autoGenerateName': { value: 'yes', locked: true } },
      })
    ).toMatch(/"settings.tasks.autoGenerateName.value" is invalid/);
    expect(
      reason({
        schemaVersion: 1,
        organization: 'Org',
        settings: { 'tasks.defaultPermissionMode': { value: 'yolo', locked: false } },
      })
    ).toMatch(/defaultPermissionMode.value/);
  });

  it('rejects a default permission mode broader than the ceiling', () => {
    expect(
      reason({
        schemaVersion: 1,
        organization: 'Org',
        settings: { 'tasks.defaultPermissionMode': { value: 'bypass', locked: false } },
        limits: { maxPermissionMode: 'auto' },
      })
    ).toMatch(/broader than "limits.maxPermissionMode"/);
    expect(
      reason({
        schemaVersion: 1,
        organization: 'Org',
        settings: { 'tasks.autoApproveByDefault': { value: true, locked: true } },
        limits: { maxPermissionMode: 'auto' },
      })
    ).toMatch(/autoApproveByDefault/);
  });

  it('rejects both provider lists and unknown provider ids', () => {
    expect(
      reason({
        schemaVersion: 1,
        organization: 'Org',
        limits: { providers: { allowed: ['claude'], denied: ['codex'] } },
      })
    ).toMatch(/either/);
    expect(
      reason({
        schemaVersion: 1,
        organization: 'Org',
        limits: { providers: { denied: ['claud'] } },
      })
    ).toMatch(/"claud" is not an agent/);
    expect(
      reason({ schemaVersion: 1, organization: 'Org', limits: { providers: { allowed: [] } } })
    ).toMatch(/allowed/);
  });

  it('rejects a non-http support URL and an unknown update mode', () => {
    expect(
      reason({ schemaVersion: 1, organization: 'Org', supportUrl: 'javascript:alert(1)' })
    ).toMatch(/supportUrl/);
    expect(
      reason({ schemaVersion: 1, organization: 'Org', limits: { updates: { mode: 'nightly' } } })
    ).toMatch(/updates/);
  });
});

describe('permission mode ordering', () => {
  const modes = ['plan', 'default', 'acceptEdits', 'auto', 'bypass'] as const;

  it('clamps every mode against every ceiling (matrix)', () => {
    for (const [ceilingIndex, ceiling] of modes.entries()) {
      for (const [modeIndex, mode] of modes.entries()) {
        const above = modeIndex > ceilingIndex;
        expect(isPermissionModeAbove(mode, ceiling)).toBe(above);
        expect(clampPermissionMode(mode, ceiling)).toBe(above ? ceiling : mode);
      }
    }
  });

  it('never clamps without a ceiling', () => {
    for (const mode of modes) {
      expect(isPermissionModeAbove(mode, undefined)).toBe(false);
      expect(clampPermissionMode(mode, undefined)).toBe(mode);
    }
  });
});

describe('provider allow/deny', () => {
  it('allows everything without limits', () => {
    expect(isManagedProviderAllowed(undefined, 'claude')).toBe(true);
    expect(isManagedProviderAllowed({}, 'claude')).toBe(true);
  });

  it('honours allow and deny lists', () => {
    expect(isManagedProviderAllowed({ providers: { allowed: ['codex'] } }, 'codex')).toBe(true);
    expect(isManagedProviderAllowed({ providers: { allowed: ['codex'] } }, 'claude')).toBe(false);
    expect(isManagedProviderAllowed({ providers: { denied: ['codex'] } }, 'codex')).toBe(false);
    expect(isManagedProviderAllowed({ providers: { denied: ['codex'] } }, 'claude')).toBe(true);
  });
});

describe('isLockedSettingPath', () => {
  it('matches the path, its parents and its children', () => {
    const locked = ['tasks.defaultPermissionMode'];
    expect(isLockedSettingPath(locked, 'tasks.defaultPermissionMode')).toBe(true);
    expect(isLockedSettingPath(locked, 'tasks')).toBe(true);
    expect(isLockedSettingPath(locked, 'tasks.autoGenerateName')).toBe(false);
    expect(isLockedSettingPath([], 'tasks')).toBe(false);
  });
});
