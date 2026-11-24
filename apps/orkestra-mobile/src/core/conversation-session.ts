import {
  getCachedChatSync,
  loadCachedChat,
  saveCachedChat,
} from './local-cache';
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

export type PromptPlacement = 'auto' | 'queue';

export type PendingPrompt = {
  promptId: string;
  text: string;
  placement: PromptPlacement;
  state: 'sending' | 'queued' | 'failed';
  error: string | null;
};

export type ConversationViewState = {
  phase: 'loading' | 'ready' | 'error';
  syncing: boolean;
  fromCache: boolean;
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
  send(text: string, placement?: PromptPlacement): Promise<boolean>;
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
 * Tek bir sohbetin WhatsApp tarzı anında-açılan canlı görünümü:
 * 1) Önbellekteki mesajları 0 ms'de gösterir (senkron bellek + IndexedDB).
 * 2) `attach`, `session.state` ve `loadHistory` çağrılarını PARALEL başlatır.
 * 3) Canlı veri gelince sorunsuz eşitler ve yerel önbelleği günceller.
 */
export function openConversation(
  api: RemoteApi,
  conversationId: string,
  options?: { hostId?: string }
): ConversationHandle {
  const hostId = options?.hostId;
  const store = new TranscriptStore();
  const listeners = new Set<() => void>();
  let disposed = false;
  let live: LiveSubscription<unknown> | null = null;
  let session: SessionView | null = null;
  let pending: PendingPrompt[] = [];

  const syncCache = hostId ? getCachedChatSync(hostId, conversationId) : null;
  let cachedEntries: TranscriptEntry[] | null = syncCache ? syncCache.entries : null;
  let cachedHasOlder = syncCache?.hasOlder ?? false;
  let phase: ConversationViewState['phase'] = syncCache ? 'ready' : 'loading';
  let syncing = true;
  let error: string | null = null;
  let actionError: string | null = null;
  let loadingOlder = false;
  let state: ConversationViewState = compute();

  let lastRevision: number | null = null;
  let lastGeneration: string | null = null;
  let lastLifecycle: string | null = null;
  let refreshRunning = false;
  let refreshAgain = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let historyLimit = HISTORY_PAGE_SIZE;

  function compute(): ConversationViewState {
    const liveLoaded = store.loaded || session !== null;
    const liveEntries = store.entries();
    const entries =
      store.loaded || liveEntries.length > 0 ? liveEntries : (cachedEntries ?? liveEntries);
    const seen = new Set(
      entries.flatMap((entry) =>
        entry.kind === 'message' && entry.promptId ? [entry.promptId] : []
      )
    );
    return {
      phase,
      syncing,
      fromCache: !store.loaded && cachedEntries !== null,
      error,
      session,
      entries,
      // Masaüstü mesajı dökümde gösterince bekleyen balon kalkar.
      pending: pending.filter((item) => !seen.has(item.promptId)),
      hasOlder: liveLoaded ? store.hasOlder : cachedHasOlder,
      loadingOlder,
      actionError,
    };
  }

  function persistSnapshot(): void {
    if (!hostId || !store.loaded) return;
    saveCachedChat(hostId, conversationId, {
      entries: store.entries(),
      hasOlder: store.hasOlder,
    });
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
    const attemptFetch = async (limit: number) => {
      const input: { conversationId: string; limit: number; before?: number } = {
        conversationId,
        limit,
      };
      if (before !== undefined) input.before = before;
      return mapHistoryPage(unwrapResult(await api.call('conversations.acp.loadHistory', input)));
    };
    let page;
    try {
      page = await attemptFetch(historyLimit);
    } catch (cause) {
      // Eski sunucu 4 MiB sınırına çarparsa sayfa boyutunu küçültüp yeniden dene.
      const code =
        typeof cause === 'object' && cause !== null && 'code' in cause
          ? String((cause as { code?: unknown }).code)
          : '';
      if (code === 'SERIALIZATION' && historyLimit > 8) {
        historyLimit = Math.max(8, Math.floor(historyLimit / 3));
        page = await attemptFetch(historyLimit);
      } else {
        throw cause;
      }
    }
    if (disposed) return;
    store.applyPage(page, updateCursor);
    cachedEntries = null;
    persistSnapshot();
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
      // Geçici hata: önbellek varsa kullanıcıyı kesme, sonraki canlı güncellemede dene.
      if (!disposed && !store.loaded && cachedEntries === null) {
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
    persistSnapshot();
    emit();
    if (revisionChanged || generationChanged || replayDone || reseeded) void refreshLatest();
  }

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleStartRetry(): void {
    if (disposed || retryTimer !== null) return;
    const delays = [1_500, 3_000, 6_000, 10_000];
    const delay = delays[Math.min(retryAttempt, delays.length - 1)] ?? 10_000;
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed) return;
      void connectLive();
    }, delay);
  }

  async function connectLive(): Promise<void> {
    if (disposed) return;
    syncing = true;
    emit();
    try {
      // attach'i başlat, hemen ardından canlı konuyu ve geçmişi paralel çek.
      unwrapResult(await api.call('conversations.acp.attach', { conversationId }));
      if (disposed) return;
      live?.dispose();
      live = api.live(topicOf(REMOTE_TOPICS.sessionState, { conversationId }), onSessionState);
      await Promise.all([live.ready, loadPage(undefined, true)]);
      if (disposed) return;
      retryAttempt = 0;
      clearRetryTimer();
      phase = 'ready';
      syncing = false;
      error = null;
      actionError = null;
      emit();
      // En iyi çaba: okundu işareti.
      void api.call('conversations.markConversationSeen', { conversationId }).catch(() => {});
    } catch (cause) {
      if (disposed) return;
      syncing = false;
      const code =
        typeof cause === 'object' && cause !== null && 'code' in cause
          ? String((cause as { code?: unknown }).code)
          : '';
      if (cachedEntries === null && !store.loaded) {
        phase = 'error';
        error = describeCallError(cause);
      } else {
        actionError = describeCallError(cause);
      }
      emit();
      // Kalıcı yetki/kayıt hatası değilse canlı aboneliği otomatik yeniden kurmayı dene.
      if (code !== 'UNKNOWN_PROCEDURE' && code !== 'UNKNOWN_TOPIC' && code !== 'NOT_FOUND') {
        scheduleStartRetry();
      }
    }
  }

  async function start(): Promise<void> {
    // IndexedDB'de kayıtlı sohbet varsa canlı yanıtı beklemeden anında ekrana bas.
    if (hostId && cachedEntries === null) {
      void loadCachedChat(hostId, conversationId).then((disk) => {
        if (disposed || store.loaded || !disk) return;
        cachedEntries = disk.entries;
        cachedHasOlder = disk.hasOlder;
        if (phase === 'loading') {
          phase = 'ready';
          error = null;
        }
        emit();
      });
    }
    await connectLive();
  }
  void start();

  async function doSend(
    text: string,
    promptId: string,
    placement: PromptPlacement
  ): Promise<boolean> {
    try {
      const data = unwrapResult(
        await api.call('conversations.acp.sendPrompt', {
          conversationId,
          promptId,
          prompt: { text },
          placement,
        })
      );
      const queued =
        placement === 'queue' ||
        (typeof data === 'object' &&
          data !== null &&
          (data as { queued?: unknown }).queued === true);
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
    async send(text, placement = 'auto') {
      const trimmed = text.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_PROMPT_CHARS) return false;
      const promptId = newPromptId();
      pending = [
        ...pending,
        {
          promptId,
          text: trimmed,
          placement,
          state: placement === 'queue' ? 'queued' : 'sending',
          error: null,
        },
      ];
      emit();
      return doSend(trimmed, promptId, placement);
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
      return doSend(item.text, promptId, item.placement);
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
      clearRetryTimer();
      live?.dispose();
      listeners.clear();
    },
  };
}
