import { Sparkles, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getTextGenerationClient } from '@core/features/text-generation/api/browser/client';
import type { AcpChatStore } from './acp-chat-store';
import {
  extractPromptSuggestionContext,
  type SuggestionTurn,
} from './prompt-suggestions-context';

interface PromptSuggestionsBarProps {
  store: AcpChatStore;
  projectName?: string;
  taskName?: string;
  onPickSuggestion: (text: string) => void;
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
  const turnsState = store.chatState.transcript.state;
  const turns: readonly SuggestionTurn[] = [
    ...turnsState.displayTurns,
    ...(turnsState.activeTurnSnapshot ? [turnsState.activeTurnSnapshot] : []),
  ];
  const ctx = extractPromptSuggestionContext(turns);
  const signature = useMemo(() => {
    if (!ctx) return null;
    const editedCount = ctx.activity.editedFiles?.length ?? 0;
    const cmdCount = ctx.activity.executedCommands?.length ?? 0;
    return `${store.conversationId}:${ctx.turnId}:${ctx.outcome ?? 'done'}:${ctx.lastAssistantText.length}:${editedCount}:${cmdCount}`;
  }, [store.conversationId, ctx]);

  const [state, setState] = useState<{ signature: string | null; suggestions: string[] }>({
    signature: null,
    suggestions: [],
  });
  const [dismissedForSignature, setDismissedForSignature] = useState<string | null>(null);
  const fetchedSignatureRef = useRef<string | null>(null);
  const latestCtxRef = useRef(ctx);
  latestCtxRef.current = ctx;

  useEffect(() => {
    const activeCtx = latestCtxRef.current;
    if (!enabled || isWorking || store.isEmpty || !signature || !activeCtx) {
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
          lastUserText: activeCtx.lastUserText,
          lastAssistantText: activeCtx.lastAssistantText,
          projectName,
          taskName,
          activity: activeCtx.activity,
        })
      )
      .then((res) => {
        if (!cancelled) {
          setState({ signature, suggestions: res.suggestions });
        }
      })
      .catch(() => {
        // Öneri üretilemezse sessizce gizle
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, isWorking, store.isEmpty, signature, projectName, taskName]);

  const activeSuggestions = signature && state.signature === signature ? state.suggestions : [];

  if (
    !enabled ||
    isWorking ||
    store.isEmpty ||
    !signature ||
    dismissedForSignature === signature ||
    activeSuggestions.length === 0
  ) {
    return null;
  }

  return (
    <div className="mx-3 mb-1.5 flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
        <Sparkles className="h-3 w-3 text-amber-400" />
        Önerilen sonraki adımlar:
      </span>
      {activeSuggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          onClick={() => {
            setDismissedForSignature(signature);
            onPickSuggestion(suggestion);
          }}
          className="max-w-[360px] truncate rounded-full border border-border bg-(--em-surface-elevated,var(--card)) px-2.5 py-0.5 text-[11px] text-foreground transition hover:border-foreground/30 hover:bg-muted"
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
