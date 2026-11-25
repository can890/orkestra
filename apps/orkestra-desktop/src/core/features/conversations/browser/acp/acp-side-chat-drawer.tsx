import { Button, Input } from '@orkestra/ui/react/primitives';
import { ArrowUpRight, LoaderCircle, MessageSquarePlus, Send, Trash2, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { AcpSideChatState } from '@core/features/conversations/contributions/mementos';
import { getTextGenerationClient } from '@core/features/text-generation/api/browser/client';
import type { AcpChatStore } from './acp-chat-store';

type SideChatMessage = AcpSideChatState['messages'][number];

function summarizeRecentMainContext(store: AcpChatStore): string {
  const turns = store.visibleTurns().slice(-4);
  const lines: string[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (typeof item.text === 'string' && item.text.trim()) {
        const who = item.role === 'user' || item.kind === 'user-message' ? 'Kullanıcı' : 'Asistan';
        lines.push(`${who}: ${item.text.trim().slice(0, 600)}`);
      }
    }
  }
  return lines.join('\n').slice(0, 3000);
}

interface AcpSideChatDrawerProps {
  store: AcpChatStore;
  onClose: () => void;
  onTransferToMain: (text: string) => void;
}

export const AcpSideChatDrawer = observer(function AcpSideChatDrawer({
  store,
  onClose,
  onTransferToMain,
}: AcpSideChatDrawerProps) {
  const { sideChat } = store;
  const { messages } = sideChat.value;
  const [draft, setDraft] = useState('');
  const sending = store.sideChatSending;
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void sideChat.ready.then(() => {
      if (active) setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [sideChat]);

  const handleSend = async () => {
    const question = draft.trim();
    if (!question || store.sideChatSending || !loaded) return;
    const questionId = crypto.randomUUID();
    const history = messages
      .filter((message) => message.role !== 'error')
      .slice(-12)
      .map(
        (message) =>
          `${message.role === 'user' ? 'Kullanıcı' : 'Asistan'}: ${message.text.slice(0, 1200)}`
      )
      .join('\n')
      .slice(-6000);
    const contextDigest = summarizeRecentMainContext(store);
    const appendReply = (role: SideChatMessage['role'], text: string) => {
      if (store.disposed) return;
      sideChat.update((current) =>
        current.messages.some((message) => message.id === questionId)
          ? { ...current, messages: [...current.messages, { id: crypto.randomUUID(), role, text }] }
          : current
      );
    };

    setDraft('');
    store.setSideChatSending(true);
    sideChat.update((current) => ({
      ...current,
      messages: [...current.messages, { id: questionId, role: 'user', text: question }],
    }));
    try {
      const client = await getTextGenerationClient();
      const status = await client.getStatus();
      if (!status.enabled || !status.hasApiKey) {
        appendReply(
          'error',
          'Yan Sohbet için Ayarlar → General → Text Generator API bölümünden bir yardımcı model etkinleştirip API anahtarı kaydedin.'
        );
        return;
      }
      const res = await client.generateText({
        systemPrompt:
          'Sen ana görevin bağlamını kirletmeden hızlı yan sorulara yanıt veren kısa ve net bir teknik asistansın. Türkçe yanıtla.',
        prompt: [
          contextDigest ? `Ana sohbet özeti:\n${contextDigest}\n` : '',
          history ? `Önceki yan sohbet:\n${history}\n` : '',
          `Kullanıcı yan sorusu:\n${question}`,
        ]
          .filter(Boolean)
          .join('\n'),
        maxTokens: 900,
        temperature: 0.3,
      });
      if (!res.success) appendReply('error', res.error.message);
      else appendReply('assistant', res.data.text);
    } catch (error) {
      appendReply('error', error instanceof Error ? error.message : String(error));
    } finally {
      store.setSideChatSending(false);
    }
  };

  return (
    <aside
      className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-(--em-surface)"
      aria-label="Yan Sohbet"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5">
          <MessageSquarePlus className="h-3.5 w-3.5 text-blue-400" />
          <span className="text-xs font-semibold text-foreground">Yan Sohbet</span>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              icon
              aria-label="Yan sohbeti temizle"
              onClick={() => sideChat.update({ version: '1', messages: [] })}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            icon
            aria-label="Yan sohbeti kapat"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3 text-xs">
        {messages.length === 0 ? (
          <div className="text-muted-foreground rounded-md border border-dashed border-border p-3 text-[11px] leading-relaxed">
            Yan sohbetin geçmişi saklanır. Yanıtları ana sohbet taslağına aktarabilirsiniz.
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`rounded-md border px-2.5 py-2 ${
                msg.role === 'user'
                  ? 'ml-4 border-blue-500/30 bg-blue-500/10 text-foreground'
                  : msg.role === 'error'
                    ? 'border-destructive/40 bg-destructive/10 text-destructive'
                    : 'mr-2 border-border bg-background text-foreground'
              }`}
            >
              <div className="leading-relaxed whitespace-pre-wrap">{msg.text}</div>
              {msg.role === 'assistant' && (
                <div className="mt-1.5 flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => onTransferToMain(msg.text)}
                  >
                    <ArrowUpRight className="h-3 w-3" />
                    Ana Sohbete Aktar
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <form
        className="flex items-center gap-1.5 border-t border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
      >
        <Input
          value={draft}
          maxLength={12_000}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Yan sohbete bir soru yaz..."
          className="h-8 flex-1 text-xs"
          disabled={sending || !loaded}
        />
        <Button
          type="submit"
          aria-label="Yan soruyu gönder"
          variant="primary"
          size="xs"
          disabled={sending || !loaded || !draft.trim()}
        >
          {sending ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </Button>
      </form>
    </aside>
  );
});
