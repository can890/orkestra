import { observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/features/browser/api/browser/client', () => ({
  getBrowserClient: async () => ({
    unregisterSession: vi.fn(async () => ({ success: true })),
    events: {
      subscribe: vi.fn(async () => () => {}),
    },
  }),
}));

vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { browserAgentActivity } from '@core/features/browser/api/browser/browser-agent-activity';
import { browserMiniPlayerStore } from '@core/features/browser/api/browser/browser-mini-player-store';
import { browserPointerStore } from '@core/features/browser/api/browser/browser-pointer-store';
import { browserRightPanelStore } from '@core/features/browser/api/browser/browser-right-panel-store';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import {
  BROWSER_AGENT_PROFILE_ID,
  BROWSER_ISOLATED_PROFILE_ID,
  type BrowserAgentRequestReply,
  type BrowserEvent,
} from '@core/primitives/browser/api';
import {
  collectTaskActiveBrowsers,
  createBrowserAgentRequestHandler,
  type BrowserAgentRequestDeps,
} from './browser-agent-requests';

const TASK = { projectId: 'project-1', workspaceId: 'workspace-1', taskId: 'task-1' };

describe('createBrowserAgentRequestHandler (T3 right panel + floating mini-player)', () => {
  let readyTasks: Set<string>;
  let deps: BrowserAgentRequestDeps;

  beforeEach(() => {
    browserRightPanelStore.clear();
    browserMiniPlayerStore.clear();
    browserSessionStore.clear();
    browserAgentActivity.clear();
    browserPointerStore.pointers.clear();
    browserPointerStore.findResults.clear();
    readyTasks = observable.set(['project-1/task-1']);
    deps = {
      isTaskReady: (projectId, taskId) => readyTasks.has(`${projectId}/${taskId}`),
      activateTask: vi.fn(async () => null),
      layoutWaitMs: 1_000,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function openRequest(
    overrides: Partial<Extract<BrowserEvent, { type: 'open-requested' }>> = {}
  ) {
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
    if (!reply?.ok || !reply.browserId) {
      throw new Error(`Unexpected reply ${JSON.stringify(reply)}`);
    }
    return reply.browserId;
  }

  it('opens in floating mini-player when right panel is closed, then docks seamlessly to right panel', async () => {
    const handler = createBrowserAgentRequestHandler(deps);

    const browserId = okBrowserId(await handler.handle(openRequest()));

    expect(browserRightPanelStore.isOpen(TASK.projectId, TASK.taskId)).toBe(false);
    expect(browserMiniPlayerStore.floatingBrowserForTask(TASK.projectId, TASK.taskId)).toBe(
      browserId
    );
    expect(browserSessionStore.getSession(browserId)).toMatchObject({
      ...TASK,
      currentUrl: 'https://example.com/',
    });
    expect(browserAgentActivity.isAgentOpened(browserId)).toBe(true);

    browserRightPanelStore.dockMiniPlayerToPanel(TASK.projectId, TASK.taskId, browserId);
    expect(browserMiniPlayerStore.floatingBrowserForTask(TASK.projectId, TASK.taskId)).toBeNull();
    expect(browserRightPanelStore.isOpen(TASK.projectId, TASK.taskId)).toBe(true);
    expect(browserRightPanelStore.activeTabForTask(TASK.projectId, TASK.taskId)).toBe(browserId);

    browserRightPanelStore.floatTabToMiniPlayer(TASK.projectId, TASK.taskId, browserId);
    expect(browserRightPanelStore.isOpen(TASK.projectId, TASK.taskId)).toBe(false);
    expect(browserMiniPlayerStore.floatingBrowserForTask(TASK.projectId, TASK.taskId)).toBe(
      browserId
    );
  });

  it('opens in right panel when right panel is already open', async () => {
    browserRightPanelStore.openTab(TASK, { initialUrl: 'https://user.example/', mode: 'panel' });
    const handler = createBrowserAgentRequestHandler(deps);

    const browserId = okBrowserId(await handler.handle(openRequest()));

    expect(browserRightPanelStore.isOpen(TASK.projectId, TASK.taskId)).toBe(true);
    expect(browserMiniPlayerStore.floatingBrowserForTask(TASK.projectId, TASK.taskId)).toBeNull();
    expect(browserRightPanelStore.activeTabForTask(TASK.projectId, TASK.taskId)).toBe(browserId);
  });

  it('opens agent tabs with agent or isolated profile while user tabs keep default profile', async () => {
    const userTab = browserRightPanelStore.openTab(TASK, {
      initialUrl: 'https://user.example/',
      mode: 'panel',
    });

    const agentHandler = createBrowserAgentRequestHandler({
      ...deps,
      agentProfileId: () => BROWSER_AGENT_PROFILE_ID,
    });
    const agentTab = okBrowserId(await agentHandler.handle(openRequest({ requestId: 'req-agent' })));
    expect(browserSessionStore.getSession(agentTab)).toMatchObject({
      profileId: BROWSER_AGENT_PROFILE_ID,
      partition: 'persist:orkestra-browser-agent',
    });
    expect(browserSessionStore.getSession(userTab)?.profileId).toBe('default');

    const isolatedHandler = createBrowserAgentRequestHandler({
      ...deps,
      agentProfileId: () => BROWSER_ISOLATED_PROFILE_ID,
    });
    const isolatedTab = okBrowserId(
      await isolatedHandler.handle(openRequest({ requestId: 'req-iso' }))
    );
    expect(browserSessionStore.getSession(isolatedTab)?.partition).toBe(
      'persist:orkestra-browser-isolated-project-1-workspace-1-task-1'
    );
  });

  it('activates a background task and waits for readiness before opening tab', async () => {
    readyTasks.clear();
    let finishActivation = () => {};
    deps.activateTask = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finishActivation = () => resolve(null);
        })
    );
    const handler = createBrowserAgentRequestHandler(deps);

    const pending = handler.handle(openRequest());
    await Promise.resolve();
    expect(deps.activateTask).toHaveBeenCalledWith('project-1', 'task-1');

    finishActivation();
    await Promise.resolve();
    runInAction(() => readyTasks.add('project-1/task-1'));
    const reply = await pending;

    const browserId = okBrowserId(reply);
    expect(browserRightPanelStore.hasTab(browserId)).toBe(true);
  });

  it('reports activation failures and timeouts', async () => {
    readyTasks.clear();
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
    const pending = stuck.handle(openRequest());
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({
      requestId: 'request-1',
      ok: false,
      error: 'Task task-1 did not become ready in the Orkestra window in time.',
    });
  });

  it('activates and closes tabs cleanly and tolerates closing missing tabs', async () => {
    browserRightPanelStore.openPanel(TASK);
    const handler = createBrowserAgentRequestHandler(deps);
    const first = okBrowserId(await handler.handle(openRequest({ requestId: 'open-1' })));
    okBrowserId(await handler.handle(openRequest({ requestId: 'open-2' })));

    const activateReply = await handler.handle({
      type: 'activate-requested',
      requestId: 'activate-1',
      browserId: first,
    });
    expect(activateReply).toEqual({ requestId: 'activate-1', ok: true, browserId: first });
    expect(browserRightPanelStore.activeTabForTask(TASK.projectId, TASK.taskId)).toBe(first);

    await expect(
      handler.handle({ type: 'activate-requested', requestId: 'activate-missing', browserId: 'nope' })
    ).resolves.toEqual({
      requestId: 'activate-missing',
      ok: false,
      error: 'Browser tab nope is not open.',
    });

    await expect(
      handler.handle({ type: 'close-requested', requestId: 'close-1', browserId: first })
    ).resolves.toEqual({ requestId: 'close-1', ok: true, browserId: first });
    expect(browserSessionStore.getSession(first)).toBeUndefined();

    await expect(
      handler.handle({ type: 'close-requested', requestId: 'close-2', browserId: first })
    ).resolves.toMatchObject({ requestId: 'close-2', ok: true });
  });

  it('handles pip, audio, find, controller, pointer, and activity events', async () => {
    const browserId = browserRightPanelStore.openTab(TASK, {
      initialUrl: 'https://example.com/',
      mode: 'mini-player',
    });
    const handler = createBrowserAgentRequestHandler(deps);

    await expect(handler.handle({ type: 'agent-activity', browserId, at: 1 })).resolves.toBeNull();
    expect(browserAgentActivity.isActive(browserId)).toBe(true);

    await handler.handle({ type: 'pip-state-changed', browserId, open: true });
    expect(browserSessionStore.getSession(browserId)?.pictureInPicture).toBe(true);

    await handler.handle({ type: 'audio-state-changed', browserId, audible: true, muted: false });
    expect(browserSessionStore.getSession(browserId)).toMatchObject({
      audible: true,
      audioMuted: false,
    });

    await handler.handle({ type: 'controller-changed', browserId, controller: 'user' });
    expect(browserSessionStore.getSession(browserId)?.controller).toBe('user');

    await handler.handle({
      type: 'find-result',
      browserId,
      activeMatchOrdinal: 2,
      matches: 5,
      finalUpdate: true,
    });
    expect(browserPointerStore.getFindResult(browserId)).toMatchObject({
      activeMatchOrdinal: 2,
      matches: 5,
    });

    await handler.handle({
      type: 'agent-pointer',
      browserId,
      x: 120,
      y: 240,
      action: 'click',
      at: 99,
    });
    expect(browserPointerStore.getPointer(browserId)).toMatchObject({
      x: 120,
      y: 240,
      action: 'click',
    });
  });
});

describe('collectTaskActiveBrowsers', () => {
  beforeEach(() => {
    browserRightPanelStore.clear();
    browserMiniPlayerStore.clear();
    browserSessionStore.clear();
  });

  it('collects visible right panel active tab and floating mini-player per task', () => {
    const floating = browserRightPanelStore.openTab(TASK, {
      initialUrl: 'https://mini.example/',
      mode: 'mini-player',
    });
    const panelTab = browserRightPanelStore.openTab(
      { projectId: 'project-1', workspaceId: 'workspace-1', taskId: 'task-2' },
      { initialUrl: 'https://panel.example/', mode: 'panel' }
    );

    expect(collectTaskActiveBrowsers()).toEqual([
      { projectId: 'project-1', taskId: 'task-1', browserIds: [floating] },
      { projectId: 'project-1', taskId: 'task-2', browserIds: [panelTab] },
    ]);
  });
});
