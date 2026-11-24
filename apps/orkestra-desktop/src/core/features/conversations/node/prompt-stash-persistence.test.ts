// İstem zulasının gerçek memento hattı üzerinden (MementoClient → wire → MementoService →
// geçici SQLite) kalıcılığını uçtan uca doğrular: zulaya al, istemciyi kapat, yeni bir
// istemciyle (uygulama yeniden başlatılmış gibi) aç ve girdilerin durduğunu gör.

import { createTestWire } from '@orkestra/wire/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { PromptStashStore } from '@core/features/conversations/browser/prompt-stash/prompt-stash-store';
import {
  PROMPT_STASH_MAX_ENTRIES,
  promptStashMemento,
  type PromptStashEntry,
} from '@core/features/conversations/contributions/mementos';
import { mementosWireContract } from '@core/primitives/mementos/api';
import { MementoClient } from '@core/primitives/mementos/browser/memento-client';
import { appSubject } from '@core/primitives/subjects/api';
import { MementoService } from '@core/services/mementos/node/memento-service';
import {
  MementoPersistenceService,
  mementosSqliteStore,
} from '@core/services/mementos/node/persistence';
import { createMementosWireController } from '@core/services/mementos/node/wire-controller';

function entry(id: string, overrides: Partial<PromptStashEntry> = {}): PromptStashEntry {
  return {
    id,
    createdAt: new Date(2026, 10, 24, 10, 0, Number(id.replace(/\D/g, '') || 0)).toISOString(),
    text: `prompt ${id} with @[a.ts](/repo/a.ts)`,
    conversationId: 'conv-1',
    attachments: [{ id: `att-${id}`, mimeType: 'image/png', name: 'shot.png' }],
    ...overrides,
  };
}

describe('prompt stash persistence (memento round trip)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
  });

  async function openPersistence() {
    const handle = await mementosSqliteStore.openTemp();
    const persistence = new MementoPersistenceService(handle);
    const service = new MementoService({ persistence });
    cleanups.push(async () => await service.dispose());
    return { persistence, service };
  }

  async function openStore(service: MementoService) {
    const wire = createTestWire(mementosWireContract, createMementosWireController(service));
    const client = new MementoClient(wire.client, {
      debounceMs: 0,
      registerBeforeUnload: false,
      catalog: [promptStashMemento],
    });
    const space = client.subject(appSubject({}));
    const handle = space.handle(promptStashMemento);
    await space.ready;
    const store = new PromptStashStore(handle);
    const close = async () => {
      await handle.flush();
      await client.dispose();
      await wire.dispose();
    };
    return { store, handle, close };
  }

  it('survives a restart, restores (takes) and deletes entries', async () => {
    const { service } = await openPersistence();

    const first = await openStore(service);
    expect(first.store.entries).toEqual([]);
    first.store.stash(entry('e1'));
    first.store.stash(entry('e2', { conversationId: 'conv-2', attachments: [] }));
    first.store.stash(entry('e3'));
    await first.close();

    const second = await openStore(service);
    expect(second.store.entries.map((e) => e.id)).toEqual(['e3', 'e2', 'e1']);
    expect(second.store.entries[2]).toEqual(entry('e1'));

    const restored = second.store.take('e2');
    expect(restored?.conversationId).toBe('conv-2');
    expect(second.store.remove('e1')?.id).toBe('e1');
    expect(second.store.take('missing')).toBeNull();
    await second.close();

    const third = await openStore(service);
    expect(third.store.entries.map((e) => e.id)).toEqual(['e3']);
    await third.close();
  });

  it('caps the stash and reports the evicted oldest entry', async () => {
    const { service } = await openPersistence();
    const opened = await openStore(service);
    for (let i = 0; i < PROMPT_STASH_MAX_ENTRIES; i++) {
      expect(opened.store.stash(entry(`e${i}`)).evicted).toEqual([]);
    }
    const { evicted } = opened.store.stash(entry('overflow'));
    expect(evicted.map((e) => e.id)).toEqual(['e0']);
    expect(opened.store.entries).toHaveLength(PROMPT_STASH_MAX_ENTRIES);
    await opened.close();

    const reopened = await openStore(service);
    expect(reopened.store.entries).toHaveLength(PROMPT_STASH_MAX_ENTRIES);
    expect(reopened.store.entries[0]?.id).toBe('overflow');
    await reopened.close();
  });
});
