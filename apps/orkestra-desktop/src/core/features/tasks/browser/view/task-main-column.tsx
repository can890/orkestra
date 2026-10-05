import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  Button,
  Tooltip,
  Resizable,
  useCollapsiblePanelBinding,
  useResizableDefaultLayout,
} from '@orkestra/ui/react/primitives';
import { Columns2, Rows2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Fragment, useMemo, useState } from 'react';
import {
  splitPanePanelId,
  taskPanelLayoutsMemento,
} from '@core/features/tasks/contributions/mementos';
import {
  isTerminalDrawerDragData,
  type TerminalDrawerDragData,
} from '@core/features/terminals/api/browser/task-terminal/terminal-drag';
import { TerminalsPanel } from '@core/features/terminals/contributions/browser/task-terminal/terminal-panel';
import { useTaskComposition } from '@core/features/workbench/api/browser/task-composition-context';
import { PaneProvider } from '@core/features/workbench/contributions/browser/tabs/pane-provider';
import { createLayoutStorage, type MementoLayoutStorage } from '@core/primitives/mementos/browser';
import type { PaneLayoutNode } from '@core/primitives/workbench-shell/api/pane-layout';
import { PaneContent } from '@core/primitives/workbench-shell/browser/tabs/pane-content';
import { isPaneSplitDropTargetId } from '@core/primitives/workbench-shell/browser/tabs/pane-drop-target';
import type { Pane as PaneGroup } from '@core/primitives/workbench-shell/browser/tabs/pane-layout-store';
import { TabDragPreview } from '@core/primitives/workbench-shell/browser/tabs/tab-bar/tab-drag-preview';
import { NewTabButton } from '../new-tab-button';
import { PaneEmptyState } from '../pane-empty-state';

type ActiveDrag =
  | { kind: 'tab'; tabId: string }
  | { kind: 'terminal'; terminal: TerminalDrawerDragData };

// Drag-to-close threshold for the bottom drawer, in percent of the column.
// Below ~10% only the drawer tab bar and a row or two of terminal remain
// visible, so a drag settling there reads as intent to close rather than a
// resize. Deliberately under the drawer's old 15% resize floor, so every
// height the previous UI could persist stays a plain restore, never a close.
const TERMINAL_DRAWER_CLOSE_THRESHOLD = 10;

const collisionDetection: CollisionDetection = (args) => {
  const collisions = pointerWithin(args);
  const splitZones = collisions.filter((collision) =>
    isPaneSplitDropTargetId(String(collision.id))
  );
  return splitZones.length > 0 ? splitZones : collisions;
};

