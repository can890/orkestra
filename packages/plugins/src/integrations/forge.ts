/**
 * Bitbucket Cloud ve Azure DevOps Services pull request istemcilerinin masaüstüne açılan yüzü.
 * Yalnızca fetch tabanlı, SDK'sız kod içerir; hem PR işçisi hem de depo adresi çözümü kullanır.
 */
export type {
  ForgeActor,
  ForgeCheck,
  ForgeCheckStatus,
  ForgeComment,
  ForgeCreatePullRequestInput,
  ForgeMergeability,
  ForgeMergeInput,
  ForgeMergeMethod,
  ForgePullRequest,
  ForgePullRequestPage,
  ForgePullRequestPageInput,
  ForgePullRequestState,
  ForgePullRequestStateFilter,
} from './helpers/forge-pull-requests';
export type { FetchLike, HttpClient, HttpClientError } from './helpers/http-client';
export type { IntegrationError } from './types';

export { createBitbucketClient, readBitbucketCredentials } from './impl/bitbucket/client';
export {
  createBitbucketPullRequest,
  getBitbucketPullRequest,
  listBitbucketPullRequestChecks,
  listBitbucketPullRequestComments,
  listBitbucketPullRequestPage,
  listBitbucketPullRequests,
  mergeBitbucketPullRequest,
} from './impl/bitbucket/pull-requests';
export {
  BITBUCKET_CLOUD_HOST,
  parseBitbucketRemote,
  resolveBitbucketCloudRepository,
  type BitbucketCloudRepository,
} from './impl/bitbucket/remote';
export { bitbucketCredentialsSchema, type BitbucketCredentials } from './impl/bitbucket/types';

export { createAzureDevOpsClient, readAzureDevOpsCredentials } from './impl/azure-devops/client';
export {
  createAzureDevOpsPullRequest,
  getAzureDevOpsPullRequest,
  listAzureDevOpsPullRequestChecks,
  listAzureDevOpsPullRequestComments,
  listAzureDevOpsPullRequestPage,
  listAzureDevOpsPullRequests,
  mergeAzureDevOpsPullRequest,
} from './impl/azure-devops/pull-requests';
export {
  AZURE_DEVOPS_HOST,
  organizationFromUrl,
  parseAzureDevOpsRemote,
  resolveAzureDevOpsRepository,
  type AzureDevOpsRepository,
} from './impl/azure-devops/remote';
export {
  azureDevOpsCredentialsSchema,
  type AzureDevOpsCredentials,
} from './impl/azure-devops/types';
