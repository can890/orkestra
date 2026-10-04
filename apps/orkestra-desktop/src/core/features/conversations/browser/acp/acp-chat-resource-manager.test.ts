import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpChatResourceManager } from './acp-chat-resource-manager';
const state = vi.hoisted(() => ({ type: 'acp' as 'pty' | 'acp' }));
vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectHostAccess: () => undefined,
}));
vi.mock('@core/features/conversations/api/browser/stores/conversation-registry', () => ({
  conversationRegistry: {
    get: () => ({ conversations: new Map([['c1', { data: { type: state.type } }]]) }),
  },
}));
vi.mock('./acp-chat-store', () => ({
  AcpChatStore: class {
    dispose = vi.fn();
  },
}));
afterEach(() => {
  state.type = 'acp';
  vi.useRealTimers();
});
describe('ACP view handoff resource lifetime', () => {
  it('creates a new store for immediate return from terminal, while preserving normal tab grace', () => {
    vi.useFakeTimers();
    const manager = new AcpChatResourceManager('p1', 't1');
    const original = manager.acquire('c1');
    manager.release('c1');
    expect(manager.acquire('c1')).toBe(original);
    state.type = 'pty';
    manager.release('c1');
    expect(original.dispose).toHaveBeenCalledOnce();
    state.type = 'acp';
    const replay = manager.acquire('c1');
    expect(replay).not.toBe(original);
    vi.advanceTimersByTime(5_000);
    expect(manager.get('c1')).toBe(replay);
    expect(replay.dispose).not.toHaveBeenCalled();
    manager.dispose();
  });
});
