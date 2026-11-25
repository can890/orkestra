import type { ChatItem, PrefixTranscriptTurn, TranscriptTurn } from '@orkestra/chat-ui';

/** Önceki oturum turlarının kimlik ön eki: yeni oturumun aynı sıradaki tur kimlikleriyle çakışmaz. */
const EARLIER_ID_PREFIX = 'earlier-session';
/** Salt okunur önek turları yeni geçmişin (seq >= 0) önünde sıralanır. */
const EARLIER_SEQ_BASE = -2_000_000;

type WithIds = { id?: unknown; parentId?: unknown; children?: unknown };

function rewriteIds<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const item = value as WithIds;
  const next: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if (typeof item.id === 'string') next.id = `${EARLIER_ID_PREFIX}:${item.id}`;
  if (typeof item.parentId === 'string') next.parentId = `${EARLIER_ID_PREFIX}:${item.parentId}`;
  if (Array.isArray(item.children)) next.children = item.children.map((child) => rewriteIds(child));
  return next as T;
}

/**
 * Sohbet yeni bir ajan oturumuyla sürdürüldüğünde eski oturumun turları ekranda kalır ama artık
 * geçmişin parçası değildir: ajan onları hatırlamaz. Bunlar çakışmayan kimlikler ve negatif `seq`
 * ile salt okunur önek turlarına çevrilir.
 */
export function buildEarlierSessionPrefixTurns(
  turns: readonly TranscriptTurn[]
): PrefixTranscriptTurn[] {
  return [...turns]
    .sort((a, b) => a.seq - b.seq)
    .map((turn, index) => ({
      ...turn,
      id: `${EARLIER_ID_PREFIX}:${turn.id}`,
      seq: EARLIER_SEQ_BASE + index,
      items: turn.items.map((item) => rewriteIds(item) as ChatItem),
    }));
}
