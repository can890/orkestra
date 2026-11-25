import { Button } from '@orkestra/ui/react/primitives';
import { ArrowRightLeft, GitFork } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { getHandoffStore, type HandoffRecord } from './handoff-store';

function useHandoffRecord(conversationId: string): HandoffRecord | undefined {
  const store = getHandoffStore();
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.get(conversationId)
  );
}

function describe(record: HandoffRecord): string {
  const verb =
    record.mode === 'fork'
      ? 'çatallandı'
      : record.mode === 'context-handoff'
        ? 'yeni bağlama taşındı'
        : 'devredildi';
  return `"${record.sourceTitle}" sohbetinden ${verb}`;
}

/** Sekmede soy bilgisini gösteren küçük rozet; çatal/devir değilse hiçbir şey çizmez. */
export function HandoffBadge({ conversationId }: { conversationId: string }) {
  const record = useHandoffRecord(conversationId);
  if (!record || record.mode === 'inline-handoff') return null;
  const Icon = record.mode === 'fork' ? GitFork : ArrowRightLeft;
  return (
    <span
      className="inline-flex shrink-0 items-center text-foreground-muted"
      title={describe(record)}
      aria-label={describe(record)}
    >
      <Icon size={12} aria-hidden="true" />
    </span>
  );
}

/**
 * Boş sohbetin karşılama alanında, bağlamın eklendiğini bildirir. Devirle açılan sohbette ayrıca
 * "Kaldığı yerden devam et" düğmesi çıkar; mesaj yalnızca bu düğmeye tıklanınca gönderilir.
 */
export function HandoffNotice({
  conversationId,
  onContinue,
  continueDisabled,
}: {
  conversationId: string;
  /** Verilirse (ve sohbet devirse) "Kaldığı yerden devam et" düğmesi gösterilir. */
  onContinue?: (() => void) | undefined;
  continueDisabled?: boolean;
}) {
  const record = useHandoffRecord(conversationId);
  if (!record?.context || record.mode === 'inline-handoff') return null;
  return (
    <div className="mx-auto mt-3 flex max-w-md flex-col items-center gap-3">
      <p className="text-xs text-foreground-muted">
        {describe(record)}. Önceki konuşmanın özeti ({record.context.length.toLocaleString('tr-TR')}{' '}
        karakter) ilk mesajınızla birlikte gönderilecek; kendiliğinden gönderilmez.
      </p>
      {record.mode === 'handoff' && onContinue ? (
        <Button type="button" variant="primary" disabled={continueDisabled} onClick={onContinue}>
          Kaldığı yerden devam et
        </Button>
      ) : null}
    </div>
  );
}
