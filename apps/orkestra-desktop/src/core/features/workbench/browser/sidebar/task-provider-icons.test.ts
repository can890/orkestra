import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import type { TaskStore } from '@core/features/tasks/api/browser/stores/task-store';

const getHandoffProviderChainMock = vi.hoisted(() => vi.fn<(id: string) => string[]>(() => []));

vi.mock('@core/features/conversations/api/browser/handoff-visibility', () => ({
  getHandoffProviderChain: getHandoffProviderChainMock,
  subscribeHandoffStore: () => () => {},
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

vi.mock('@core/features/agents/api/browser/use-agent-metadata', () => ({
  useAgentMetadata: () => ({
    data: [
      { id: 'codex', name: 'Codex' },
      { id: 'claude', name: 'Claude' },
      { id: 'antigravity', name: 'Antigravity' },
      { id: 'gemini', name: 'Gemini CLI' },
      { id: 'kimi', name: 'Kimi' },
    ],
  }),
}));

vi.mock('@core/features/agents/contributions/browser/agent-icon', () => ({
  AgentIcon: ({ id, size }: { id: string; size?: number }) =>
    React.createElement('span', { 'data-agent-icon': id, 'data-size': size }),
}));

vi.mock('@orkestra/ui/react/primitives', () => ({
  Tooltip: {
    Root: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { 'data-tooltip-root': 'true' }, children),
    Trigger: ({ render, children }: { render?: React.ReactElement; children?: React.ReactNode }) =>
      render ?? React.createElement('span', null, children),
    Content: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { 'data-tooltip-content': 'true' }, children),
  },
}));

import { collectTaskProviderIds, TaskProviderIcons } from './task-provider-icons';

function makeTask(
  id: string,
  opts: {
    state?: 'unregistered' | 'unprovisioned' | 'provisioned';
    conversations?: Record<string, number>;
  } = {}
): TaskStore {
  return {
    state: opts.state ?? 'provisioned',
    data: {
      id,
      projectId: 'project-1',
      name: id,
      status: 'todo',
      isPinned: false,
      type: 'task',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      statusChangedAt: '2026-01-01T00:00:00.000Z',
      conversations: opts.conversations ?? {},
    },
  } as unknown as TaskStore;
}

describe('collectTaskProviderIds', () => {
  afterEach(() => {
    getHandoffProviderChainMock.mockReset();
    getHandoffProviderChainMock.mockReturnValue([]);
    vi.restoreAllMocks();
  });

  it('returns empty array for unregistered or conversation-less tasks', () => {
    vi.spyOn(conversationRegistry, 'get').mockReturnValue(undefined);
    expect(collectTaskProviderIds(makeTask('t-unreg', { state: 'unregistered' }))).toEqual([]);
    expect(collectTaskProviderIds(makeTask('t-empty', { conversations: {} }))).toEqual([]);
  });

  it('falls back to taskConversationStats when conversationRegistry is not loaded', () => {
    vi.spyOn(conversationRegistry, 'get').mockReturnValue(undefined);
    const task = makeTask('t-fallback', {
      state: 'unprovisioned',
      conversations: { codex: 1, claude: 2 },
    });

    expect(collectTaskProviderIds(task)).toEqual(['codex', 'claude']);
  });

  it('collects handoff chain providers and conversation providers in chronological order without duplicates', () => {
    const conv1 = {
      data: {
        id: 'conv-1',
        providerId: 'claude',
        isInitialConversation: true,
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    };
    const conv2 = {
      data: {
        id: 'conv-2',
        providerId: 'antigravity',
        isInitialConversation: false,
        createdAt: '2026-01-01T00:00:02.000Z',
      },
    };
    // Registry map inserted out of chronological order to verify sorting by createdAt
    vi.spyOn(conversationRegistry, 'get').mockReturnValue({
      conversations: new Map([
        ['conv-2', conv2],
        ['conv-1', conv1],
      ]),
    } as never);

    const handoffChains = new Map<string, string[]>([
      ['conv-1', ['codex', 'claude']],
      ['conv-2', ['claude', 'antigravity']],
    ]);

    getHandoffProviderChainMock.mockImplementation((id) => handoffChains.get(id) ?? []);

    expect(collectTaskProviderIds(makeTask('t-1'))).toEqual(['codex', 'claude', 'antigravity']);
  });
});

describe('TaskProviderIcons', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost',
    });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    dom.window.close();
  });

  it('renders up to maxIcons provider icons, +N overflow badge, and provider tooltip', async () => {
    vi.spyOn(conversationRegistry, 'get').mockReturnValue(undefined);
    const task = makeTask('t-multi', {
      state: 'unprovisioned',
      conversations: { codex: 1, claude: 1, antigravity: 1, gemini: 1, kimi: 1 },
    });

    await act(async () => {
      root.render(React.createElement(TaskProviderIcons, { task, maxIcons: 3 }));
    });

    const icons = [...container.querySelectorAll('[data-agent-icon]')].map((el) =>
      el.getAttribute('data-agent-icon')
    );
    expect(icons).toEqual(['codex', 'claude', 'antigravity']);
    expect(container.textContent).toContain('+2');
    expect(container.querySelector('[data-tooltip-content]')?.textContent).toBe(
      'Codex · Claude · Antigravity · Gemini CLI · Kimi'
    );
  });

  it('renders nothing when the task has no conversations', async () => {
    vi.spyOn(conversationRegistry, 'get').mockReturnValue(undefined);
    const task = makeTask('t-none', { state: 'unprovisioned', conversations: {} });

    await act(async () => {
      root.render(React.createElement(TaskProviderIcons, { task }));
    });

    expect(container.innerHTML).toBe('');
  });
});
