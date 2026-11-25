// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/components/chat/useComposerStash.ts
//
// ACP oluşturucusunu zulaya bağlayan React kancası: denetleyiciyi kurar, menü durumunu tutar,
// bildirimleri toast olarak gösterir ve oluşturucu odak kapsamındaki zula komutunu uygular.

import { toast } from '@orkestra/ui/react/primitives';
import { useMemo, useState } from 'react';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import type { conversationComposerScope } from '@core/features/conversations/contributions/scopes';
import { disabled, enabled, type ViewScopeImpl } from '@core/primitives/view-scopes/api';
import {
  ComposerStashController,
  type StashAttachmentAccess,
  type StashComposerTarget,
  type StashNotice,
} from './composer-stash-controller';
import { getPromptStashStore } from './prompt-stash-instance';
import type { PromptStashEntry } from './prompt-stash-model';

const attachmentAccess: StashAttachmentAccess = {
  async download(conversationId, attachmentId) {
    const client = await getConversationsClient();
    const result = await client.attachments.download({ conversationId, attachmentId });
    if (!result.success) return null;
    return await result.data.bytes();
  },
  async delete(conversationId, attachmentId) {
    const client = await getConversationsClient();
    await client.attachments.delete({ conversationId, attachmentId });
  },
};

function showNotice(notice: StashNotice): void {
  switch (notice.kind) {
    case 'stashed':
      toast.success('Prompt stashed');
      return;
    case 'evicted':
      toast.warning('Oldest stashed prompt discarded', {
        description: `The stash holds ${notice.max} prompts; the oldest was removed to make room.`,
      });
      return;
    case 'attachments-uploading':
      toast.info('Wait for file uploads before stashing this prompt');
      return;
    case 'attachments-dropped':
      toast.warning('Some stashed attachments could not be restored', {
        description: `${notice.count} attachment(s) could not be copied from the original conversation. Attach them again if you still need them.`,
      });
      return;
  }
}

export interface ComposerStash {
  readonly entries: readonly PromptStashEntry[];
  readonly menuOpen: boolean;
  readonly setMenuOpen: (open: boolean) => void;
  readonly canStash: boolean;
  readonly stash: () => void;
  readonly restore: (entry: PromptStashEntry) => void;
  readonly remove: (entry: PromptStashEntry) => void;
  /** Yalnızca zula komutu; kapsamın diğer komutlarını oluşturucu bileşen bağlar. */
  readonly scopeImplementation: Pick<
    ViewScopeImpl<typeof conversationComposerScope>,
    'conversations.stashPrompt'
  >;
}

export function useComposerStash(
  target: StashComposerTarget,
  options: { uploadsPending: number; disabledReason?: string | null; focusComposer: () => void }
): ComposerStash {
  const [menuOpen, setMenuOpen] = useState(false);
  const store = getPromptStashStore();
  const controller = useMemo(
    () =>
      new ComposerStashController(target, {
        store,
        attachments: attachmentAccess,
        notify: showNotice,
      }),
    [target, store]
  );

  const stashOrRestore = () => {
    void controller.stashOrRestore({ uploadsPending: options.uploadsPending }).then((outcome) => {
      if (outcome === 'toggle-menu') setMenuOpen((open) => !open);
      else options.focusComposer();
    });
  };

  return {
    // MobX gözlemlenebilir okuma; çağıran bileşen observer olmalı.
    entries: store.entries,
    menuOpen,
    setMenuOpen,
    canStash: target.draftText.trim().length > 0 || target.draftAttachments.length > 0,
    stash: () => {
      setMenuOpen(false);
      controller.stash({ uploadsPending: options.uploadsPending });
      options.focusComposer();
    },
    restore: (entry) => {
      setMenuOpen(false);
      void controller.restore(entry.id).then(() => options.focusComposer());
    },
    remove: (entry) => {
      void controller.remove(entry.id);
    },
    scopeImplementation: {
      'conversations.stashPrompt': () => ({
        availability: () => (options.disabledReason ? disabled(options.disabledReason) : enabled),
        execute: () => stashOrRestore(),
      }),
    },
  };
}
