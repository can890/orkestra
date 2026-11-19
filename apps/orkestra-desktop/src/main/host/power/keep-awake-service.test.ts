import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettingsKey } from '@core/services/settings/api';
import { startKeepAwakeService } from './keep-awake-service';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@core/features/conversations/api/node/registry', () => ({
  conversationRegistryTable: {},
  liveConversations: () => undefined,
}));

function setup(initial: { enabled: boolean; working: number }) {
  let enabled = initial.enabled;
  let working = initial.working;
  const settingListeners = new Set<(key: AppSettingsKey) => void>();
  const statusListeners = new Set<() => void>();
  const active = new Set<number>();
  let nextId = 1;
  const deps = {
    settings: {
      get: vi.fn(async () => ({ keepAwakeWhileWorking: enabled })),
      on: (_: 'app-settings:changed', l: (key: AppSettingsKey) => void) =>
        void settingListeners.add(l),
      off: (_: 'app-settings:changed', l: (key: AppSettingsKey) => void) =>
        void settingListeners.delete(l),
    },
    agentStatus: {
      on: (_name: 'status:changed', handler: () => void) => {
        statusListeners.add(handler);
        return () => void statusListeners.delete(handler);
      },
    },
    countWorking: vi.fn(async () => working),
    blocker: {
      start: () => {
        const id = nextId++;
        active.add(id);
        return id;
      },
      stop: (id: number) => void active.delete(id),
    },
  };
  return {
    deps,
    active,
    settingListeners,
    statusListeners,
    setWorking: (n: number) => {
      working = n;
      for (const l of statusListeners) l();
    },
    setEnabled: (value: boolean) => {
      enabled = value;
      for (const l of settingListeners) l('power');
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('startKeepAwakeService', () => {
  afterEach(() => vi.useRealTimers());

  it('stays off by default even with working conversations', async () => {
    const t = setup({ enabled: false, working: 2 });
    const stop = startKeepAwakeService(t.deps);
    await flush();
    expect(t.active.size).toBe(0);
    stop();
  });

  it('follows the working count and the setting', async () => {
    const t = setup({ enabled: true, working: 0 });
    const stop = startKeepAwakeService(t.deps);
    await flush();
    expect(t.active.size).toBe(0);

    t.setWorking(1);
    await flush();
    expect(t.active.size).toBe(1);
    t.setWorking(2);
    await flush();
    expect(t.active.size).toBe(1);

    t.setEnabled(false);
    await flush();
    expect(t.active.size).toBe(0);
    t.setEnabled(true);
    await flush();
    expect(t.active.size).toBe(1);

    t.setWorking(0);
    await flush();
    expect(t.active.size).toBe(0);
    stop();
  });

  it('ignores unrelated settings keys', async () => {
    const t = setup({ enabled: true, working: 1 });
    const stop = startKeepAwakeService(t.deps);
    await flush();
    const reads = t.deps.settings.get.mock.calls.length;
    for (const l of t.settingListeners) l('theme');
    await flush();
    expect(t.deps.settings.get.mock.calls.length).toBe(reads);
    stop();
  });

  it('releases the blocker and all listeners on dispose', async () => {
    const t = setup({ enabled: true, working: 1 });
    const stop = startKeepAwakeService(t.deps);
    await flush();
    expect(t.active.size).toBe(1);
    stop();
    expect(t.active.size).toBe(0);
    expect(t.settingListeners.size).toBe(0);
    expect(t.statusListeners.size).toBe(0);
    stop();
    expect(t.active.size).toBe(0);
  });

  it('does not take the blocker when a count resolves after dispose', async () => {
    const t = setup({ enabled: true, working: 1 });
    const stop = startKeepAwakeService(t.deps);
    stop();
    await flush();
    expect(t.active.size).toBe(0);
  });

  it('re-counts periodically while held so deleted conversations cannot leak the blocker', async () => {
    vi.useFakeTimers();
    const t = setup({ enabled: true, working: 1 });
    const stop = startKeepAwakeService(t.deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.active.size).toBe(1);
    t.deps.countWorking.mockResolvedValue(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.active.size).toBe(0);
    stop();
  });
});
