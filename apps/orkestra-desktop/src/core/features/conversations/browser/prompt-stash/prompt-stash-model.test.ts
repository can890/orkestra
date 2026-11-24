import { describe, expect, it } from 'vitest';
import {
  addStashEntry,
  mergeRestoredPrompt,
  partitionRestorableAttachments,
  PROMPT_STASH_MAX_ENTRIES,
  stashEntrySnippet,
  stashShortcutAction,
  takeStashEntry,
  type PromptStashEntry,
  type PromptStashState,
} from './prompt-stash-model';

function entry(id: string, overrides: Partial<PromptStashEntry> = {}): PromptStashEntry {
  return {
    id,
    createdAt: '2026-11-24T10:00:00.000Z',
    text: `prompt ${id}`,
    conversationId: 'conv-1',
    attachments: [],
    ...overrides,
  };
}

const empty: PromptStashState = { version: '1', entries: [] };

describe('addStashEntry', () => {
  it('adds newest first', () => {
    const one = addStashEntry(empty, entry('a')).state;
    const two = addStashEntry(one, entry('b')).state;
    expect(two.entries.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('evicts the oldest entry beyond the cap', () => {
    let state = empty;
    for (let i = 0; i < PROMPT_STASH_MAX_ENTRIES; i++) {
      const result = addStashEntry(state, entry(`e${i}`));
      expect(result.evicted).toEqual([]);
      state = result.state;
    }
    const result = addStashEntry(state, entry('newest'));
    expect(result.state.entries).toHaveLength(PROMPT_STASH_MAX_ENTRIES);
    expect(result.state.entries[0]?.id).toBe('newest');
    expect(result.evicted.map((e) => e.id)).toEqual(['e0']);
  });

  it('honours a custom cap', () => {
    const state = addStashEntry(addStashEntry(empty, entry('a'), 1).state, entry('b'), 1);
    expect(state.state.entries.map((e) => e.id)).toEqual(['b']);
    expect(state.evicted.map((e) => e.id)).toEqual(['a']);
  });
});

describe('takeStashEntry', () => {
  it('removes and returns the entry', () => {
    const state = addStashEntry(addStashEntry(empty, entry('a')).state, entry('b')).state;
    const result = takeStashEntry(state, 'a');
    expect(result.entry?.id).toBe('a');
    expect(result.state.entries.map((e) => e.id)).toEqual(['b']);
  });

  it('returns null and leaves state untouched for an unknown id', () => {
    const state = addStashEntry(empty, entry('a')).state;
    const result = takeStashEntry(state, 'missing');
    expect(result.entry).toBeNull();
    expect(result.state).toBe(state);
  });
});

describe('mergeRestoredPrompt (restore into a non-empty composer)', () => {
  it('restores as-is into an empty composer', () => {
    expect(mergeRestoredPrompt('', 'stashed')).toBe('stashed');
    expect(mergeRestoredPrompt('   \n', 'stashed')).toBe('stashed');
  });

  it('appends after the current draft separated by a blank line', () => {
    expect(mergeRestoredPrompt('current draft  \n', 'stashed')).toBe('current draft\n\nstashed');
  });

  it('keeps the current draft when the stashed prompt has no text', () => {
    expect(mergeRestoredPrompt('current', '')).toBe('current');
  });
});

describe('stashShortcutAction', () => {
  it('stashes a composer with text or attachments', () => {
    expect(stashShortcutAction({ text: 'hi', attachmentCount: 0 }, [])).toEqual({ kind: 'stash' });
    expect(stashShortcutAction({ text: ' ', attachmentCount: 1 }, [])).toEqual({ kind: 'stash' });
  });

  it('restores the only entry into an empty composer', () => {
    const only = entry('a');
    expect(stashShortcutAction({ text: '', attachmentCount: 0 }, [only])).toEqual({
      kind: 'restore',
      entry: only,
    });
  });

  it('toggles the menu with zero or several entries', () => {
    const draft = { text: '', attachmentCount: 0 };
    expect(stashShortcutAction(draft, [])).toEqual({ kind: 'toggle-menu' });
    expect(stashShortcutAction(draft, [entry('a'), entry('b')])).toEqual({ kind: 'toggle-menu' });
  });
});

describe('partitionRestorableAttachments', () => {
  const withFiles = entry('a', {
    attachments: [{ id: 'att-1', mimeType: 'image/png', name: 'shot.png' }],
  });

  it('restores attachments into their original conversation', () => {
    expect(partitionRestorableAttachments(withFiles, 'conv-1')).toEqual({
      restorable: withFiles.attachments,
      dropped: [],
    });
  });

  it('drops attachments when restoring into another conversation', () => {
    expect(partitionRestorableAttachments(withFiles, 'conv-2')).toEqual({
      restorable: [],
      dropped: withFiles.attachments,
    });
  });
});

describe('stashEntrySnippet', () => {
  it('collapses whitespace and shows mention labels', () => {
    expect(stashEntrySnippet({ text: 'Fix  @[a.ts](/repo/a.ts)\nplease', attachments: [] })).toBe(
      'Fix @a.ts please'
    );
    expect(stashEntrySnippet({ text: 'see @[My File.ts](</x/My File.ts>)', attachments: [] })).toBe(
      'see @My File.ts'
    );
  });

  it('truncates long prompts', () => {
    const snippet = stashEntrySnippet({ text: 'x'.repeat(200), attachments: [] });
    expect(snippet).toHaveLength(91);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('describes attachment-only and empty entries', () => {
    const att = { id: '1', mimeType: 'image/png' };
    expect(stashEntrySnippet({ text: '', attachments: [att] })).toBe('(1 attachment)');
    expect(stashEntrySnippet({ text: '', attachments: [att, att] })).toBe('(2 attachments)');
    expect(stashEntrySnippet({ text: '', attachments: [] })).toBe('(empty)');
  });
});
