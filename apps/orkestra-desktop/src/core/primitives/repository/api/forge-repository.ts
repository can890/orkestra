import { parseAzureDevOpsRemote, parseBitbucketRemote } from '@orkestra/plugins/integrations/forge';

/** GitHub dışında pull request desteği olan barındırma sağlayıcıları (entegrasyon kimlikleri). */
export type ForgeProvider = 'bitbucket' | 'azure-devops';

export type ForgeRepositoryRef = {
  provider: ForgeProvider;
  host: string;
  owner: string;
  repo: string;
  nameWithOwner: string;
  /** Sağlayıcının tek kanonik depo adresi; PR önbelleği ve hesap eşleştirme bu adresi kullanır. */
  repositoryUrl: string;
};

/**
 * Bitbucket Cloud ve Azure DevOps Services remote'larını tek bir kanonik adrese çözer. Aynı depo
 * farklı klon biçimleriyle gelir (`git@bitbucket.org:`, `altssh.bitbucket.org:443`,
 * `git@ssh.dev.azure.com:v3/…`, eski `{org}.visualstudio.com`); PR önbelleği ve görev–PR eşlemesi
 * depoyu tek kimlikle tanımalıdır. Bitbucket Data Center ve Azure DevOps Server tanınmaz (`null`).
 */
export function parseForgeRepositoryRef(
  input: string | null | undefined
): ForgeRepositoryRef | null {
  const value = input?.trim();
  if (!value) return null;

  const bitbucket = parseBitbucketRemote(value);
  if (bitbucket?.deployment === 'cloud') {
    return {
      provider: 'bitbucket',
      host: bitbucket.host,
      owner: bitbucket.workspace,
      repo: bitbucket.repoSlug,
      nameWithOwner: bitbucket.fullName,
      repositoryUrl: `https://${bitbucket.host}/${bitbucket.fullName}`,
    };
  }

  const azure = parseAzureDevOpsRemote(value);
  if (azure) {
    return {
      provider: 'azure-devops',
      host: 'dev.azure.com',
      owner: `${azure.organization}/${azure.project}`,
      repo: azure.repository,
      nameWithOwner: `${azure.organization}/${azure.project}/${azure.repository}`,
      repositoryUrl: azure.webUrl,
    };
  }
  return null;
}
