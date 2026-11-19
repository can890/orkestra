import {
  closestCenter,
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDndContext,
  useSensor,
  useSensors,
  type ClientRect,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useVirtualizer } from '@tanstack/react-virtual';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  dropProjectOnMainArea,
  dropTaskOnMainArea,
} from '@core/features/board/api/browser/board-actions';
import { isBoardEligibleTask } from '@core/features/board/api/browser/board-eligibility';
import { isUnregisteredProject } from '@core/features/projects/api/browser/stores/project';
import { getProjectStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { type SidebarRow } from '@core/features/workbench/browser/sidebar/sidebar-store';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import {
  useViewParams,
  useWorkspaceSlots,
} from '@core/primitives/navigation/browser/navigation-hooks';
import { SidebarProjectItem } from './project-item';
import { isPointOverMainDropZone, sidebarDragStore } from './sidebar-drag-store';
import { SidebarTaskItem } from './task-item';

const ROW_HEIGHT = 32;

export const SidebarVirtualList = observer(function SidebarVirtualList() {
  const rows = getSidebarStore().sidebarRows;
  const { currentView } = useWorkspaceSlots();
  const taskParams = useViewParams(taskViewDef) ?? {
    projectId: undefined,
    taskId: undefined,
  };
  const projectParams = useViewParams(projectViewDef) ?? { projectId: undefined };

  const scrollRef = useRef<HTMLDivElement>(null);
  const initialPointerYRef = useRef<number | null>(null);
  const initialScrollTopRef = useRef(0);
  const dragPointerYRef = useRef<number | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const stopTrackingRef = useRef<(() => void) | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dragPointerY, setDragPointerY] = useState<number | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const activeTaskProjectExpanded =
    currentView === 'task' && taskParams.projectId
      ? getSidebarStore().expandedProjectIds.has(taskParams.projectId)
      : null;
  const allDndIds = useMemo(() => rows.map(rowToDndId), [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  // Scroll the active project/task into view only when the navigation target itself
  // changes, plus the active task's project expansion state. Re-running on every
  // `rows` change would yank the user back to the active row whenever the
  // sidebar mutates (e.g. deleting an unrelated task), but direct navigation to a
  // task in a collapsed project needs one rerun after `revealProject`.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    let targetProjectId: string | null = null;
    let targetTaskId: string | null = null;

    if (currentView === 'task') {
      targetProjectId = taskParams.projectId ?? null;
      targetTaskId = taskParams.taskId ?? null;
    } else if (currentView === 'project') {
      targetProjectId = projectParams.projectId ?? null;
    }

    if (!targetProjectId) return;

    if (targetTaskId) {
      const activeTask = getTaskStore(targetProjectId, targetTaskId);
      if (activeTask?.data.isPinned) {
        return;
      }
    }

    const activeIndex = rowsRef.current.findIndex((row) => {
      if (targetTaskId) {
        return (
          row.kind === 'task' && row.taskId === targetTaskId && row.projectId === targetProjectId
        );
      }
      return row.kind === 'project' && row.projectId === targetProjectId;
    });

    if (activeIndex >= 0) {
      virtualizer.scrollToIndex(activeIndex, { align: 'auto' });
    }
  }, [
    currentView,
    taskParams.projectId,
    taskParams.taskId,
    projectParams.projectId,
    activeTaskProjectExpanded,
    virtualizer,
  ]);

  function setCurrentDragPointerY(pointerY: number | null) {
    dragPointerYRef.current = pointerY;
    setDragPointerY(pointerY);
  }

  // Tracks the real pointer for the whole drag: dnd-kit's own delta is scroll-adjusted, and only
  // the viewport position can be hit-tested against the main area.
  function startPointerTracking(activator: Event) {
    stopPointerTracking();
    const seed = getEventClientPoint(activator);
    pointerRef.current = seed;
    const onMove = (event: PointerEvent) => {
      const point = { x: event.clientX, y: event.clientY };
      pointerRef.current = point;
      sidebarDragStore.setOverMain(isPointOverMainDropZone(point));
    };
    window.addEventListener('pointermove', onMove, true);
    stopTrackingRef.current = () => window.removeEventListener('pointermove', onMove, true);
  }

  function stopPointerTracking() {
    stopTrackingRef.current?.();
    stopTrackingRef.current = null;
    pointerRef.current = null;
    sidebarDragStore.reset();
  }

  useEffect(() => stopPointerTracking, []);

  function handleDragStart(event: DragStartEvent) {
    startPointerTracking(event.activatorEvent);
    sidebarDragStore.start(isDraggedItemDroppable(String(event.active.id)), false);
    const pointerY = getEventClientY(event.activatorEvent);
    initialPointerYRef.current = pointerY;
    initialScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
    setActiveDragId(String(event.active.id));
    setCurrentDragPointerY(pointerY);
  }

  function handleDragMove(event: DragMoveEvent) {
    const initialPointerY = initialPointerYRef.current;
    if (initialPointerY === null) return;
    // dnd-kit's `delta` is scroll-adjusted: pointer travel plus however far the list has
    // scrolled since the drag started. `over.rect` reads in viewport space, so strip the
    // scroll component to keep the pointer in viewport space for the above/below decision.
    const scrollTop = scrollRef.current?.scrollTop ?? initialScrollTopRef.current;
    const scrollDelta = scrollTop - initialScrollTopRef.current;
    setCurrentDragPointerY(initialPointerY + event.delta.y - scrollDelta);
  }

  function clearDragPointerY() {
    stopPointerTracking();
    initialPointerYRef.current = null;
    setActiveDragId(null);
    setCurrentDragPointerY(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    const pointerY = dragPointerYRef.current;
    // Decided before the state is cleared: a drop that ends over the main area opens the item side
    // by side, anything else is a reorder inside the sidebar.
    const droppedOnMain = isPointOverMainDropZone(pointerRef.current);
    const droppable = sidebarDragStore.droppable;
    clearDragPointerY();
    if (droppedOnMain) {
      if (droppable) dropDraggedItemOnMainArea(String(active.id));
      return;
    }
    if (!over || active.id === over.id) return;
    const aParsed = parseDndId(String(active.id));
    const oParsed = parseDndId(String(over.id));
    if (!aParsed || !oParsed) return;

    const isAbove = isCursorAbove(pointerY, active.rect.current.translated, over.rect);

    if (aParsed.kind === 'project') {
      const overRowIdx = rows.findIndex((r) => rowToDndId(r) === String(over.id));
      if (overRowIdx === -1) return;
      const insertionRowIdx = isAbove ? overRowIdx : overRowIdx + 1;
      const ids = getSidebarStore()
        .orderedProjects.map((p) => (p.state === 'unregistered' ? p.id : (p.data?.id ?? '')))
        .filter(Boolean);
      const oldIdx = ids.indexOf(aParsed.projectId);
      if (oldIdx === -1) return;
      const projectsAbove = rows
        .slice(0, insertionRowIdx)
        .filter((r) => r.kind === 'project').length;
      let newIdx = projectsAbove;
      if (newIdx > oldIdx) newIdx -= 1;
      if (newIdx === oldIdx) return;
      getSidebarStore().setProjectOrder(arrayMove(ids, oldIdx, newIdx));
    } else if (oParsed.kind === 'task' && oParsed.projectId === aParsed.projectId) {
      const projectId = aParsed.projectId;
      const taskIds = rows
        .filter(
          (r): r is Extract<SidebarRow, { kind: 'task' }> =>
            r.kind === 'task' && r.projectId === projectId
        )
        .map((r) => r.taskId);
      const oldIdx = taskIds.indexOf(aParsed.taskId);
      const overTaskIdx = taskIds.indexOf(oParsed.taskId);
      if (oldIdx === -1 || overTaskIdx === -1) return;
      let newIdx = isAbove ? overTaskIdx : overTaskIdx + 1;
      if (newIdx > oldIdx) newIdx -= 1;
      if (newIdx === oldIdx) return;
      getSidebarStore().setTaskOrder(projectId, arrayMove(taskIds, oldIdx, newIdx));
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sidebarCollision}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      autoScroll={{ threshold: { x: 0, y: 0.18 }, acceleration: 8, interval: 5 }}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={clearDragPointerY}
    >
      <SortableContext items={allDndIds} strategy={verticalListSortingStrategy}>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-3">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vItem) => {
              const row = rows[vItem.index];
              if (!row) return null;
              const dndId = rowToDndId(row);
              const vStyle: React.CSSProperties = {
                position: 'absolute',
                top: vItem.start,
                left: 0,
                width: '100%',
                height: `${vItem.size}px`,
              };
              if (row.kind === 'project') {
                return (
                  <SortableRow key={row.projectId} dndId={dndId} style={vStyle}>
                    <SidebarProjectItem projectId={row.projectId} />
                  </SortableRow>
                );
              }
              return (
                <SortableRow key={`${row.projectId}:${row.taskId}`} dndId={dndId} style={vStyle}>
                  <SidebarTaskItem projectId={row.projectId} taskId={row.taskId} />
                </SortableRow>
              );
            })}
          </div>
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeDragId ? <DragOverlayContent dndId={activeDragId} /> : null}
      </DragOverlay>
      <InsertionIndicator pointerY={dragPointerY} />
    </DndContext>
  );
});

