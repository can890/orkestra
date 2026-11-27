import { WireError } from '@orkestra/wire/rpc';
import type { ElicitationAction, ElicitationContent } from './elicitation-schema';
import { getCachedChatSync, loadCachedChat, saveCachedChat } from './local-cache';
import { mapHistoryPage, mapSessionState, type SessionView, type TranscriptEntry } from './mappers';
import {
  claimOutbox,
  readOutbox,
  updateOutbox,
  type ComposerDraft,
  type MobileImage,
} from './mobile-outbox';
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

/**
 * `steer`: çalışan tura canlı yönlendirme; `queue`: tur bitince kendiliğinden gönderilir. Masaüstü
 * çalışan turu bir mesaj yüzünden asla durdurmaz (alamayan ajanda `steer` de sıraya girer).
 */
export type PromptPlacement = 'auto' | 'queue' | 'steer';

/**
 * Ajan çalışırken gönderilen mesajın yerleşimi: araya mesaj alabilen ajana canlı yönlendirme,
 * diğerlerine sıra. Eski bir masaüstü yönlendiremeyen ajanın turunu `steer` ile durdururdu; `queue`
 * her sürümde turu sürdürür.
 */
export function workingPlacement(session: SessionView | null): PromptPlacement {
  const working = session?.lifecycle === 'working' || session?.isGenerating === true;
  if (!working) return 'auto';
  return session?.supportsSteering ? 'steer' : 'queue';
}

