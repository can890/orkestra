import { describe, expect, it } from 'vitest';
import {
  ComposerStashController,
  type StashComposerTarget,
  type StashDraftAttachment,
  type StashNotice,
} from './composer-stash-controller';
import { PROMPT_STASH_MAX_ENTRIES, type PromptStashState } from './prompt-stash-model';
import { PromptStashStore, type PromptStashPersistence } from './prompt-stash-store';

class MemoryPersistence implements PromptStashPersistence {
  state: PromptStashState = { version: '1', entries: [] };
  flushes = 0;
  readonly ready = Promise.resolve();
  read() {
    return this.state;
  }
  update(next: (current: PromptStashState) => PromptStashState) {
    this.state = next(this.state);
  }
  async flush() {
    this.flushes++;
  }
}

class FakeComposer implements StashComposerTarget {
  draftText = '';
  draftAttachments: StashDraftAttachment[] = [];
  uploads: Array<{ name?: string; mimeType: string; data: Uint8Array }> = [];
  constructor(readonly conversationId: string) {}
  setDraftText(text: string) {
    this.draftText = text;
  }
  addDraftAttachments(attachments: StashDraftAttachment[]) {
    this.draftAttachments = [...this.draftAttachments, ...attachments];
  }
  clearDraftKeepingAttachments() {
    this.draftText = '';
    this.draftAttachments = [];
  }
  async uploadAttachment(input: { name?: string; mimeType: string; data: Uint8Array }) {
    this.uploads.push(input);
    return { id: `copy-${this.uploads.length}`, name: input.name, mimeType: input.mimeType };
  }
}

function setup(conversationId = 'conv-1') {
  const persistence = new MemoryPersistence();
  const store = new PromptStashStore(persistence);
  const notices: StashNotice[] = [];
  const deleted: string[] = [];
  const blobs = new Map<string, Uint8Array>([['conv-1/att-1', new Uint8Array([1, 2, 3])]]);
  let seq = 0;
  const deps = {
    store,
    notify: (notice: StashNotice) => notices.push(notice),
    newId: () => `id-${++seq}`,
    now: () => new Date('2026-11-24T10:00:00.000Z'),
    attachments: {
      download: async (conv: string, id: string) => blobs.get(`${conv}/${id}`) ?? null,
      delete: async (conv: string, id: string) => {
        deleted.push(`${conv}/${id}`);
      },
    },
  };
  const composer = new FakeComposer(conversationId);
  const controller = new ComposerStashController(composer, deps);
  return { persistence, store, notices, deleted, composer, controller, deps };
}

const image: StashDraftAttachment = {
  ref: { type: 'attachment', id: 'att-1', mimeType: 'image/png', name: 'shot.png' },
  previewUrl: 'data:image/png;base64,AA==',
};

