// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/promptStashStore.ts,
// apps/web/src/components/chat/useComposerStash.ts, apps/web/src/components/chat/ComposerStashMenu.tsx
//
// İstem zulası (prompt stash) için saf mantık: ekleme/çıkarma/üst sınır, geri yüklemede metin
// birleştirme kuralı, kısayolun boş/dolu oluşturucuda ne yapacağı ve menü önizlemesi.
// Kalıcılık ve arayüz bu dosyada değildir; böylece kurallar doğrudan test edilebilir.

import {
  PROMPT_STASH_MAX_ENTRIES,
  type PromptStashEntry,
  type PromptStashState,
} from '@core/features/conversations/contributions/mementos';

export type { PromptStashEntry, PromptStashState };
export { PROMPT_STASH_MAX_ENTRIES };

/** Menüdeki önizleme metninin en fazla uzunluğu (karakter). */
export const STASH_SNIPPET_MAX_CHARS = 90;

/** Yeni girdiyi en başa ekler; üst sınır aşılırsa en eskisini çıkarıp döndürür. */
export function addStashEntry(
  state: PromptStashState,
  entry: PromptStashEntry,
  max: number = PROMPT_STASH_MAX_ENTRIES
): { state: PromptStashState; evicted: PromptStashEntry[] } {
  const entries = [entry, ...state.entries.filter((candidate) => candidate.id !== entry.id)];
  const evicted = entries.length > max ? entries.splice(max) : [];
  return { state: { ...state, entries }, evicted };
}

/** Girdiyi zuladan alır (geri yükleme): girdi listeden çıkar ve döndürülür. */
export function takeStashEntry(
  state: PromptStashState,
  entryId: string
): { state: PromptStashState; entry: PromptStashEntry | null } {
  const entry = state.entries.find((candidate) => candidate.id === entryId) ?? null;
  if (!entry) return { state, entry: null };
  return {
    state: { ...state, entries: state.entries.filter((candidate) => candidate.id !== entryId) },
    entry,
  };
}

/**
 * Geri yüklenen istemi mevcut oluşturucu metniyle birleştirir.
 * Oluşturucu boşsa zuladaki metin olduğu gibi gelir; doluysa mevcut metnin sonuna
 * boş bir satırla eklenir (mevcut taslak asla ezilmez).
 */
export function mergeRestoredPrompt(current: string, restored: string): string {
  if (restored.length === 0) return current;
  if (current.trim().length === 0) return restored;
  return `${current.replace(/\s+$/, '')}\n\n${restored}`;
}

/** Oluşturucuda zulaya alınacak bir şey var mı? */
export function hasStashableDraft(text: string, attachmentCount: number): boolean {
  return text.trim().length > 0 || attachmentCount > 0;
}

export type StashShortcutAction =
  | { kind: 'stash' }
  | { kind: 'restore'; entry: PromptStashEntry }
  | { kind: 'toggle-menu' };

/**
 * Zula kısayolunun davranışı: oluşturucu doluysa taslağı zulaya alır; boşsa tek girdi
 * varsa onu geri yükler, aksi halde (hiç ya da birden çok girdi) menüyü açar/kapatır.
 */
export function stashShortcutAction(
  draft: { text: string; attachmentCount: number },
  entries: readonly PromptStashEntry[]
): StashShortcutAction {
  if (hasStashableDraft(draft.text, draft.attachmentCount)) return { kind: 'stash' };
  const only = entries.length === 1 ? entries[0] : undefined;
  return only ? { kind: 'restore', entry: only } : { kind: 'toggle-menu' };
}

/**
 * Eklerin geri yüklenebilirliği: yüklenmiş ekler kaynak sohbete aittir, bu yüzden yalnızca
 * aynı sohbete geri eklenebilir; başka bir sohbete geri yüklemede düşürülür.
 */
export function partitionRestorableAttachments(
  entry: PromptStashEntry,
  targetConversationId: string
): { restorable: PromptStashEntry['attachments']; dropped: PromptStashEntry['attachments'] } {
  if (entry.conversationId === targetConversationId) {
    return { restorable: entry.attachments, dropped: [] };
  }
  return { restorable: [], dropped: entry.attachments };
}

// `@[etiket](hedef)` ya da `@[etiket](<boşluklu hedef>)` biçimindeki dosya bahsetmeleri.
const BRACKET_MENTION_RE = /@\[([^\]]+)\]\((?:<[^>]*>|[^)\s]*)\)/g;

/** Menü için tek satırlık önizleme: bahsetmeler etiketine indirgenir, boşluklar sıkıştırılır. */
export function stashEntrySnippet(entry: Pick<PromptStashEntry, 'text' | 'attachments'>): string {
  const plain = entry.text.replace(BRACKET_MENTION_RE, '@$1').trim().replace(/\s+/g, ' ');
  if (plain.length > 0) {
    if (plain.length <= STASH_SNIPPET_MAX_CHARS) return plain;
    // Bir emojinin ilk yarısında (yalnız yüksek vekil) kesme.
    const last = plain.charCodeAt(STASH_SNIPPET_MAX_CHARS - 1);
    const end =
      last >= 0xd800 && last <= 0xdbff ? STASH_SNIPPET_MAX_CHARS - 1 : STASH_SNIPPET_MAX_CHARS;
    return `${plain.slice(0, end)}…`;
  }
  const count = entry.attachments.length;
  if (count === 0) return '(empty)';
  return count === 1 ? '(1 attachment)' : `(${count} attachments)`;
}