const toProjectDndId = (id: string) => `proj::${id}`;
const toTaskDndId = (projectId: string, taskId: string) => `task::${projectId}::${taskId}`;

type SidebarDndId =
  | { kind: 'project'; projectId: string }
  | { kind: 'task'; projectId: string; taskId: string };

function rowToDndId(row: SidebarRow): string {
  if (row.kind === 'project') return toProjectDndId(row.projectId);
  return toTaskDndId(row.projectId, row.taskId);
}

function parseDndId(id: string): SidebarDndId | null {
  if (id.startsWith('proj::')) return { kind: 'project', projectId: id.slice(6) };
  if (id.startsWith('task::')) {
    const [, projectId, taskId] = id.split('::');
    if (projectId && taskId) return { kind: 'task', projectId, taskId };
  }
  return null;
}

// Project drags consider every visible row so dropping over a task maps to its
// owning project in onDragEnd without changing the virtualized list mid-drag.
// Task drags stay restricted to their own project's tasks.
const sidebarCollision: CollisionDetection = (args) => {
  // Over the main area nothing in the sidebar may match, or the nearest row would show an
  // insertion line and a drop would reorder.
  if (args.pointerCoordinates && isPointOverMainDropZone(args.pointerCoordinates)) return [];
  const activeId = String(args.active.id);
  const parsed = parseDndId(activeId);
  if (!parsed) return [];
  const containers = args.droppableContainers.filter((c) => {
    const id = String(c.id);
    if (id === activeId) return false;
    if (parsed.kind === 'task') {
      const cParsed = parseDndId(id);
      return cParsed?.kind === 'task' && cParsed.projectId === parsed.projectId;
    }
    return true;
  });
  const filteredArgs = { ...args, droppableContainers: containers };
  const pointerCollisions = pointerWithin(filteredArgs);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(filteredArgs);
};

