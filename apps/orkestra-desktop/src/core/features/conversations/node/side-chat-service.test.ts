import { createTestWire } from '@orkestra/wire/testing';
import { expect, it, vi } from 'vitest';
import { mementosWireContract } from '@core/primitives/mementos/api';
import { MementoClient } from '@core/primitives/mementos/browser';
import { MementoService } from '@core/services/mementos/node/memento-service';
import { MementoPersistenceService } from '@core/services/mementos/node/persistence';
import { createMementosWireController } from '@core/services/mementos/node/wire-controller';
import { acpSideChatMemento } from '../contributions/mementos';
import { conversationSubject } from '../contributions/subject';
import { SideChatService, sideChatPage } from './side-chat-service';

it('uses the existing desktop memento and does not restore a reply after clearing', async () => {
  const service = new MementoService({ persistence: MementoPersistenceService.open(':memory:') });
  const wire = createTestWire(mementosWireContract, createMementosWireController(service));
  const desktop = new MementoClient(wire.client, { registerBeforeUnload: false });
  const space = desktop.subject(conversationSubject({ conversationId: 'chat' }));
  const desktopHistory = space.handle(acpSideChatMemento);
  const generate = vi.fn(async (_prompt: string) => 'Yanıt');
  const side = new SideChatService({ getMementos: async () => wire.client, generate });
  try {
    await desktopHistory.ready;
    desktopHistory.update({
      version: '1',
      messages: [{ id: 'saved', role: 'user', text: 'Önceki soru' }],
    });
    await desktopHistory.flush();
    expect((await side.get('chat')).messages[0]?.text).toBe('Önceki soru');
    await side.send('chat', 'Takip sorusu', async () => 'Ana konuşma');
    expect(generate).toHaveBeenCalledWith(
      expect.stringMatching(/Ana konuşma[\s\S]*Önceki soru[\s\S]*Takip sorusu/)
    );
    await vi.waitFor(() => expect(desktopHistory.value.messages.at(-1)?.text).toBe('Yanıt'));

    let finish: (answer: string) => void = () => {};
    generate.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );
    const pending = side.send('chat', 'Silinecek', async () => '');
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    await side.clear('chat');
    finish('Silinmiş yanıt');
    expect((await pending).messages).toEqual([]);
    await vi.waitFor(() => expect(desktopHistory.value.messages).toEqual([]));
  } finally {
    await desktop.dispose();
    await service.dispose();
    await wire.dispose();
  }
});

it('pages older messages without changing the saved history', () => {
  const messages = Array.from({ length: 51 }, (_, index) => ({
    id: String(index),
    role: 'user' as const,
    text: String(index),
  }));
  const state = { version: '1' as const, messages };
  const latest = sideChatPage(state);
  expect(latest.earlier).toBe('11');
  expect(latest.messages.map(({ id }) => id)).toEqual(messages.slice(11).map(({ id }) => id));
  expect(sideChatPage(state, latest.earlier).messages).toEqual(messages.slice(0, 11));
});
