// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/components/chat/useComposerStash.ts
//
// Oluşturucu ile zula arasındaki akış: taslağı zulaya al (ve oluşturucuyu temizle), bir girdiyi
// geri yükle (dolu oluşturucuda metni sona ekle), sil ve üst sınırla çıkarılan girdilerin
// yüklenmiş eklerini temizle. React'ten bağımsızdır; bağımlılıklar enjekte edilir.

import {
  hasStashableDraft,
  mergeRestoredPrompt,
  partitionRestorableAttachments,
  PROMPT_STASH_MAX_ENTRIES,
  stashShortcutAction,
  type PromptStashEntry,
} from './prompt-stash-model';
import type { PromptStashStore } from './prompt-stash-store';

export type StashDraftAttachment = {
  ref: { type: 'attachment'; id: string; mimeType: string; name?: string };
  previewUrl?: string;
};

/** Zulanın çalıştığı oluşturucu (AcpChatStore bunu karşılar). */
export interface StashComposerTarget {
  readonly conversationId: string;
  readonly draftText: string;
  readonly draftAttachments: readonly StashDraftAttachment[];
  setDraftText(text: string): void;
  addDraftAttachments(attachments: StashDraftAttachment[]): void;
  /** Taslağı temizler ama yüklenmiş ekleri sunucudan SİLMEZ (zula onları tutar). */
  clearDraftKeepingAttachments(): void;
  uploadAttachment(input: {
    name?: string;
    mimeType: string;
    data: Uint8Array;
  }): Promise<{ id: string; name?: string; mimeType?: string } | null>;
}

/** Herhangi bir sohbetin yüklenmiş eklerine erişim. */
export interface StashAttachmentAccess {
  download(conversationId: string, attachmentId: string): Promise<Uint8Array | null>;
  delete(conversationId: string, attachmentId: string): Promise<void>;
}

export type StashNotice =
  | { kind: 'stashed' }
  | { kind: 'evicted'; max: number }
  | { kind: 'attachments-uploading' }
  | { kind: 'attachments-dropped'; count: number };

export interface ComposerStashDeps {
  readonly store: PromptStashStore;
  readonly attachments: StashAttachmentAccess;
  readonly notify: (notice: StashNotice) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export type StashOutcome = 'stashed' | 'restored' | 'toggle-menu' | 'blocked';

export class ComposerStashController {
  constructor(
    private readonly target: StashComposerTarget,
    private readonly deps: ComposerStashDeps
  ) {}

  get entries(): readonly PromptStashEntry[] {
    return this.deps.store.entries;
  }

  /** Kısayol / menü eylemi: doluysa zulaya al, boşsa tek girdiyi geri yükle ya da menüyü aç. */
  async stashOrRestore(options: { uploadsPending?: number } = {}): Promise<StashOutcome> {
    const action = stashShortcutAction(
      {
        text: this.target.draftText,
        attachmentCount: this.target.draftAttachments.length,
      },
      this.entries
    );
    switch (action.kind) {
      case 'stash':
        return this.stash(options);
      case 'restore':
        await this.restore(action.entry.id);
        return 'restored';
      case 'toggle-menu':
        return 'toggle-menu';
    }
  }

  /** Mevcut taslağı zulaya alır ve oluşturucuyu temizler. */
  stash(options: { uploadsPending?: number } = {}): StashOutcome {
    const text = this.target.draftText;
    const attachments = this.target.draftAttachments;
    if (!hasStashableDraft(text, attachments.length)) return 'blocked';
    if ((options.uploadsPending ?? 0) > 0) {
      // T3 gibi: yüklemeler bitmeden zulaya alma, aksi halde ek kaybolur.
      this.deps.notify({ kind: 'attachments-uploading' });
      return 'blocked';
    }
    const entry: PromptStashEntry = {
      id: this.deps.newId?.() ?? crypto.randomUUID(),
      createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
      text: text.trimEnd(),
      conversationId: this.target.conversationId,
      attachments: attachments.map(({ ref }) => ({
        id: ref.id,
        mimeType: ref.mimeType,
        ...(ref.name ? { name: ref.name } : {}),
      })),
    };
    const { evicted } = this.deps.store.stash(entry);
    this.target.clearDraftKeepingAttachments();
    this.deps.notify({ kind: 'stashed' });
    if (evicted.length > 0) {
      for (const old of evicted) void this.discardAttachments(old);
      this.deps.notify({ kind: 'evicted', max: PROMPT_STASH_MAX_ENTRIES });
    }
    return 'stashed';
  }

  /** Girdiyi zuladan alıp oluşturucuya geri yükler (dolu oluşturucuda metni sona ekler). */
  async restore(entryId: string): Promise<boolean> {
    const entry = this.deps.store.take(entryId);
    if (!entry) return false;
    this.target.setDraftText(mergeRestoredPrompt(this.target.draftText, entry.text));

    const { restorable, dropped } = partitionRestorableAttachments(
      entry,
      this.target.conversationId
    );
    if (restorable.length > 0) {
      this.target.addDraftAttachments(
        restorable.map((attachment) => ({ ref: { type: 'attachment', ...attachment } }))
      );
    }
    if (dropped.length > 0) {
      // Ekler başka bir sohbete ait: baytları indirip bu sohbete yeniden yükle.
      const copied = await this.copyAttachments(entry.conversationId, dropped);
      if (copied.length > 0) this.target.addDraftAttachments(copied);
      const lost = dropped.length - copied.length;
      if (lost > 0) this.deps.notify({ kind: 'attachments-dropped', count: lost });
      for (const attachment of dropped) {
        void this.deps.attachments.delete(entry.conversationId, attachment.id).catch(() => {});
      }
    }
    return true;
  }

  /** Girdiyi zuladan siler ve yüklenmiş eklerini temizler. */
  async remove(entryId: string): Promise<boolean> {
    const entry = this.deps.store.remove(entryId);
    if (!entry) return false;
    await this.discardAttachments(entry);
    return true;
  }

  private async copyAttachments(
    sourceConversationId: string,
    attachments: PromptStashEntry['attachments']
  ): Promise<StashDraftAttachment[]> {
    const copied: StashDraftAttachment[] = [];
    for (const attachment of attachments) {
      try {
        const data = await this.deps.attachments.download(sourceConversationId, attachment.id);
        if (!data) continue;
        const uploaded = await this.target.uploadAttachment({
          name: attachment.name,
          mimeType: attachment.mimeType,
          data,
        });
        if (!uploaded) continue;
        copied.push({
          ref: {
            type: 'attachment',
            id: uploaded.id,
            mimeType: uploaded.mimeType ?? attachment.mimeType,
            ...((uploaded.name ?? attachment.name)
              ? { name: uploaded.name ?? attachment.name }
              : {}),
          },
        });
      } catch {
        // Kaynak sohbet silinmiş olabilir; eklenemeyenler bildirimle raporlanır.
      }
    }
    return copied;
  }

  private async discardAttachments(entry: PromptStashEntry): Promise<void> {
    await Promise.all(
      entry.attachments.map((attachment) =>
        this.deps.attachments.delete(entry.conversationId, attachment.id).catch(() => {})
      )
    );
  }
}
