import { expect, it, vi } from 'vitest';
import {
  fetchReviewFiles,
  fetchReviewHunks,
  listReviewPullRequests,
  setReviewViewed,
} from './pull-request-review';
import type { RemoteApi } from './wire-client';

it('reads revision-bound PR hunks and sends a scoped account mark', async () => {
  const url = 'https://github.com/owner/repo/pull/3';
  const call = vi
    .fn()
    .mockResolvedValueOnce({ success: true, data: { prs: [{ url, number: 3, title: 'PR' }] } })
    .mockResolvedValueOnce({
      success: true,
      data: {
        account: 'account',
        files: [{ path: 'src/main.ts', revision: 'revision', viewed: false, additions: 1 }],
      },
    })
    .mockResolvedValueOnce({
      success: true,
      data: { hunks: [{ id: 'one', header: '@@', lines: ['+change'] }] },
    })
    .mockResolvedValueOnce({ success: true });
  const api: RemoteApi = { call, live: vi.fn() };

  expect(await listReviewPullRequests(api, 'workspace')).toEqual([{ url, number: 3, title: 'PR' }]);
  const { account, files } = await fetchReviewFiles(api, 'workspace', url);
  expect(files[0]).toMatchObject({ path: 'src/main.ts', revision: 'revision', viewed: false });
  expect(await fetchReviewHunks(api, 'workspace', url, files[0]!)).toEqual([
    { id: 'one', header: '@@', lines: ['+change'] },
  ]);
  await setReviewViewed(api, 'workspace', url, files[0]!, account);
  expect(call).toHaveBeenLastCalledWith('sourceControl.review.setViewed', {
    workspaceId: 'workspace',
    url,
    path: 'src/main.ts',
    revision: 'revision',
    account,
    viewed: true,
  });
});