describe('ComposerStashController', () => {
  it('stashes the draft (text + attachments), clears the composer and persists', async () => {
    const { controller, composer, store, persistence, notices } = setup();
    composer.draftText = 'Refactor @[a.ts](/repo/a.ts)\n';
    composer.draftAttachments = [image];

    expect(await controller.stashOrRestore()).toBe('stashed');
    expect(composer.draftText).toBe('');
    expect(composer.draftAttachments).toEqual([]);
    expect(store.entries).toEqual([
      {
        id: 'id-1',
        createdAt: '2026-11-24T10:00:00.000Z',
        text: 'Refactor @[a.ts](/repo/a.ts)',
        conversationId: 'conv-1',
        attachments: [{ id: 'att-1', mimeType: 'image/png', name: 'shot.png' }],
      },
    ]);
    expect(persistence.flushes).toBe(1);
    expect(notices).toEqual([{ kind: 'stashed' }]);
  });

  it('refuses to stash while uploads are pending', async () => {
    const { controller, composer, store, notices } = setup();
    composer.draftText = 'x';
    expect(await controller.stashOrRestore({ uploadsPending: 1 })).toBe('blocked');
    expect(store.entries).toEqual([]);
    expect(composer.draftText).toBe('x');
    expect(notices).toEqual([{ kind: 'attachments-uploading' }]);
  });

  it('restores the only entry when the composer is empty', async () => {
    const { controller, composer, store } = setup();
    composer.draftText = 'saved prompt';
    composer.draftAttachments = [image];
    await controller.stashOrRestore();

    expect(await controller.stashOrRestore()).toBe('restored');
    expect(composer.draftText).toBe('saved prompt');
    expect(composer.draftAttachments.map((a) => a.ref.id)).toEqual(['att-1']);
    expect(store.entries).toEqual([]);
  });

  it('opens the menu instead of guessing with several entries and an empty composer', async () => {
    const { controller, composer } = setup();
    composer.draftText = 'one';
    await controller.stashOrRestore();
    composer.draftText = 'two';
    await controller.stashOrRestore();
    expect(await controller.stashOrRestore()).toBe('toggle-menu');
  });

  it('appends a restored prompt to a non-empty composer instead of replacing it', async () => {
    const { controller, composer, store } = setup();
    composer.draftText = 'stashed text';
    await controller.stashOrRestore();
    composer.draftText = 'new draft';

    const id = store.entries[0]!.id;
    expect(await controller.restore(id)).toBe(true);
    expect(composer.draftText).toBe('new draft\n\nstashed text');
  });

  it('copies attachments when restoring into another conversation', async () => {
    const source = setup('conv-1');
    source.composer.draftText = 'with image';
    source.composer.draftAttachments = [image];
    await source.controller.stashOrRestore();

    const otherComposer = new FakeComposer('conv-2');
    const other = new ComposerStashController(otherComposer, source.deps);
    expect(await other.restore('id-1')).toBe(true);
    expect(otherComposer.uploads).toHaveLength(1);
    expect(otherComposer.draftAttachments.map((a) => a.ref.id)).toEqual(['copy-1']);
    expect(source.deleted).toEqual(['conv-1/att-1']);
    expect(source.notices).not.toContainEqual(
      expect.objectContaining({ kind: 'attachments-dropped' })
    );
  });

  it('reports attachments that could not be copied', async () => {
    const source = setup('conv-1');
    source.composer.draftText = 'x';
    source.composer.draftAttachments = [
      { ref: { type: 'attachment', id: 'gone', mimeType: 'image/png' } },
    ];
    await source.controller.stashOrRestore();
    const other = new ComposerStashController(new FakeComposer('conv-2'), source.deps);
    await other.restore('id-1');
    expect(source.notices).toContainEqual({ kind: 'attachments-dropped', count: 1 });
  });

  it('deletes an entry and its uploaded attachments', async () => {
    const { controller, composer, store, deleted } = setup();
    composer.draftText = 'x';
    composer.draftAttachments = [image];
    await controller.stashOrRestore();
    expect(await controller.remove('id-1')).toBe(true);
    expect(store.entries).toEqual([]);
    expect(deleted).toEqual(['conv-1/att-1']);
    expect(await controller.remove('id-1')).toBe(false);
  });

  it('evicts the oldest entry at the cap and cleans up its attachments', async () => {
    const { controller, composer, store, deleted, notices } = setup();
    composer.draftText = 'oldest';
    composer.draftAttachments = [image];
    await controller.stashOrRestore();
    for (let i = 1; i < PROMPT_STASH_MAX_ENTRIES; i++) {
      composer.draftText = `p${i}`;
      await controller.stashOrRestore();
    }
    expect(deleted).toEqual([]);
    composer.draftText = 'newest';
    await controller.stashOrRestore();
    expect(store.entries).toHaveLength(PROMPT_STASH_MAX_ENTRIES);
    expect(store.entries.some((e) => e.text === 'oldest')).toBe(false);
    expect(deleted).toEqual(['conv-1/att-1']);
    expect(notices).toContainEqual({ kind: 'evicted', max: PROMPT_STASH_MAX_ENTRIES });
  });
});