export type PendingPrompt = {
  promptId: string;
  text: string;
  placement: PromptPlacement;
  attachments?: MobileImage[];
  /**
   * `waiting`: masaüstüne bağlantı yok; mesaj telefonda bekler ve bağlantı gelince kendiliğinden
   * gönderilir. `queued`: masaüstü sırasında, tur bitince gönderilir.
   */
  state: 'waiting' | 'sending' | 'queued' | 'delivered' | 'failed';
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

export type PromptSuggestionInput = {
  lastUserText?: string;
  lastAssistantText: string;
  projectName?: string;
  taskName?: string;
  activity?: {
    outcome?: 'done' | 'cancelled' | 'error' | 'interrupted';
    editedFiles?: string[];
    readFilesCount?: number;
    executedCommands?: Array<{ command: string; failed?: boolean }>;
    createdPlan?: boolean;
    failedToolsCount?: number;
  };
};

export type ConversationHandle = {
  getState(): ConversationViewState;
  subscribe(listener: () => void): () => void;
  send(
    text: string,
    placement?: PromptPlacement,
    attachments?: MobileImage[],
    draft?: ComposerDraft
  ): Promise<boolean>;
  retry(promptId: string): Promise<boolean>;
  dismissPending(promptId: string): void;
  /** Sıradaki mesajı masaüstü sırasından kaldırır (bağlantı beklerken yalnızca telefondan). */
  removeQueued(promptId: string): Promise<boolean>;
  /** Kullanıcının açık isteği: sıradaki mesajı öne alır ve çalışan turu durdurur. */
  sendQueuedNow(promptId: string): Promise<void>;
  cancel(): Promise<void>;
  resolvePermission(requestId: string, optionId: string): Promise<void>;
  resolveElicitation(
    requestId: string,
    action: ElicitationAction,
    content?: ElicitationContent
  ): Promise<void>;
  generatePromptSuggestions(input: PromptSuggestionInput): Promise<string[]>;
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
  options?: { hostId?: string; deviceId?: string; background?: boolean }
): ConversationHandle {
  const hostId = options?.hostId;
  const store = new TranscriptStore();
  const listeners = new Set<() => void>();
  let disposed = false;
  let live: LiveSubscription<unknown> | null = null;
  let session: SessionView | null = null;
  const scope =
    hostId && options?.deviceId
      ? { hostId, deviceId: options.deviceId, conversationId }
      : undefined;
  let pending: PendingPrompt[] = scope ? readOutbox(scope).pending : [];
  let flushing = false;

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
  let reattachInFlight = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let historyLimit = HISTORY_PAGE_SIZE;
  /** Canlı bağlantı (attach + konu + geçmiş) kuruldu mu; değilse gönderim telefonda bekler. */
  let liveReady = false;

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
    reconcilePending();
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
    const revisionChanged = lastRevision !== null && lastRevision !== next.historyRevision;
    const generationChanged = lastGeneration !== null && lastGeneration !== next.generation;
    const replayDone = lastLifecycle === 'replaying' && next.lifecycle === 'ready';
    const reseeded = meta.seed && lastRevision !== null; // yeniden bağlanma sonrası tazeleme
    const willRefresh = revisionChanged || generationChanged || replayDone || reseeded;
    // Etkin tur yeni bittiğinde geçmiş tazelenene kadar eski etkin tur öğelerini koru (flicker önleme).
    store.setActiveTurn(next.activeTurn, {
      retainUntilPage: next.activeTurn === null && (willRefresh || refreshRunning),
    });
    lastRevision = next.historyRevision;
    lastGeneration = next.generation;
    lastLifecycle = next.lifecycle;
    persistSnapshot();
    reconcilePending();
    emit();
    // Reconnect sonrası oturum kapalıya düşmüşse `conversations.acp.attach` yenile.
    if (reseeded && next.lifecycle === 'closed' && !reattachInFlight) {
      reattachInFlight = true;
      void api
        .call('conversations.acp.attach', { conversationId })
        .then(unwrapResult)
        .then(() => {
          if (!disposed) void refreshLatest();
        })
        .catch(() => {
          if (!disposed) scheduleStartRetry();
        })
        .finally(() => {
          reattachInFlight = false;
        });
      return;
    }
    if (willRefresh) void refreshLatest();
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
      liveReady = true;
      emit();
      flushWaiting();
      // En iyi çaba: okundu işareti.
      if (!options?.background) {
        void api.call('conversations.markConversationSeen', { conversationId }).catch(() => {});
      }
    } catch (cause) {
      if (disposed) return;
      syncing = false;
      liveReady = false;
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

  function changePending(
    update: (items: PendingPrompt[]) => PendingPrompt[],
    draft?: ComposerDraft
  ): boolean {
    try {
      pending = scope
        ? updateOutbox(scope, (value) => ({
            draft:
              draft &&
              value.draft.text === draft.text &&
              JSON.stringify(value.draft.attachments) === JSON.stringify(draft.attachments)
                ? { text: '', attachments: [] }
                : value.draft,
            pending: update(value.pending),
          })).pending
        : update(pending);
      emit();
      return true;
    } catch {
      actionError = 'Yerel giden kutusuna yazılamadı. Cihazda yer açıp tekrar deneyin.';
      emit();
      return false;
    }
  }

  function updatePending(promptId: string, patch: Partial<PendingPrompt>): boolean {
    return changePending((items) =>
      items.map((item) => (item.promptId === promptId ? { ...item, ...patch } : item))
    );
  }

  function reconcilePending(): boolean {
    const seen = new Set(
      store
        .entries()
        .flatMap((entry) => (entry.kind === 'message' && entry.promptId ? [entry.promptId] : []))
    );
    const queued = new Set(session?.queuedIds);
    if (scope) pending = readOutbox(scope).pending;
    if (
      !pending.some(
        (item) => seen.has(item.promptId) || (queued.has(item.promptId) && item.state !== 'queued')
      )
    )
      return true;
    return changePending((items) =>
      items
        .filter((item) => !seen.has(item.promptId))
        .map((item) =>
          queued.has(item.promptId) ? { ...item, state: 'queued', error: null } : item
        )
    );
  }

  async function doSend(item: PendingPrompt, placement: PromptPlacement): Promise<void> {
    const input = {
      conversationId,
      promptId: item.promptId,
      prompt: {
        text: item.text,
        ...(scope ? { mobileDelivery: true } : {}),
        ...(item.attachments?.length ? { mobileImages: item.attachments } : {}),
      },
      placement,
    };
    try {
      let raw: unknown;
      try {
        raw = await api.call('conversations.acp.sendPrompt', input);
      } catch (cause) {
        if (
          !(cause instanceof WireError && cause.code === 'CONTRACT_MISMATCH') ||
          item.attachments?.length ||
          item.state === 'sending'
        )
          throw cause;
        // Eski masaüstünün doğrulayıcısı yeni alanı reddeder; ilk gönderim güvenle yapılabilir.
        raw = await api.call('conversations.acp.sendPrompt', {
          ...input,
          prompt: { text: item.text },
          placement: placement === 'steer' ? (scope ? 'queue' : 'auto') : placement,
        });
      }
      const data = unwrapResult(raw);
      const queued =
        typeof data === 'object' && data !== null && (data as { queued?: unknown }).queued === true;
      updatePending(item.promptId, {
        state: queued ? 'queued' : 'delivered',
        error: null,
        ...(queued ? {} : { attachments: undefined }),
      });
      if (!disposed) void refreshLatest();
    } catch (cause) {
      if (
        cause instanceof WireError &&
        ['DISCONNECTED', 'TIMEOUT', 'CANCELLED'].includes(cause.code)
      ) {
        liveReady = false;
        scheduleStartRetry();
        return;
      }
      updatePending(item.promptId, { state: 'failed', error: describeCallError(cause) });
    }
  }

  function flushWaiting(): void {
    if (disposed || flushing || !liveReady) return;
    const release = claimOutbox(scope);
    if (!release) {
      scheduleStartRetry();
      return;
    }
    flushing = true;
    void (async () => {
      try {
        if (!reconcilePending()) return;
        for (const { promptId } of pending) {
          if (disposed || !liveReady) return;
          const item = (scope ? readOutbox(scope).pending : pending).find(
            (entry) => entry.promptId === promptId
          );
          if (!item || (item.state !== 'waiting' && item.state !== 'sending')) continue;
          const placement =
            item.state === 'sending' || item.placement !== 'auto'
              ? item.placement
              : workingPlacement(session);
          if (!updatePending(item.promptId, { placement, state: 'sending' })) return;
          await doSend(item, placement);
        }
      } finally {
        flushing = false;
        release();
        if (
          !disposed &&
          liveReady &&
          pending.some((item) => item.state === 'waiting') &&
          !actionError
        ) {
          flushWaiting();
        }
      }
    })();
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
    async send(text, placement = 'auto', attachments, draft) {
      const trimmed = text.trim();
      if ((!trimmed && !attachments?.length) || trimmed.length > MAX_PROMPT_CHARS) return false;
      actionError = null;
      const accepted = changePending(
        (items) => [
          ...items,
          {
            promptId: newPromptId(),
            text: trimmed,
            placement,
            attachments,
            state: 'waiting',
            error: null,
          },
        ],
        draft
      );
      if (accepted) flushWaiting();
      return accepted;
    },
    async retry(promptId) {
      const item = pending.find((candidate) => candidate.promptId === promptId);
      if (item?.state !== 'failed') return false;
      const accepted = updatePending(promptId, { state: 'sending', error: null });
      if (accepted) flushWaiting();
      return accepted;
    },
    dismissPending(promptId) {
      changePending((items) => items.filter((item) => item.promptId !== promptId));
    },
    async removeQueued(promptId) {
      const item = pending.find((candidate) => candidate.promptId === promptId);
      if (item?.state === 'waiting') {
        return changePending((items) => items.filter((entry) => entry.promptId !== promptId));
      }
      if (item?.state !== 'queued') return false;
      try {
        unwrapResult(
          await api.call('conversations.acp.deleteQueuedPrompt', { conversationId, id: promptId })
        );
      } catch (cause) {
        actionError = describeCallError(cause);
        emit();
        return false;
      }
      return changePending((items) => items.filter((entry) => entry.promptId !== promptId));
    },
    async sendQueuedNow(promptId) {
      const others = (session?.queuedIds ?? []).filter((id) => id !== promptId);
      await action(async () => {
        unwrapResult(
          await api.call('conversations.acp.changeQueuePromptOrder', {
            conversationId,
            ids: [promptId, ...others],
          })
        );
        return api.call('conversations.acp.cancelTurn', { conversationId });
      });
    },
    cancel: () => action(() => api.call('conversations.acp.cancelTurn', { conversationId })),
    resolvePermission: (requestId, optionId) =>
      action(() =>
        api.call('conversations.acp.resolvePermission', { conversationId, requestId, optionId })
      ),
    resolveElicitation: (requestId, decisionAction, content) =>
      action(() =>
        api.call('conversations.acp.resolveElicitation', {
          conversationId,
          requestId,
          action: decisionAction,
          ...(content !== undefined ? { content } : {}),
        })
      ),
    async generatePromptSuggestions(input) {
      try {
        const raw = unwrapResult(
          await api.call('textGeneration.generatePromptSuggestions', input)
        );
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
        const suggestions = (raw as Record<string, unknown>)['suggestions'];
        if (!Array.isArray(suggestions)) return [];
        return suggestions.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0
        );
      } catch {
        // Eski masaüstü (UNKNOWN_PROCEDURE / NOT_ALLOWED / CONTRACT_MISMATCH) ya da ağ hatasında sessizce boş dön.
        return [];
      }
    },
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