export const TaskMainColumn = observer(function TaskMainColumn() {
  const taskView = useTaskComposition();
  const { paneLayout } = taskView;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);

  // One storage facade per composition. TaskMainColumn renders below the task
  // view's space.isHydrated gate, so synchronous reads are safe by contract.
  const layoutStorage = useMemo(
    () => createLayoutStorage(taskView.space, taskPanelLayoutsMemento),
    [taskView.space]
  );
  const drawerBinding = useCollapsiblePanelBinding({
    storageKey: 'task-main-vertical',
    storage: layoutStorage,
    panelIds: ['task-main-content', 'task-terminal-drawer'],
    collapsiblePanelId: 'task-terminal-drawer',
    open: taskView.isTerminalDrawerOpen,
    onCloseRequest: () => taskView.chrome.commands.closeTerminalDrawer(),
    closeThreshold: TERMINAL_DRAWER_CLOSE_THRESHOLD,
  });

  const handleDragStart = (event: DragStartEvent) => {
    const terminalDragData = event.active.data.current;
    if (isTerminalDrawerDragData(terminalDragData)) {
      setActiveDrag({ kind: 'terminal', terminal: terminalDragData });
      return;
    }
    setActiveDrag({ kind: 'tab', tabId: event.active.id as string });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDrag(null);
    if (!event.over) return;

    const terminalDragData = event.active.data.current;
    if (isTerminalDrawerDragData(terminalDragData)) {
      const overId = String(event.over.id);
      const destination = paneLayout.materializeDropDestination(overId);
      if (!destination) return;
      paneLayout.setActiveGroup(destination.paneId);
      paneLayout.open(
        'terminal',
        { terminalId: terminalDragData.terminalId },
        { target: { paneId: destination.paneId } }
      );
      return;
    }

    paneLayout.handleDragEnd(event.active.id as string, event.over.id as string);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDrag(null)}
    >
      <Resizable.Group orientation="vertical" id="task-main-vertical" {...drawerBinding.groupProps}>
        <Resizable.Panel id="task-main-content" minSize="30%">
          <SplitPaneLayout storage={layoutStorage} />
        </Resizable.Panel>
        {/* Closed = panel AND handle unmounted (sync contract: never program
            the panels). Terminal content survives the unmount because each
            PTY session's xterm DOM is reparented to the off-screen host, not
            disposed (see usePty). */}
        {taskView.isTerminalDrawerOpen && (
          <>
            <Resizable.Handle />
            <Resizable.Panel
              {...drawerBinding.collapsiblePanelProps}
              defaultSize={drawerBinding.collapsiblePanelProps.defaultSize ?? '25%'}
            >
              <TerminalsPanel />
            </Resizable.Panel>
          </>
        )}
      </Resizable.Group>
      <DragOverlay dropAnimation={null}>
        {activeDrag?.kind === 'tab' ? (
          <TabDragPreview tabId={activeDrag.tabId} />
        ) : activeDrag?.kind === 'terminal' ? (
          <TerminalDragPreview label={activeDrag.terminal.label} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
});

const SplitPaneContent = observer(function SplitPaneContent({ group }: { group: PaneGroup }) {
  const { paneLayout } = useTaskComposition();
  const canSplit = group.pane.resolvedTabs.length >= 2 && paneLayout.canInsertPane;
  return (
    <PaneProvider
      group={group}
      canSplit={canSplit}
      splitPane={() => {
        paneLayout.setActiveGroup(group.paneId);
        paneLayout.splitRight();
      }}
      splitPaneDown={() => {
        paneLayout.setActiveGroup(group.paneId);
        paneLayout.splitDown();
      }}
    >
      <PaneContent
        emptyState={<PaneEmptyState />}
        trailingSlot={
          <>
            <Tooltip.Root>
              <Tooltip.Trigger>
                <Button
                  size="sm"
                  icon
                  variant="ghost"
                  disabled={!canSplit}
                  aria-label="Paneli sağa böl"
                  onClick={() => {
                    paneLayout.setActiveGroup(group.paneId);
                    paneLayout.splitRight();
                  }}
                >
                  <Columns2 className="size-3.5" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content>Paneli sağa böl</Tooltip.Content>
            </Tooltip.Root>
            <Tooltip.Root>
              <Tooltip.Trigger>
                <Button
                  size="sm"
                  icon
                  variant="ghost"
                  disabled={!canSplit}
                  aria-label="Paneli alta böl"
                  onClick={() => {
                    paneLayout.setActiveGroup(group.paneId);
                    paneLayout.splitDown();
                  }}
                >
                  <Rows2 className="size-3.5" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content>Paneli alta böl</Tooltip.Content>
            </Tooltip.Root>
            <NewTabButton />
          </>
        }
      />
    </PaneProvider>
  );
});

export const SplitPaneLayout = observer(function SplitPaneLayout({
  storage,
}: {
  storage: MementoLayoutStorage;
}) {
  const { paneLayout } = useTaskComposition();
  return <PaneTree node={paneLayout.layout} storage={storage} />;
});

function nodePanelId(node: PaneLayoutNode): string {
  return node.kind === 'pane' ? splitPanePanelId(node.paneId) : `split:${node.id}`;
}

const PaneTree = observer(function PaneTree({
  node,
  storage,
}: {
  node: PaneLayoutNode;
  storage: MementoLayoutStorage;
}) {
  const { paneLayout } = useTaskComposition();
  if (node.kind === 'pane') {
    const group = paneLayout.groups.find((group) => group.paneId === node.paneId);
    return group ? <SplitPaneContent group={group} /> : null;
  }
  return <PaneBranch node={node} storage={storage} />;
});

const PaneBranch = observer(function PaneBranch({
  node,
  storage,
}: {
  node: Extract<PaneLayoutNode, { kind: 'split' }>;
  storage: MementoLayoutStorage;
}) {
  const { paneLayout } = useTaskComposition();
  const panelIds = node.children.map(nodePanelId);
  const id = node.id === 'legacy' ? 'task-main-split' : `task-main-split-${node.id}`;
  const { defaultLayout, onLayoutChanged } = useResizableDefaultLayout({ id, panelIds, storage });
  return (
    <Resizable.Group
      orientation={node.axis}
      id={id}
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      {node.children.map((child, index) => (
        <Fragment key={nodePanelId(child)}>
          {index > 0 && <Resizable.Handle />}
          <Resizable.Panel
            id={nodePanelId(child)}
            defaultSize={`${defaultLayout?.[nodePanelId(child)] ?? 100 / node.children.length}%`}
            minSize={node.axis === 'horizontal' ? '120px' : '100px'}
            onPointerDown={() => {
              if (child.kind === 'pane') paneLayout.setActiveGroup(child.paneId);
            }}
          >
            <PaneTree node={child} storage={storage} />
          </Resizable.Panel>
        </Fragment>
      ))}
    </Resizable.Group>
  );
});

function TerminalDragPreview({ label }: { label: string }) {
  return (
    <div className="surface-paper flex cursor-grabbing items-center gap-1.5 rounded-md border border-border bg-(--em-surface) px-2 py-1 text-sm opacity-80 shadow-lg">
      <span className="max-w-[200px] truncate">{label}</span>
    </div>
  );
}
