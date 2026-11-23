import { Button, Textarea, toast } from '@orkestra/ui/react/primitives';
import { Send, X } from 'lucide-react';
import { useState } from 'react';
import type { BrowserPickedElement } from '@core/features/browser/api';
import {
  hasActiveChatDraftTarget,
  injectIntoActiveChatDraft,
} from '@core/features/conversations/api/browser/active-chat-draft-bus';

export function formatPickedElementMarkdown(element: BrowserPickedElement, note: string): string {
  const lines = [
    `### Önizleme Öğesi: \`${element.selector || element.tagName}\``,
    `- **Sayfa:** ${element.pageTitle ? `${element.pageTitle} (${element.pageUrl})` : element.pageUrl}`,
    `- **Konum/Boyut:** ${element.rect.width}×${element.rect.height}px (${element.rect.x}, ${element.rect.y})`,
  ];
  if (element.textSnippet) {
    lines.push(`- **Metin:** ${element.textSnippet}`);
  }
  const stylePairs = Object.entries(element.computedStyles)
    .filter(([, value]) => Boolean(value))
    .slice(0, 6)
    .map(([key, value]) => `${key}: ${value}`);
  if (stylePairs.length > 0) {
    lines.push(`- **Stiller:** \`${stylePairs.join('; ')}\``);
  }
  if (note.trim()) {
    lines.push('', `**Not:** ${note.trim()}`);
  }
  if (element.outerHtmlSnippet) {
    lines.push('', '```html', element.outerHtmlSnippet, '```');
  }
  return lines.join('\n');
}

export function BrowserElementAnnotationPopover({
  element,
  onClose,
}: {
  element: BrowserPickedElement | null;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  if (!element) return null;

  const handleSendToChat = async () => {
    setSending(true);
    try {
      const text = formatPickedElementMarkdown(element, note);
      if (!hasActiveChatDraftTarget()) {
        await navigator.clipboard?.writeText(text).catch(() => {});
        toast('Aktif sohbet açık değil; öğe bilgisi panoya kopyalandı.');
        onClose();
        return;
      }
      const injected = await injectIntoActiveChatDraft({
        text,
        ...(element.screenshotBase64
          ? {
              image: {
                name: 'element-preview.png',
                mimeType: 'image/png',
                base64: element.screenshotBase64,
              },
            }
          : {}),
      });
      if (injected) {
        toast.success('Öğe bağlamı ve görseli sohbet taslağına eklendi');
        setNote('');
        onClose();
      } else {
        toast.error('Aktif sohbet taslağına eklenemedi');
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Seçili Sayfa Öğesi"
      className="fixed top-14 right-4 z-50 w-80 space-y-3 rounded-lg border border-border bg-(--em-surface) p-3 shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">Seçili Sayfa Öğesi</div>
          <div className="truncate font-mono text-[11px] text-foreground-muted">
            {element.selector || element.tagName}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          icon
          className="size-6 shrink-0"
          aria-label="Kapat"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {element.screenshotBase64 && (
        <div className="overflow-hidden rounded-md border border-border bg-background-2 p-1">
          <img
            src={`data:image/png;base64,${element.screenshotBase64}`}
            alt={element.selector}
            className="max-h-32 w-full rounded object-contain"
          />
        </div>
      )}

      <div className="space-y-1.5">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Bu öğeyle ilgili değişiklik notu ekleyin (isteğe bağlı)…"
          rows={3}
          className="text-xs"
        />
        <div className="flex items-center justify-between gap-2 text-[11px] text-foreground-muted">
          <span>
            {element.rect.width}×{element.rect.height}px · {element.tagName}
          </span>
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={sending}
            onClick={() => void handleSendToChat()}
            className="gap-1.5"
          >
            <Send className="size-3" />
            Sohbete Ekle
          </Button>
        </div>
      </div>
    </div>
  );
}
