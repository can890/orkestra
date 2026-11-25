import { parseRepositoryRef } from '@core/primitives/repository/api';

/**
 * PR sağlayıcısı, kanonik depo adresinin ana makinesinden çıkarılır. `bitbucket.org` ve
 * `dev.azure.com` dışındaki her ana makine GitHub (github.com ya da GHES) yolunda kalır; böylece
 * GitHub davranışı değişmez.
 */
export type PullRequestProviderId = 'github' | 'bitbucket' | 'azure-devops';

export type PullRequestProviderInfo = {
  id: PullRequestProviderId;
  /** Arayüzde gösterilen ad. */
  name: string;
  /** GitHub'ın yerel auto-merge'ü ("Kontroller geçince birleştir"). */
  autoMerge: boolean;
  /** Taslak PR'ı uygulamadan "hazır" işaretleme. */
  markReadyForReview: boolean;
  /** Kural atlama (bypass) ile birleştirme; GitHub'ın yönetici atlamasına özgüdür. */
  bypassRequirements: boolean;
  /** `mergeStateStatus` (CLEAN/BLOCKED/…) bildirir mi; bildirmeyenlerde kuralları sağlayıcı uygular. */
  mergeStateStatus: boolean;
};

const providers: Record<PullRequestProviderId, PullRequestProviderInfo> = {
  github: {
    id: 'github',
    name: 'GitHub',
    autoMerge: true,
    markReadyForReview: true,
    bypassRequirements: true,
    mergeStateStatus: true,
  },
  bitbucket: {
    id: 'bitbucket',
    name: 'Bitbucket',
    autoMerge: false,
    markReadyForReview: false,
    bypassRequirements: false,
    mergeStateStatus: false,
  },
  'azure-devops': {
    id: 'azure-devops',
    name: 'Azure DevOps',
    autoMerge: false,
    markReadyForReview: false,
    bypassRequirements: false,
    mergeStateStatus: false,
  },
};

export function pullRequestProviderForHost(host: string | null | undefined): PullRequestProviderId {
  const value = host?.trim().toLowerCase();
  if (value === 'bitbucket.org') return 'bitbucket';
  if (value === 'dev.azure.com') return 'azure-devops';
  return 'github';
}

export function pullRequestProviderForRepositoryUrl(
  repositoryUrl: string | null | undefined
): PullRequestProviderId {
  return pullRequestProviderForHost(parseRepositoryRef(repositoryUrl)?.host);
}

export function pullRequestProviderInfo(
  provider: string | null | undefined
): PullRequestProviderInfo {
  return provider && provider in providers
    ? providers[provider as PullRequestProviderId]
    : providers.github;
}

/**
 * PR önbelleğinin anahtarı olan web adresi. GitHub `/pull/N`, Bitbucket `/pull-requests/N`,
 * Azure DevOps `/pullrequest/N` kullanır; sağlayıcının döndürdüğü `url` ile aynıdır.
 */
export function pullRequestUrlFor(repositoryUrl: string, number: number): string {
  switch (pullRequestProviderForRepositoryUrl(repositoryUrl)) {
    case 'bitbucket':
      return `${repositoryUrl}/pull-requests/${number}`;
    case 'azure-devops':
      return `${repositoryUrl}/pullrequest/${number}`;
    case 'github':
      return `${repositoryUrl}/pull/${number}`;
  }
}
