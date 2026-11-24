import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAccountUsage, readAccountUsage } from './account-usage';

afterEach(() => {
  vi.unstubAllGlobals();
});

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
  it('orders core Codex limit before model buckets and preserves both 5-hour and weekly windows', () => {
    const result = parseAccountUsage('codex', {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1791421540 },
        secondary: { usedPercent: 11, windowDurationMins: 10080, resetsAt: 1791582238 },
        planType: 'plus',
      },
      rateLimitsByLimitId: {
        codex_bengalfox: {
          limitId: 'codex_bengalfox',
          primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1791421540 },
        },
        codex: {
          limitId: 'codex',
          primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1791421540 },
          planType: 'plus',
        },
      },
    });
    expect(result.plan).toBe('plus');
    expect(result.windows.map((w) => [w.label, w.remainingPercent])).toEqual([
      ['codex · 5 saatlik', 96],
      ['codex · Haftalık', 89],
      ['codex_bengalfox · 5 saatlik', 98],
    ]);
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

  it('persists rotated Kimi OAuth tokens back to disk after refresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orkestra-kimi-refresh-'));
    try {
      const credDir = join(root, '.kimi-code', 'credentials');
      const credPath = join(credDir, 'kimi-code.json');
      await mkdir(credDir, { recursive: true });
      await writeFile(
        credPath,
        JSON.stringify({
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          expires_at: 1,
          expires_in: 900,
          scope: 'kimi-code',
          token_type: 'Bearer',
        })
      );

      const fetchMock = vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/api/oauth/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_in: 900,
              token_type: 'Bearer',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            usage: { limit: '100', used: '20', resetTime: '2026-11-21T00:00:00Z' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await readAccountUsage('kimi', undefined, {}, root);
      expect(result.status).toBe('available');
      const saved = JSON.parse(await readFile(credPath, 'utf8')) as Record<string, unknown>;
      expect(saved.access_token).toBe('new-access');
      expect(saved.refresh_token).toBe('new-refresh');
      expect(typeof saved.expires_at).toBe('number');
      expect(saved.expires_at as number).toBeGreaterThan(Math.floor(Date.now() / 1000));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists rotated Grok OAuth tokens back to disk after refresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orkestra-grok-refresh-'));
    try {
      const grokDir = join(root, '.grok');
      const authPath = join(grokDir, 'auth.json');
      await mkdir(grokDir, { recursive: true });
      const entryKey = 'https://auth.x.ai::user-1';
      await writeFile(
        authPath,
        JSON.stringify({
          [entryKey]: {
            key: 'old-grok-access',
            refresh_token: 'old-grok-refresh',
            expires_at: '2020-01-01T00:00:00Z',
            oidc_issuer: 'https://auth.x.ai',
            oidc_client_id: 'grok-cli',
            email: 'test@example.com',
          },
        })
      );

      const fetchMock = vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/oauth2/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'new-grok-access',
              refresh_token: 'new-grok-refresh',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            config: { creditUsagePercent: 15, prepaidBalance: { val: 500 } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await readAccountUsage('grok', undefined, {}, root);
      expect(result.status).toBe('available');
      const saved = JSON.parse(await readFile(authPath, 'utf8')) as Record<
        string,
        Record<string, unknown>
      >;
      expect(saved[entryKey]?.key).toBe('new-grok-access');
      expect(saved[entryKey]?.refresh_token).toBe('new-grok-refresh');
      expect(typeof saved[entryKey]?.expires_at).toBe('string');
      expect(Date.parse(saved[entryKey]?.expires_at as string)).toBeGreaterThan(Date.now());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
