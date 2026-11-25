import { describe, expect, it, vi } from 'vitest';
import type { SidebarSectionId } from '@core/features/workbench/browser/sidebar/sidebar-store';
import {
  LEGACY_SIDEBAR_SECTION_OPEN_KEYS,
  migrateLegacySidebarSectionOpen,
  readLegacySidebarSectionOpen,
} from './legacy-sidebar-section-open';

function memoryStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

function target(stored: Partial<Record<SidebarSectionId, boolean>> = {}) {
  const state = { ...stored };
  return {
    state,
    adoptLegacySectionOpen: vi.fn((legacy: Partial<Record<SidebarSectionId, boolean>>) => {
      const adopted: SidebarSectionId[] = [];
      for (const [section, value] of Object.entries(legacy) as [SidebarSectionId, boolean][]) {
        if (state[section] !== undefined) continue;
        state[section] = value;
        adopted.push(section);
      }
      return adopted;
    }),
  };
}

describe('readLegacySidebarSectionOpen', () => {
  it('reads only exact true/false values', () => {
    const storage = memoryStorage({
      [LEGACY_SIDEBAR_SECTION_OPEN_KEYS.freeChats]: 'false',
      [LEGACY_SIDEBAR_SECTION_OPEN_KEYS.externalSessions]: 'garbage',
      [LEGACY_SIDEBAR_SECTION_OPEN_KEYS.settled]: 'true',
    });
    expect(readLegacySidebarSectionOpen(storage)).toEqual({ freeChats: false, settled: true });
  });

  it('treats a throwing storage as empty', () => {
    const storage = {
      getItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {},
    };
    expect(readLegacySidebarSectionOpen(storage)).toEqual({});
  });
});

describe('migrateLegacySidebarSectionOpen', () => {
  it('adopts the legacy state, flushes the memento, then removes the legacy keys', async () => {
    const storage = memoryStorage({
      [LEGACY_SIDEBAR_SECTION_OPEN_KEYS.freeChats]: 'false',
      [LEGACY_SIDEBAR_SECTION_OPEN_KEYS.settled]: 'true',
      unrelated: 'keep',
    });
    const sidebar = target();
    const order: string[] = [];
    const flush = vi.fn(async () => {
      order.push(`flush:${storage.values.size}`);
    });

    const adopted = await migrateLegacySidebarSectionOpen(sidebar, storage, flush);

    expect(adopted).toEqual(['freeChats', 'settled']);
    expect(sidebar.state).toEqual({ freeChats: false, settled: true });
    // The keys are still present while the memento flushes.
    expect(order).toEqual(['flush:3']);
    expect([...storage.values.keys()]).toEqual(['unrelated']);
  });

  it('runs once: a second boot finds no legacy keys and touches nothing', async () => {
    const storage = memoryStorage({ [LEGACY_SIDEBAR_SECTION_OPEN_KEYS.settled]: 'true' });
    const sidebar = target();
    await migrateLegacySidebarSectionOpen(sidebar, storage, async () => {});
    sidebar.adoptLegacySectionOpen.mockClear();

    const flush = vi.fn(async () => {});
    expect(await migrateLegacySidebarSectionOpen(sidebar, storage, flush)).toEqual([]);
    expect(sidebar.adoptLegacySectionOpen).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it('never overrides a value already stored in the memento', async () => {
    const storage = memoryStorage({ [LEGACY_SIDEBAR_SECTION_OPEN_KEYS.settled]: 'true' });
    const sidebar = target({ settled: false });
    const flush = vi.fn(async () => {});

    expect(await migrateLegacySidebarSectionOpen(sidebar, storage, flush)).toEqual([]);
    expect(sidebar.state).toEqual({ settled: false });
    expect(flush).not.toHaveBeenCalled();
    expect(storage.values.size).toBe(0);
  });
});
