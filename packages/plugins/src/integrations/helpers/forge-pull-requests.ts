/**
 * Sağlayıcıdan bağımsız pull request şekilleri. Bitbucket ve Azure DevOps istemcileri kendi
 * sözlüklerini bu şekillere eşler. Masaüstü bunları `@orkestra/plugins/integrations/forge`
 * girişinden alır ve kendi PR önbelleği şekline çevirir.
 */

export type ForgePullRequestState = 'open' | 'closed' | 'merged';

export type ForgePullRequestStateFilter = ForgePullRequestState | 'all';

export type ForgeMergeability = 'mergeable' | 'conflicting' | 'unknown';

export type ForgeCheckStatus =
  | 'success'
  | 'failure'
  | 'pending'
  | 'cancelled'
  | 'skipped'
  | 'neutral'
  | 'action-required';

export type ForgeMergeMethod = 'merge' | 'squash' | 'rebase';

export type ForgeActor = {
  login: string;
  name: string | null;
  avatarUrl: string | null;
};

export type ForgePullRequest = {
  number: number;
  title: string;
  url: string;
  body: string;
  state: ForgePullRequestState;
  isDraft: boolean;
  author: ForgeActor | null;
  headBranch: string;
  headSha: string | null;
  baseBranch: string;
  /** Hedef dalın PR'ın karşılaştırıldığı commit'i; sağlayıcı bildirmezse `null`. */
  baseSha: string | null;
  mergeability: ForgeMergeability;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  reviewers: ForgeActor[];
};

export type ForgeCheck = {
  name: string;
  status: ForgeCheckStatus;
  description: string | null;
  url: string | null;
  required?: boolean;
};

export type ForgeComment = {
  id: string;
  author: ForgeActor | null;
  body: string;
  createdAt: string;
  url: string | null;
  /** Satır içi inceleme yorumunun dosyası; genel yorumlarda `null`. */
  path: string | null;
};

export type ForgeCreatePullRequestInput = {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  isDraft?: boolean;
};

export type ForgeMergeInput = {
  number: number;
  method?: ForgeMergeMethod;
  /** Birleştirilecek baş commit; araya push girmişse sağlayıcı reddeder. */
  expectedHeadSha?: string;
  deleteSourceBranch?: boolean;
};

/** Tek bir PR liste sayfası isteği; `page` 1'den başlar. */
export type ForgePullRequestPageInput = {
  state?: ForgePullRequestStateFilter;
  sourceBranch?: string;
  page?: number;
  pageSize?: number;
};

/**
 * Tek bir PR liste sayfası. `nextPage` yalnızca sağlayıcı ardından en az bir sayfa daha olduğunu
 * bildirdiğinde doludur; son sayfada (tam dolu olsa bile) `null` olur.
 */
export type ForgePullRequestPage = {
  pullRequests: ForgePullRequest[];
  nextPage: number | null;
};

/** Sayfa numarasını 1 ya da üstü bir tamsayıya indirger. */
export function normalizePageNumber(page: number | undefined): number {
  return Number.isSafeInteger(page) && (page as number) >= 1 ? (page as number) : 1;
}

export function trimmedOrNull(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return text.length > 0 ? text : null;
}

/** Aynı anahtarla yeniden çalışan kontrollerde son kayıt kazanır. */
export function dedupeChecksByKey(entries: { key: string; check: ForgeCheck }[]): ForgeCheck[] {
  const byKey = new Map<string, ForgeCheck>();
  for (const entry of entries) byKey.set(entry.key, entry.check);
  return [...byKey.values()];
}
