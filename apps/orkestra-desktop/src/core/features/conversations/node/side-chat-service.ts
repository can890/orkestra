import { randomUUID } from 'node:crypto';
import { KeyedMutex } from '@orkestra/shared/concurrency';
import { mementoRowSchema } from '@core/primitives/mementos/api';
import type { MementosWireClient } from '@core/primitives/mementos/api/client';
import { acpSideChatMemento, type AcpSideChatState } from '../contributions/mementos';
import { conversationSubject } from '../contributions/subject';

export type SideChatPort = {
  getMementos(): Promise<MementosWireClient>;
  generate(prompt: string): Promise<string>;
};

export function sideChatPage(state: AcpSideChatState, before?: string) {
  const end =
    before === undefined
      ? state.messages.length
      : state.messages.findIndex((message) => message.id === before);
  if (end < 0) return { version: state.version, messages: [] };
  const start = Math.max(0, end - 40);
  const messages = state.messages.slice(start, end);
  return { version: state.version, messages, ...(start > 0 ? { earlier: messages[0]?.id } : {}) };
}

export class SideChatService {
  private readonly writes = new KeyedMutex();
  private readonly sending = new Set<string>();

  constructor(private readonly port: SideChatPort) {}

  private key(conversationId: string) {
    return { ...conversationSubject({ conversationId }), mementoId: acpSideChatMemento.id };
  }

  async get(conversationId: string): Promise<AcpSideChatState> {
    const mementos = await this.port.getMementos();
    const snapshot = await mementos.memento
      .state(this.key(conversationId), 'value')
      .asLiveSource()
      .snapshot();
    const row = mementoRowSchema.safeParse(snapshot.data);
    const raw = row.success ? row.data.data : undefined;
    return (raw ? acpSideChatMemento.schema.parseJson(raw) : null) ?? acpSideChatMemento.default;
  }

  async clear(conversationId: string): Promise<AcpSideChatState> {
    return this.writes.runExclusive(conversationId, async () => {
      const mementos = await this.port.getMementos();
      const result = await mementos.memento.mutate('reset', {
        key: this.key(conversationId),
        input: undefined,
      });
      if (!result.success) throw new Error('Yan sohbet silinemedi.');
      return acpSideChatMemento.default;
    });
  }

  private async save(conversationId: string, state: AcpSideChatState) {
    const mementos = await this.port.getMementos();
    const result = await mementos.memento.mutate('save', {
      key: this.key(conversationId),
      input: {
        version: acpSideChatMemento.schema.currentVersion,
        data: acpSideChatMemento.schema.serialize(state),
        updatedAt: Date.now(),
      },
    });
    if (!result.success) throw new Error('Yan sohbet geçmişi yazılamadı.');
  }

  async send(
    conversationId: string,
    text: string,
    readMainContext: () => Promise<string>
  ): Promise<AcpSideChatState> {
    if (this.sending.has(conversationId)) throw new Error('Yan sohbet bir yanıt hazırlıyor.');
    this.sending.add(conversationId);
    try {
      const id = randomUUID();
      const previous = await this.writes.runExclusive(conversationId, async () => {
        const state = await this.get(conversationId);
        await this.save(conversationId, {
          ...state,
          messages: [...state.messages, { id, role: 'user', text }],
        });
        return state;
      });
      const history = previous.messages
        .filter(({ role }) => role !== 'error')
        .slice(-12)
        .map(
          ({ role, text }) => `${role === 'user' ? 'Kullanıcı' : 'Asistan'}: ${text.slice(0, 1200)}`
        )
        .join('\n')
        .slice(-6000);
      const context = await readMainContext().catch(() => '');
      const prompt = [
        context ? `Ana sohbet özeti:\n${context}\n` : '',
        history ? `Önceki yan sohbet:\n${history}\n` : '',
        `Kullanıcı yan sorusu:\n${text}`,
      ]
        .filter(Boolean)
        .join('\n');
      let reply: AcpSideChatState['messages'][number];
      try {
        reply = { id: randomUUID(), role: 'assistant', text: await this.port.generate(prompt) };
      } catch {
        reply = {
          id: randomUUID(),
          role: 'error',
          text: 'Yan sohbet yanıtı alınamadı. Masaüstündeki yardımcı model ayarını kontrol edin.',
        };
      }
      return await this.writes.runExclusive(conversationId, async () => {
        const latest = await this.get(conversationId);
        if (!latest.messages.some((message) => message.id === id)) return latest;
        const next = { ...latest, messages: [...latest.messages, reply] };
        await this.save(conversationId, next);
        return next;
      });
    } finally {
      this.sending.delete(conversationId);
    }
  }
}
