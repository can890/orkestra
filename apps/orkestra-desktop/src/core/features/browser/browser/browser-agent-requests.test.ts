import { observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/features/browser/api/browser/client', () => ({
  getBrowserClient: async () => ({
    unregisterSession: vi.fn(),
    events: {
      subscribe: vi.fn(async () => () => {}),
    },
  }),
}));

vi.mock('@core/primitives/telemetry/browser/telemetry-scope', () => ({
  setTelemetryConversationScope: vi.fn(),
}));

vi.mock('@core/features/browser/browser/browser-tab-item', () => ({
  BrowserTabBarItem: () => null,
  BrowserTabBarItemDragPreview: () => null,
}));
vi.mock('@core/features/editor/browser/task-editor/file-tab-item', () => ({
  FileTabBarItem: () => null,
  FileTabBarItemDragPreview: () => null,
}));
vi.mock('@core/features/conversations/browser/conversation-tab-item', () => ({
  ConversationTabBarItem: () => null,
  ConversationTabBarItemDragPreview: () => null,
}));
vi.mock('@core/features/source-control/browser/diff-view/diff-tab-item', () => ({
  DiffTabBarItem: () => null,
  DiffTabBarItemDragPreview: () => null,
  diffGroupSuffix: (group: string) => `(${group})`,
}));
vi.mock('@core/features/conversations/api/browser/conversation-title-utils', () => ({
  formatConversationTitleForDisplay: (_providerId: unknown, title: unknown) =>
    (title as string) ?? 'Conversation',
}));
vi.mock('@core/features/conversations/browser/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    conversationId = '';
    dispose() {}
    bootstrap() {}
  },
}));
vi.mock('@core/features/conversations/browser/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { browserAgentActivity } from '@core/features/browser/api/browser/browser-agent-activity';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { taskTabView } from '@core/features/workbench/api/browser/task-tab-registry';
import type { BrowserAgentRequestReply, BrowserEvent } from '@core/primitives/browser/api';
import { PaneLayoutStore } from '@core/primitives/workbench-shell/browser/tabs/pane-layout-store';
import {
  browserIdOfEntry,
  findBrowserTab,
  openAgentBrowserTab,
  resolveAgentBrowserPane,
} from './agent-tab-placement';
import {
  collectTaskActiveBrowsers,
  createBrowserAgentRequestHandler,
  type BrowserAgentRequestDeps,
} from './browser-agent-requests';

const TASK = { projectId: 'project-1', workspaceId: 'workspace-1', taskId: 'task-1' };

function createLayout(taskId = TASK.taskId) {
  const ctx = { viewId: taskId, ...TASK, taskId };
  return new PaneLayoutStore(taskTabView.registry, ctx);
}

type Layout = ReturnType<typeof createLayout>;

function userBrowserTab(layout: Layout, url = 'https://user.example/'): string {
  runInAction(() => layout.open('browser', { initialUrl: url }));
  const browserId = browserIdOfEntry(layout.focusedPane.activeEntry);
  if (!browserId) throw new Error('Expected a browser tab');
  return browserId;
}

function paneOf(layout: Layout, browserId: string) {
  return findBrowserTab(layout, browserId);
}

describe('agent browser tab placement', () => {
  beforeEach(() => {
    browserSessionStore.clear();
    browserAgentActivity.clear();
  });

  it('splits a single pane to the right and keeps the user in the focused pane', () => {
    const layout = createLayout();
    const userTab = userBrowserTab(layout);
    const focusedPaneId = layout.activePaneId;

    const browserId = runInAction(() =>
      openAgentBrowserTab(layout, { url: 'http://localhost:5173/', activate: true })
    );

    expect(layout.groups).toHaveLength(2);
    expect(layout.layout).toMatchObject({ kind: 'split', axis: 'horizontal' });
    expect(layout.activePaneId).toBe(focusedPaneId);
    expect(paneOf(layout, userTab)?.paneId).toBe(focusedPaneId);
    const placed = paneOf(layout, browserId);
    expect(placed?.paneId).not.toBe(focusedPaneId);
    expect(placed?.pane.resolvedActiveTabId).toBe(placed?.tabId);
    expect(browserSessionStore.getSession(browserId)).toMatchObject({
      ...TASK,
      currentUrl: 'http://localhost:5173/',
    });
    expect(browserAgentActivity.isAgentOpened(browserId)).toBe(true);
    layout.dispose();
  });

  it('reuses the agent pane for later tabs instead of splitting again', () => {
    const layout = createLayout();
    userBrowserTab(layout);
    const first = runInAction(() => openAgentBrowserTab(layout, { activate: true }));
    const second = runInAction(() =>
      openAgentBrowserTab(layout, { url: 'https://example.com/', activate: true })
    );

    expect(layout.groups).toHaveLength(2);
    expect(paneOf(layout, second)?.paneId).toBe(paneOf(layout, first)?.paneId);
    expect(paneOf(layout, second)?.pane.tabOrder).toHaveLength(2);
    layout.dispose();
  });

  it('keeps the front tab of the agent pane when activate is false', () => {
    const layout = createLayout();
    userBrowserTab(layout);
    const first = runInAction(() => openAgentBrowserTab(layout, { activate: true }));
    const background = runInAction(() =>
      openAgentBrowserTab(layout, { url: 'https://example.com/', activate: false })
    );

    const agentPane = paneOf(layout, first)!;
    expect(agentPane.pane.resolvedActiveTabId).toBe(agentPane.tabId);
    expect(paneOf(layout, background)?.paneId).toBe(agentPane.paneId);
    layout.dispose();
  });

  it('opens in the only pane when it is empty', () => {
    const layout = createLayout();
    const browserId = runInAction(() => openAgentBrowserTab(layout, { activate: true }));

    expect(layout.groups).toHaveLength(1);
    expect(paneOf(layout, browserId)?.paneId).toBe(layout.activePaneId);
    layout.dispose();
  });

  it('uses a pane that already shows a browser when the task has several panes', () => {
    const layout = createLayout();
    const leftTab = userBrowserTab(layout);
    const leftPaneId = layout.activePaneId;
    const rightPaneId = runInAction(() => layout.insertPane(leftPaneId, 'right'))!;
    runInAction(() => layout.open('browser', {}, { target: { paneId: rightPaneId } }));
    runInAction(() => layout.setActiveGroup(rightPaneId));

    expect(resolveAgentBrowserPane(layout)).toBe(leftPaneId);

    const browserId = runInAction(() => openAgentBrowserTab(layout, { activate: false }));
    expect(paneOf(layout, browserId)?.paneId).toBe(leftPaneId);
    expect(paneOf(layout, leftTab)?.pane.resolvedActiveTabId).toBe(paneOf(layout, leftTab)?.tabId);
    expect(layout.activePaneId).toBe(rightPaneId);
    expect(layout.groups).toHaveLength(2);
    layout.dispose();
  });
});

describe('createBrowserAgentRequestHandler', () => {
  let layouts: Map<string, Layout>;
  let deps: BrowserAgentRequestDeps;

  beforeEach(() => {
    browserSessionStore.clear();
    browserAgentActivity.clear();
    layouts = new Map();
    deps = {
      getTaskLayout: (projectId, taskId) => layouts.get(`${projectId}/${taskId}`),
      activateTask: vi.fn(async () => null),
      layoutWaitMs: 1_000,
    };
  });

  afterEach(() => {
    for (const layout of layouts.values()) layout.dispose();
    vi.useRealTimers();
  });

  function openRequest(overrides: Partial<Extract<BrowserEvent, { type: 'open-requested' }>> = {}) {
    return {
      type: 'open-requested',
      requestId: 'request-1',
      ...TASK,
      url: 'https://example.com/',
      activate: true,
      ...overrides,
    } satisfies BrowserEvent;
  }

  function okBrowserId(reply: BrowserAgentRequestReply | null): string {
    if (!reply?.ok || !reply.browserId)
      throw new Error(`Unexpected reply ${JSON.stringify(reply)}`);
    return reply.browserId;
  }

  it('opens the tab in a ready task and answers with its browser id', async () => {
    const layout = createLayout();
    layouts.set('project-1/task-1', layout);
    const handler = createBrowserAgentRequestHandler(deps);

    const reply = await handler.handle(openRequest());

    const browserId = okBrowserId(reply);
    expect(reply).toMatchObject({ requestId: 'request-1', ok: true });
    expect(findBrowserTab(layout, browserId)).toBeDefined();
    expect(deps.activateTask).not.toHaveBeenCalled();
  });

  it('activates a task in the background and waits for its layout', async () => {
    const layout = createLayout();
    const readyLayouts = observable.map<string, Layout>();
    let finishActivation: () => void = () => {};
    deps.activateTask = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finishActivation = () => resolve(null);
        })
    );
    const handler = createBrowserAgentRequestHandler({
      ...deps,
      getTaskLayout: (projectId, taskId) => readyLayouts.get(`${projectId}/${taskId}`),
    });

    const pending = handler.handle(openRequest());
    await Promise.resolve();
    expect(deps.activateTask).toHaveBeenCalledWith('project-1', 'task-1');

    // Activation resolves before the persisted layout is restored; the handler keeps waiting.
    finishActivation();
    await Promise.resolve();
    runInAction(() => readyLayouts.set('project-1/task-1', layout));
    const reply = await pending;

    expect(findBrowserTab(layout, okBrowserId(reply))).toBeDefined();
    layout.dispose();
  });

  it('reports activation failures and timeouts', async () => {
    deps.activateTask = vi.fn(async () => 'Task task-1 was not found.');
    const failing = createBrowserAgentRequestHandler(deps);
    await expect(failing.handle(openRequest())).resolves.toEqual({
      requestId: 'request-1',
      ok: false,
      error: 'Task task-1 was not found.',
    });

    vi.useFakeTimers();
    deps.activateTask = vi.fn(() => new Promise<string | null>(() => {}));
    const stuck = createBrowserAgentRequestHandler(deps);
    const reply = stuck.handle(openRequest());
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(reply).resolves.toEqual({
      requestId: 'request-1',
      ok: false,
      error: 'Task task-1 did not become ready in the Orkestra window in time.',
    });
  });

  it('brings a tab to the front of its pane without changing the focused pane', async () => {
    const layout = createLayout();
    layouts.set('project-1/task-1', layout);
    const handler = createBrowserAgentRequestHandler(deps);
    const first = okBrowserId(await handler.handle(openRequest({ requestId: 'open-1' })));
    okBrowserId(await handler.handle(openRequest({ requestId: 'open-2' })));
    const focusedPaneId = layout.activePaneId;

    const reply = await handler.handle({
      type: 'activate-requested',
      requestId: 'activate-1',
      browserId: first,
    });

    expect(reply).toEqual({ requestId: 'activate-1', ok: true, browserId: first });
    const placed = findBrowserTab(layout, first)!;
    expect(placed.pane.resolvedActiveTabId).toBe(placed.tabId);
    expect(layout.activePaneId).toBe(focusedPaneId);

    await expect(
      handler.handle({ type: 'activate-requested', requestId: 'activate-2', browserId: 'nope' })
    ).resolves.toEqual({
      requestId: 'activate-2',
      ok: false,
      error: 'Browser tab nope is not open.',
    });
  });

  it('closes a tab and its session; closing a missing tab still succeeds', async () => {
    const layout = createLayout();
    layouts.set('project-1/task-1', layout);
    const handler = createBrowserAgentRequestHandler(deps);
    const browserId = okBrowserId(await handler.handle(openRequest()));

    await expect(
      handler.handle({ type: 'close-requested', requestId: 'close-1', browserId })
    ).resolves.toEqual({ requestId: 'close-1', ok: true, browserId });
    expect(findBrowserTab(layout, browserId)).toBeUndefined();
    expect(browserSessionStore.getSession(browserId)).toBeUndefined();

    await expect(
      handler.handle({ type: 'close-requested', requestId: 'close-2', browserId })
    ).resolves.toMatchObject({ requestId: 'close-2', ok: true });
  });

  it('marks agent activity without replying and ignores unrelated events', async () => {
    const handler = createBrowserAgentRequestHandler(deps);

    await expect(
      handler.handle({ type: 'agent-activity', browserId: 'browser-1', at: 1 })
    ).resolves.toBeNull();
    expect(browserAgentActivity.isActive('browser-1')).toBe(true);
    await expect(
      handler.handle({ type: 'link-copied', kind: 'url', url: 'https://example.com/' })
    ).resolves.toBeNull();
  });
});

describe('collectTaskActiveBrowsers', () => {
  beforeEach(() => {
    browserSessionStore.clear();
    browserAgentActivity.clear();
  });

  it('reports the front browser tab of every pane per task', () => {
    const layout = createLayout();
    const background = userBrowserTab(layout);
    const front = userBrowserTab(layout);
    const agent = runInAction(() => openAgentBrowserTab(layout, { activate: true }));
    const other = createLayout('task-2');

    expect(
      collectTaskActiveBrowsers((projectId, taskId) =>
        taskId === 'task-1' ? layout : taskId === 'task-2' ? other : undefined
      )
    ).toEqual([{ projectId: 'project-1', taskId: 'task-1', browserIds: [front, agent].sort() }]);
    expect(background).not.toBe(front);
    layout.dispose();
    other.dispose();
  });
});
