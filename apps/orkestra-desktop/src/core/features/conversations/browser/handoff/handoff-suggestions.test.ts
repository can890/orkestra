import { describe, expect, it } from 'vitest';
import type { UsageCapacityStatus } from '@core/features/usage-limits/api/usage-capacity';
import {
  agentUsageBadge,
  currentLimitSignals,
  decideLimitBanner,
  dismissalsFor,
  formatResetIn,
  isUsageLimitMessage,
  limitErrorTurnId,
  listHandoffCandidates,
  sortHandoffCandidates,
  suggestHandoffAgents,
  DEFAULT_LIMIT_WINDOW_MS,
  type HandoffAgentInfo,
  type HandoffCapacities,
} from './handoff-suggestions';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const HOUR = 60 * 60_000;

function agent(id: string, overrides: Partial<HandoffAgentInfo> = {}): HandoffAgentInfo {
  return { id, name: id.toUpperCase(), supportsAcp: true, ...overrides };
}

function caps(entries: Record<string, UsageCapacityStatus>): HandoffCapacities {
  return Object.fromEntries(Object.entries(entries).map(([id, status]) => [id, { status }]));
}

describe('listHandoffCandidates', () => {
  const agents = [
    agent('claude'),
    agent('codex'),
    agent('kimi'),
    agent('cursor', { supportsAcp: false }),
  ];

  it('excludes the current agent and agents without ACP', () => {
    const result = listHandoffCandidates({
      agents,
      installedIds: undefined,
      currentProviderId: 'kimi',
    });
    expect(result.map((a) => a.id)).toEqual(['claude', 'codex']);
  });

  it('keeps only installed agents when availability is known', () => {
    const result = listHandoffCandidates({
      agents,
      installedIds: ['claude', 'kimi', 'cursor'],
      currentProviderId: 'kimi',
    });
    expect(result.map((a) => a.id)).toEqual(['claude']);
  });

  it('does not filter on installation while availability is unknown', () => {
    expect(
      listHandoffCandidates({ agents, installedIds: undefined, currentProviderId: null })
    ).toHaveLength(3);
  });

  it('returns nothing when no other agent qualifies', () => {
    expect(listHandoffCandidates({ agents, installedIds: [], currentProviderId: 'kimi' })).toEqual(
      []
    );
  });
});

describe('sortHandoffCandidates / suggestHandoffAgents', () => {
  const candidates = ['a', 'b', 'c', 'd', 'e'].map((id) => agent(id));

  it('orders ok, tight, unknown, saturated and keeps input order within a status', () => {
    const sorted = sortHandoffCandidates(
      candidates,
      caps({ a: 'saturated', b: 'unknown', c: 'tight', d: 'ok', e: 'ok' })
    );
    expect(sorted.map((c) => c.id)).toEqual(['d', 'e', 'c', 'b', 'a']);
  });

  it('treats agents without capacity data as unknown', () => {
    const sorted = sortHandoffCandidates(candidates, caps({ c: 'tight', e: 'ok' }));
    expect(sorted.map((c) => c.id)).toEqual(['e', 'c', 'a', 'b', 'd']);
  });

  it('suggests at most three non-saturated buttons and counts the rest as "more"', () => {
    const result = suggestHandoffAgents(
      candidates,
      caps({ a: 'saturated', b: 'ok', c: 'tight', d: 'ok', e: 'unknown' })
    );
    expect(result.buttons.map((b) => [b.id, b.status])).toEqual([
      ['b', 'ok'],
      ['d', 'ok'],
      ['c', 'tight'],
    ]);
    expect(result.moreCount).toBe(2);
  });

  it('never offers a saturated agent as a button but keeps it reachable via "more"', () => {
    const result = suggestHandoffAgents(
      [agent('a'), agent('b')],
      caps({ a: 'saturated', b: 'saturated' })
    );
    expect(result.buttons).toEqual([]);
    expect(result.moreCount).toBe(2);
  });

  it('has no "more" when everything fits', () => {
    const result = suggestHandoffAgents([agent('a'), agent('b')], caps({ a: 'ok' }));
    expect(result.buttons.map((b) => b.id)).toEqual(['a', 'b']);
    expect(result.moreCount).toBe(0);
  });

  it('returns an empty result without candidates', () => {
    expect(suggestHandoffAgents([], {})).toEqual({ buttons: [], moreCount: 0 });
  });

  it('respects a custom button limit', () => {
    const result = suggestHandoffAgents(candidates, {}, 1);
    expect(result.buttons).toHaveLength(1);
    expect(result.moreCount).toBe(4);
  });
});

