import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_EXECUTOR_FAMILIES,
  ANTIGRAVITY_ORCHESTRATOR_ENV_KEYS,
  ANTIGRAVITY_PLANNER_FAMILIES,
  buildAntigravityRoleSlug,
  formatAntigravityRoleLabel,
  normalizeProviderOrchestratorConfig,
  parseAntigravityRoleSlug,
  resolveProviderExtraArgs,
  resolveProviderRuntimeEnv,
} from './antigravity-orchestrator';

describe('antigravity orchestrator settings helpers', () => {
  it('parses and builds planner and executor role slugs', () => {
    expect(parseAntigravityRoleSlug('gemini-4-neon-xhigh', ANTIGRAVITY_PLANNER_FAMILIES)).toEqual({
      familyId: 'gemini-4-neon',
      effort: 'xhigh',
    });
    expect(buildAntigravityRoleSlug('gemini-4-carbon', 'xhigh', ANTIGRAVITY_PLANNER_FAMILIES)).toBe(
      'gemini-4-carbon-high'
    );
    expect(
      buildAntigravityRoleSlug('claude-sonnet-5-5', 'medium', ANTIGRAVITY_EXECUTOR_FAMILIES)
    ).toBe('claude-sonnet-5-5-medium');
  });

  it('normalizes standard/empty orchestrator config to undefined', () => {
    expect(normalizeProviderOrchestratorConfig({ defaultMode: 'standard' })).toBeUndefined();
    expect(
      normalizeProviderOrchestratorConfig({
        defaultMode: 'standard',
        plannerModel: '  ',
        executorModel: '',
      })
    ).toBeUndefined();
    expect(
      normalizeProviderOrchestratorConfig({
        defaultMode: 'gemini-pro-orchestrator-neon',
        plannerModel: 'gemini-4-neon-high',
      })
    ).toEqual({
      defaultMode: 'gemini-pro-orchestrator-neon',
      plannerModel: 'gemini-4-neon-high',
    });
  });

  it('resolves runtime env for Antigravity and respects explicit manual env overrides', () => {
    expect(
      resolveProviderRuntimeEnv('antigravity', {
        orchestrator: {
          defaultMode: 'gemini-pro-orchestrator-argon',
          plannerModel: 'gemini-4-neon-high',
          executorModel: 'gemini-4-hydrogen-xhigh',
        },
        env: {
          CUSTOM_VAR: '1',
          [ANTIGRAVITY_ORCHESTRATOR_ENV_KEYS.planner]: 'claude-opus-5-5-high',
        },
      })
    ).toEqual({
      [ANTIGRAVITY_ORCHESTRATOR_ENV_KEYS.mode]: 'gemini-pro-orchestrator-argon',
      [ANTIGRAVITY_ORCHESTRATOR_ENV_KEYS.planner]: 'claude-opus-5-5-high',
      [ANTIGRAVITY_ORCHESTRATOR_ENV_KEYS.executor]: 'gemini-4-hydrogen-xhigh',
      CUSTOM_VAR: '1',
    });

    expect(
      resolveProviderRuntimeEnv('claude', {
        orchestrator: { defaultMode: 'gemini-pro-orchestrator-neon' },
      })
    ).toBeUndefined();
  });

  it('formats Turkish role labels cleanly', () => {
    expect(formatAntigravityRoleLabel('gemini-4-neon-xhigh', ANTIGRAVITY_PLANNER_FAMILIES)).toBe(
      'Gemini 4 Neon (Çok Yüksek)'
    );
    expect(formatAntigravityRoleLabel(undefined, ANTIGRAVITY_EXECUTOR_FAMILIES)).toBe(
      'Antigravity varsayılanı'
    );
  });

  it('merges active agent profile env and extraArgs onto base provider config', () => {
    const cfg = {
      extraArgs: '--base-flag',
      env: { API_HOST: 'default.local', BASE_ONLY: 'yes' },
      activeProfileId: 'prof-work',
      profiles: [
        {
          id: 'prof-work',
          name: 'İş',
          extraArgs: '--profile fast',
          env: { API_HOST: 'work.internal', PROFILE_ONLY: '1' },
        },
      ],
    };
    expect(resolveProviderExtraArgs(cfg)).toBe('--base-flag --profile fast');
    expect(resolveProviderRuntimeEnv('claude', cfg)).toEqual({
      API_HOST: 'work.internal',
      BASE_ONLY: 'yes',
      PROFILE_ONLY: '1',
    });
  });
});
