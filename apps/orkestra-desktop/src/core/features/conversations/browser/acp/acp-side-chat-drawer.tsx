import { Button, Input } from '@orkestra/ui/react/primitives';
import { ArrowUpRight, LoaderCircle, MessageSquarePlus, Send, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getTextGenerationClient } from '@core/features/text-generation/api/browser/client';
import type { AcpChatStore } from './acp-chat-store';

type SideChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
};

const sideMessagesByConversation = new Map<string, SideChatMessage[]>();

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

export function AcpSideChatDrawer({ store, onClose, onTransferToMain }: AcpSideChatDrawerProps) {
  const [messages, setMessages] = useState<SideChatMessage[]>(
    () => sideMessagesByConversation.get(store.conversationId) ?? []
  );
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setMessages(sideMessagesByConversation.get(store.conversationId) ?? []);
  }, [store.conversationId]);

  const updateMessages = (updater: (prev: SideChatMessage[]) => SideChatMessage[]) => {
    setMessages((prev) => {
      const next = updater(prev);
      sideMessagesByConversation.set(store.conversationId, next);
      return next;
    });
  };

  const handleSend = async () => {
    const question = draft.trim();
    if (!question || sending) return;
    setDraft('');
    updateMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', text: question }]);
    setSending(true);
    try {
      const client = await getTextGenerationClient();
      const status = await client.getStatus();
      if (!status.enabled || !status.hasApiKey) {
        updateMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'error',
            text: 'Yan Sohbet için Ayarlar → General → Text Generator API bölümünden bir yardımcı model etkinleştirip API anahtarı kaydedin.',
          },
        ]);
        return;
      }
      const contextDigest = summarizeRecentMainContext(store);
      const res = await client.generateText({
        systemPrompt:
          'Sen ana görevin bağlamını kirletmeden hızlı yan sorulara yanıt veren kısa ve net bir teknik asistansın. Türkçe yanıtla.',
        prompt: [
          contextDigest ? `Ana sohbet özeti:\n${contextDigest}\n` : '',
          `Kullanıcı yan sorusu:\n${question}`,
        ]
          .filter(Boolean)
          .join('\n'),
        maxTokens: 900,
        temperature: 0.3,
      });
      if (!res.success) {
        updateMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'error', text: res.error.message },
        ]);
        return;
      }
      updateMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', text: res.data.text },
      ]);
    } catch (error) {
      updateMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'error',
          text: error instanceof Error ? error.message : String(error),
        },
      ]);
    } finally {
      setSending(false);
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
              onClick={() => updateMessages(() => [])}
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
            Ana ajanın bağlam penceresini kirletmeden geçici sorular sorun. Beğendiğiniz yanıtları
            tek tıkla ana sohbete aktarabilirsiniz.
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
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Geçici bir soru sor..."
          className="h-8 flex-1 text-xs"
          disabled={sending}
        />
        <Button type="submit" variant="primary" size="xs" disabled={sending || !draft.trim()}>
          {sending ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </Button>
      </form>
    </aside>
  );
}
