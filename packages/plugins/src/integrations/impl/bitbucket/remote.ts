// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/source-control-bitbucket/src/shared/definition.ts, packages/source-control-bitbucket/src/server/BitbucketApi.ts
import { err, ok, type Result } from '@orkestra/shared';
import type { IntegrationError } from '../../types';

export const BITBUCKET_CLOUD_HOST = 'bitbucket.org';
export const BITBUCKET_CLOUD_WEB_URL = 'https://bitbucket.org';

export type BitbucketCloudRepository = {
  deployment: 'cloud';
  host: typeof BITBUCKET_CLOUD_HOST;
  workspace: string;
  repoSlug: string;
  fullName: string;
};

export type BitbucketDataCenterRepository = {
  deployment: 'data-center';
  host: string;
  projectKey: string;
  repoSlug: string;
};

export type BitbucketRemote = BitbucketCloudRepository | BitbucketDataCenterRepository;

/** Cloud, `ssh.bitbucket.org` ve `altssh.bitbucket.org` üzerinden de klonlanır. */
export function isBitbucketCloudHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === BITBUCKET_CLOUD_HOST || host.endsWith(`.${BITBUCKET_CLOUD_HOST}`);
}

/** Kendi sunucusunda çalışan Bitbucket (Data Center / Server) yalnızca ad etiketiyle tanınır. */
export function isBitbucketSelfHostedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return !isBitbucketCloudHost(host) && host.split('.').includes('bitbucket');
}

type RemoteParts = { hostname: string; segments: string[] };

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function splitPath(path: string): string[] {
  return path
    .replace(/[?#].*$/, '')
    .split('/')
    .filter((part) => part.length > 0)
    .map(decodeSegment);
}

function remoteParts(remoteUrl: string): RemoteParts | null {
  const value = remoteUrl.trim();
  if (!value) return null;

  if (!value.includes('://')) {
    // scp biçimi: git@bitbucket.org:workspace/repo.git
    const scp = /^[^@\s/]+@([^:\s/]+):(.+)$/.exec(value);
    return scp ? { hostname: scp[1].toLowerCase(), segments: splitPath(scp[2]) } : null;
  }

  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ssh:', 'git+ssh:'].includes(url.protocol) || !url.hostname) {
      return null;
    }
    return { hostname: url.hostname.toLowerCase(), segments: splitPath(url.pathname) };
  } catch {
    return null;
  }
}

function stripGit(value: string): string {
  return value.replace(/\.git$/i, '');
}

function parseDataCenterSegments(
  hostname: string,
  segments: string[]
): BitbucketDataCenterRepository | null {
  // HTTPS klonu: /<bağlam>/scm/<PROJE>/<depo>.git (kişisel depolar ~kullanıcı ile başlar).
  const scm = segments.indexOf('scm');
  if (scm >= 0 && segments.length >= scm + 3) {
    return {
      deployment: 'data-center',
      host: hostname,
      projectKey: segments[scm + 1],
      repoSlug: stripGit(segments[scm + 2]),
    };
  }
  // Web adresi: /projects/<PROJE>/repos/<depo>/browse ya da /users/<kullanıcı>/repos/<depo>.
  const repos = segments.indexOf('repos');
  if (repos >= 2 && (segments[repos - 2] === 'projects' || segments[repos - 2] === 'users')) {
    const owner = segments[repos - 1];
    const repo = segments[repos + 1];
    if (owner && repo) {
      return {
        deployment: 'data-center',
        host: hostname,
        projectKey: segments[repos - 2] === 'users' ? `~${owner}` : owner,
        repoSlug: stripGit(repo),
      };
    }
  }
  // SSH klonu: ssh://git@host:7999/<proje>/<depo>.git
  if (segments.length === 2) {
    return {
      deployment: 'data-center',
      host: hostname,
      projectKey: segments[0],
      repoSlug: stripGit(segments[1]),
    };
  }
  return null;
}

/**
 * Bir Git remote'unu ya da Bitbucket web adresini çözer. Bitbucket Cloud için `workspace/repo`,
 * Data Center için `PROJE/repo` döndürür. Bitbucket olmayan adresler için `null`.
 */
export function parseBitbucketRemote(remoteUrl: string | null | undefined): BitbucketRemote | null {
  const parts = remoteParts(remoteUrl ?? '');
  if (!parts) return null;

  if (isBitbucketCloudHost(parts.hostname)) {
    const [workspace, repo] = parts.segments;
    if (!workspace || !repo) return null;
    const repoSlug = stripGit(repo);
    if (!repoSlug) return null;
    return {
      deployment: 'cloud',
      host: BITBUCKET_CLOUD_HOST,
      workspace,
      repoSlug,
      fullName: `${workspace}/${repoSlug}`,
    };
  }

  if (isBitbucketSelfHostedHost(parts.hostname)) {
    return parseDataCenterSegments(parts.hostname, parts.segments);
  }

  return null;
}

/** Bir depo adresini yalnızca Bitbucket Cloud deposu olarak kabul eder. */
export function resolveBitbucketCloudRepository(
  repositoryUrl: string | undefined
): Result<BitbucketCloudRepository, IntegrationError> {
  const value = repositoryUrl?.trim();
  if (!value) {
    return err({ type: 'invalid_input', message: 'Repository URL is required.' });
  }
  const remote = parseBitbucketRemote(value);
  if (!remote) {
    return err({
      type: 'unsupported_host',
      message: 'The repository remote is not a Bitbucket Cloud repository.',
    });
  }
  if (remote.deployment === 'data-center') {
    return err({
      type: 'unsupported_host',
      message: `Bitbucket Data Center ("${remote.host}") is not supported yet. Only bitbucket.org repositories can be used.`,
    });
  }
  return ok(remote);
}

export function bitbucketRepositoryPath(repository: BitbucketCloudRepository): string {
  return `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}`;
}
