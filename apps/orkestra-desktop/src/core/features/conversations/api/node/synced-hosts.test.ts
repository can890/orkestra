import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isConversationHostSynced,
  markConversationHostSynced,
  resetConversationHostSyncForTests,
  whenConversationHostSynced,
} from './synced-hosts';

const local = { location: 'local' as const, sshConnectionId: null };
const huawei = { location: 'remote' as const, sshConnectionId: 'ssh-huawei' };

describe('synced conversation hosts', () => {
  afterEach(() => {
    resetConversationHostSyncForTests();
    vi.useRealTimers();
  });

  it('tracks hosts independently', () => {
    markConversationHostSynced(local);
    expect(isConversationHostSynced(local)).toBe(true);
    expect(isConversationHostSynced(huawei)).toBe(false);
  });

  it('resolves waiters when the host syncs and times out otherwise', async () => {
    vi.useFakeTimers();
    const synced = whenConversationHostSynced(local, 1_000);
    const timedOut = whenConversationHostSynced(huawei, 1_000);
    markConversationHostSynced(local);
    await expect(synced).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(timedOut).resolves.toBe(false);
    await expect(whenConversationHostSynced(local, 1)).resolves.toBe(true);
  });
});
