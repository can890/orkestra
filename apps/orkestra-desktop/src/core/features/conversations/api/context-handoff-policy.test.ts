import { describe, expect, it } from 'vitest';
import {
  arrangeComposerBanners,
  clampContextHandoffThreshold,
  contextHandoffOwnsContextWarning,
  contextHandoffStep,
  contextUsageRatio,
  decideContextHandoffBanner,
  reconcileContextHandoffDismissals,
  type ContextHandoffBannerInput,
} from './context-handoff-policy';

function input(overrides: Partial<ContextHandoffBannerInput> = {}): ContextHandoffBannerInput {
  return {
    enabled: true,
    thresholdPercent: 85,
    usage: { used: 87, size: 100 },
    usageFresh: true,
    dismissed: [],
    hasMessages: true,
    hasSuccessor: false,
    inFlight: false,
    ...overrides,
  };
}

describe('context handoff thresholds', () => {
  it('clamps the threshold into the allowed range and falls back on garbage', () => {
    expect(clampContextHandoffThreshold(10)).toBe(50);
    expect(clampContextHandoffThreshold(99)).toBe(95);
    expect(clampContextHandoffThreshold(72.4)).toBe(72);
    expect(clampContextHandoffThreshold(Number.NaN)).toBe(85);
    expect(clampContextHandoffThreshold(undefined)).toBe(85);
  });

  it('treats missing, zero-sized or implausible usage as unknown', () => {
    expect(contextUsageRatio(null)).toBeNull();
    expect(contextUsageRatio({ used: 10, size: 0 })).toBeNull();
    expect(contextUsageRatio({ used: -1, size: 100 })).toBeNull();
    expect(contextUsageRatio({ used: 400, size: 100 })).toBeNull();
    expect(contextUsageRatio({ used: 50, size: 100 })).toBe(0.5);
  });

  it('maps usage to the warn and critical steps', () => {
    expect(contextHandoffStep(0.84, 85)).toBeNull();
    expect(contextHandoffStep(0.85, 85)).toBe('warn');
    expect(contextHandoffStep(0.949, 85)).toBe('warn');
    expect(contextHandoffStep(0.95, 85)).toBe('critical');
    // A threshold at the critical step has a single step.
    expect(contextHandoffStep(0.95, 95)).toBe('critical');
    expect(contextHandoffStep(0.9, 95)).toBeNull();
    expect(contextHandoffStep(null, 85)).toBeNull();
  });
});

describe('decideContextHandoffBanner', () => {
  it('suggests the move with the rounded percentage', () => {
    expect(decideContextHandoffBanner(input())).toEqual({ show: true, step: 'warn', percent: 87 });
    expect(decideContextHandoffBanner(input({ usage: { used: 961, size: 1000 } }))).toEqual({
      show: true,
      step: 'critical',
      percent: 96,
    });
  });

  it('never shows on stale or unknown usage, when disabled, empty, moved or in flight', () => {
    expect(decideContextHandoffBanner(input({ usageFresh: false })).show).toBe(false);
    expect(decideContextHandoffBanner(input({ usage: null })).show).toBe(false);
    expect(decideContextHandoffBanner(input({ enabled: false })).show).toBe(false);
    expect(decideContextHandoffBanner(input({ hasMessages: false })).show).toBe(false);
    expect(decideContextHandoffBanner(input({ hasSuccessor: true })).show).toBe(false);
    expect(decideContextHandoffBanner(input({ inFlight: true })).show).toBe(false);
  });

  it('keeps a dismissal per step: warn returns at critical, critical never returns', () => {
    expect(decideContextHandoffBanner(input({ dismissed: ['warn'] })).show).toBe(false);
    expect(
      decideContextHandoffBanner(input({ dismissed: ['warn'], usage: { used: 96, size: 100 } }))
    ).toEqual({ show: true, step: 'critical', percent: 96 });
    expect(
      decideContextHandoffBanner(
        input({ dismissed: ['warn', 'critical'], usage: { used: 99, size: 100 } })
      ).show
    ).toBe(false);
    // A dismissed critical step also silences the warn step (e.g. after the usage dips to 90%).
    expect(decideContextHandoffBanner(input({ dismissed: ['critical'] })).show).toBe(false);
  });
});

describe('reconcileContextHandoffDismissals', () => {
  it('resets suggestion dismissals once the usage clearly drops, keeping the moved note', () => {
    const dismissed = ['warn', 'moved'] as const;
    expect(reconcileContextHandoffDismissals(dismissed, { used: 80, size: 100 }, 85)).toBe(
      dismissed
    );
    expect(reconcileContextHandoffDismissals(dismissed, { used: 40, size: 100 }, 85)).toEqual([
      'moved',
    ]);
  });

  it('returns the same array when nothing changes or the usage is unknown', () => {
    const empty: readonly [] = [];
    expect(reconcileContextHandoffDismissals(empty, { used: 1, size: 100 }, 85)).toBe(empty);
    const dismissed = ['critical'] as const;
    expect(reconcileContextHandoffDismissals(dismissed, null, 85)).toBe(dismissed);
  });
});

describe('banner stacking', () => {
  it('lets the in-flight state win and hides the suggestion behind the limit banner', () => {
    expect(
      arrangeComposerBanners({
        limit: true,
        handoffInFlight: false,
        handoffSuggestion: true,
        handoffMoved: false,
      })
    ).toEqual({ limit: true, handoff: null });
    expect(
      arrangeComposerBanners({
        limit: true,
        handoffInFlight: true,
        handoffSuggestion: false,
        handoffMoved: false,
      })
    ).toEqual({ limit: true, handoff: 'in-flight' });
    expect(
      arrangeComposerBanners({
        limit: false,
        handoffInFlight: false,
        handoffSuggestion: false,
        handoffMoved: true,
      })
    ).toEqual({ limit: false, handoff: 'moved' });
  });

  it('gives the context-full topic to the handoff banner instead of /compact', () => {
    const base = { enabled: true, thresholdPercent: 85, hasSuccessor: false };
    expect(contextHandoffOwnsContextWarning({ ...base, usage: { used: 80, size: 100 } })).toBe(
      false
    );
    expect(contextHandoffOwnsContextWarning({ ...base, usage: { used: 90, size: 100 } })).toBe(
      true
    );
    expect(
      contextHandoffOwnsContextWarning({ ...base, enabled: false, usage: { used: 90, size: 100 } })
    ).toBe(false);
    expect(
      contextHandoffOwnsContextWarning({
        ...base,
        hasSuccessor: true,
        usage: { used: 90, size: 100 },
      })
    ).toBe(false);
  });
});
