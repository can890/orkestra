import { isAbsolute } from 'node:path';
import { LOCAL_HOST_REF, type HostRef } from '@orkestra/core/primitives/host/api';
import type { CheckoutStatusState } from '@orkestra/core/runtimes/git/api';
import type { RuntimeBroker } from '@orkestra/core/services/runtime-broker/api';
import { log } from '@orkestra/shared/logger';
import { hostPathFromNative } from '@core/primitives/desktop-runtime/api';
import type {
  DiscoverFolderResult,
  ListProjectRepositoriesResult,
  ListRepositoryChangesResult,
  RepositoryChanges,
} from '../contract';
import {
  discoverRepositories,
  readRepositoryHeadInfo,
  type RepositoryDiscoveryFs,
  type RepositoryDiscoveryResult,
} from '../discovery';
import { parseNestedRepositoryWorkspaceId } from '../nested-repository-id';
import { createLocalDiscoveryFs } from './local-discovery-fs';

export type ProjectRepositoriesIdentity = Readonly<{
  workspaceId: string;
  host: HostRef;
  path: string;
  projectId: string;
}>;

export type ProjectRepositoriesIdentityResolver = Readonly<{
  resolve(workspaceId: string): Promise<ProjectRepositoriesIdentity | null>;
  resolveProject(projectId: string): Promise<ProjectRepositoriesIdentity | null>;
}>;

export type ProjectRepositoriesServiceOptions = Readonly<{
  workspaceIdentity: ProjectRepositoriesIdentityResolver;
  runtimes: Pick<RuntimeBroker, 'client'>;
  /** Testler için; varsayılan yerel `node:fs` portu. */
  fs?: RepositoryDiscoveryFs;
  /** Aynı klasörün art arda keşfini paylaştırma süresi. */
  cacheTtlMs?: number;
}>;

const DEFAULT_CACHE_TTL_MS = 2_000;

type CacheEntry = { expiresAt: number; promise: Promise<RepositoryDiscoveryResult> };

/**
 * Çok depolu projelerin ana süreç servisi. Keşif yalnızca yerel host'ta yapılır: uzak (SSH)
 * dosya düzleminde sığ dizin listeleme yok, bu yüzden SSH projeleri için sonuç `unsupported`
 * döner ve kaynak kontrolü tek depolu davranışında kalır.
 */
