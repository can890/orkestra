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
  const verb = record.mode === 'fork' ? 'çatallandı' : 'devredildi';
  return `"${record.sourceTitle}" sohbetinden ${verb}`;
}

/** Sekmede soy bilgisini gösteren küçük rozet; çatal/devir değilse hiçbir şey çizmez. */
export function HandoffBadge({ conversationId }: { conversationId: string }) {
  const record = useHandoffRecord(conversationId);
  if (!record) return null;
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

/** Boş sohbetin karşılama alanında, bağlamın eklendiğini bildirir. */
export function HandoffNotice({ conversationId }: { conversationId: string }) {
  const record = useHandoffRecord(conversationId);
  if (!record?.context) return null;
  return (
    <p className="mx-auto mt-3 max-w-md text-xs text-foreground-muted">
      {describe(record)}. Önceki konuşmanın özeti ({record.context.length.toLocaleString('tr-TR')}{' '}
      karakter) ilk mesajınızla birlikte gönderilecek; kendiliğinden gönderilmez.
    </p>
  );
}
