import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getTextGenerationClient } from '@core/features/text-generation/api/browser/client';
import type { AcpChatStore } from './acp-chat-store';
import { extractPromptSuggestionContext, type SuggestionTurn } from './prompt-suggestions-context';

export interface UsePromptGhostSuggestionOptions {
  store: AcpChatStore;
  projectName?: string;
  taskName?: string;
}

/**
 * Claude Code / Codex tarzı: tur bittikten sonra metin kutusunun içinde silik olarak
 * gösterilecek ve Tab tuşuyla kabul edilecek tek satırlık bağlamsal sonraki mesaj önerisi üretir.
 */
export function usePromptGhostSuggestion({
  store,
  projectName,
  taskName,
}: UsePromptGhostSuggestionOptions): {
  ghostSuggestion: string | null;
  acceptGhostSuggestion: () => void;
} {
  const { value: settings } = useAppSettingsKey('textGeneration');
  const enabled = settings?.promptSuggestionsEnabled ?? true;
  const isWorking = store.affordances.isWorking;
  const hasBlockingCard =
    store.elicitationQueue.length > 0 || store.permissionQueue.length > 0;
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

  const [state, setState] = useState<{ signature: string | null; suggestion: string | null }>({
    signature: null,
    suggestion: null,
  });
  const [consumedSignature, setConsumedSignature] = useState<string | null>(null);
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
          const first = res.suggestions[0]?.trim() || null;
          setState({ signature, suggestion: first });
        }
      })
      .catch(() => {
        // Öneri üretilemezse sessizce boş bırak.
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, isWorking, store.isEmpty, signature, projectName, taskName]);

  const acceptGhostSuggestion = useCallback(() => {
    if (signature) {
      setConsumedSignature(signature);
    }
  }, [signature]);

  if (
    !enabled ||
    isWorking ||
    store.isEmpty ||
    hasBlockingCard ||
    !signature ||
    consumedSignature === signature ||
    state.signature !== signature
  ) {
    return { ghostSuggestion: null, acceptGhostSuggestion };
  }

  return { ghostSuggestion: state.suggestion, acceptGhostSuggestion };
}
