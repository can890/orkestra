import { err, ok } from '@orkestra/shared';
import { toast } from '@orkestra/ui/react/primitives';
import { defineContract } from '@orkestra/wire/rpc';
import { observable } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@core/primitives/conversations/api';
import { seedSliceWire } from '@core/primitives/wire/browser/testing';
import { conversationsContract, conversationsDomain } from '../contract';
import type { ConversationStore } from './conversation-manager';
import {
  collectOpenConversationIds,
  executeConversationViewSwitch,
  resolveTaskSwitchableConversation,
} from './conversation-view-switch';
import { getHandoffStore } from '@core/features/conversations/browser/handoff/handoff-store';
import { conversationRegistry } from './stores/conversation-registry';

function makeConversation(overrides: Partial<Conversation> & { id: string }): ConversationStore {
  return observable({
    data: {
      projectId: 'p1',
      taskId: 't1',
      providerId: 'claude',
      title: 'Sohbet',
      type: 'acp' as const,
      sessionId: 'native-session-1',
      lastInteractedAt: null,
      isInitialConversation: false,
      ...overrides,
    },
  }) as ConversationStore;
}

describe('conversation-view-switch helpers', () => {
  let wire: { dispose: () => Promise<void> } | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await wire?.dispose();
    wire = undefined;
  });

  describe('resolveTaskSwitchableConversation', () => {
    it('prioritizes preferredConversationIds, skips superseded conversations, and falls back by interaction recency', () => {
      const c1 = makeConversation({
        id: 'c-old',
        lastInteractedAt: '2026-01-01T10:00:00.000Z',
        isInitialConversation: true,
      });
      const c2 = makeConversation({
        id: 'c-newer',
        providerId: 'codex',
        sessionId: 'codex-real-1',
        lastInteractedAt: '2026-01-02T10:00:00.000Z',
      });
      const c3Unsupported = makeConversation({
        id: 'c-unsupported',
        providerId: 'gemini',
        lastInteractedAt: '2026-01-03T10:00:00.000Z',
      });
      const c4Superseded = makeConversation({
        id: 'c-superseded',
        lastInteractedAt: '2026-01-04T10:00:00.000Z',
      });

      const conversations = new Map<string, ConversationStore>([
        ['c-old', c1],
        ['c-newer', c2],
        ['c-unsupported', c3Unsupported],
        ['c-superseded', c4Superseded],
      ]);

      vi.spyOn(conversationRegistry, 'get').mockReturnValue({ conversations } as never);
      vi.spyOn(getHandoffStore(), 'isSuperseded').mockImplementation(
        (id) => id === 'c-superseded'
      );

      // Açık sekmelerdeki geçerli tercih önce seçilir; superseded olan atlanır.
      expect(
        resolveTaskSwitchableConversation('t1', ['c-superseded', 'c-old'])?.data.id
      ).toBe('c-old');

      // Tercih verilmezse destekleyen + oturumu hazır en güncel sohbet seçilir (desteklemeyen c3 ve superseded c4 elenir).
      expect(resolveTaskSwitchableConversation('t1')?.data.id).toBe('c-newer');

      // Yalnızca desteklemeyen konuşma varsa bile bilgi amaçlı döndürülür (menü öğesi kendi gizler).
      vi.spyOn(conversationRegistry, 'get').mockReturnValue({
        conversations: new Map([['c-unsupported', c3Unsupported]]),
      } as never);
      expect(resolveTaskSwitchableConversation('t1')?.data.id).toBe('c-unsupported');
    });
  });

  describe('collectOpenConversationIds', () => {
    it('collects active focused tab first then remaining pane conversation tabs without duplicates', () => {
      const ids = collectOpenConversationIds({
        focusedPane: {
          resolvedActiveTabId: 'tab-2',
          entries: new Map([
            ['tab-2', { kind: 'acp-chat', state: { conversationId: 'conv-active' } }],
          ]),
        },
        groups: [
          {
            pane: {
              resolvedActiveTabId: 'tab-1',
              tabOrder: ['tab-1', 'tab-2', 'tab-3'],
              entries: new Map([
                ['tab-1', { kind: 'conversation', state: { conversationId: 'conv-other' } }],
                ['tab-2', { kind: 'acp-chat', state: { conversationId: 'conv-active' } }],
                ['tab-3', { kind: 'diff', state: {} }],
              ]),
            },
          },
        ],
      });

      expect(ids).toEqual(['conv-active', 'conv-other']);
    });
  });

  describe('executeConversationViewSwitch', () => {
    it.each([
      ['acp', 'pty'],
      ['pty', 'acp'],
    ] as const)('switches conversation type %s -> %s and updates store.data', async (from, to) => {
      const store = makeConversation({ id: 'c1', type: from });
      const switchView = vi.fn(async () => ok({ ...store.data, type: to }));
      const onSwitched = vi.fn();
      wire = seedSliceWire(
        conversationsDomain,
        defineContract({ switchView: conversationsContract.switchView }),
        { switchView }
      );

      const changed = await executeConversationViewSwitch(store, to, { onSwitched });

      expect(changed).toBe(true);
      expect(switchView).toHaveBeenCalledWith({ conversationId: 'c1', type: to }, expect.anything());
      expect(store.data.type).toBe(to);
      expect(onSwitched).toHaveBeenCalledWith(expect.objectContaining({ type: to }));
    });

    it('offers stop-and-return toast action on canStopTerminal and retries with stopUnobservedTerminal: true', async () => {
      const store = makeConversation({ id: 'c1', type: 'pty' });
      const switchView = vi.fn(async (input: { stopUnobservedTerminal?: boolean }) =>
        input.stopUnobservedTerminal
          ? ok({ ...store.data, type: 'acp' as const })
          : err({
              type: 'view-switch-failed' as const,
              message: 'Terminal çalışıyor.',
              canStopTerminal: true,
            })
      );
      wire = seedSliceWire(
        conversationsDomain,
        defineContract({ switchView: conversationsContract.switchView }),
        { switchView }
      );
      const warningSpy = vi.spyOn(toast, 'warning').mockImplementation(() => '');

      const firstAttempt = await executeConversationViewSwitch(store, 'acp');
      expect(firstAttempt).toBe(false);
      expect(warningSpy).toHaveBeenCalledWith(
        'Çalışan bir iş var',
        expect.objectContaining({
          action: expect.objectContaining({ label: 'Durdur ve sohbete geç' }),
        })
      );

      const action = (
        warningSpy.mock.calls[0]?.[1] as { action?: { onClick?: () => void } } | undefined
      )?.action;
      action?.onClick?.();

      await vi.waitFor(() => expect(store.data.type).toBe('acp'));
      expect(switchView).toHaveBeenNthCalledWith(
        2,
        {
          conversationId: 'c1',
          type: 'acp',
          stopUnobservedTerminal: true,
        },
        expect.anything()
      );
    });

    it('shows error toast and returns false on switch failure', async () => {
      const store = makeConversation({ id: 'c1', type: 'acp' });
      const switchView = vi.fn(async () =>
        err({
          type: 'view-switch-failed' as const,
          message: 'Ajan meşgul.',
        })
      );
      wire = seedSliceWire(
        conversationsDomain,
        defineContract({ switchView: conversationsContract.switchView }),
        { switchView }
      );
      const errorSpy = vi.spyOn(toast, 'error').mockImplementation(() => '');

      const result = await executeConversationViewSwitch(store, 'pty');

      expect(result).toBe(false);
      expect(store.data.type).toBe('acp');
      expect(errorSpy).toHaveBeenCalledWith('Görünüm değiştirilemedi', {
        description: 'Ajan meşgul.',
      });
    });
  });
});
