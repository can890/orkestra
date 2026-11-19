import { describe, expect, it, vi } from 'vitest';
import { DeepLinkCoordinator } from './deep-link-coordinator';

const found = async (route: { kind: 'task' | 'project' | 'conversation'; id: string }) =>
  ({ kind: 'task', projectId: 'p', taskId: route.id }) as const;

describe('DeepLinkCoordinator', () => {
  it('queues cold-start links until the sink attaches, then notifies once', () => {
    const c = new DeepLinkCoordinator('orkestra');
    expect(c.handleArgv(['/app/Orkestra', 'orkestra://task/abc'])).toBe(true);
    expect(c.pendingCount).toBe(1);
    const sink = { notifyPending: vi.fn(), focusWindow: vi.fn() };
    c.attach(sink);
    expect(sink.notifyPending).toHaveBeenCalledTimes(1);
    expect(c.pendingCount).toBe(1);
  });

  it('notifies and focuses immediately for links that arrive while running', () => {
    const c = new DeepLinkCoordinator('orkestra');
    const sink = { notifyPending: vi.fn(), focusWindow: vi.fn() };
    c.attach(sink);
    expect(sink.notifyPending).not.toHaveBeenCalled();
    expect(c.handleUrl('orkestra://project/abc')).toBe(true);
    expect(sink.notifyPending).toHaveBeenCalledTimes(1);
    expect(sink.focusWindow).toHaveBeenCalledTimes(1);
  });

  it('silently ignores anything unrecognized', () => {
    const c = new DeepLinkCoordinator('orkestra');
    const sink = { notifyPending: vi.fn(), focusWindow: vi.fn() };
    c.attach(sink);
    for (const raw of ['orkestra://task/../x', 'orkestra://task/id?cmd=1', 'x', 5, undefined]) {
      expect(c.handleUrl(raw)).toBe(false);
    }
    expect(c.handleArgv(['--flag', 'orkestra://task/a', 'orkestra://task/b'])).toBe(false);
    expect(c.handleArgv(['--open=orkestra://task/a'])).toBe(false);
    expect(c.pendingCount).toBe(0);
    expect(sink.notifyPending).not.toHaveBeenCalled();
    expect(sink.focusWindow).not.toHaveBeenCalled();
  });

  it('drains the queue exactly once and resolves each link', async () => {
    const c = new DeepLinkCoordinator('orkestra');
    c.handleUrl('orkestra://task/a');
    c.handleUrl('orkestra://task/b');
    const first = await c.takePending(found);
    expect(first.map((t) => (t.kind === 'task' ? t.taskId : ''))).toEqual(['a', 'b']);
    expect(await c.takePending(found)).toEqual([]);
  });

  it('turns resolver failures into not-found', async () => {
    const c = new DeepLinkCoordinator('orkestra');
    c.handleUrl('orkestra://conversation/zzz');
    const out = await c.takePending(async () => {
      throw new Error('db down');
    });
    expect(out).toEqual([{ kind: 'not-found', route: { kind: 'conversation', id: 'zzz' } }]);
  });

  it('keeps only the most recent links when flooded', () => {
    const c = new DeepLinkCoordinator('orkestra');
    for (let i = 0; i < 50; i++) c.handleUrl(`orkestra://task/t${i}`);
    expect(c.pendingCount).toBe(5);
  });

  it('does not accept the other installation scheme', () => {
    const c = new DeepLinkCoordinator('orkestra');
    expect(c.handleUrl('orkestra-canary://task/a')).toBe(false);
  });
});
