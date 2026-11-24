import type { BitbucketIssue, BitbucketUser } from '../../../integrations/impl/bitbucket/types';
import type { IssueData, IssueDetail } from '../../types';

/** Bitbucket Cloud'da "açık" sayılan iş durumları. */
export const BITBUCKET_OPEN_ISSUE_STATES = ['new', 'open', 'on hold'] as const;

export function bitbucketUserName(user: BitbucketUser | null | undefined): string | undefined {
  return user?.display_name || user?.nickname || user?.username || undefined;
}

export function toIssueData(issue: BitbucketIssue, repoName: string): IssueData {
  const assignee = bitbucketUserName(issue.assignee);
  return {
    identifier: `#${issue.id}`,
    title: issue.title,
    url: issue.links?.html?.href ?? '',
    description: issue.content?.raw || undefined,
    status: issue.state ?? undefined,
    assignees: assignee ? [assignee] : undefined,
    project: repoName,
    updatedAt: issue.updated_on ?? undefined,
  };
}

export function toIssueDetail(
  issue: BitbucketIssue,
  repoName: string,
  comments: { author?: string; body: string; createdAt?: string }[]
): IssueDetail {
  const data = toIssueData(issue, repoName);
  const lines = [
    `Kind: ${issue.kind ?? 'issue'}`,
    ...(issue.priority ? [`Priority: ${issue.priority}`] : []),
    ...(bitbucketUserName(issue.reporter)
      ? [`Reporter: ${bitbucketUserName(issue.reporter)}`]
      : []),
  ];
  const commentBlocks = comments
    .filter((comment) => comment.body.trim().length > 0)
    .map(
      (comment) =>
        `- ${comment.author ?? 'Unknown'}${comment.createdAt ? ` (${comment.createdAt})` : ''}: ${comment.body.trim()}`
    );
  return {
    ...data,
    context: [
      lines.join('\n'),
      ...(commentBlocks.length > 0 ? [`Comments:\n${commentBlocks.join('\n')}`] : []),
    ].join('\n\n'),
  };
}
