import { parseGitHunks, unwrapResult, type MobileGitChange, type RemoteApi } from './wire-client';

export type ReviewPullRequest = { url: string; title: string; number: number };
export type ReviewFile = MobileGitChange & { revision: string; viewed: boolean };

function records(value: unknown, key: string): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  const items = (value as Record<string, unknown>)[key];
  return Array.isArray(items) ? items.filter((item) => item && typeof item === 'object') : [];
}

export async function listReviewPullRequests(api: RemoteApi, workspaceId: string) {
  const data = unwrapResult(await api.call('sourceControl.review.list', { workspaceId }));
  return records(data, 'prs').flatMap(({ url, title, number }) =>
    typeof url === 'string' && typeof title === 'string' && typeof number === 'number'
      ? [{ url, title, number }]
      : []
  );
}

export async function fetchReviewFiles(
  api: RemoteApi,
  workspaceId: string,
  url: string
): Promise<{ account: string; files: ReviewFile[] }> {
  const data = unwrapResult(await api.call('sourceControl.review.files', { workspaceId, url }));
  const account = (data as { account?: unknown } | null)?.account;
  if (typeof account !== 'string') throw new Error('Missing review account');
  const files = records(data, 'files').flatMap(
    ({ path, revision, viewed, status, additions, deletions }) =>
      typeof path === 'string' && typeof revision === 'string'
        ? [
            {
              path,
              revision,
              viewed: viewed === true,
              status: String(status ?? 'modified'),
              additions: typeof additions === 'number' ? additions : 0,
              deletions: typeof deletions === 'number' ? deletions : 0,
            },
          ]
        : []
  );
  return { account, files };
}

export async function fetchReviewHunks(
  api: RemoteApi,
  workspaceId: string,
  url: string,
  file: Pick<ReviewFile, 'path' | 'revision'>
) {
  return parseGitHunks(
    unwrapResult(
      await api.call('sourceControl.review.hunks', {
        workspaceId,
        url,
        path: file.path,
        revision: file.revision,
      })
    )
  );
}

export async function setReviewViewed(
  api: RemoteApi,
  workspaceId: string,
  url: string,
  file: ReviewFile,
  account: string
) {
  unwrapResult(
    await api.call('sourceControl.review.setViewed', {
      workspaceId,
      url,
      path: file.path,
      revision: file.revision,
      viewed: !file.viewed,
      account,
    })
  );
}
