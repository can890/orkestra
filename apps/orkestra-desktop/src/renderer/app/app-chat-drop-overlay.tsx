import { ImagePlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  hasActiveChatDraftTarget,
  injectIntoActiveChatDraft,
} from '@core/features/conversations/api/browser/active-chat-draft-bus';
import {
  hasDraggedFiles,
  hasDraggedWorkspaceFile,
} from '@core/primitives/drag-files/browser/drag-files';

function hasOpenDialog(): boolean {
  return Boolean(document.querySelector('[role="dialog"], [role="alertdialog"]'));
}

function isEditableOrTerminalTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  ) {
    return true;
  }
  return Boolean(
    target.closest('[contenteditable="true"], .xterm, [role="dialog"], [role="alertdialog"]')
  );
}

/**
 * Sohbet alanı dışında uygulama penceresinin herhangi bir yerine sürüklenen dosyaları
 * (veya düzenlenebilir bir alan odakta değilken yapıştırılan dosya/görselleri) aktif
 * sohbete yönlendirir. Halihazırda başka bir hedefin (`ChatComposer`, `AcpChatPanel`,
 * kenar çubuğu vb.) `preventDefault()` ile sahiplendiği olaylara karışmaz.
 */
export function AppChatDropOverlay() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const canAcceptTransfer = (dataTransfer: DataTransfer | null): dataTransfer is DataTransfer =>
      Boolean(
        dataTransfer &&
          hasActiveChatDraftTarget() &&
          !hasOpenDialog() &&
          hasDraggedFiles(dataTransfer) &&
          !hasDraggedWorkspaceFile(dataTransfer)
      );

    const onDragOver = (event: DragEvent) => {
      if (event.defaultPrevented) {
        setVisible(false);
        return;
      }
      if (!canAcceptTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setVisible(true);
    };

    const onDrop = (event: DragEvent) => {
      setVisible(false);
      if (event.defaultPrevented) return;
      if (!canAcceptTransfer(event.dataTransfer)) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;
      event.preventDefault();
      void injectIntoActiveChatDraft({ files });
    };

    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) {
        setVisible(false);
      }
    };

    const clear = () => setVisible(false);

    const onPaste = (event: ClipboardEvent) => {
      if (
        event.defaultPrevented ||
        !hasActiveChatDraftTarget() ||
        hasOpenDialog() ||
        isEditableOrTerminalTarget(event.target)
      ) {
        return;
      }
      const items = event.clipboardData?.items;
      if (!items || items.length === 0) return;
      const files = Array.from(items).flatMap((item) => {
        if (item.kind !== 'file') return [];
        const file = item.getAsFile();
        return file ? [file] : [];
      });
      if (files.length === 0) return;
      event.preventDefault();
      void injectIntoActiveChatDraft({ files });
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragend', clear);
    window.addEventListener('blur', clear);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragend', clear);
      window.removeEventListener('blur', clear);
      window.removeEventListener('paste', onPaste);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-3 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-foreground/30 bg-(--em-surface)/65 backdrop-blur-[2px]"
    >
      <div className="flex items-center gap-2 rounded-full border border-border bg-(--em-surface) px-4 py-2 text-xs font-medium text-foreground shadow-lg">
        <ImagePlus className="size-4" />
        <span>Aktif sohbete eklemek için bırakın</span>
      </div>
    </div>
  );
}
