import { describe, expect, it, vi } from 'vitest';
import type { SearchClient } from '@core/features/search/api/client';
import { matchPaletteText, type PaletteContext } from '@core/primitives/palette/api';
import type { SearchItem } from '@core/primitives/search/api';
import { createConversationPaletteSource } from './conversation-palette-source';

const CONTEXT: PaletteContext = {
  projectId: 'project-1',
  taskId: 'task-1',
  workspaceId: 'workspace-1',
};

function conversation(id: string, title: string, overrides: Partial<SearchItem> = {}): SearchItem {
  return {
    kind: 'conversation',
    id,
    projectId: 'project-1',
    taskId: 'task-1',
    title,
    subtitle: '',
    score: 0,
    ...overrides,
  };
}

function setup() {
  const searchPaletteEntities = vi.fn<SearchClient['searchPaletteEntities']>();
  const source = createConversationPaletteSource(async () => ({
    searchPaletteEntities,
  }));
  return { source, searchPaletteEntities };
}

describe('conversation palette source', () => {
  it('allows global conversation search and idle recents without task context', async () => {
    const { source, searchPaletteEntities } = setup();
    searchPaletteEntities.mockResolvedValue([
      conversation('conversation-global', 'Global Thread', { taskId: 'task-9' }),
    ]);

    await expect(
      source.search({ query: 'gl', context: { projectId: 'project-1' } })
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'conversation-global',
        title: 'Global Thread',
        relevance: {
          ...matchPaletteText('gl', { primary: ['Global Thread'] }),
          contextAffinity: 0.5,
        },
      }),
    ]);

    await expect(source.idle({ projectId: 'project-1' })).resolves.toEqual([
      expect.objectContaining({
        id: 'conversation-global',
        section: 'Recent Conversations',
        relevance: { band: 'fuzzy', score: 0, contextAffinity: 0.5 },
      }),
    ]);
  });

  it('searches across all tasks while boosting current task contextAffinity', async () => {
    const { source, searchPaletteEntities } = setup();
    searchPaletteEntities.mockResolvedValue([
      conversation('conversation-1', 'Architecture Review'),
      conversation('conversation-2', 'Planning', { subtitle: 'Architecture notes' }),
      conversation('conversation-3', 'Architecture elsewhere', { taskId: 'task-2' }),
      conversation('task-shaped-result', 'Architecture task', { kind: 'task' }),
    ]);

    await expect(source.search({ query: 'ar', context: CONTEXT })).resolves.toEqual([
      expect.objectContaining({
        id: 'conversation-1',
        title: 'Architecture Review',
        item: expect.objectContaining({ id: 'conversation-1', kind: 'conversation' }),
        relevance: {
          ...matchPaletteText('ar', { primary: ['Architecture Review'] }),
          contextAffinity: 1,
        },
      }),
      expect.objectContaining({
        id: 'conversation-3',
        title: 'Architecture elsewhere',
        item: expect.objectContaining({ id: 'conversation-3', kind: 'conversation' }),
        relevance: {
          ...matchPaletteText('ar', { primary: ['Architecture elsewhere'] }),
          contextAffinity: 0.5,
        },
      }),
    ]);
    expect(searchPaletteEntities).toHaveBeenCalledWith({
      kind: 'conversation',
      query: 'ar',
      context: { ...CONTEXT, taskId: undefined },
      limit: 50,
    });
  });

  it('provides five recent conversations only in task-context idle state', async () => {
    const { source, searchPaletteEntities } = setup();
    searchPaletteEntities.mockResolvedValue([
      conversation('conversation-1', 'Most recent'),
      conversation('conversation-2', 'Earlier'),
    ]);

    await expect(source.idle(CONTEXT)).resolves.toEqual([
      expect.objectContaining({
        id: 'conversation-1',
        section: 'Recent Conversations',
        relevance: { band: 'fuzzy', score: 0, contextAffinity: 1 },
      }),
      expect.objectContaining({
        id: 'conversation-2',
        section: 'Recent Conversations',
        relevance: { band: 'fuzzy', score: 0, contextAffinity: 1 },
      }),
    ]);
    expect(searchPaletteEntities).toHaveBeenCalledWith({
      kind: 'conversation',
      query: '',
      context: CONTEXT,
      limit: 5,
    });
  });
});
