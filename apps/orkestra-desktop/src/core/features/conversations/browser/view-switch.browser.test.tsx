import { ok, err } from '@orkestra/shared';
import { toast } from '@orkestra/ui/react/primitives';
import { defineContract } from '@orkestra/wire/rpc';
import { observable } from 'mobx';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedSliceWire } from '@core/primitives/wire/browser/testing';
import type { TabHost } from '@core/primitives/workbench-shell/browser/tabs/core/tab-host';
import type { ConversationStore } from '../api/browser/conversation-manager';
import { conversationsContract, conversationsDomain } from '../api/contract';
import { useConversationViewSwitch } from './use-conversation-view-switch';

vi.mock('@core/primitives/workbench-shell/browser/tabs/pane-context', () => ({
  usePaneContext: () => ({ paneId: 'pane-1' }),
}));
const retry = vi.hoisted(() => vi.fn());
vi.mock('./stores/conversation-session-manager', () => ({
  getConversationSessionManager: () => ({ retryHydration: retry }),
}));

const Harness = observer(function Harness({
  store,
  host,
  type,
}: {
  store: ConversationStore;
  host: TabHost;
  type: 'pty' | 'acp';
}) {
  const command = useConversationViewSwitch(store, host, 'old-tab', type);
  return command.isAvailable() ? (
    <button onClick={() => void command.run()}>{command.label}</button>
  ) : null;
});

describe('conversation view menu', () => {
  let container: HTMLDivElement;
  let root: Root;
  let wire: { dispose: () => Promise<void> };
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  beforeEach(() => {
    env.IS_REACT_ACT_ENVIRONMENT = true;
    retry.mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await wire?.dispose();
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  });

  it.each(['pty', 'acp'] as const)(
    'opens the other view before closing the %s tab',
    async (type) => {
      const data = {
        id: 'c1',
        projectId: 'p1',
        taskId: 't1',
        providerId: 'claude',
        title: 'Conversation',
        type,
        sessionId: 'native-session',
        lastInteractedAt: null,
        isInitialConversation: false,
      };
      const store = observable({ data }) as ConversationStore;
      const order: string[] = [];
      const host = {
        openKind: vi.fn(() => order.push('open')),
        closeTab: vi.fn(() => order.push('close')),
      } as unknown as TabHost;
      const switchView = vi.fn(async () =>
        ok({ ...data, type: type === 'pty' ? ('acp' as const) : ('pty' as const) })
      );
      wire = seedSliceWire(
        conversationsDomain,
        defineContract({ switchView: conversationsContract.switchView }),
        {
          switchView,
        }
      );
      await act(async () => root.render(<Harness store={store} host={host} type={type} />));
      expect(container.textContent).toBe(
        type === 'pty' ? 'Sohbet görünümüne geç' : 'Terminal görünümüne geç'
      );
      await act(async () => container.querySelector('button')!.click());
      await vi.waitFor(() => expect(order).toEqual(['open', 'close']));
      expect(host.openKind).toHaveBeenCalledWith(
        type === 'pty' ? 'acp-chat' : 'conversation',
        { conversationId: 'c1' },
        { target: { paneId: 'pane-1' }, preview: false }
      );
      expect(store.data.sessionId).toBe('native-session');
      if (type === 'acp') expect(retry).toHaveBeenCalledWith('c1');
    }
  );

  it('offers stop-and-return only after the host reports an unobserved terminal', async () => {
    const data = {
      id: 'c1',
      projectId: 'p1',
      taskId: 't1',
      providerId: 'claude',
      type: 'pty' as const,
      title: 'Saved chat',
      sessionId: 'native-session',
      lastInteractedAt: null,
      isInitialConversation: false,
    };
    const store = observable({ data }) as ConversationStore;
    const host = { openKind: vi.fn(), closeTab: vi.fn() } as unknown as TabHost;
    const switchView = vi.fn(async (input: { stopUnobservedTerminal?: boolean }) =>
      input.stopUnobservedTerminal
        ? ok({ ...data, type: 'acp' as const })
        : err({
            type: 'view-switch-failed' as const,
            message: 'Terminal durumu alınamadı',
            canStopTerminal: true,
          })
    );
    wire = seedSliceWire(
      conversationsDomain,
      defineContract({ switchView: conversationsContract.switchView }),
      { switchView }
    );
    const notification = vi.spyOn(toast, 'error').mockReturnValue('recovery');
    try {
      await act(async () => root.render(<Harness store={store} host={host} type="pty" />));
      await act(async () => container.querySelector('button')!.click());
      await vi.waitFor(() => expect(notification).toHaveBeenCalled());
      expect(host.openKind).not.toHaveBeenCalled();
      expect(switchView).toHaveBeenCalledTimes(1);
      const action = notification.mock.calls[0]?.[1]?.action as {
        label: string;
        onClick: () => void;
      };
      expect(action.label).toBe('Durdur ve sohbete geç');
      await act(async () => action.onClick());
      await vi.waitFor(() => expect(host.openKind).toHaveBeenCalled());
      expect(switchView.mock.calls[1]?.[0]).toMatchObject({ stopUnobservedTerminal: true });
      expect(store.data.sessionId).toBe('native-session');
    } finally {
      notification.mockRestore();
    }
  });

  it.each([
    ['grok', '01a10889-02e1-7043-8beb-c8071aa18201'],
    ['kimi', 'session_ebdc4615-036f-4138-bb1f-35b773be3149'],
  ])('offers the %s switch only once the native session id is known', async (providerId, id) => {
    const store = observable({
      data: { id: 'c1', providerId, type: 'pty' as const, sessionId: 'c1' },
    }) as unknown as ConversationStore;
    const host = { openKind: vi.fn(), closeTab: vi.fn() } as unknown as TabHost;
    await act(async () => root.render(<Harness store={store} host={host} type="pty" />));
    expect(container.textContent).toBe('');
    await act(async () => {
      store.data.sessionId = id;
    });
    expect(container.textContent).toBe('Sohbet görünümüne geç');
  });

  it('keeps the current tab when the host refuses a busy conversation', async () => {
    const store = observable({
      data: { id: 'c1', providerId: 'claude', type: 'acp', sessionId: 'native-session' },
    }) as ConversationStore;
    const host = { openKind: vi.fn(), closeTab: vi.fn() } as unknown as TabHost;
    wire = seedSliceWire(
      conversationsDomain,
      defineContract({ switchView: conversationsContract.switchView }),
      {
        switchView: async () =>
          err({ type: 'view-switch-failed' as const, message: 'Ajan çalışıyor' }),
      }
    );
    await act(async () => root.render(<Harness store={store} host={host} type="acp" />));
    await act(async () => container.querySelector('button')!.click());
    await vi.waitFor(() => expect(container.textContent).toBe('Terminal görünümüne geç'));
    expect(host.openKind).not.toHaveBeenCalled();
    expect(host.closeTab).not.toHaveBeenCalled();
  });
});
