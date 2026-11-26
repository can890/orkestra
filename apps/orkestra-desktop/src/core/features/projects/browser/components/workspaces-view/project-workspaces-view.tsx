import { observer } from 'mobx-react-lite';
import { getMachinesStore } from '@core/features/machines/contributions/app-stores';
import {
  asAvailableProject,
  getProjectStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { WorkspaceDetailPage } from '@core/features/workspaces/contributions/browser/workspace-detail-page';

/** Derives the shared workspace detail page's local or SSH scope from the project. */
export const ProjectWorkspacesView = observer(function ProjectWorkspacesView({
  projectId,
}: {
  projectId: string;
}) {
  const context = asAvailableProject(getProjectStore(projectId));
  if (!context) return null;
  const project = context.project;

  if (project.type === 'ssh') {
    const machinesStore = getMachinesStore();
    const machine = machinesStore.connections.find(
      (connection) => connection.id === project.connectionId
    );
    return (
      <WorkspaceDetailPage
        scope={{ kind: 'machine', machineId: project.connectionId }}
        host={context.host}
        machineName={machine?.name}
        projectId={projectId}
      />
    );
  }

  return (
    <WorkspaceDetailPage scope={{ kind: 'local' }} host={context.host} projectId={projectId} />
  );
});
