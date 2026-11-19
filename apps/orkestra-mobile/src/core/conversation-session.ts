import { mapHistoryPage, mapSessionState, type SessionView, type TranscriptEntry } from './mappers';
import { TranscriptStore } from './transcript-store';
import {
  describeCallError,
  REMOTE_TOPICS,
  topicOf,
  unwrapResult,
  type LiveSubscription,
  type RemoteApi,
} from './wire-client';

export const HISTORY_PAGE_SIZE = 50;
export const MAX_PROMPT_CHARS = 100_000;

export type PendingPrompt = {
  promptId: string;
  text: string;
  state: 'sending' | 'queued' | 'failed';
  error: string | null;
};

export type ConversationViewState = {
  phase: 'loading' | 'ready' | 'error';
  error: string | null;
  session: SessionView | null;
  entries: TranscriptEntry[];
  pending: PendingPrompt[];
  hasOlder: boolean;
  loadingOlder: boolean;
  /** Son eylem (gönder/iptal/izin) hatası; kullanıcı kapatabilir. */
  actionError: string | null;
};

export type ConversationHandle = {
  getState(): ConversationViewState;
  subscribe(listener: () => void): () => void;
  send(text: string): Promise<boolean>;
  retry(promptId: string): Promise<boolean>;
  dismissPending(promptId: string): void;
  cancel(): Promise<void>;
  resolvePermission(requestId: string, optionId: string): Promise<void>;
  loadOlder(): Promise<void>;
  dismissActionError(): void;
  dispose(): void;
};

function newPromptId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Tek bir sohbetin canlı görünümü: oturumu bağlar, geçmişi yükler, `session.state` canlı
 * konusunu izler (etkin tur, bekleyen izinler, kuyruk) ve prompt/iptal/izin eylemlerini yapar.
 * Yalnızca izin listesindeki yordamlar ve konular kullanılır.
 */
