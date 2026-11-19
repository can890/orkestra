import { describe, expect, it, vi } from 'vitest';
import { HandoffStore, type HandoffRecord } from './handoff-store';

function memoryStorage(initial?: string) {
  let value: string | null = initial ?? null;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
    read: () => value,
  };
}

const record = (over: Partial<HandoffRecord> = {}): HandoffRecord => ({
  version: 1,
  mode: 'fork',
  sourceConversationId: 'src',
  sourceTitle: 'Kaynak',
  context: 'özet',
  createdAt: 1,
  ...over,
});

describe('HandoffStore', () => {
  it('kaydı saklar ve yeni örnekte geri yükler', () => {
    const storage = memoryStorage();
    new HandoffStore(storage).put('c1', record());
    expect(new HandoffStore(storage).get('c1')).toEqual(record());
  });

  it('bozuk ya da geçersiz depolama içeriğini yok sayar', () => {
    expect(new HandoffStore(memoryStorage('{bozuk')).get('x')).toBeUndefined();
    const invalid = JSON.stringify([
      ['c1', { version: 2 }],
      ['c2', record({ mode: 'fork' })],
    ]);
    const store = new HandoffStore(memoryStorage(invalid));
    expect(store.get('c1')).toBeUndefined();
    expect(store.get('c2')).toBeDefined();
  });

  it('depolama yokken bellek içi çalışır', () => {
    const store = new HandoffStore(null);
    store.put('c1', record());
    expect(store.get('c1')?.context).toBe('özet');
  });

  it('yazma hatası fırlatmaz', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('dolu');
      },
    };
    const store = new HandoffStore(storage);
    expect(() => store.put('c1', record())).not.toThrow();
    expect(store.get('c1')).toBeDefined();
  });

  it('en eski kayıtları 200 ile sınırlar', () => {
    const store = new HandoffStore(null);
    for (let i = 0; i < 205; i += 1) store.put(`c${i}`, record());
    expect(store.get('c0')).toBeUndefined();
    expect(store.get('c204')).toBeDefined();
  });

  it('abonelere değişiklik bildirir ve silmeyi yansıtır', () => {
    const store = new HandoffStore(null);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.put('c1', record());
    store.remove('c1');
    store.remove('c1');
    off();
    store.put('c2', record());
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get('c1')).toBeUndefined();
  });
});
