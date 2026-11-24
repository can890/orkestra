import { Button } from '@orkestra/ui/react/primitives';
import { CornerDownRight, Minimize2, Pencil, X } from 'lucide-react';

function collapsePreview(value: string, maxLength = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export interface ReplyQuoteChipProps {
  quote: string;
  onClear: () => void;
}

/** Alıntılanan metni mesaj yazma alanının üstünde tek satırlık önizleme olarak gösterir. */
export function ReplyQuoteChip({ quote, onClear }: ReplyQuoteChipProps) {
  const preview = collapsePreview(quote);
  if (!preview) return null;

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-2 rounded-md border border-l-2 border-border/70 border-l-sky-400/75 bg-foreground/[0.04] px-2.5 py-1.5 text-xs"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
        <span className="shrink-0 font-medium text-foreground">Yanıtlanıyor</span>
        <span className="min-w-0 truncate text-foreground-muted" title={quote}>
          {preview}
        </span>
      </div>
      <button
        type="button"
        onClick={onClear}
        aria-label="Yanıt alıntısını kaldır"
        title="Yanıt alıntısını kaldır"
        className="shrink-0 rounded p-0.5 text-foreground-muted transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

export interface EditMessageChipProps {
  text: string;
  onCancel: () => void;
}

/** Mesaj düzenleme kipini ve gönderildiğinde temiz dal açılacağını gösteren üst şerit. */
export function EditMessageChip({ text, onCancel }: EditMessageChipProps) {
  const preview = collapsePreview(text, 120);

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-2 rounded-md border border-amber-500/35 bg-amber-500/[0.09] px-2.5 py-1.5 text-xs"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Pencil className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 font-medium text-foreground">
            Mesaj düzenleniyor — gönderildiğinde bu noktadan temiz dal açılır
          </span>
          {preview ? (
            <span className="min-w-0 truncate text-foreground-muted" title={text}>
              · {preview}
            </span>
          ) : null}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={onCancel}
        aria-label="Düzenlemeden vazgeç"
      >
        <X className="h-3 w-3" aria-hidden="true" />
        <span>Vazgeç</span>
      </Button>
    </div>
  );
}

export interface ManualCompactButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

/** Bağlam kullanımı verisi dolmadan da tek tıkla `/compact` tetikleyen araç çubuğu düğmesi. */
export function ManualCompactButton({ onClick, disabled }: ManualCompactButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      icon
      onClick={onClick}
      disabled={disabled}
      aria-label="Bağlamı sıkıştır (/compact)"
      title="Bağlamı sıkıştır (/compact)"
    >
      <Minimize2 aria-hidden="true" />
    </Button>
  );
}
