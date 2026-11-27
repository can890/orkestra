import { observer } from 'mobx-react-lite';
import { EditorFileTree } from '@core/features/editor/contributions/browser/editor-file-tree';
import { ChangesPanel } from '@core/features/source-control/contributions/browser/changes-panel';
import { useTaskComposition } from '@core/features/workbench/api/browser/task-composition-context';
import { TaskDetailsPanel } from './task-details-panel';

/**
 * Task sidebar body. Mounted only while the sidebar is expanded (the panel is
 * conditionally rendered in `ReadyTaskMainPanel`), so there is no
 * collapsed/hidden representation here.
 */
export const TaskSidebar = observer(function TaskSidebar() {
  const taskView = useTaskComposition();
  const activeTab = taskView.sidebarTab;

  return (
    <div className="h-full min-h-0 overflow-hidden">
      {(activeTab === 'details' || activeTab === 'conversations') && <TaskDetailsPanel />}
      {activeTab === 'changes' && <ChangesPanel />}
      {activeTab === 'files' && <EditorFileTree />}
    </div>
  );
});
