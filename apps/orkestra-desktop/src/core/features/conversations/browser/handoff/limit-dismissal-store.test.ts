import { describe, expect, it } from 'vitest';
import { LimitDismissalStore } from './limit-dismissal-store';

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    read: () => value,
  };
}

describe('LimitDismissalStore', () => {
  it('stores dismissals per conversation and persists them', () => {
    const storage = memoryStorage();
    const store = new LimitDismissalStore(storage);
    store.add('c1', [{ key: 'saturated:kimi:1', expiresAt: 5000 }], 1000);
    expect(store.get('c1')).toEqual([{ key: 'saturated:kimi:1', expiresAt: 5000 }]);
    expect(store.get('c2')).toEqual([]);
    const reloaded = new LimitDismissalStore(storage);
    expect(reloaded.get('c1')).toHaveLength(1);
  });

  it('replaces a dismissal with the same key and drops expired ones', () => {
    const store = new LimitDismissalStore(null);
    store.add('c1', [{ key: 'a', expiresAt: 2000 }], 1000);
    store.add('c1', [{ key: 'b', expiresAt: 9000 }], 3000);
    expect(store.get('c1')).toEqual([{ key: 'b', expiresAt: 9000 }]);
    store.add('c1', [{ key: 'b', expiresAt: 12000 }], 4000);
    expect(store.get('c1')).toEqual([{ key: 'b', expiresAt: 12000 }]);
  });

  it('notifies subscribers and survives corrupt storage', () => {
    const store = new LimitDismissalStore(memoryStorage('{not json'));
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    store.add('c1', [{ key: 'a', expiresAt: 9000 }], 0);
    off();
    store.add('c2', [{ key: 'a', expiresAt: 9000 }], 0);
    expect(calls).toBe(1);
  });

  it('keeps a stable reference for unknown conversations', () => {
    const store = new LimitDismissalStore(null);
    expect(store.get('x')).toBe(store.get('y'));
  });
});
