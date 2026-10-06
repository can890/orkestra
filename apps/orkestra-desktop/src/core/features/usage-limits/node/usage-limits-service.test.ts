import { LOCAL_HOST_REF, hostRef } from '@orkestra/core/primitives/host/api';
import type { AccountUsage } from '@orkestra/core/runtimes/agent-config/api';
import { describe, expect, it, vi } from 'vitest';
import { toProviderUsage, UsageLimitsService } from './usage-limits-service';

const MEASURED = '2026-10-06T00:00:00.000Z';

function usage(providerId: string, remaining: number[], overrides: Partial<AccountUsage> = {}) {
  return {
    providerId,
    status: 'available',
    checkedAt: MEASURED,
    source: 'test',
    windows: remaining.map((remainingPercent, index) => ({
      label: `w${index}`,
      remainingPercent,
      resetsAt: '2026-10-09T00:00:00.000Z',
    })),
    balances: [],
    ...overrides,
  } satisfies AccountUsage;
}

function setup(fetchImpl?: (host: unknown, providerId: string) => Promise<AccountUsage>) {
  let now = 1_000_000;
  const fetch = vi.fn(fetchImpl ?? (async (_host: unknown, id: string) => usage(id, [40])));
  const service = new UsageLimitsService({
    fetch,
    now: () => now,
    ttlMs: 180_000,
    errorTtlMs: 60_000,
  });
  return { service, fetch, advance: (ms: number) => (now += ms) };
}

describe('UsageLimitsService', () => {
  it('converts remaining percentages into used percentages and keeps the measurement time', () => {
    const converted = toProviderUsage(usage('codex', [18], { plan: 'pro' }), 42);
    expect(converted).toMatchObject({
      providerId: 'codex',
      plan: 'pro',
      measuredAt: MEASURED,
      fetchedAt: 42,
      windows: [{ label: 'w0', usedPercent: 82 }],
    });
  });

  it('serves fresh values from the cache and refetches after the TTL', async () => {
    const { service, fetch, advance } = setup();
    await service.get(LOCAL_HOST_REF, ['claude']);
    await service.get(LOCAL_HOST_REF, ['claude']);
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(181_000);
    await service.get(LOCAL_HOST_REF, ['claude']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache on force and caches per host', async () => {
    const { service, fetch } = setup();
    await service.get(LOCAL_HOST_REF, ['claude']);
    await service.get(LOCAL_HOST_REF, ['claude'], { force: true });
    await service.get(hostRef('remote', 'ssh-1'), ['claude']);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('coalesces concurrent requests into one fetch', async () => {
    let release: (value: AccountUsage) => void = () => {};
    const { service, fetch } = setup(
      () =>
        new Promise<AccountUsage>((resolve) => {
          release = resolve;
        })
    );
    const first = service.get(LOCAL_HOST_REF, ['codex', 'codex']);
    const second = service.get(LOCAL_HOST_REF, ['codex'], { force: true });
    release(usage('codex', [10]));
    const [a, b] = await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a).toHaveLength(1);
    expect(b[0]?.windows[0]?.usedPercent).toBe(90);
  });

  it('keeps the last good windows when a refresh fails, and retries sooner', async () => {
    let fail = false;
    const { service, fetch, advance } = setup(async (_host, id) => {
      if (fail) throw new Error('offline');
      return usage(id, [5]);
    });
    await service.get(LOCAL_HOST_REF, ['claude']);
    fail = true;
    advance(181_000);
    const [kept] = await service.get(LOCAL_HOST_REF, ['claude']);
    expect(kept?.windows[0]?.usedPercent).toBe(95);
    expect(kept?.refreshError).toContain('ulaşılamadı');
    advance(61_000);
    await service.get(LOCAL_HOST_REF, ['claude']);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reports a provider error without windows when nothing was ever read', async () => {
    const { service } = setup(async () => {
      throw new Error('offline');
    });
    const [value] = await service.get(LOCAL_HOST_REF, ['kimi']);
    expect(value).toMatchObject({ providerId: 'kimi', status: 'error', windows: [] });
  });

  it('peek returns cached values when a fetch is slower than the wait budget', async () => {
    let release: (value: AccountUsage) => void = () => {};
    const { service } = setup(
      () =>
        new Promise<AccountUsage>((resolve) => {
          release = resolve;
        })
    );
    expect(await service.peek(LOCAL_HOST_REF, ['codex'], 5)).toEqual({ codex: null });
    release(usage('codex', [30]));
    await vi.waitFor(() => expect(service.cached(LOCAL_HOST_REF, 'codex')).not.toBeNull());
    const fast = await service.peek(LOCAL_HOST_REF, ['codex'], 5);
    expect(fast.codex?.windows[0]?.usedPercent).toBe(70);
  });
});
