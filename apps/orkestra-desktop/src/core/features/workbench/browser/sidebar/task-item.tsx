import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  addTaskToBoard,
  dropTaskOnMainArea,
  isTaskOnBoard,
  removeTaskFromBoard,
} from '@core/features/board/api/browser/board-actions';
import { isBoardEligibleTask } from '@core/features/board/api/browser/board-eligibility';
import {
  collectOpenConversationIds,
  useTaskViewSwitchAction,
} from '@core/features/conversations/api/browser/conversation-view-switch';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import {
  getTaskGitCheckoutStore,
  getTaskPrAssociationStore,
} from '@core/features/source-control/api/browser/stores/task-source-control-selectors';
import { type TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import {
  getTaskManagerStore,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { TaskContextMenu } from '@core/features/tasks/contributions/browser/task-context-menu';
import { TaskGitDiffStats } from '@core/features/tasks/contributions/browser/task-git-diff-stats';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import {
  getTaskWorkspace,
  getTaskComposition,
} from '@core/features/workbench/api/browser/task-composition-selectors';
import { TaskSidebarTrailingSlot } from '@core/features/workbench/browser/sidebar/task-sidebar-agent-status';
import { homeViewDef } from '@core/features/workbench/contributions/views';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import {
  useNavigate,
  useViewParams,
  useWorkspaceSlots,
} from '@core/primitives/navigation/browser/navigation-hooks';
import { isFreeChatProjectId } from '@core/primitives/projects/api';
import { cn } from '@core/primitives/styling/browser/cn';
import { selectCurrentPr } from '@root/src/core/services/pull-requests/api';
import { PrBadge } from '@root/src/core/services/pull-requests/browser/components/pr-badge';
import {
  isPointOverMainDropZone,
  resolveMainDropTarget,
  sidebarDragStore,
} from './sidebar-drag-store';
import { SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';
import { TaskProviderIcons } from './task-provider-icons';

interface SidebarTaskItemProps {
  taskId: string;
  projectId: string;
  /** Pinned strip uses tighter padding than tasks nested under a project. */
  rowVariant?: 'underProject' | 'pinned';
  /** Enables dragging directly to the main area outside SortableContext (e.g. free chats, pinned). */
  enableDirectDragToMain?: boolean;
}

const DIRECT_DRAG_THRESHOLD_PX = 6;

export const SidebarTaskItem = observer(function SidebarTaskItem({
  taskId,
  projectId,
  rowVariant = 'underProject',
  enableDirectDragToMain = false,
}: SidebarTaskItemProps) {
  const { navigate } = useNavigate();
  const openRename = useOpenModal('renameTaskModal');
  const openDeleteTask = useOpenModal('deleteTaskModal');
  const openCodeReview = useOpenModal('codeReviewModal');

  const { currentView } = useWorkspaceSlots();
  const params = useViewParams(taskViewDef);
  const { value: interfaceSettings } = useAppSettingsKey('interface');
  const isActive =
    currentView === 'task' && params?.taskId === taskId && params.projectId === projectId;

  const task = getTaskStore(projectId, taskId)!;
  const taskManager = getTaskManagerStore(projectId);

  const taskName = task.data.name;
  const isFreeChat = isFreeChatProjectId(projectId);

  const suppressClickRef = useRef(false);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const [dragChipPos, setDragChipPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => () => cleanupDragRef.current?.(), []);

  const openTask = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    navigate(taskViewDef({ projectId, taskId }));
  };

  const startDirectDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!enableDirectDragToMain || e.button !== 0 || !isBoardEligibleTask(task)) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onEnd, true);
      window.removeEventListener('pointercancel', onCancel, true);
      cleanupDragRef.current = null;
      setDragChipPos(null);
      sidebarDragStore.reset();
    };

    const onMove = (moveEvent: PointerEvent) => {
      const point = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (!dragging) {
        const dist = Math.hypot(point.x - startX, point.y - startY);
        if (dist < DIRECT_DRAG_THRESHOLD_PX) return;
        dragging = true;
        suppressClickRef.current = true;
        sidebarDragStore.start(true, isPointOverMainDropZone(point), taskName || 'Sohbet', taskId);
      }
      sidebarDragStore.updatePoint(point);
      setDragChipPos(point);
    };

    const onEnd = (endEvent: PointerEvent) => {
      const point = { x: endEvent.clientX, y: endEvent.clientY };
      const hit = dragging ? resolveMainDropTarget(point, taskId) : null;
      cleanup();
      if (hit) {
        dropTaskOnMainArea(
          { projectId, taskId },
          { side: hit.side, ...(hit.targetTaskId ? { targetTaskId: hit.targetTaskId } : {}) }
        );
      }
      if (dragging) {
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    };

    const onCancel = () => {
      cleanup();
      suppressClickRef.current = false;
    };

    cleanupDragRef.current?.();
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onEnd, true);
    window.addEventListener('pointercancel', onCancel, true);
    cleanupDragRef.current = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onEnd, true);
      window.removeEventListener('pointercancel', onCancel, true);
      setDragChipPos(null);
      sidebarDragStore.reset();
    };
  };

  const handleArchive = () => {
    if (isActive) navigate(isFreeChat ? homeViewDef() : projectViewDef({ projectId }));
    void taskManager?.archiveTask(taskId);
  };

  const handleRename = () => {
    void openRename({ projectId, taskId, currentName: taskName });
  };

  const handleDelete = () => {
    void openDeleteTask({
      projectId,
      tasks: [{ taskId, taskName }],
    }).then((outcome) => {
      if (!outcome.success) return;
      const { deleteWorktree, deleteBranch, deleteConversations } = outcome.data;
      void taskManager?.deleteTasks([taskId], {
        deleteWorktree,
        deleteBranch,
        deleteConversations,
      });
      if (isActive) navigate(isFreeChat ? homeViewDef() : projectViewDef({ projectId }));
    });
  };

  const canPin = task.state !== 'unregistered';

  const workspaceStore = getTaskWorkspace(projectId, taskId);
  const git = getTaskGitCheckoutStore(projectId, taskId);
  const showLineChanges = interfaceSettings?.showLeftSidebarLineChanges ?? true;
  const showPrStatus = interfaceSettings?.showLeftSidebarPrStatus ?? true;
  const showTimestamps = interfaceSettings?.showLeftSidebarTimestamps ?? true;
  const branchName = git?.branchName ?? undefined;
  const onBoard = isTaskOnBoard(taskId);
  const canAddToBoard =
    !onBoard &&
    task.state !== 'unregistered' &&
    task.data.type !== 'automation-run' &&
    !('archivedAt' in task.data && task.data.archivedAt);
  const handleReconnect =
    workspaceStore?.connectionState != null ? () => workspaceStore.reconnect() : undefined;
  const composition =
    typeof getTaskComposition === 'function' ? getTaskComposition(projectId, taskId) : undefined;
  const liveActionDisabledReason = projectAvailabilityUi.getLiveActionDisabledReason(projectId);
  const viewSwitch = useTaskViewSwitchAction({
    taskId,
    preferredConversationIds: collectOpenConversationIds(composition?.paneLayout),
    disabledReason: liveActionDisabledReason,
    onSwitched: () => {
      if (!isActive) navigate(taskViewDef({ projectId, taskId }));
    },
  });

  return (
    <TaskContextMenu
      isPinned={task.data.isPinned}
      canPin={canPin}
      isArchived={false}
      branchName={branchName}
      taskId={taskId}
      viewSwitch={viewSwitch}
      onPin={() => void task.setPinned(true)}
      onUnpin={() => void task.setPinned(false)}
      onRename={handleRename}
      onArchive={handleArchive}
      onReconnect={handleReconnect}
      onConvertAutomation={undefined}
      onReview={
        task.state === 'provisioned' ? () => void openCodeReview({ projectId, taskId }) : undefined
      }
      onAddToBoard={canAddToBoard ? () => addTaskToBoard({ projectId, taskId }) : undefined}
      onRemoveFromBoard={onBoard ? () => removeTaskFromBoard(taskId) : undefined}
      onDelete={handleDelete}
    >
      <SidebarMenuRow
        className={cn(
          'group/row flex items-center justify-between px-1 py-1.5 h-8 gap-1',
          rowVariant === 'pinned' ? 'pl-2' : 'pl-8'
        )}
        isActive={isActive}
        onPointerDown={enableDirectDragToMain ? startDirectDrag : undefined}
        onMouseDown={(e) => e.preventDefault()}
        onClick={openTask}
      >
        <SidebarMenuAction
          aria-label={`Open task ${taskName || 'task'}`}
          className="gap-1 overflow-hidden"
        >
          <span
            className={cn(
              'min-w-0 truncate text-left transition-colors',
              task.isBootstrapping && 'text-foreground/40'
            )}
          >
            {taskName}
          </span>
        </SidebarMenuAction>
        <div className="ml-2 flex shrink-0 items-center justify-end gap-1.5">
          <TaskProviderIcons task={task} />
          {showLineChanges && !isFreeChat && <TaskGitDiffStats task={task} />}
          {showPrStatus && !isFreeChat && <RenderPrBadge task={task} />}
          <TaskSidebarTrailingSlot task={task} showTimestamp={showTimestamps} />
        </div>
      </SidebarMenuRow>
      {dragChipPos && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[9999] max-w-56 truncate rounded-md border border-border bg-background-tertiary-2 px-2.5 py-1 text-xs font-medium text-foreground shadow-lg"
              style={{ left: dragChipPos.x + 12, top: dragChipPos.y + 8 }}
            >
              {taskName || 'Sohbet'}
            </div>,
            document.body
          )
        : null}
    </TaskContextMenu>
  );
});

const RenderPrBadge = observer(function RenderPrBadge({ task }: { task: TaskStore }) {
  const pr = selectCurrentPr(getTaskPrAssociationStore(task).pullRequests);
  return pr ? (
    <span onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <PrBadge variant="compact" pr={pr} hoverDelay={100} />
    </span>
  ) : null;
});