export class ProjectRepositoriesService {
  private readonly fs: RepositoryDiscoveryFs;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: ProjectRepositoriesServiceOptions) {
    this.fs = options.fs ?? createLocalDiscoveryFs();
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /** Yerel bir klasörün kapsadığı depolar; uzak host için `null`. */
  discover(host: HostRef, path: string): Promise<RepositoryDiscoveryResult> | null {
    if (host.type !== 'local') return null;
    const now = Date.now();
    const cached = this.cache.get(path);
    if (cached && cached.expiresAt > now) return cached.promise;
    const promise = discoverRepositories(this.fs, path);
    this.cache.set(path, { expiresAt: now + this.cacheTtlMs, promise });
    promise.catch(() => this.cache.delete(path));
    if (this.cache.size > 64) {
      for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(key);
    }
    return promise;
  }

  /** Proje eklenmeden önce yerel bir klasörün kapsayacağı depolar. */
  async discoverLocalFolder(path: string): Promise<DiscoverFolderResult> {
    if (!isAbsolute(path)) return { rootIsRepository: false, repositories: [], truncated: false };
    const result = await this.discover(LOCAL_HOST_REF, path);
    return {
      rootIsRepository: result?.rootIsRepository ?? false,
      repositories: (result?.repositories ?? []).map(({ relativePath, name, kind }) => ({
        relativePath,
        name,
        kind,
      })),
      truncated: result?.truncated ?? false,
    };
  }

  async listRepositories(input: {
    projectId: string;
    workspaceId?: string;
  }): Promise<ListProjectRepositoriesResult> {
    const identity = input.workspaceId
      ? await this.options.workspaceIdentity.resolve(input.workspaceId)
      : await this.options.workspaceIdentity.resolveProject(input.projectId);
    if (!identity || identity.projectId !== input.projectId) {
      return { status: 'unsupported', reason: 'not-found' };
    }
    const discovery = this.discover(identity.host, identity.path);
    if (!discovery) return { status: 'unsupported', reason: 'remote-host' };
    const result = await discovery;
    const repositories = await Promise.all(
      result.repositories.map(async (repository) => ({
        ...repository,
        ...(await readRepositoryHeadInfo(this.fs, repository.path)),
      }))
    );
    return {
      status: 'ok',
      root: result.root,
      rootIsRepository: result.rootIsRepository,
      repositories: repositories.map((repository) => ({
        ...repository,
        remotes: [...repository.remotes],
      })),
      truncated: result.truncated,
    };
  }

  /** Görev klasöründeki her deponun değişen dosyaları, yollar depo klasörüyle önekli. */
  async listChanges(input: { workspaceId: string }): Promise<ListRepositoryChangesResult> {
    const identity = await this.options.workspaceIdentity.resolve(input.workspaceId);
    if (!identity) return { status: 'unsupported', reason: 'not-found' };
    const discovery = this.discover(identity.host, identity.path);
    if (!discovery) return { status: 'unsupported', reason: 'remote-host' };
    const result = await discovery;
    const runtime = await this.options.runtimes.client(identity.host);
    if (!runtime.success) {
      return {
        status: 'ok',
        repositories: result.repositories.map((repository) => ({
          relativePath: repository.relativePath,
          name: repository.name,
          kind: repository.kind,
          branch: null,
          files: [],
          tooManyFiles: false,
          error: 'Host runtime unavailable',
        })),
      };
    }
    const git = runtime.data.git;
    const repositories = await Promise.all(
      result.repositories.map(async (repository): Promise<RepositoryChanges> => {
        const head = await readRepositoryHeadInfo(this.fs, repository.path);
        const base = {
          relativePath: repository.relativePath,
          name: repository.name,
          kind: repository.kind,
          branch: head.branch ?? head.detachedAt,
        };
        try {
          const snapshot = await git.checkout.model
            .state({ checkout: hostPathFromNative(repository.path) }, 'status')
            .snapshot();
          const status = snapshot.data as CheckoutStatusState | null;
          if (!status) return { ...base, files: [], tooManyFiles: false, error: null };
          if (status.kind === 'too-many-files') {
            return { ...base, files: [], tooManyFiles: true, error: null };
          }
          if (status.kind === 'error') {
            return { ...base, files: [], tooManyFiles: false, error: status.message };
          }
          const files = Object.values(status.entries)
            .filter((entry) => entry.worktree !== 'ignored')
            .filter((entry) => entry.index !== 'unmodified' || entry.worktree !== 'unmodified')
            .map((entry) => ({
              path: `${repository.relativePath}/${entry.path}`,
              repositoryPath: entry.path,
              index: entry.index,
              worktree: entry.worktree,
            }))
            .sort((left, right) => (left.path < right.path ? -1 : 1));
          return { ...base, files, tooManyFiles: false, error: null };
        } catch (error) {
          log.warn('Failed to read nested repository status', {
            repository: repository.relativePath,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            ...base,
            files: [],
            tooManyFiles: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );
    return { status: 'ok', repositories };
  }

  /**
   * Bir çalışma alanı kimlik çözücüsünü iç depo kimliklerini (`<workspaceId>::repo::<yol>`)
   * tanıyacak şekilde sarar. Göreli yol, görev klasörünün o anki keşif sonucunda yoksa kimlik
   * çözülmez; böylece istemci keşfedilmemiş bir yolu Git'e adresleyemez. Sıradan kimlikler
   * olduğu gibi temel çözücüye gider.
   */
  withNestedRepositories(
    base: ProjectRepositoriesIdentityResolver
  ): ProjectRepositoriesIdentityResolver {
    const resolveNested = async (id: string) => {
      const parsed = parseNestedRepositoryWorkspaceId(id);
      if (!parsed) return base.resolve(id);
      const identity = await base.resolve(parsed.workspaceId);
      if (!identity) return null;
      const discovery = this.discover(identity.host, identity.path);
      if (!discovery) return null;
      const repository = (await discovery).repositories.find(
        (candidate) => candidate.relativePath === parsed.relativePath
      );
      if (!repository) return null;
      return { ...identity, workspaceId: id, path: repository.path };
    };
    return {
      resolve: resolveNested,
      resolveProject: (projectId: string) => base.resolveProject(projectId),
    };
  }
}
