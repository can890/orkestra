// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/source-control-azure-devops/src/shared/definition.ts
import { err, ok, type Result } from '@orkestra/shared';
import type { IntegrationError } from '../../types';

export const AZURE_DEVOPS_HOST = 'dev.azure.com';

export type AzureDevOpsRepository = {
  organization: string;
  project: string;
  repository: string;
  /** `https://dev.azure.com/{organization}` — REST çağrılarının kökü. */
  organizationUrl: string;
  /** İnsanların gördüğü depo adresi (`.../{project}/_git/{repository}`). */
  webUrl: string;
};

/**
 * `ssh.dev.azure.com` varsayılan SSH klon sunucusudur; her `*.dev.azure.com` alt alanı Azure'dur.
 * Eski kuruluşlar `.visualstudio.com` altında kalır (`vs-ssh.visualstudio.com` dahil).
 */
export function isAzureDevOpsHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return (
    host === AZURE_DEVOPS_HOST ||
    host.endsWith(`.${AZURE_DEVOPS_HOST}`) ||
    host.endsWith('.visualstudio.com')
  );
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

type RemoteParts = { hostname: string; segments: string[] };

function remoteParts(remoteUrl: string): RemoteParts | null {
  const value = remoteUrl.trim();
  if (!value) return null;
  const split = (path: string) =>
    path
      .replace(/[?#].*$/, '')
      .split('/')
      .filter((part) => part.length > 0)
      .map(decodeSegment);

  if (!value.includes('://')) {
    // scp biçimi: git@ssh.dev.azure.com:v3/org/project/repo
    const scp = /^[^@\s/]+@([^:\s/]+):(.+)$/.exec(value);
    return scp ? { hostname: scp[1].toLowerCase(), segments: split(scp[2]) } : null;
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ssh:', 'git+ssh:'].includes(url.protocol) || !url.hostname) {
      return null;
    }
    return { hostname: url.hostname.toLowerCase(), segments: split(url.pathname) };
  } catch {
    return null;
  }
}

function toRepository(
  organization: string,
  project: string,
  repository: string
): AzureDevOpsRepository | null {
  const repo = repository.replace(/\.git$/i, '');
  if (!organization || !project || !repo) return null;
  const organizationUrl = `https://${AZURE_DEVOPS_HOST}/${encodeURIComponent(organization)}`;
  return {
    organization,
    project,
    repository: repo,
    organizationUrl,
    webUrl: `${organizationUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`,
  };
}

/** `_git/_optimized/<depo>` ve `_git/_full/<depo>` klon biçimleri de aynı depoyu adlar. */
function repositoryAfterGit(segments: string[], gitIndex: number): string | undefined {
  const next = segments[gitIndex + 1];
  if (next === '_optimized' || next === '_full') return segments[gitIndex + 2];
  return next;
}

/**
 * Azure DevOps Services remote'unu ya da web adresini `{organization, project, repository}`
 * üçlüsüne çözer. Desteklenen biçimler:
 * - `https://[kullanıcı@]dev.azure.com/{org}/{project}/_git/{repo}` (ve `{org}/_git/{repo}`)
 * - `https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}`
 * - `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`, `ssh://git@ssh.dev.azure.com/v3/...`
 * - `{org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}`
 * - Masaüstünün normalize ettiği `https://ssh.dev.azure.com/v3/{org}/{project}/{repo}`
 */
export function parseAzureDevOpsRemote(
  remoteUrl: string | null | undefined
): AzureDevOpsRepository | null {
  const parts = remoteParts(remoteUrl ?? '');
  if (!parts || !isAzureDevOpsHost(parts.hostname)) return null;
  const { hostname, segments } = parts;

  // SSH: v3/{org}/{project}/{repo}
  if (segments[0]?.toLowerCase() === 'v3') {
    const [, organization, project, repository] = segments;
    if (segments.length !== 4 || !organization || !project || !repository) return null;
    return toRepository(organization, project, repository);
  }

  const gitIndex = segments.indexOf('_git');
  if (gitIndex < 0) return null;
  const repository = repositoryAfterGit(segments, gitIndex);
  if (!repository) return null;
  const before = segments.slice(0, gitIndex);

  if (hostname === AZURE_DEVOPS_HOST) {
    // {org}/{project}/_git/{repo} ya da projeyle aynı adlı depo için {org}/_git/{repo}.
    if (before.length === 2) return toRepository(before[0], before[1], repository);
    if (before.length === 1) return toRepository(before[0], repository, repository);
    return null;
  }

  if (hostname.endsWith('.visualstudio.com') && !hostname.startsWith('vs-ssh.')) {
    // Eski kuruluş ana makine adının kendisidir: {org}.visualstudio.com/[DefaultCollection/]{project}
    const organization = hostname.slice(0, -'.visualstudio.com'.length);
    const path =
      before[0]?.toLowerCase() === 'defaultcollection' ? before.slice(1) : before.slice();
    if (path.length === 1) return toRepository(organization, path[0], repository);
    if (path.length === 0) return toRepository(organization, repository, repository);
    return null;
  }

  return null;
}

/** Bir kimlik bilgisinin kuruluş adresinden kuruluş adını çıkarır. */
export function organizationFromUrl(organizationUrl: string): string | null {
  try {
    const url = new URL(organizationUrl);
    const host = url.hostname.toLowerCase();
    if (host === AZURE_DEVOPS_HOST) {
      const [organization] = url.pathname.split('/').filter(Boolean);
      return organization ? decodeSegment(organization) : null;
    }
    if (host.endsWith('.visualstudio.com')) {
      return host.slice(0, -'.visualstudio.com'.length) || null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Kullanıcının girdiği kuruluşu `https://dev.azure.com/{org}` biçimine getirir. Kabul edilenler:
 * çıplak kuruluş adı, `dev.azure.com/{org}` adresi ve eski `{org}.visualstudio.com` adresi.
 * Azure DevOps Server (şirket içi) desteklenmez.
 */
export function normalizeAzureDevOpsOrganizationUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  if (/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(trimmed)) {
    return `https://${AZURE_DEVOPS_HOST}/${trimmed}`;
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const organization = organizationFromUrl(withScheme);
  if (!organization || !/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(organization)) return null;
  return `https://${AZURE_DEVOPS_HOST}/${organization}`;
}

/**
 * Depo adresini çözer ve kimlik bilgisinin kuruluşuyla eşleştiğini doğrular; başka kuruluşa
 * kimlik bilgisi gönderilmez.
 */
export function resolveAzureDevOpsRepository(
  repositoryUrl: string | undefined,
  organizationUrl: string
): Result<AzureDevOpsRepository, IntegrationError> {
  const value = repositoryUrl?.trim();
  if (!value) return err({ type: 'invalid_input', message: 'Repository URL is required.' });
  const repository = parseAzureDevOpsRemote(value);
  if (!repository) {
    return err({
      type: 'unsupported_host',
      message: 'The repository remote is not an Azure DevOps Services repository.',
    });
  }
  const organization = organizationFromUrl(organizationUrl);
  if (!organization || organization.toLowerCase() !== repository.organization.toLowerCase()) {
    return err({
      type: 'unsupported_host',
      message: `The repository belongs to Azure DevOps organization "${repository.organization}", but this account is connected to "${organization ?? organizationUrl}".`,
    });
  }
  return ok(repository);
}
