import { describe, expect, it } from 'vitest';
import { parseAccountUsage, readAccountUsage } from './account-usage';

describe('account usage measurements', () => {
  it.each(['codex', 'claude', 'grok', 'kimi', 'glm', 'antigravity'])(
    'does not invent an empty %s quota',
    (provider) => {
      expect(parseAccountUsage(provider, {})).toMatchObject({
        status: 'unavailable',
        windows: [],
        balances: [],
      });
    }
  );
  it('preserves explicit zero usage and fully consumed windows', () => {
    const usage = parseAccountUsage('claude', {
      five_hour: { utilization: 0 },
      seven_day: { utilization: 100 },
    });
    expect(usage.windows.map((w) => w.remainingPercent)).toEqual([100, 0]);
  });
  it('ignores malformed and absent numbers rather than coercing them to zero', () => {
    for (const value of [null, '', false, 'unknown', -1, 101, Infinity]) {
      expect(parseAccountUsage('grok', { config: { creditUsagePercent: value } }).windows).toEqual(
        []
      );
    }
  });
  it('keeps spend limits distinct from balances', () => {
    expect(
      parseAccountUsage('claude', {
        extra_usage: { monthly_limit: 4000, used_credits: 0, is_enabled: false },
      }).balances
    ).toEqual([]);
    expect(
      parseAccountUsage('grok', { config: { creditUsagePercent: 58, prepaidBalance: { val: 0 } } })
    ).toMatchObject({ windows: [{ remainingPercent: 42 }], balances: [{ value: 0, unit: 'USD' }] });
  });
  it('prefers Codex per-limit data without duplicating legacy quotas or converting credits to dollars', () => {
    const window = {
      primary: { usedPercent: 95, windowDurationMins: 10080, resetsAt: 1791421540 },
      credits: { balance: '62408.0268' },
    };
    const result = parseAccountUsage('codex', {
      rateLimits: window,
      rateLimitsByLimitId: { codex: window },
    });
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.remainingPercent).toBe(5);
    expect(result.balances[0]).toMatchObject({ value: 62408.0268, unit: 'kredi' });
  });
  it('accepts only Antigravity usage command results', () => {
    const data = {
      groups: [{ name: 'Gemini', buckets: [{ remaining_fraction: 0.8854, window: 'weekly' }] }],
    };
    expect(
      parseAccountUsage('antigravity', { status: 'SUCCESS', command: { name: 'usage', data } })
        .windows[0]?.remainingPercent
    ).toBeCloseTo(88.54);
    expect(
      parseAccountUsage('antigravity', { status: 'ERROR', command: { name: 'usage', data } })
        .windows
    ).toEqual([]);
  });
  it('reports missing credentials without paths or secrets', async () => {
    const result = await readAccountUsage('kimi', undefined, {}, '/tmp/no-such-orkestra-account');
    expect(result.status).toBe('auth-required');
    expect(JSON.stringify(result)).not.toContain('/tmp/');
  });
});
