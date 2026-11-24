/**
 * Sağlayıcıdan bağımsız pull request şekilleri. Bitbucket ve Azure DevOps istemcileri kendi
 * sözlüklerini bu şekillere eşler. Masaüstündeki PR arayüzü şimdilik yalnızca GitHub'a bağlı
 * olduğundan bu tipler eklenti paketinin içinde kalır; ortak bir PR eklenti yeteneği geldiğinde
 * buradan taşınabilir.
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
