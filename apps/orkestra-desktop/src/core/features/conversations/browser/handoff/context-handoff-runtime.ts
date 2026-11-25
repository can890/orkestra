/**
 * Bağlam devri akışının uygulamaya bağlandığı yer: kaynak sohbetin deposu, sohbet istemcisi,
 * dosya çalışma zamanı ve bölme düzeni. Akışın kendisi `context-handoff-service.ts` içindedir.
 */
import { encodeResourceUri } from '@orkestra/core/primitives/path/api';
import type { QueuedPrompt } from '@orkestra/core/runtimes/acp/api/client';
import { toast } from '@orkestra/ui/react/primitives';
import { runInAction } from 'mobx';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { visibleConversationTitle } from '@core/features/conversations/api/browser/conversation-title-utils';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import {
  BRIEF_REQUEST_MARKER,
  type HandoffTurnWithOutcome,
} from '@core/features/conversations/api/context-handoff-package';
import { getFilesClient } from '@core/features/files/api/browser/client';
import { getProjectsWireClient } from '@core/features/projects/api/browser/client';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { hostFileRefFromNativePath } from '@core/primitives/desktop-runtime/api/paths';
import { log } from '@core/primitives/logging/browser/logger';
import type { AcpChatStore } from '../acp/acp-chat-store';
import { formatTranscriptAsMarkdown } from '../acp/format-transcript-markdown';
import {
  getContextHandoffCoordinator,
  type BriefRequestResult,
  type ContextHandoffEnvironment,
  type ContextHandoffSourcePort,
} from './context-handoff-service';
import {
  writeContextHandoffTranscript,
  type TranscriptFilesDeps,
} from './context-handoff-transcript';
import { collectHistoryTurns, type HistoryPageResult } from './handoff-history';
import { getHandoffStore, setPendingDraftText } from './handoff-store';

/** Tam döküm için okunacak en fazla geçmiş sayfası (sayfa başına 100 tur). */
const TRANSCRIPT_MAX_PAGES = 50;
const PAGE_SIZE = 100;
const POLL_MS = 1_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function conversationData(store: AcpChatStore) {
  return conversationRegistry.get(store.taskId)?.conversations.get(store.conversationId)?.data;
}

async function loadHistoryPage(
  conversationId: string,
  limit: number,
  before?: number
): Promise<HistoryPageResult> {
  const client = (await getConversationsClient()).acp;
  return (await client.loadHistory({
    conversationId,
    limit,
    ...(before === undefined ? {} : { before }),
  })) as HistoryPageResult;
}

async function activateConversation(conversationId: string): Promise<void> {
  try {
    const client = (await getConversationsClient()).acp;
    const attached = await client.attach({ conversationId });
    if (!attached.success) {
      log.warn('[context-handoff] could not attach the new conversation', {
        error: attached.error,
      });
      return;
    }
    await client.loadHistory({ conversationId, limit: 1 });
  } catch (error) {
    log.warn('[context-handoff] could not activate the new conversation', { error });
  }
}

