import { describe, expect, it } from 'vitest';
import {
  canonicalizePermissionMode,
  resolveDefaultPermissionForProvider,
} from './default-permission-mode';

describe('default-permission-mode', () => {
  it('maps each permission mode cleanly across claude, codex, antigravity, and grok', () => {
    expect(resolveDefaultPermissionForProvider('claude', 'bypass')).toEqual({
      autoApprove: true,
      modeId: 'bypassPermissions',
    });
    expect(resolveDefaultPermissionForProvider('codex', 'bypass')).toEqual({
      autoApprove: true,
      modeId: 'full-access',
    });
    expect(resolveDefaultPermissionForProvider('antigravity', 'bypass')).toEqual({
      autoApprove: true,
      modeId: 'auto',
    });
    expect(resolveDefaultPermissionForProvider('grok', 'bypass')).toEqual({
      autoApprove: true,
      modeId: 'always-approve',
    });

    expect(resolveDefaultPermissionForProvider('claude', 'acceptEdits')).toEqual({
      autoApprove: false,
      modeId: 'acceptEdits',
    });
    expect(resolveDefaultPermissionForProvider('codex', 'plan')).toEqual({
      autoApprove: false,
      modeId: 'read-only',
    });
    expect(resolveDefaultPermissionForProvider('claude', 'plan')).toEqual({
      autoApprove: false,
      modeId: 'plan',
    });
    expect(resolveDefaultPermissionForProvider('claude', 'auto')).toEqual({
      autoApprove: false,
      modeId: 'auto',
    });
    expect(resolveDefaultPermissionForProvider('claude', 'default')).toEqual({
      autoApprove: false,
      modeId: 'default',
    });
  });

  it('canonicalizes provider modeIds and autoApprove flags symmetrically', () => {
    expect(canonicalizePermissionMode('bypassPermissions', false)).toBe('bypass');
    expect(canonicalizePermissionMode('full-access', true)).toBe('bypass');
    expect(canonicalizePermissionMode('acceptEdits', false)).toBe('acceptEdits');
    expect(canonicalizePermissionMode('read-only', false)).toBe('plan');
    expect(canonicalizePermissionMode('plan', false)).toBe('plan');
    expect(canonicalizePermissionMode('auto', false)).toBe('auto');
    expect(canonicalizePermissionMode('auto', true)).toBe('bypass');
    expect(canonicalizePermissionMode(null, true)).toBe('bypass');
    expect(canonicalizePermissionMode(undefined, false)).toBe('default');
  });
});
