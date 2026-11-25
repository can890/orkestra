import { err, ok, Result } from '@orkestra/shared';
import { match } from 'ts-pattern';
import { githubRepositoryResolver } from '@core/features/github/api/node/services/github-repository-resolver';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import { parseForgeRepositoryRef } from '@core/primitives/repository/api';
import type { ProviderRepositoryResult } from '../api';

export class ProviderRepositoryService {
  constructor(
    private readonly dependencies: {
      projects: Pick<ProjectAttachmentManager, 'requireAttached'>;
      loadProject(projectId: string): Promise<unknown | undefined>;
    }
  ) {}

  async resolveProject(projectId: string): Promise<ProviderRepositoryResult> {
    const record = await this.dependencies.loadProject(projectId);
    if (!record) return err({ type: 'project-missing', projectId });
    const attached = this.dependencies.projects.requireAttached(projectId);
    if (!attached.success) return attached;
    const project = attached.data;

    const remoteState = await project.getRemoteState();
    if (!remoteState.hasRemote) return err({ type: 'no_remote' });
    if (!remoteState.selectedRemoteUrl) return err({ type: 'invalid_remote' });

    // Bitbucket Cloud and Azure DevOps are recognised from the remote alone (no host probe).
    // Their issues come from the repository-scoped issue plugins, not the GitHub issue path.
    const forge = parseForgeRepositoryRef(remoteState.selectedRemoteUrl);
    if (forge) {
      return ok({
        provider: forge.provider,
        host: forge.host,
        repositoryUrl: forge.repositoryUrl,
        nameWithOwner: forge.nameWithOwner,
        capabilities: { pullRequests: true, issues: false },
      });
    }

    return Result.fromAsync(githubRepositoryResolver.resolve(remoteState.selectedRemoteUrl))
      .map((repo) => ({
        provider: 'github' as const,
        host: repo.host,
        repositoryUrl: repo.repositoryUrl,
        nameWithOwner: repo.nameWithOwner,
        capabilities: { pullRequests: true, issues: true },
      }))
      .mapErr((e) =>
        match(e)
          .with({ type: 'not_parseable' }, () => ({ type: 'invalid_remote' as const }))
          .with({ type: 'not_github' }, (x) => ({
            type: 'unsupported_provider' as const,
            host: x.host,
            reason: x.reason,
          }))
          .with({ type: 'host_unreachable' }, (x) => ({
            type: 'host_unreachable' as const,
            host: x.host,
            reason: x.reason,
          }))
          .with({ type: 'host_error' }, (x) => ({
            type: 'host_error' as const,
            host: x.host,
            reason: x.reason,
          }))
          .exhaustive()
      );
  }
}
