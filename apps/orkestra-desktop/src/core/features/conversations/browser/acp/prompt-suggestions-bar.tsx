import { Sparkles, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getTextGenerationClient } from '@core/features/text-generation/api/browser/client';
import type { AcpChatStore } from './acp-chat-store';

interface PromptSuggestionsBarProps {
  store: AcpChatStore;
  projectName?: string;
  taskName?: string;
  onPickSuggestion: (text: string) => void;
}

function extractLastAssistantText(store: AcpChatStore): { turnId: string; text: string } | null {
  const turns = store.visibleTurns();
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn) continue;
    const chunks: string[] = [];
    for (const item of turn.items) {
      if (
        (item.role === 'assistant' || item.kind === 'assistant-message' || item.kind === 'text') &&
        typeof item.text === 'string' &&
        item.text.trim().length > 0
      ) {
        chunks.push(item.text.trim());
      }
    }
    if (chunks.length > 0) {
      return { turnId: turn.id, text: chunks.join('\n').slice(0, 4000) };
    }
  }
  return null;
}

export const PromptSuggestionsBar = observer(function PromptSuggestionsBar({
  store,
  projectName,
  taskName,
  onPickSuggestion,
}: PromptSuggestionsBarProps) {
  const { value: settings } = useAppSettingsKey('textGeneration');
  const enabled = settings?.promptSuggestionsEnabled ?? true;
  const isWorking = store.affordances.isWorking;
  const lastAssistant = extractLastAssistantText(store);
  const signature = useMemo(
    () => (lastAssistant ? `${store.conversationId}:${lastAssistant.turnId}` : null),
    [store.conversationId, lastAssistant]
  );

  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [dismissedForSignature, setDismissedForSignature] = useState<string | null>(null);
  const fetchedSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || isWorking || store.isEmpty || !signature || !lastAssistant) {
      return;
    }
    if (fetchedSignatureRef.current === signature) {
      return;
    }
    fetchedSignatureRef.current = signature;
    let cancelled = false;

    void getTextGenerationClient()
      .then((client) =>
        client.generatePromptSuggestions({
          lastAssistantText: lastAssistant.text,
          projectName,
          taskName,
        })
      )
      .then((res) => {
        if (!cancelled) {
          setSuggestions(res.suggestions);
        }
      })
      .catch(() => {
        // Öneri üretilemezse sessizce gizle
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, isWorking, store.isEmpty, signature, lastAssistant, projectName, taskName]);

  if (
    !enabled ||
    isWorking ||
    store.isEmpty ||
    !signature ||
    dismissedForSignature === signature ||
    suggestions.length === 0
  ) {
    return null;
  }

  return (
    <div className="mx-3 mb-1.5 flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
        <Sparkles className="h-3 w-3 text-amber-400" />
        Önerilen sonraki adımlar:
      </span>
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          onClick={() => {
            setDismissedForSignature(signature);
            onPickSuggestion(suggestion);
          }}
          className="max-w-[260px] truncate rounded-full border border-border bg-(--em-surface-elevated,var(--card)) px-2.5 py-0.5 text-[11px] text-foreground transition hover:border-foreground/30 hover:bg-muted"
          title={suggestion}
        >
          {suggestion}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setDismissedForSignature(signature)}
        className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Önerileri kapat"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
});
