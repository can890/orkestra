import { parseReviewReport } from './review-findings';
import type { ReviewReport } from './review-model';

/** Transcript turunun inceleme için gereken asgari biçimi (ACP `TranscriptTurn` ile uyumlu). */
export type ReviewTurnLike = Readonly<{
  id: string;
  items: ReadonlyArray<Readonly<{ kind: string; role?: string; text?: string }>>;
  outcome?: Readonly<{ kind: string }>;
}>;

export type LocatedReviewReport = Readonly<{
  turnId: string;
  /** Tur sonuçlanmış mı (sonuç bilgisi olmayan yeniden oynatılmış turlar da bitmiş sayılır). */
  settled: boolean;
  report: ReviewReport;
}>;

function assistantText(turn: ReviewTurnLike): string {
  return turn.items
    .filter((item) => item.kind === 'message' && item.role === 'assistant' && item.text)
    .map((item) => item.text)
    .join('\n\n');
}

/**
 * En yeni turdan geriye doğru, yapılandırılmış inceleme raporu içeren ilk turu bulur. Kullanıcı
 * inceleme sohbetinde takip soruları sorduysa son rapor yine bulunur.
 */
export function findLatestReviewReport(
  turns: readonly ReviewTurnLike[],
  options: Readonly<{ activeTurnId?: string | null }> = {}
): LocatedReviewReport | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const text = assistantText(turn);
    if (!text.trim()) continue;
    const report = parseReviewReport(text);
    if (!report.structured) continue;
    const settled = turn.id !== options.activeTurnId;
    return { turnId: turn.id, settled, report };
  }
  return null;
}
