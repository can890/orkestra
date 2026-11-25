import { observable, runInAction } from 'mobx';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import {
  acpSideChatMemento,
  type AcpSideChatState,
} from '@core/features/conversations/contributions/mementos';
import type { AcpChatStore } from './acp-chat-store';
import { AcpSideChatDrawer } from './acp-side-chat-drawer';

const tools = vi.hoisted(() => ({
  send: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('@core/features/conversations/api/browser/client', () => ({
  getConversationsClient: async () => ({ sideChat: tools }),
}));

it('reads shared side history and sends, transfers or deletes replies', async () => {
  let snapshot = acpSideChatMemento.schema.serialize(acpSideChatMemento.default);
  function createStore() {
    const value = observable.box(
      acpSideChatMemento.schema.parseJson(snapshot) ?? acpSideChatMemento.default
    );
    const update = (next: AcpSideChatState) => {
      snapshot = acpSideChatMemento.schema.serialize(next);
      runInAction(() => value.set(next));
    };
    tools.send.mockImplementation(async ({ text }: { text: string }) => {
      const next: AcpSideChatState = {
        version: '1',
        messages: [
          ...value.get().messages,
          { id: crypto.randomUUID(), role: 'user', text },
          { id: crypto.randomUUID(), role: 'assistant', text: 'Yan sohbet yanıtı' },
        ],
      };
      update(next);
      return next;
    });
    tools.clear.mockImplementation(async () => {
      update(acpSideChatMemento.default);
      return acpSideChatMemento.default;
    });
    return {
      conversationId: 'conversation-1',
      sideChatSending: false,
      setSideChatSending() {},
      sideChat: {
        ready: Promise.resolve(),
        get value() {
          return value.get();
        },
      },
    } as unknown as AcpChatStore;
  }

  const onTransferToMain = vi.fn();
  const onClose = vi.fn();
  const open = () =>
    render(
      <AcpSideChatDrawer
        store={createStore()}
        onClose={onClose}
        onTransferToMain={onTransferToMain}
      />
    );

  const first = await open();
  const question = first.getByPlaceholder('Yan sohbete bir soru yaz...');
  await question.fill('İlk soru');
  await first.getByRole('button', { name: 'Yan soruyu gönder' }).click();
  await expect.element(first.getByText('Yan sohbet yanıtı')).toBeVisible();
  await first.unmount();

  const restored = await open();
  await expect.element(restored.getByText('İlk soru')).toBeVisible();
  await restored.getByRole('button', { name: 'Ana Sohbete Aktar' }).click();
  expect(onTransferToMain).toHaveBeenCalledWith('Yan sohbet yanıtı');

  const followUp = restored.getByPlaceholder('Yan sohbete bir soru yaz...');
  await followUp.fill('Takip sorusu');
  await restored.getByRole('button', { name: 'Yan soruyu gönder' }).click();
  await vi.waitFor(() =>
    expect(tools.send).toHaveBeenLastCalledWith(
      {
        conversationId: 'conversation-1',
        text: 'Takip sorusu',
      },
      { timeoutMs: 90_000 }
    )
  );
  await restored.getByRole('button', { name: 'Yan sohbeti temizle' }).click();
  await expect.element(restored.getByText('İlk soru')).not.toBeInTheDocument();
  await restored.unmount();

  const cleared = await open();
  await expect.element(cleared.getByText('İlk soru')).not.toBeInTheDocument();
  await expect.element(cleared.getByText('Yan sohbet yanıtı')).not.toBeInTheDocument();
  await cleared.unmount();
});
