import { EmptyState } from '@orkestra/ui/react/components';
import { PageLayout } from '@orkestra/ui/react/patterns';
import { Button, Spinner } from '@orkestra/ui/react/primitives';
import {
  ChevronRight,
  FolderInput,
  FolderOpen,
  GitPullRequest,
  PanelsTopLeft,
  Settings,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { ProjectMemoryPanel } from '@core/features/project-memory/contributions/project-memory-panel';
import { ProjectRepositoriesPanel } from '@core/features/project-repositories/contributions/browser/project-repositories-panel';
import {
  getProjectManagerStore,
  getProjectStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { ProjectAvailabilityBoundary } from '@core/features/projects/contributions/browser/project-availability-boundary';
import { ProjectViewWrapper } from '@core/features/projects/contributions/browser/project-view-wrapper';
import { isFreeChatProjectId } from '@core/primitives/projects/api';
import type {
  SettingsPageDetailProps,
  SettingsPageProps,
} from '@core/primitives/settings/api/page-contribution';
import { PullRequestView } from '../pr-view/pr-view';
import { ProjectWorkspacesView } from '../workspaces-view/project-workspaces-view';
import { SettingsPanel } from './settings-panel';

export const projectSettingsSections = [
  { id: 'pull-requests', label: 'Pull Requests', icon: GitPullRequest },
  { id: 'workspaces', label: 'Workspaces', icon: PanelsTopLeft },
  { id: 'settings', label: 'Project settings', icon: Settings },
] as const;

export const ProjectsSettingsPage = observer(function ProjectsSettingsPage({
  openDetail,
}: SettingsPageProps) {
  const projects = Array.from(getProjectManagerStore().projects.values()).flatMap(({ data }) =>
    data && !isFreeChatProjectId(data.id) ? [data] : []
  );

  return (
    <div className="space-y-6 pb-6">
      <PageLayout.Header sticky title="Projects" />
      {projects.length === 0 ? (
        <EmptyState bare label="No projects found." />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {projects.map((project) => {
            const Icon = project.type === 'ssh' ? FolderInput : FolderOpen;
            return (
              <li key={project.id}>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start gap-3 rounded-none px-4 py-3 text-left"
                  onClick={() => openDetail(project.id)}
                >
                  <Icon aria-hidden="true" className="shrink-0 text-foreground-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{project.name}</span>
                    <span className="block truncate text-xs text-foreground-muted" dir="ltr">
                      {project.path}
                    </span>
                  </span>
                  <ChevronRight aria-hidden="true" className="shrink-0 text-foreground-muted" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

export function ProjectSettingsOverview({ openDetail }: SettingsPageDetailProps) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
      {projectSettingsSections.map(({ id, label, icon: Icon }) => (
        <li key={id}>
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-start gap-3 rounded-none px-4 py-3"
            onClick={() => openDetail(id)}
          >
            <Icon aria-hidden="true" className="shrink-0 text-foreground-muted" />
            <span className="flex-1 text-left">{label}</span>
            <ChevronRight aria-hidden="true" className="shrink-0 text-foreground-muted" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

export const ProjectSettingsSection = observer(function ProjectSettingsSection({
  path: [projectId],
  detailId,
}: SettingsPageDetailProps) {
  if (!projectId) return null;
  const project = getProjectStore(projectId);
  if (!project?.data) return null;
  if (project.context?.kind === 'failed') {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <p role="status" className="text-sm text-foreground-muted">
          Could not load Project
        </p>
        <Button
          type="button"
          variant="secondary"
          onClick={() => void getProjectManagerStore().hydrateProjectContext(projectId)}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (project.context?.kind !== 'available') {
    return (
      <div className="flex justify-center py-10" role="status" aria-label="Loading project…">
        <Spinner />
      </div>
    );
  }

  return (
    <ProjectViewWrapper key={projectId} projectId={projectId}>
      <div className="pb-6">
        <ProjectAvailabilityBoundary projectId={projectId} layout="inline">
          {detailId === 'pull-requests' && (
            <div className="h-[calc(100vh-12rem)] min-h-80">
              <PullRequestView projectId={projectId} />
            </div>
          )}
          {detailId === 'workspaces' && <ProjectWorkspacesView projectId={projectId} />}
          {detailId === 'settings' && (
            <>
              <SettingsPanel projectId={projectId} />
              <ProjectRepositoriesPanel projectId={projectId} />
              <ProjectMemoryPanel projectId={projectId} />
            </>
          )}
        </ProjectAvailabilityBoundary>
      </div>
    </ProjectViewWrapper>
  );
});
