import type { HandoffTurn } from '@core/features/conversations/api/handoff-summary';

export { handoffTitle } from '@core/features/conversations/api/handoff-title';

export const MAX_PAGES = 6;

export type HistoryPageResult =
  | {
      success: true;
      data: { turns: readonly HandoffTurn[]; nextCursor: number | null; unavailable?: true };
    }
  | { success: false; error: unknown };

/**
 * Geçmişi en yeniden geriye doğru sayfalayarak toplar (en fazla `MAX_PAGES` sayfa) ve
 * kronolojik sırada döndürür. Geçmiş okunamıyorsa `fallback` kullanılır; o da yoksa hata fırlatır.
 */
export async function collectHistoryTurns(
  loadPage: (before: number | undefined) => Promise<HistoryPageResult>,
  fallback: readonly HandoffTurn[] = [],
  maxPages: number = MAX_PAGES
): Promise<HandoffTurn[]> {
  const pages: (readonly HandoffTurn[])[] = [];
  let before: number | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await loadPage(before);
    if (!result.success) {
      if (pages.length === 0 && fallback.length > 0) return [...fallback];
      throw new Error('Sohbet geçmişi okunamadı.');
    }
    if (result.data.unavailable) {
      if (pages.length === 0 && fallback.length > 0) return [...fallback];
      break;
    }
    pages.unshift(result.data.turns);
    if (result.data.nextCursor === null) break;
    before = result.data.nextCursor;
  }
  return pages.flat();
}
