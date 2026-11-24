import { ContextMenu, toast } from '@orkestra/ui/react/primitives';
import {
  Archive,
  Copy,
  LayoutGrid,
  Link,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  SearchCheck,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import React from 'react';
import { buildDeepLink } from '@core/primitives/deep-links/api/deep-link';

export interface TaskContextMenuViewSwitch {
  targetType: 'pty' | 'acp';
  label: string;
  disabled?: boolean;
  disabledReason?: string;
  onSwitch: () => void;
}

interface TaskContextMenuProps {
  children: React.ReactNode;
  isPinned: boolean;
  canPin: boolean;
  isArchived: boolean;
  archiveDisabledReason?: string;
  branchName?: string;
  /** Verilirse "Bağlantıyı kopyala" öğesi görevin `orkestra://task/<id>` bağlantısını kopyalar. */
  taskId?: string;
  /** Varsa sağ tık menüsünde "Terminal moduna geç" / "Sohbet moduna geç" öğesini gösterir. */
  viewSwitch?: TaskContextMenuViewSwitch;
  onPin: () => void;
  onUnpin: () => void;
  onRename: () => void;
  onArchive: () => void;
  onRestore?: () => void;
  onReconnect?: () => void;
  onConvertAutomation?: () => void;
  /** Görevin değişiklikleri için kod incelemesi başlatır. */
  onReview?: () => void;
  /** Görevi Pano görünümüne ekler; verilmezse öğe gösterilmez. */
  onAddToBoard?: () => void;
  /** Görevi Panodan çıkarır; verilmezse öğe gösterilmez. */
  onRemoveFromBoard?: () => void;
  onDelete: () => void;
}

export function TaskContextMenu({
  children,
  isPinned,
  canPin,
  isArchived,
  archiveDisabledReason,
  branchName,
  taskId,
  viewSwitch,
  onPin,
  onUnpin,
  onRename,
  onArchive,
  onRestore,
  onReconnect,
  onConvertAutomation,
  onReview,
  onAddToBoard,
  onRemoveFromBoard,
  onDelete,
}: TaskContextMenuProps) {
  const archiveDisabledReasonId = React.useId();
  const handleCopyBranchName = async () => {
    if (!branchName) return;

    try {
      await navigator.clipboard.writeText(branchName);
      toast('Branch name copied');
    } catch {
      toast.error('Copy failed', {
        description: 'The branch name could not be copied to the clipboard.',
      });
    }
  };

  const handleCopyLink = async () => {
    if (!taskId) return;

    try {
      await navigator.clipboard.writeText(buildDeepLink({ kind: 'task', id: taskId }));
      toast('Bağlantı kopyalandı');
    } catch {
      toast.error('Kopyalanamadı', {
        description: 'Bağlantı panoya kopyalanamadı.',
      });
    }
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
      <ContextMenu.Content>
        {canPin &&
          (isPinned ? (
            <ContextMenu.Item onClick={onUnpin}>
              <PinOff className="size-4" />
              Unpin task
            </ContextMenu.Item>
          ) : (
            <ContextMenu.Item onClick={onPin}>
              <Pin className="size-4" />
              Pin task
            </ContextMenu.Item>
          ))}
        <ContextMenu.Item onClick={onRename}>
          <Pencil className="size-4" />
          Rename
        </ContextMenu.Item>
        {viewSwitch && (
          <ContextMenu.Item
            disabled={viewSwitch.disabled}
            title={viewSwitch.disabledReason}
            onClick={viewSwitch.onSwitch}
          >
            {viewSwitch.targetType === 'pty' ? (
              <Terminal className="size-4" />
            ) : (
              <MessageSquare className="size-4" />
            )}
            {viewSwitch.label}
          </ContextMenu.Item>
        )}
        {onReconnect && (
          <ContextMenu.Item onClick={onReconnect}>
            <RotateCcw className="size-4" />
            Reconnect
          </ContextMenu.Item>
        )}
        {onConvertAutomation && (
          <ContextMenu.Item onClick={onConvertAutomation}>
            <MessageSquare className="size-4" />
            Convert to regular task
          </ContextMenu.Item>
        )}
        {!isArchived && (
          <ContextMenu.Item
            disabled={!!archiveDisabledReason}
            aria-describedby={archiveDisabledReason ? archiveDisabledReasonId : undefined}
            onClick={onArchive}
          >
            <Archive className="size-4" />
            Archive
          </ContextMenu.Item>
        )}
        {archiveDisabledReason && (
          <span id={archiveDisabledReasonId} className="sr-only">
            {archiveDisabledReason}
          </span>
        )}
        {isArchived && onRestore && (
          <ContextMenu.Item onClick={onRestore}>
            <RotateCcw className="size-4" />
            Restore
          </ContextMenu.Item>
        )}
        {onReview && (
          <ContextMenu.Item onClick={onReview}>
            <SearchCheck className="size-4" />
            Değişiklikleri incele…
          </ContextMenu.Item>
        )}
        {onAddToBoard && (
          <ContextMenu.Item onClick={onAddToBoard}>
            <LayoutGrid className="size-4" />
            Add to board
          </ContextMenu.Item>
        )}
        {onRemoveFromBoard && (
          <ContextMenu.Item onClick={onRemoveFromBoard}>
            <X className="size-4" />
            Remove from board
          </ContextMenu.Item>
        )}
        {branchName && (
          <ContextMenu.Item onClick={() => void handleCopyBranchName()}>
            <Copy className="size-4" />
            Copy branch name
          </ContextMenu.Item>
        )}
        {taskId && (
          <ContextMenu.Item onClick={() => void handleCopyLink()}>
            <Link className="size-4" />
            Bağlantıyı kopyala
          </ContextMenu.Item>
        )}
        <ContextMenu.Separator />
        <ContextMenu.Item variant="destructive" onClick={onDelete}>
          <Trash2 className="size-4" />
          Delete
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