/** Kaynak deposunu akışın portuna çevirir. */
export function createStoreSourcePort(
  store: AcpChatStore,
  options: { providerLabel?: string } = {}
): ContextHandoffSourcePort {
  /** Kaynağın kuyruğundan alınan mesajların özgün hâlleri (geri koymak gerekirse). */
  const taken: QueuedPrompt[] = [];
  return {
    conversationId: store.conversationId,
    projectId: store.projectId,
    taskId: store.taskId,
    title: () => visibleConversationTitle(conversationData(store)?.title ?? ''),
    providerId: () => {
      const providerId = conversationData(store)?.providerId;
      if (!providerId) throw new Error('Kaynak sohbet bulunamadı.');
      return providerId;
    },
    providerLabel: () => options.providerLabel,
    isWorking: () => store.affordances.isWorking,
    isUsable: () => store.liveActionsEnabled,
    async waitUntilIdle(signal) {
      while (!signal.aborted) {
        // Sekme kapanıp depo bırakıldıysa beklemek anlamsız: taşıma vazgeçilir.
        if (store.disposed) return 'aborted';
        if (!store.affordances.isWorking && store.queuedPrompts.length === 0) return 'idle';
        await sleep(POLL_MS, signal);
      }
      return 'aborted';
    },
    async takeQueuedPrompts() {
      const session = store.session;
      const queued = session?.sessionState.current().queuedPrompts ?? [];
      const texts: string[] = [];
      for (const prompt of queued) {
        const text = prompt.text.trim();
        if (!text) continue;
        const removed = await session?.deleteQueuedPrompt(prompt.id).catch(() => undefined);
        if (!removed?.success) continue;
        taken.push(prompt);
        const attachments = prompt.attachments?.length ?? 0;
        texts.push(
          attachments > 0
            ? `${text}\n\n(Not: bu mesajın ${attachments} eki önceki sohbette kaldı.)`
            : text
        );
      }
      return texts;
    },
    restoreQueuedPrompts() {
      // Alınan mesajlar özgün hâlleriyle (gizli bağlam ve ekler dahil) kaynağın kuyruğuna geri
      // konur; böylece taşıma hiç olmamış gibi sırayla çalışırlar.
      const originals = taken.splice(0);
      if (originals.length === 0) return;
      void (async () => {
        const client = (await getConversationsClient()).acp;
        const failed: string[] = [];
        for (const prompt of originals) {
          const result = await client
            .sendPrompt(
              {
                conversationId: store.conversationId,
                promptId: crypto.randomUUID(),
                prompt: {
                  text: prompt.text,
                  ...(prompt.hiddenContext ? { hiddenContext: prompt.hiddenContext } : {}),
                  ...(prompt.attachments?.length ? { attachments: prompt.attachments } : {}),
                },
                placement: 'queue',
              },
              { timeoutMs: 0 }
            )
            .catch(() => null);
          if (!result?.success) failed.push(prompt.text);
        }
        if (failed.length === 0) return;
        if (!store.disposed) {
          const current = store.draftText.replace(/\s*$/, '');
          store.setDraftText([current, ...failed].filter(Boolean).join('\n\n'));
        }
        toast.warning('Sıradaki mesajlar kuyruğa geri konamadı', {
          description: store.disposed
            ? failed.join('\n\n')
            : 'Kaybolmasınlar diye mesaj kutusuna eklendi.',
        });
      })();
    },
    async requestBrief(text, timeoutMs, signal): Promise<BriefRequestResult> {
      const promptId = crypto.randomUUID();
      // Önceki (ör. vazgeçilmiş) bir taşımadan kalan istek turu yanıt sanılmasın.
      const before = await loadHistoryPage(store.conversationId, 4).catch(() => null);
      const earlierTurnIds = new Set(
        before?.success ? before.data.turns.map((candidate) => candidate.id) : []
      );
      const sent = await store.sendVisiblePrompt(text, promptId);
      if (sent === 'rejected') return { status: 'not-sent' };
      const deadline = Date.now() + timeoutMs;
      let sawWork = store.affordances.isWorking;
      while (!signal.aborted) {
        await sleep(POLL_MS, signal);
        if (signal.aborted) break;
        const working = store.affordances.isWorking;
        sawWork ||= working;
        const stillQueued = store.queuedPrompts.some((prompt) =>
          prompt.text.startsWith(BRIEF_REQUEST_MARKER)
        );
        if (!working && !stillQueued) {
          const page = await loadHistoryPage(store.conversationId, 4).catch(() => null);
          if (page?.success) {
            const turn = [...page.data.turns]
              .reverse()
              .find(
                (candidate) =>
                  !earlierTurnIds.has(candidate.id) &&
                  candidate.items.some(
                    (item) =>
                      item.kind === 'message' &&
                      item.role === 'user' &&
                      (item.promptId === promptId || item.text?.startsWith(BRIEF_REQUEST_MARKER))
                  )
              );
            const outcome = (turn as HandoffTurnWithOutcome | undefined)?.outcome;
            if (turn && (outcome !== undefined || sawWork)) {
              return { status: 'completed', promptId };
            }
          }
        }
        if (Date.now() >= deadline) return { status: 'timeout', promptId };
      }
      return { status: 'aborted' };
    },
    async loadTurns(): Promise<HandoffTurnWithOutcome[]> {
      const visible = store.visibleTurns();
      try {
        return await collectHistoryTurns(
          (before) => loadHistoryPage(store.conversationId, PAGE_SIZE, before),
          visible,
          TRANSCRIPT_MAX_PAGES
        );
      } catch (error) {
        log.warn('[context-handoff] history unavailable; using visible turns', { error });
        return [...visible];
      }
    },
    snapshot: () => ({
      draftText: store.draftText,
      planEntries: store.session?.plan.current()?.entries ?? [],
      runningAgents: store.agents
        .filter((agent) => agent.status === 'running')
        .map((agent) => ({
          name: agent.name,
          ...((agent.prompt ?? agent.role) ? { detail: agent.prompt ?? agent.role } : {}),
        })),
    }),
    conversationSettings: () => {
      const data = conversationData(store);
      const model = store.model ?? data?.model;
      const modeId = store.permissionMode ?? data?.modeId;
      const effort = store.effort ?? data?.effort;
      const collaborationMode = store.collaborationMode ?? data?.collaborationMode;
      return {
        // Çatallama kuralı: aynı ajanla açıldığı için kaynağın otomatik onay ayarı korunur.
        ...(data?.autoApprove !== undefined ? { autoApprove: data.autoApprove } : {}),
        ...(model ? { model } : {}),
        ...(modeId ? { modeId } : {}),
        ...(effort ? { effort } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
      };
    },
  };
}

/** Dosya çalışma zamanı üzerinden yazar; SSH projelerinde uzak ana makineye gider. */
export const runtimeTranscriptFiles: TranscriptFilesDeps = {
  async getHomeDir(connectionId) {
    const client = await getProjectsWireClient();
    return client.getHostHomeDir(connectionId ? { type: 'ssh', connectionId } : { type: 'local' });
  },
  async createDirectory({ path, connectionId }) {
    const client = await getFilesClient();
    const uri = encodeResourceUri(hostFileRefFromNativePath(path, connectionId));
    const result = await client.fs.createDirectory({ uri });
    return result.success ? { success: true } : { success: false, error: result.error };
  },
  async writeText({ path, connectionId, content }) {
    const client = await getFilesClient();
    const uri = encodeResourceUri(hostFileRefFromNativePath(path, connectionId));
    const blob = new Blob([content], { type: 'text/markdown' });
    const result = await client.fs.upload(
      { uri, overwrite: true },
      {
        name: path.split(/[\\/]/).pop() ?? 'devir.md',
        mimeType: 'text/markdown',
        size: blob.size,
        source: blob.stream(),
      }
    );
    return result.success ? { success: true } : { success: false, error: result.error };
  },
};

/** Yeni sohbeti kaynağın bulunduğu bölmenin sağındaki bölmede açar (gerekirse böler). */
export function openConversationBeside(input: {
  projectId: string;
  taskId: string;
  sourceConversationId: string;
  conversationId: string;
}): void {
  const paneLayout = getTaskComposition(input.projectId, input.taskId)?.paneLayout;
  if (!paneLayout) return;
  runInAction(() => {
    const sourceGroup = paneLayout.groups.find((group) =>
      group.pane.findSingleMountEntry('acp-chat', input.sourceConversationId)
    );
    if (sourceGroup) paneLayout.setActiveGroup(sourceGroup.paneId);
    paneLayout.open(
      'acp-chat',
      { conversationId: input.conversationId },
      { preview: false, target: 'right' }
    );
  });
}

export function createRuntimeEnvironment(store: AcpChatStore): ContextHandoffEnvironment {
  const connectionId = getProjectSshConnectionId(store.projectId) ?? undefined;
  return {
    newConversationId: () => crypto.randomUUID(),
    now: () => Date.now(),
    writeTranscript: ({ newConversationId, turns }) => {
      const data = conversationData(store);
      const markdown = formatTranscriptAsMarkdown({
        title: data?.title,
        providerId: data?.providerId,
        model: store.model,
        // Dışa aktarma biçimlendiricisi tur sonucunu kendi türüyle bekler; döküm için gerekmez.
        turns: turns.map(({ outcome: _outcome, ...turn }) => turn),
      });
      return writeContextHandoffTranscript(
        { connectionId, newConversationId, markdown },
        runtimeTranscriptFiles
      );
    },
    async createConversation(params) {
      const manager = conversationRegistry.get(store.taskId);
      if (!manager) throw new Error('Görevin sohbetleri henüz yüklenmedi.');
      await manager.createConversation(params);
      // İlk tur (kuyruktaki devam mesajı) sekmenin açılmasını beklemeden başlasın; sekme de
      // aynı oturuma bağlanır. Başarısızlık taşımayı bozmaz: sekme açılınca oturum yine başlar.
      void activateConversation(params.id);
    },
    openBeside: ({ sourceConversationId, conversationId }) =>
      openConversationBeside({
        projectId: store.projectId,
        taskId: store.taskId,
        sourceConversationId,
        conversationId,
      }),
    setPendingDraft: setPendingDraftText,
    pruneTranscripts: () => {
      void (async () => {
        const client = await getConversationsClient();
        await client.handoff.pruneTranscripts(connectionId ? { connectionId } : {});
      })().catch((error: unknown) => {
        log.warn('[context-handoff] transcript cleanup failed', { error });
      });
    },
    handoffStore: getHandoffStore(),
  };
}

/**
 * "Sohbeti yeni bağlama taşı": öneri şeridi, sekme menüsü ve komut paleti buradan başlatır.
 * Tıklama onaydır; sonraki adımlar (devir notu, yeni sohbet, ilk tur) kendiliğinden yürür.
 */
export async function moveConversationToNewContext(
  store: AcpChatStore,
  options: { providerLabel?: string } = {}
): Promise<void> {
  const env = createRuntimeEnvironment(store);
  const outcome = await getContextHandoffCoordinator().start(
    createStoreSourcePort(store, options),
    env
  );
  switch (outcome.kind) {
    case 'moved':
      toast.success('Sohbet yeni bağlama taşındı', {
        description:
          outcome.contextSource === 'agent-brief'
            ? 'Yeni sohbet devir notuyla kaldığı yerden devam ediyor.'
            : `Önceki ajan devir notu yazamadı (${outcome.fallbackReason ?? 'bilinmeyen neden'}); otomatik özet ve tam döküm kullanıldı.`,
      });
      return;
    case 'already-moved':
      env.openBeside({
        sourceConversationId: store.conversationId,
        conversationId: outcome.conversationId,
      });
      toast('Bu sohbet zaten yeni bir sohbete taşındı', {
        description: 'Halef sohbet açıldı.',
      });
      return;
    case 'failed':
      toast.error('Sohbet yeni bağlama taşınamadı', { description: outcome.message });
      return;
    case 'cancelled':
      return;
  }
}
