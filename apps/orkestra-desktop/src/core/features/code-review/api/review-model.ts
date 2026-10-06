/**
 * Kod incelemesi (code review) özelliğinin çalışma zamanından bağımsız veri modeli. İnceleme,
 * görevin worktree'sinde yeni bir ACP konuşması olarak çalışır; burada yalnızca kapsam, odak ve
 * ayrıştırılmış bulgu tipleri tanımlanır.
 */

/** İncelenecek değişiklik kümesi. */
export const REVIEW_SCOPES = ['uncommitted', 'branch', 'last-commit'] as const;
export type ReviewScope = (typeof REVIEW_SCOPES)[number];

/** İncelemenin odaklanacağı alanlar. */
export const REVIEW_FOCUS_AREAS = ['correctness', 'security', 'simplification'] as const;
export type ReviewFocus = (typeof REVIEW_FOCUS_AREAS)[number];

/** Bulgu önem dereceleri; en ciddiden en hafife sıralıdır. */
export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** İnceleyicinin son kararı. */
export const REVIEW_VERDICTS = ['approve', 'comment', 'request-changes'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export type ReviewFinding = {
  /** Aynı rapor yeniden ayrıştırıldığında değişmeyen kimlik (seçim durumunu korumak için). */
  id: string;
  /** Rapordaki 1 tabanlı sıra. */
  index: number;
  severity: FindingSeverity;
  /** Depo köküne göre yol (ya da ajanın yazdığı mutlak yol); belirlenemezse null. */
  file: string | null;
  /** 1 tabanlı satır; belirlenemezse null. */
  line: number | null;
  endLine: number | null;
  /** Ajanın yazdığı ham konum metni. */
  location: string | null;
  summary: string;
  failureScenario: string | null;
  suggestedFix: string | null;
};

export type ReviewReport = {
  findings: ReviewFinding[];
  verdict: ReviewVerdict | null;
  verdictRationale: string | null;
  /** İnceleyici açıkça "bulgu yok" dedi. */
  noFindings: boolean;
  /** Metin beklenen yapıyı (bulgu, "bulgu yok" ya da karar) içeriyor. */
  structured: boolean;
};

export function severityRank(severity: FindingSeverity): number {
  return FINDING_SEVERITIES.indexOf(severity);
}

export function isReviewScope(value: unknown): value is ReviewScope {
  return typeof value === 'string' && (REVIEW_SCOPES as readonly string[]).includes(value);
}

export function isReviewFocus(value: unknown): value is ReviewFocus {
  return typeof value === 'string' && (REVIEW_FOCUS_AREAS as readonly string[]).includes(value);
}
