import { z } from 'zod';
import { gitOperationCredentialsSchema } from '#runtimes/git/api/schemas';
import { repositorySelectorSchema } from '#runtimes/git/api/selectors';

/**
 * Repository subdomain schemas: the input shapes for repository-scoped jobs
 * (fetch / fetch-PR). The worktree descriptor (`checkoutInfoSchema`)
 * is cross-cutting and lives in `../api/schemas`.
 */

export const fetchPrForReviewOptionsSchema = z.object({
  prNumber: z.number().int(),
  headRefName: z.string(),
  headRepositoryUrl: z.string(),
  localBranch: z.string(),
  isFork: z.boolean(),
  /**
   * The effective base remote, resolved by the caller (blessed resolver;
   * spec: github-git-settings §2) — this layer never invents one. Unused for
   * fork PRs, which fetch through a dedicated fork remote.
   */
  configuredRemote: z.string(),
});
export type FetchPrForReviewOptions = z.infer<typeof fetchPrForReviewOptionsSchema>;

// -- Job inputs --

export const fetchJobInputSchema = repositorySelectorSchema.extend({
  remote: z.string().optional(),
  refspec: z.string().optional(),
  force: z.boolean().optional(),
  credentials: gitOperationCredentialsSchema.optional(),
});
export type FetchJobInput = z.infer<typeof fetchJobInputSchema>;

export const fetchPrForReviewJobInputSchema = repositorySelectorSchema.extend({
  options: fetchPrForReviewOptionsSchema,
  credentials: gitOperationCredentialsSchema.optional(),
});
export type FetchPrForReviewJobInput = z.infer<typeof fetchPrForReviewJobInputSchema>;

// -- Local branch merge/squash --

export const localMergeStrategySchema = z.enum(['merge', 'squash']);
export type LocalMergeStrategy = z.infer<typeof localMergeStrategySchema>;

export const mergeLocalBranchInputSchema = repositorySelectorSchema.extend({
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  strategy: localMergeStrategySchema,
  commitMessage: z.string().optional(),
});
export type MergeLocalBranchInput = z.infer<typeof mergeLocalBranchInputSchema>;

export const mergeLocalBranchResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('merged'),
    commitHash: z.string(),
    mergedCommits: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('already-up-to-date'),
  }),
  z.object({
    kind: z.literal('dirty-target'),
    message: z.string(),
  }),
  z.object({
    kind: z.literal('merge-conflict'),
    files: z.array(z.string()),
    message: z.string(),
  }),
]);
export type MergeLocalBranchResult = z.infer<typeof mergeLocalBranchResultSchema>;