export function openConversation(api: RemoteApi, conversationId: string): ConversationHandle {
  const store = new TranscriptStore();
  const listeners = new Set<() => void>();
  let disposed = false;
  let live: LiveSubscription<unknown> | null = null;
  let session: SessionView | null = null;
  let pending: PendingPrompt[] = [];
  let phase: ConversationViewState['phase'] = 'loading';
  let error: string | null = null;
  let actionError: string | null = null;
  let loadingOlder = false;
  let state: ConversationViewState = compute();

  let lastRevision: number | null = null;
  let lastGeneration: string | null = null;
  let lastLifecycle: string | null = null;
  let refreshRunning = false;
  let refreshAgain = false;

  function compute(): ConversationViewState {
    const entries = store.entries();
    const seen = new Set(
      entries.flatMap((entry) =>
        entry.kind === 'message' && entry.promptId ? [entry.promptId] : []
      )
    );
    return {
      phase,
      error,
      session,
      entries,
      // Masaüstü mesajı dökümde gösterince bekleyen balon kalkar.
      pending: pending.filter((item) => !seen.has(item.promptId)),
      hasOlder: store.hasOlder,
      loadingOlder,
      actionError,
    };
  }

  function emit(): void {
    if (disposed) return;
    state = compute();
    pending = pending.filter((item) =>
      state.pending.some((kept) => kept.promptId === item.promptId)
    );
    for (const listener of listeners) listener();
  }

  async function loadPage(before: number | undefined, updateCursor: boolean): Promise<void> {
    const input: { conversationId: string; limit: number; before?: number } = {
      conversationId,
      limit: HISTORY_PAGE_SIZE,
    };
    if (before !== undefined) input.before = before;
    const page = mapHistoryPage(
      unwrapResult(await api.call('conversations.acp.loadHistory', input))
    );
    if (disposed) return;
    store.applyPage(page, updateCursor);
  }

  async function refreshLatest(): Promise<void> {
    if (refreshRunning) {
      refreshAgain = true;
      return;
    }
    refreshRunning = true;
    try {
      do {
        refreshAgain = false;
        await loadPage(undefined, !store.loaded);
        emit();
      } while (refreshAgain && !disposed);
    } catch (cause) {
      // Geçici hata: sonraki canlı güncellemede yeniden denenir.
      if (!disposed && !store.loaded) {
        phase = 'error';
        error = describeCallError(cause);
        emit();
      }
    } finally {
      refreshRunning = false;
    }
  }

  function onSessionState(value: unknown, meta: { seed: boolean }): void {
    if (disposed) return;
    const next = mapSessionState(value);
    session = next;
    store.setActiveTurn(next.activeTurn);
    const revisionChanged = lastRevision !== null && lastRevision !== next.historyRevision;
    const generationChanged = lastGeneration !== null && lastGeneration !== next.generation;
    const replayDone = lastLifecycle === 'replaying' && next.lifecycle === 'ready';
    const reseeded = meta.seed && lastRevision !== null; // yeniden bağlanma sonrası tazeleme
    lastRevision = next.historyRevision;
    lastGeneration = next.generation;
    lastLifecycle = next.lifecycle;
    emit();
    if (revisionChanged || generationChanged || replayDone || reseeded) void refreshLatest();
  }

  async function start(): Promise<void> {
    try {
      unwrapResult(await api.call('conversations.acp.attach', { conversationId }));
      if (disposed) return;
      live = api.live(topicOf(REMOTE_TOPICS.sessionState, { conversationId }), onSessionState);
      await live.ready;
      if (disposed) return;
      await loadPage(undefined, true);
      if (disposed) return;
      phase = 'ready';
      error = null;
      emit();
      // En iyi çaba: okundu işareti.
      void api.call('conversations.markConversationSeen', { conversationId }).catch(() => {});
    } catch (cause) {
      if (disposed) return;
      phase = 'error';
      error = describeCallError(cause);
      emit();
    }
  }
  void start();

  async function doSend(text: string, promptId: string): Promise<boolean> {
    try {
      const data = unwrapResult(
        await api.call('conversations.acp.sendPrompt', {
          conversationId,
          promptId,
          prompt: { text },
          placement: 'auto',
        })
      );
      const queued =
        typeof data === 'object' && data !== null && (data as { queued?: unknown }).queued === true;
      pending = pending.map((item) =>
        item.promptId === promptId
          ? { ...item, state: queued ? 'queued' : 'sending', error: null }
          : item
      );
      emit();
      return true;
    } catch (cause) {
      pending = pending.map((item) =>
        item.promptId === promptId
          ? { ...item, state: 'failed', error: describeCallError(cause) }
          : item
      );
      emit();
      return false;
    }
  }

  async function action(run: () => Promise<unknown>): Promise<void> {
    try {
      unwrapResult(await run());
      actionError = null;
    } catch (cause) {
      actionError = describeCallError(cause);
    }
    emit();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(text) {
      const trimmed = text.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_PROMPT_CHARS) return false;
      const promptId = newPromptId();
      pending = [...pending, { promptId, text: trimmed, state: 'sending', error: null }];
      emit();
      return doSend(trimmed, promptId);
    },
    async retry(promptId) {
      const item = pending.find((candidate) => candidate.promptId === promptId);
      if (!item) return false;
      pending = pending.map((candidate) =>
        candidate.promptId === promptId
          ? { ...candidate, state: 'sending', error: null }
          : candidate
      );
      emit();
      return doSend(item.text, promptId);
    },
    dismissPending(promptId) {
      pending = pending.filter((item) => item.promptId !== promptId);
      emit();
    },
    cancel: () => action(() => api.call('conversations.acp.cancelTurn', { conversationId })),
    resolvePermission: (requestId, optionId) =>
      action(() =>
        api.call('conversations.acp.resolvePermission', { conversationId, requestId, optionId })
      ),
    async loadOlder() {
      const cursor = store.olderCursor;
      if (typeof cursor !== 'number' || loadingOlder) return;
      loadingOlder = true;
      emit();
      try {
        await loadPage(cursor, true);
      } catch (cause) {
        actionError = describeCallError(cause);
      }
      loadingOlder = false;
      emit();
    },
    dismissActionError() {
      actionError = null;
      emit();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      live?.dispose();
      listeners.clear();
    },
  };
}
