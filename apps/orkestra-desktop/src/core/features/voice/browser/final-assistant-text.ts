// Bir sohbet turunun sesli okunacak son asistan mesajını seçer. ACP turu tipine yapısal olarak
// bağlanır; böylece bu dosya chat-ui ya da core paketlerini içe aktarmadan test edilebilir.

export type SpeakableTurnItem = {
  kind: string;
  role?: string;
  text?: string;
};

export type SpeakableTurn = {
  id: string;
  items: readonly SpeakableTurnItem[];
  outcome?: { kind: string };
};

/**
 * İptal edilen, hatayla ya da kesintiyle biten turlar okunmaz. Tamamlanan turda en son
 * boş olmayan asistan mesajı döner (araç çağrılarından sonraki özet genellikle budur).
 */
export function finalAssistantText(turn: SpeakableTurn | null | undefined): string | null {
  if (!turn) return null;
  if (turn.outcome && turn.outcome.kind !== 'done') return null;
  for (let index = turn.items.length - 1; index >= 0; index--) {
    const item = turn.items[index];
    if (item.kind === 'message' && item.role === 'assistant' && item.text?.trim()) {
      return item.text;
    }
  }
  return null;
}

/** Görüntülenen turlar ile etkin turdan sesli okunacak son turu seçer. */
export function latestSpeakableTurn(
  displayTurns: readonly SpeakableTurn[],
  activeTurn: SpeakableTurn | null
): SpeakableTurn | null {
  return activeTurn ?? displayTurns[displayTurns.length - 1] ?? null;
}
