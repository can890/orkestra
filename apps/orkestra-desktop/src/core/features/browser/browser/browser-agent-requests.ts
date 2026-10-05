import { comparer, observable, reaction, runInAction, untracked, when } from 'mobx';
import { browserAgentActivity } from '@core/features/browser/api/browser/browser-agent-activity';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import {
  asAvailableProject,
  getProjectManagerStore,
  getProjectStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import type {
  BrowserAgentRequestReply,
  BrowserEvent,
  BrowserTaskActiveTabs,
} from '@core/primitives/browser/api';
import { log } from '@core/primitives/logging/browser/logger';
import {
  findBrowserTab,
  frontBrowserIds,
  openAgentBrowserTab,
  type AgentPlacementLayout,
} from './agent-tab-placement';

/** Görev düzeninin hazır olmasını bekleme süresi; ana sürecin 20 sn zaman aşımından kısa. */
export const AGENT_TAB_LAYOUT_WAIT_MS = 15_000;

export type BrowserAgentRequestDeps = {
  /** Görevin kalıcı düzeni geri yüklendiyse düzenini döndürür; MobX ile reaktif okunur. */
  getTaskLayout(projectId: string, taskId: string): AgentPlacementLayout | undefined;
  /**
   * Görevi geçerli görünümü değiştirmeden arka planda etkinleştirir. Başarıda null, aksi halde
   * ajana iletilecek hata iletisini döndürür.
   */
  activateTask(projectId: string, taskId: string): Promise<string | null>;
  layoutWaitMs?: number;
};

type AgentTabRequestEvent = Extract<
  BrowserEvent,
  { type: 'open-requested' | 'activate-requested' | 'close-requested' }
>;

/**
 * Ana süreçten gelen ajan sekme isteklerini (aç, öne getir, kapat) karşılar. Hiçbiri kullanıcının
 * baktığı görünümü değiştirmez: sekme ait olduğu görevin düzeninde açılır/seçilir/kapanır.
 */
export function createBrowserAgentRequestHandler(deps: BrowserAgentRequestDeps) {
  const layoutWaitMs = deps.layoutWaitMs ?? AGENT_TAB_LAYOUT_WAIT_MS;

  async function ensureTaskLayout(
    projectId: string,
    taskId: string
  ): Promise<AgentPlacementLayout> {
    const ready = deps.getTaskLayout(projectId, taskId);
    if (ready) return ready;

    const failure = observable.box<string | null>(null);
    void deps.activateTask(projectId, taskId).then(
      (message) => runInAction(() => failure.set(message)),
      (error: unknown) => runInAction(() => failure.set(errorMessage(error)))
    );
    try {
      await when(
        () => deps.getTaskLayout(projectId, taskId) !== undefined || failure.get() !== null,
        { timeout: layoutWaitMs }
      );
    } catch {
      throw new Error(`Task ${taskId} did not become ready in the Orkestra window in time.`);
    }
    const layout = deps.getTaskLayout(projectId, taskId);
    if (layout) return layout;
    throw new Error(failure.get() ?? `Task ${taskId} is not available in the Orkestra window.`);
  }

  function layoutOfBrowser(browserId: string): AgentPlacementLayout | undefined {
    const session = browserSessionStore.getSession(browserId);
    return session ? deps.getTaskLayout(session.projectId, session.taskId) : undefined;
  }

  async function handleRequest(event: AgentTabRequestEvent): Promise<BrowserAgentRequestReply> {
    switch (event.type) {
      case 'open-requested': {
        const layout = await ensureTaskLayout(event.projectId, event.taskId);
        const browserId = runInAction(() =>
          openAgentBrowserTab(layout, { url: event.url, activate: event.activate })
        );
        return { requestId: event.requestId, ok: true, browserId };
      }
      case 'activate-requested': {
        const layout = layoutOfBrowser(event.browserId);
        const found = layout ? findBrowserTab(layout, event.browserId) : undefined;
        if (!found) {
          return {
            requestId: event.requestId,
            ok: false,
            error: `Browser tab ${event.browserId} is not open.`,
          };
        }
        runInAction(() => found.pane.setActiveTab(found.tabId));
        return { requestId: event.requestId, ok: true, browserId: event.browserId };
      }
      case 'close-requested': {
        const layout = layoutOfBrowser(event.browserId);
        const found = layout ? findBrowserTab(layout, event.browserId) : undefined;
        // Zaten kapanmış bir sekme için de başarı: istenen son durum sağlanmış.
        if (found) runInAction(() => found.pane.closeTab(found.tabId));
        return { requestId: event.requestId, ok: true, browserId: event.browserId };
      }
    }
  }

  return {
    /** Olayı işler; renderer'ın ana sürece göndermesi gereken yanıtı (varsa) döndürür. */
    async handle(event: BrowserEvent): Promise<BrowserAgentRequestReply | null> {
      if (event.type === 'agent-activity') {
        browserAgentActivity.markActive(event.browserId);
        return null;
      }
      if (
        event.type !== 'open-requested' &&
        event.type !== 'activate-requested' &&
        event.type !== 'close-requested'
      ) {
        return null;
      }
      try {
        return await handleRequest(event);
      } catch (error) {
        return { requestId: event.requestId, ok: false, error: errorMessage(error) };
      }
    },
  };
}

/** Görevlerin bölmelerinde öndeki tarayıcı sekmeleri; ana sürece tam anlık görüntü olarak gider. */
export function collectTaskActiveBrowsers(
  getTaskLayout: BrowserAgentRequestDeps['getTaskLayout']
): BrowserTaskActiveTabs[] {
  const tasks = new Map<string, { projectId: string; taskId: string }>();
  for (const browserId of browserSessionStore.sessions.keys()) {
    // Kimlik değişmez; oturumun adres/başlık güncellemeleri bu hesabı yeniden tetiklemesin.
    const session = untracked(() => browserSessionStore.getSession(browserId));
    if (!session) continue;
    tasks.set(`${session.projectId}\u0000${session.taskId}`, {
      projectId: session.projectId,
      taskId: session.taskId,
    });
  }
  const result: BrowserTaskActiveTabs[] = [];
  for (const { projectId, taskId } of tasks.values()) {
    const layout = getTaskLayout(projectId, taskId);
    if (!layout) continue;
    result.push({ projectId, taskId, browserIds: frontBrowserIds(layout).sort() });
  }
  return result.sort((a, b) =>
    a.projectId === b.projectId
      ? a.taskId.localeCompare(b.taskId)
      : a.projectId.localeCompare(b.projectId)
  );
}

/** Uygulama görev bileşimlerinden okunan varsayılan bağımlılıklar. */
export const defaultBrowserAgentRequestDeps: BrowserAgentRequestDeps = {
  getTaskLayout(projectId, taskId) {
    try {
      const composition = getTaskComposition(projectId, taskId);
      return composition?.isPaneLayoutHydrated ? composition.paneLayout : undefined;
    } catch {
      // Arşivlenmiş görevlerin oturum depoları yoktur.
      return undefined;
    }
  },
  activateTask: activateTaskInBackground,
};

/**
 * Ajan isteği, renderer'ın henüz etkinleştirmediği bir görev için gelebilir (ör. uygulama yeniden
 * başlarken uzak sunucuda çalışmaya devam eden bir ajan). Görev, kullanıcının görünümü
 * değiştirilmeden etkinleştirilir; böylece kalıcı bölme düzeni yüklenir ve sekme açılabilir.
 */
async function activateTaskInBackground(projectId: string, taskId: string): Promise<string | null> {
  if (!asAvailableProject(getProjectStore(projectId))) {
    try {
      await getProjectManagerStore().hydrateProjectContext(projectId);
    } catch (error) {
      return `Project ${projectId} is not available: ${errorMessage(error)}`;
    }
  }
  const manager = getTaskManagerStore(projectId);
  if (!manager) return `Project ${projectId} is not available in the Orkestra window.`;
  const outcome = await manager.provisionTask(taskId);
  switch (outcome.kind) {
    case 'active':
      return null;
    case 'deferred':
      return `The workspace host of task ${taskId} is not reachable right now.`;
    case 'skipped':
      return outcome.reason === 'task-missing'
        ? `Task ${taskId} was not found.`
        : `Task ${taskId} cannot be activated.`;
    case 'failed':
      return `Task ${taskId} could not be activated: ${outcome.message}`;
  }
}

/**
 * Renderer açılışında bir kez çağrılır: ana süreçteki eski oturumları temizler, ajan sekme
 * isteklerini dinler ve görevlerin öndeki sekmelerini ana sürece bildirir.
 */
export function wireBrowserAgentRequests(
  deps: BrowserAgentRequestDeps = defaultBrowserAgentRequestDeps
): () => void {
  const handler = createBrowserAgentRequestHandler(deps);
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let stopActiveSync: (() => void) | undefined;

  void getBrowserClient()
    .then(async (client) => {
      // Yeni yüklenen pencere: önceki pencerenin oturumları ve yanıtsız istekleri geçersiz.
      await client.syncSessions({ browserIds: Array.from(browserSessionStore.sessions.keys()) });
      if (disposed) return;
      stopActiveSync = reaction(
        () => collectTaskActiveBrowsers(deps.getTaskLayout),
        (tasks) => {
          void client.syncTaskActiveBrowsers({ tasks }).catch((error: unknown) => {
            log.warn('Failed to sync active browser tabs', error);
          });
        },
        { equals: comparer.structural, fireImmediately: true }
      );
      const nextUnsubscribe = await client.events.subscribe(undefined, {
        onEvent: (event) => {
          void handler
            .handle(event)
            .then((reply) => (reply ? client.resolveAgentRequest(reply) : undefined))
            .catch((error: unknown) => log.warn('Failed to answer a browser agent request', error));
        },
        onGap: () => {},
      });
      if (disposed) nextUnsubscribe();
      else unsubscribe = nextUnsubscribe;
    })
    .catch((error: unknown) => log.error('Failed to wire browser agent requests', error));

  return () => {
    disposed = true;
    unsubscribe?.();
    stopActiveSync?.();
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