describe('agentUsageBadge / formatResetIn', () => {
  it('labels saturated and tight agents, with the reset time when known', () => {
    const resetsAt = new Date(NOW + 2 * HOUR + 15 * 60_000).toISOString();
    expect(agentUsageBadge({ status: 'saturated', resetsAt }, NOW)).toMatchObject({
      label: 'limit doldu',
      tone: 'danger',
      title: 'Kullanım limiti doldu; 2 sa 15 dk sonra yenilenir.',
    });
    expect(agentUsageBadge({ status: 'tight' }, NOW)).toMatchObject({
      label: 'az kaldı',
      tone: 'warning',
    });
  });

  it('shows no badge for ok, unknown or missing data', () => {
    expect(agentUsageBadge({ status: 'ok' }, NOW)).toBeNull();
    expect(agentUsageBadge({ status: 'unknown' }, NOW)).toBeNull();
    expect(agentUsageBadge(undefined, NOW)).toBeNull();
  });

  it('formats reset durations and ignores past or invalid times', () => {
    expect(formatResetIn(new Date(NOW + 45 * 60_000).toISOString(), NOW)).toBe('45 dk');
    expect(formatResetIn(new Date(NOW + 3 * 24 * HOUR).toISOString(), NOW)).toBe('3 gün');
    expect(formatResetIn(new Date(NOW - 1000).toISOString(), NOW)).toBeNull();
    expect(formatResetIn('nope', NOW)).toBeNull();
    expect(formatResetIn(undefined, NOW)).toBeNull();
  });
});

describe('limit error detection', () => {
  it('recognises the translated and raw usage-limit messages', () => {
    expect(isUsageLimitMessage('Bu modelin kullanım limiti doldu. Limit yenilendiğinde ...')).toBe(
      true
    );
    expect(isUsageLimitMessage('429 Too Many Requests')).toBe(true);
    expect(isUsageLimitMessage('RESOURCE_EXHAUSTED: quota exceeded')).toBe(true);
    expect(isUsageLimitMessage('Ajan bağlantısı kesildi.')).toBe(false);
    expect(isUsageLimitMessage(undefined)).toBe(false);
  });

  it('returns the turn id only for limit-caused error outcomes', () => {
    const limit = { kind: 'error', message: 'Bu modelin kullanım limiti doldu.' };
    expect(limitErrorTurnId({ id: 't1', outcome: limit })).toBe('t1');
    expect(
      limitErrorTurnId({ id: 't2', outcome: { kind: 'error', message: 'timeout' } })
    ).toBeNull();
    expect(limitErrorTurnId({ id: 't3', outcome: { kind: 'done' } })).toBeNull();
    expect(limitErrorTurnId({ id: 't4' })).toBeNull();
    expect(limitErrorTurnId(undefined)).toBeNull();
  });
});

