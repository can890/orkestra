// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/components/chat/ComposerStashMenu.tsx
//
// Oluşturucu araç çubuğundaki zula düğmesi ve menüsü: mevcut istemi zulaya al, zuladaki
// istemleri önizleme/zaman/ek sayısıyla listele, tıklayınca geri yükle, X ile sil.

import { Button, DropdownMenu, RelativeTime } from '@orkestra/ui/react/primitives';
import { Bookmark, BookmarkPlus, FileText, Paperclip, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { stashPromptCommand } from '@core/features/conversations/contributions/commands';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';
import { stashEntrySnippet, type PromptStashEntry } from './prompt-stash-model';

export interface ComposerStashMenuProps {
  readonly entries: readonly PromptStashEntry[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly canStash: boolean;
  readonly onStash: () => void;
  readonly onRestore: (entry: PromptStashEntry) => void;
  readonly onDelete: (entry: PromptStashEntry) => void;
}

export const ComposerStashMenu = observer(function ComposerStashMenu({
  entries,
  open,
  onOpenChange,
  canStash,
  onStash,
  onRestore,
  onDelete,
}: ComposerStashMenuProps) {
  return (
    <DropdownMenu.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DropdownMenu.Trigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            icon={entries.length === 0}
            aria-label="Prompt stash"
            title="Prompt stash"
            data-prompt-stash-badge="true"
          >
            <Bookmark aria-hidden="true" />
            {entries.length > 0 && (
              <span className="text-[11px] text-foreground-muted tabular-nums">
                {entries.length}
              </span>
            )}
          </Button>
        }
      />
      <DropdownMenu.Content
        align="end"
        side="top"
        width="content"
        className="w-[360px] max-w-[80vw]"
      >
        <DropdownMenu.Item disabled={!canStash} onClick={onStash}>
          <BookmarkPlus className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="flex-1">Stash current prompt</span>
          <BoundShortcut command={stashPromptCommand} variant="keycaps" />
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        {entries.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-foreground-muted">
            Nothing stashed yet. Stash a prompt to set it aside and restore it later.
          </div>
        ) : (
          <div className="max-h-[320px] overflow-y-auto" aria-label="Stashed prompts">
            {entries.map((entry) => (
              <DropdownMenu.Item
                key={entry.id}
                onClick={() => onRestore(entry)}
                onKeyDown={(event) => {
                  if (
                    (event.key === 'Backspace' && (event.metaKey || event.ctrlKey)) ||
                    event.key === 'Delete'
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    onDelete(entry);
                  }
                }}
                aria-label={`Restore stashed prompt: ${stashEntrySnippet(entry)}`}
                className="group"
              >
                <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{stashEntrySnippet(entry)}</span>
                {entry.attachments.length > 0 && (
                  <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-foreground-muted">
                    <Paperclip className="h-3 w-3" aria-hidden="true" />
                    {entry.attachments.length}
                  </span>
                )}
                <RelativeTime
                  value={entry.createdAt}
                  compact
                  className="shrink-0 text-[11px] text-foreground-muted tabular-nums"
                />
                <button
                  type="button"
                  className="hover:bg-surface-subtle shrink-0 rounded p-0.5 text-foreground-muted opacity-60 hover:text-foreground hover:opacity-100"
                  aria-label="Delete stashed prompt"
                  title="Delete stashed prompt"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onDelete(entry);
                  }}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </DropdownMenu.Item>
            ))}
          </div>
        )}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
});
