import { describe, expect, it } from 'vitest';
import { ContextHandoffDismissalStore } from './context-handoff-dismissal-store';

function memoryStorage() {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe('ContextHandoffDismissalStore', () => {
  it('keeps dismissals per conversation and survives a reload', () => {
    const storage = memoryStorage();
    const store = new ContextHandoffDismissalStore(storage);
    store.add('a', 'warn');
    store.add('a', 'warn');
    store.add('b', 'moved');
    expect(store.get('a')).toEqual(['warn']);
    expect(new ContextHandoffDismissalStore(storage).get('b')).toEqual(['moved']);
  });

  it('notifies only on real changes and drops empty lists', () => {
    const store = new ContextHandoffDismissalStore(null);
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.add('a', 'critical');
    store.set('a', ['critical']);
    expect(calls).toBe(1);
    store.set('a', []);
    expect(store.get('a')).toEqual([]);
    expect(calls).toBe(2);
  });
});