describe('decideLimitBanner', () => {
  const resetsAt = new Date(NOW + 3 * HOUR).toISOString();
  const saturated = { status: 'saturated' as const, resetsAt };
  const base = {
    providerId: 'kimi',
    capacity: undefined,
    limitErrorTurnId: null,
    dismissals: [],
    now: NOW,
  };

  it('stays hidden without any limit signal', () => {
    expect(decideLimitBanner(base)).toEqual({ show: false });
    expect(decideLimitBanner({ ...base, capacity: { status: 'tight' } })).toEqual({ show: false });
    expect(decideLimitBanner({ ...base, capacity: { status: 'ok' } })).toEqual({ show: false });
  });

  it('shows when the agent capacity is saturated, with the reset time', () => {
    const decision = decideLimitBanner({ ...base, capacity: saturated });
    expect(decision).toMatchObject({ show: true, reason: 'saturated', resetsAt });
  });

  it('shows when the last turn ended with a limit error even without usage data', () => {
    const decision = decideLimitBanner({ ...base, limitErrorTurnId: 't9' });
    expect(decision).toMatchObject({ show: true, reason: 'turn-error' });
  });

  it('is hidden once dismissed for the same limit window', () => {
    const shown = decideLimitBanner({ ...base, capacity: saturated, limitErrorTurnId: 't9' });
    if (!shown.show) throw new Error('expected the banner');
    const dismissals = dismissalsFor(shown.signals, NOW);
    expect(
      decideLimitBanner({
        ...base,
        capacity: saturated,
        limitErrorTurnId: 't9',
        dismissals,
        now: NOW + HOUR,
      })
    ).toEqual({ show: false });
  });

  it('reappears for a new limit window (new reset time) after dismissal', () => {
    const first = decideLimitBanner({ ...base, capacity: saturated });
    if (!first.show) throw new Error('expected the banner');
    const dismissals = dismissalsFor(first.signals, NOW);
    const later = NOW + 6 * HOUR;
    const nextReset = new Date(later + 3 * HOUR).toISOString();
    const decision = decideLimitBanner({
      ...base,
      capacity: { status: 'saturated', resetsAt: nextReset },
      dismissals,
      now: later,
    });
    expect(decision.show).toBe(true);
  });

  it('does not treat a small reset-time jitter as a new window', () => {
    const first = decideLimitBanner({ ...base, capacity: saturated });
    if (!first.show) throw new Error('expected the banner');
    const dismissals = dismissalsFor(first.signals, NOW);
    const jittered = new Date(Date.parse(resetsAt) + 20_000).toISOString();
    expect(
      decideLimitBanner({
        ...base,
        capacity: { status: 'saturated', resetsAt: jittered },
        dismissals,
      })
    ).toEqual({ show: false });
  });

  it('disappears when the window renewed (capacity no longer saturated)', () => {
    expect(decideLimitBanner({ ...base, capacity: { status: 'ok' } })).toEqual({ show: false });
  });

  it('ignores expired dismissals', () => {
    const signals = currentLimitSignals({ ...base, limitErrorTurnId: 't9' });
    const dismissals = dismissalsFor(signals, NOW);
    expect(dismissals[0]?.expiresAt).toBe(NOW + DEFAULT_LIMIT_WINDOW_MS);
    expect(
      decideLimitBanner({
        ...base,
        limitErrorTurnId: 't9',
        dismissals,
        now: NOW + DEFAULT_LIMIT_WINDOW_MS + 1,
      }).show
    ).toBe(true);
  });

  it('shows again for a new failing turn', () => {
    const first = decideLimitBanner({ ...base, limitErrorTurnId: 't9' });
    if (!first.show) throw new Error('expected the banner');
    const dismissals = dismissalsFor(first.signals, NOW);
    expect(decideLimitBanner({ ...base, limitErrorTurnId: 't10', dismissals }).show).toBe(true);
  });

  it('returns once for a new limit-error turn even after the saturated banner was dismissed', () => {
    const first = decideLimitBanner({ ...base, capacity: saturated });
    if (!first.show) throw new Error('expected the banner');
    const dismissals = dismissalsFor(first.signals, NOW);
    // The error turn is a new signal, so the banner returns once; that is intended.
    expect(
      decideLimitBanner({ ...base, capacity: saturated, limitErrorTurnId: 't1', dismissals }).show
    ).toBe(true);
  });
});
