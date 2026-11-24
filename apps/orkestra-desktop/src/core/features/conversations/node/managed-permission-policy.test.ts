import {
  PERMISSION_MODES,
  summarizeManagedPolicy,
  validateManagedPolicy,
  type ManagedPermissionMode,
} from '@orkestra/shared/managed-policy';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalizePermissionMode,
  resolveDefaultPermissionForProvider,
} from '@core/features/conversations/api/default-permission-mode';
import { setActiveManagedPolicy } from '@core/primitives/managed-policy/api/node/active-policy';
import {
  assertProviderAllowedByPolicy,
  clampPermissionSelectionToPolicy,
  clampTuiAutoApprove,
  ManagedPolicyDeniedError,
  permissionModeDenial,
} from './managed-permission-policy';

function activate(limits: Record<string, unknown>) {
  const result = validateManagedPolicy(
    { schemaVersion: 1, organization: 'Example Corp', limits },
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

afterEach(() => setActiveManagedPolicy(undefined));

const PROVIDERS = ['claude', 'codex', 'grok', 'antigravity', 'gemini'];

describe('permission-mode clamping matrix', () => {
  for (const ceiling of PERMISSION_MODES) {
    for (const provider of PROVIDERS) {
      it(`ceiling ${ceiling}, provider ${provider}`, () => {
        activate({ maxPermissionMode: ceiling });
        for (const requested of PERMISSION_MODES) {
          const selection = resolveDefaultPermissionForProvider(provider, requested);
          let clamped: ReturnType<typeof clampPermissionSelectionToPolicy>;
          try {
            clamped = clampPermissionSelectionToPolicy(provider, selection);
          } catch (error) {
            // Sağlayıcının tavana uyan modu yoksa başlatma reddedilir (asla daha geniş açılmaz).
            expect(error).toBeInstanceOf(ManagedPolicyDeniedError);
            continue;
          }
          const effective = canonicalizePermissionMode(clamped.modeId, clamped.autoApprove);
          const order = (mode: ManagedPermissionMode) => PERMISSION_MODES.indexOf(mode);
          // Sonuç asla tavanın üzerinde değildir.
          expect(order(effective)).toBeLessThanOrEqual(order(ceiling));
          // Tavanın altındaki bir mod (sağlayıcının modu ayırt edebildiği ölçüde) korunur.
          const requestedEffective = canonicalizePermissionMode(
            selection.modeId,
            selection.autoApprove
          );
          if (order(requestedEffective) <= order(ceiling)) {
            expect(effective).toBe(requestedEffective);
          }
          expect(
            permissionModeDenial(selection.modeId ?? 'default', selection.autoApprove) !== undefined
          ).toBe(order(requestedEffective) > order(ceiling));
        }
      });
    }
  }

  it('changes nothing without a policy', () => {
    for (const provider of PROVIDERS) {
      for (const requested of PERMISSION_MODES) {
        const selection = resolveDefaultPermissionForProvider(provider, requested);
        expect(clampPermissionSelectionToPolicy(provider, selection)).toEqual({
          ...selection,
          clamped: false,
        });
        expect(
          permissionModeDenial(selection.modeId ?? 'default', selection.autoApprove)
        ).toBeUndefined();
      }
    }
    expect(clampTuiAutoApprove(true)).toBe(true);
  });

  it('turns off skip-permissions for TUI agents below bypass', () => {
    activate({ maxPermissionMode: 'auto' });
    expect(clampTuiAutoApprove(true)).toBe(false);
    activate({ maxPermissionMode: 'bypass' });
    expect(clampTuiAutoApprove(true)).toBe(true);
  });

  it('names the organization in the refusal', () => {
    activate({ maxPermissionMode: 'default' });
    expect(permissionModeDenial('bypassPermissions', undefined)).toBe(
      'Example Corp limits conversations to the "Manual" permission mode or narrower.'
    );
  });
});

describe('provider allow/deny', () => {
  it('blocks denied and non-allowed agents', () => {
    activate({ providers: { denied: ['codex'] } });
    expect(() => assertProviderAllowedByPolicy('codex')).toThrow(ManagedPolicyDeniedError);
    expect(() => assertProviderAllowedByPolicy('claude')).not.toThrow();
    activate({ providers: { allowed: ['claude'] } });
    expect(() => assertProviderAllowedByPolicy('gemini')).toThrow(
      /does not allow the "gemini" agent/
    );
    expect(() => assertProviderAllowedByPolicy('claude')).not.toThrow();
  });

  it('allows everything without a policy', () => {
    expect(() => assertProviderAllowedByPolicy('codex')).not.toThrow();
  });
});
