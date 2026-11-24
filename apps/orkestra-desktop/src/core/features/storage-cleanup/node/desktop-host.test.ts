import { parseNativeAbsolute } from '@orkestra/core/primitives/path/api';
import { describe, expect, it } from 'vitest';
import { countSessionsUnder } from './desktop-host';

function absolute(target: string) {
  const parsed = parseNativeAbsolute(target);
  if (!parsed.success) throw new Error(target);
  return parsed.data;
}

function client<T>(data: Record<string, T>) {
  return { sessions: { state: () => ({ snapshot: async () => ({ data }) }) } };
}

describe('countSessionsUnder', () => {
  it('counts live ACP, TUI and terminal sessions inside the worktree only', async () => {
    const clients = {
      acp: client({
        a: { cwd: '/w/task', suspended: false },
        b: { cwd: '/w/task/sub', suspended: true },
        c: { cwd: '/w/other', suspended: false },
      }),
      tuiAgents: client({ t: { cwd: '/w/task/pkg' }, u: { cwd: null } }),
      terminals: client({
        x: { key: { workspace: { path: absolute('/w/task') } } },
        y: { key: { workspace: { path: absolute('/w/task-2') } } },
      }),
    } as unknown as Parameters<typeof countSessionsUnder>[0];
    expect(await countSessionsUnder(clients, '/w/task')).toBe(3);
    expect(await countSessionsUnder(clients, '/w/none')).toBe(0);
    await expect(countSessionsUnder(clients, 'relative/path')).rejects.toThrow();
  });
});
