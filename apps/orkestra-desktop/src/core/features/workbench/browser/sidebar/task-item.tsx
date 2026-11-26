import { Tooltip } from '@orkestra/ui/react/primitives';
import { FolderGit2, GitBranch, Laptop } from 'lucide-react';
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
import {
  getProjectStore,
  projectDisplayName,
} from '@core/features/projects/api/browser/stores/project-selectors';
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
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
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
import { sidebarUndoStore } from './sidebar-undo-store';
import { TaskProviderIcons } from './task-provider-icons';

interface SidebarTaskItemProps {
  taskId: string;
  projectId: string;
  /** Pinned strip uses tighter padding than tasks nested under a project. */
  rowVariant?: 'underProject' | 'pinned';
  /** Enables dragging directly to the main area outside SortableContext (e.g. free chats, pinned). */
  enableDirectDragToMain?: boolean;
  /**
   * Manual reordering by keyboard (Alt+ArrowUp/Down while the row is focused) and the context
   * menu. Omitted when the list cannot be reordered (e.g. while a filter is active).
   */
  reorder?: SidebarTaskReorder;
}

export interface SidebarTaskReorder {
  canMoveUp: boolean;
  canMoveDown: boolean;
  move: (delta: -1 | 1) => void;
}

const DIRECT_DRAG_THRESHOLD_PX = 6;

export const SidebarTaskItem = observer(function SidebarTaskItem({
  taskId,
  projectId,
  rowVariant = 'underProject',
  enableDirectDragToMain = false,
  reorder,
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
    sidebarUndoStore.push('Arşivlendi', async () => {
      await taskManager?.restoreTask(taskId);
    });
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

  const handleReorderKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!reorder || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.key === 'ArrowUp' && reorder.canMoveUp) {
      e.preventDefault();
      reorder.move(-1);
    } else if (e.key === 'ArrowDown' && reorder.canMoveDown) {
      e.preventDefault();
      reorder.move(1);
    }
  };

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

  const projectLabel = isFreeChat ? 'Sohbetler' : projectDisplayName(getProjectStore(projectId));
  const linesAdded = git?.totalLinesAdded ?? 0;
  const linesDeleted = git?.totalLinesDeleted ?? 0;

  return (
    <TaskContextMenu
      isPinned={task.data.isPinned}
      canPin={canPin}
      isArchived={false}
      branchName={branchName}
      taskId={taskId}
      viewSwitch={viewSwitch}
      onPin={() => void task.setPinned(true)}
      onUnpin={() => {
        void task.setPinned(false);
        sidebarUndoStore.push('Sabitleme kaldırıldı', async () => {
          await task.setPinned(true);
        });
      }}
      onRename={handleRename}
      onArchive={handleArchive}
      onReconnect={handleReconnect}
      onConvertAutomation={undefined}
      onReview={
        task.state === 'provisioned' ? () => void openCodeReview({ projectId, taskId }) : undefined
      }
      onAddToBoard={canAddToBoard ? () => addTaskToBoard({ projectId, taskId }) : undefined}
      onRemoveFromBoard={onBoard ? () => removeTaskFromBoard(taskId) : undefined}
      onMoveUp={reorder?.canMoveUp ? () => reorder.move(-1) : undefined}
      onMoveDown={reorder?.canMoveDown ? () => reorder.move(1) : undefined}
      onSnooze={
        canPin && task.data.type !== 'automation-run'
          ? (durationMs) => {
              getSidebarStore().snoozeTask(projectId, taskId, Date.now() + durationMs);
              sidebarUndoStore.push('Ertelendi', () => {
                getSidebarStore().restoreSnoozedTask(taskId);
              });
            }
          : undefined
      }
      onDelete={handleDelete}
    >
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <SidebarMenuRow
              className={cn(
                'group/row flex h-8 items-center justify-between gap-1.5 pr-2.5 text-[13px] transition-colors',
                rowVariant === 'pinned' ? 'pl-2.5' : 'pl-6',
                isActive
                  ? 'bg-foreground/[0.08] font-medium text-foreground'
                  : 'text-foreground/85 hover:bg-foreground/[0.045] hover:text-foreground'
              )}
              isActive={isActive}
              onPointerDown={enableDirectDragToMain ? startDirectDrag : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={openTask}
              onKeyDown={reorder ? handleReorderKeyDown : undefined}
            >
              <SidebarMenuAction
                aria-label={`Open task ${taskName || 'task'}`}
                aria-keyshortcuts={reorder ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
                className="min-w-0 flex-1 gap-1 overflow-hidden"
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
              <div className="flex shrink-0 items-center justify-end gap-1.5">
                <TaskProviderIcons task={task} maxIcons={2} />
                {showLineChanges && !isFreeChat && <TaskGitDiffStats task={task} />}
                {showPrStatus && !isFreeChat && <RenderPrBadge task={task} />}
                <TaskSidebarTrailingSlot task={task} showTimestamp={showTimestamps} />
              </div>
            </SidebarMenuRow>
          }
        />
        <Tooltip.Content
          side="right"
          sideOffset={10}
          showArrow={false}
          className="max-w-72 rounded-xl border border-border-1 bg-[#111115] p-3 text-left shadow-2xl"
        >
          <div className="flex min-w-44 flex-col gap-1.5">
            <div className="text-xs font-semibold leading-snug text-foreground">
              {taskName || 'Adsız görev'}
            </div>
            <div className="flex flex-col gap-1 text-[11px] text-foreground-muted">
              <span className="flex items-center gap-1.5">
                <FolderGit2 className="size-3 shrink-0 text-foreground-passive" />
                <span className="truncate">{projectLabel}</span>
              </span>
              {!isFreeChat && branchName ? (
                <span className="flex items-center gap-1.5 font-mono">
                  <GitBranch className="size-3 shrink-0 text-foreground-passive" />
                  <span className="truncate">{branchName}</span>
                  {(linesAdded > 0 || linesDeleted > 0) && (
                    <span className="ml-auto flex shrink-0 items-center gap-1 tabular-nums">
                      {linesAdded > 0 && (
                        <span className="text-foreground-diff-added">+{linesAdded}</span>
                      )}
                      {linesDeleted > 0 && (
                        <span className="text-foreground-diff-deleted">-{linesDeleted}</span>
                      )}
                    </span>
                  )}
                </span>
              ) : null}
              <span className="flex items-center gap-1.5">
                <Laptop className="size-3 shrink-0 text-foreground-passive" />
                <span>{workspaceStore?.sshConnectionId ? 'Uzak SSH Makinesi' : 'Yerel Mac'}</span>
              </span>
            </div>
          </div>
        </Tooltip.Content>
      </Tooltip.Root>
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
