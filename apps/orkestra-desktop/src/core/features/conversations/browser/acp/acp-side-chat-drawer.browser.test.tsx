import { observable, runInAction } from 'mobx';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import {
  acpSideChatMemento,
  type AcpSideChatState,
} from '@core/features/conversations/contributions/mementos';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import type { AcpChatStore } from './acp-chat-store';
import { AcpSideChatDrawer } from './acp-side-chat-drawer';

const generateText = vi.hoisted(() =>
  vi.fn(async (_input: { prompt: string }) => ({
    success: true,
    data: { text: 'Yan sohbet yanıtı' },
  }))
);

vi.mock('@core/features/text-generation/api/browser/client', () => ({
  getTextGenerationClient: async () => ({
    getStatus: async () => ({ enabled: true, hasApiKey: true }),
    generateText,
  }),
}));

it('restores side history, uses it for a follow-up, and transfers or deletes replies', async () => {
  let snapshot = acpSideChatMemento.schema.serialize(acpSideChatMemento.default);
  function createStore() {
    const value = observable.box(
      acpSideChatMemento.schema.parseJson(snapshot) ?? acpSideChatMemento.default
    );
    return {
      disposed: false,
      visibleTurns: () => [],
      sideChatSending: false,
      setSideChatSending() {},
      sideChat: {
        ready: Promise.resolve(),
        get value() {
          return value.get();
        },
        update(next: Parameters<MementoHandle<AcpSideChatState>['update']>[0]) {
          const updated = typeof next === 'function' ? next(value.get()) : next;
          snapshot = acpSideChatMemento.schema.serialize(updated);
          runInAction(() => value.set(updated));
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
    expect(generateText).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: expect.stringMatching(/İlk soru[\s\S]*Yan sohbet yanıtı[\s\S]*Takip sorusu/),
      })
    )
  );
  await restored.getByRole('button', { name: 'Yan sohbeti temizle' }).click();
  await restored.unmount();

  const cleared = await open();
  await expect.element(cleared.getByText('İlk soru')).not.toBeInTheDocument();
  await expect.element(cleared.getByText('Yan sohbet yanıtı')).not.toBeInTheDocument();
  await cleared.unmount();
});
