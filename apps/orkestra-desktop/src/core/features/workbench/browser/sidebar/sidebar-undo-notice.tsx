import { Undo2, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { sidebarUndoStore } from './sidebar-undo-store';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Sol menüde arşivleme, sabitleme kaldırma veya erteleme sonrası listeyi kaydırmadan
 * alt çubuğun hemen üstünde tek tıkla (veya ⌘Z ile) geri alma şeridi gösterir.
 */
export const SidebarUndoNotice = observer(function SidebarUndoNotice() {
  const entry = sidebarUndoStore.entry;

  useEffect(() => {
    if (!entry) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        void sidebarUndoStore.performUndo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [entry]);

  if (!entry) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-2 mb-1.5 flex items-center justify-between gap-2 rounded-lg border border-border bg-background-2 px-2.5 py-1.5 text-xs text-foreground-muted shadow-sm"
    >
      <span className="min-w-0 truncate">{entry.label}</span>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => void sidebarUndoStore.performUndo()}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-background-3 px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-foreground/[0.15]"
        >
          <Undo2 className="size-3" />
          <span>Geri al</span>
        </button>
        <button
          type="button"
          onClick={() => sidebarUndoStore.clear()}
          aria-label="Kapat"
          className="flex size-5 cursor-pointer items-center justify-center rounded text-foreground-passive hover:bg-background-3 hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </div>
    </div>
  );
});