function isDraggedItemDroppable(dndId: string): boolean {
  const parsed = parseDndId(dndId);
  if (!parsed) return false;
  if (parsed.kind === 'project') {
    const project = getProjectStore(parsed.projectId);
    return !!project && !isUnregisteredProject(project);
  }
  const task = getTaskStore(parsed.projectId, parsed.taskId);
  return !!task && isBoardEligibleTask(task);
}

function dropDraggedItemOnMainArea(dndId: string): void {
  const parsed = parseDndId(dndId);
  if (!parsed) return;
  if (parsed.kind === 'project') dropProjectOnMainArea(parsed.projectId);
  else dropTaskOnMainArea({ projectId: parsed.projectId, taskId: parsed.taskId });
}

function getEventClientPoint(event: Event): { x: number; y: number } | null {
  if ('clientX' in event && typeof event.clientX === 'number' && 'clientY' in event) {
    return { x: event.clientX, y: (event as MouseEvent).clientY };
  }
  return null;
}

function getEventClientY(event: Event): number | null {
  if ('clientY' in event && typeof event.clientY === 'number') return event.clientY;
  if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch?.clientY ?? null;
  }
  return null;
}

function isCursorAbove(
  pointerY: number | null,
  translated: ClientRect | null,
  overRect: ClientRect
): boolean {
  if (pointerY !== null) return pointerY < overRect.top + overRect.height / 2;
  if (!translated) return true;
  const cursorY = translated.top + translated.height / 2;
  const overCenterY = overRect.top + overRect.height / 2;
  return cursorY < overCenterY;
}

function DragOverlayContent({ dndId }: { dndId: string }) {
  const parsed = parseDndId(dndId);
  if (!parsed) return null;
  return (
    <div className="px-3">
      <div className="rounded-lg bg-background-tertiary-2 shadow-md">
        {parsed.kind === 'project' ? (
          <SidebarProjectItem projectId={parsed.projectId} />
        ) : (
          <SidebarTaskItem projectId={parsed.projectId} taskId={parsed.taskId} />
        )}
      </div>
    </div>
  );
}

function InsertionIndicator({ pointerY }: { pointerY: number | null }) {
  const { active, over } = useDndContext();
  if (!active || !over || active.id === over.id) return null;
  const activeParsed = parseDndId(String(active.id));
  const overParsed = parseDndId(String(over.id));
  if (!activeParsed || !overParsed) return null;
  if (
    activeParsed.kind === 'project' &&
    overParsed.kind === 'task' &&
    overParsed.projectId === activeParsed.projectId
  ) {
    return null;
  }
  const overRect = over.rect;
  if (!overRect) return null;
  const isAbove = isCursorAbove(pointerY, active.rect.current.translated, overRect);
  const top = isAbove ? overRect.top : overRect.top + overRect.height;
  return createPortal(
    <div
      className="bg-primary"
      style={{
        position: 'fixed',
        left: overRect.left + 8,
        top: top - 1.5,
        width: Math.max(0, overRect.width - 16),
        height: 3,
        borderRadius: 2,
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    />,
    document.body
  );
}

interface SortableRowProps {
  dndId: string;
  style: React.CSSProperties;
  children: React.ReactNode;
}

function SortableRow({ dndId, style, children }: SortableRowProps) {
  const { setNodeRef, transform, transition, isDragging, listeners } = useSortable({
    id: dndId,
  });

  const combinedStyle: React.CSSProperties = {
    ...style,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 1 : 'auto',
  };

  return (
    <div ref={setNodeRef} style={combinedStyle} {...listeners}>
      {children}
    </div>
  );
}
