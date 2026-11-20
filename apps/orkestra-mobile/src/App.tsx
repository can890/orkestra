import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppSession } from '@/core/app-session';
import {
  isConversationAwaitingPermission,
  isConversationWorking,
  mapAccounts,
  mapAgentNames,
  mapConversations,
  mapProjects,
  mapSessionSummaries,
  mapUsage,
  type AccountView,
  type ConversationView,
  type ProjectView,
  type ProviderUsageView,
  type SessionSummaryView,
  type TaskView,
} from '@/core/mappers';
import { createPairingRepository } from '@/core/pairing-store';
import { createDeviceSecureStore } from '@/core/secure-store';
import { initTheme } from '@/core/theme';
import {
  LOCAL_HOST,
  REMOTE_TOPICS,
  describeCallError,
  topicOf,
  unwrapResult,
  type LiveSubscription,
  type RemoteApi,
} from '@/core/wire-client';
import { ConnectionBanner, Loading, OrkestraMark } from './ui/components';
import { CreateModal, type CreateMode } from './ui/CreateModal';
import { useConnectionStatus, useLive, useQuery } from './ui/hooks';
import { FolderIcon, GaugeIcon, HomeIcon, PlusIcon, SettingsIcon } from './ui/icons';
import { CORE_USAGE_PROVIDERS } from './ui/ProviderBrand';
import { useRouter, type Route } from './ui/router';
import { AccountsScreen } from './ui/screens/AccountsScreen';
import { ConversationsScreen, TasksScreen } from './ui/screens/BrowseScreens';
import { ChatScreen } from './ui/screens/ChatScreen';
import { HomeScreen } from './ui/screens/HomeScreen';
import { PairingScreen } from './ui/screens/PairingScreen';
import { ProjectsScreen } from './ui/screens/ProjectsScreen';
import { SettingsScreen } from './ui/screens/SettingsScreen';
import { SidebarDrawer } from './ui/SidebarDrawer';

declare global {
  interface Window {
    __orkestraHandleBack?: () => 'handled' | 'exit';
  }
}

/** Arka planda bu kadar kalan uygulama, öne dönünce bağlantısını tazeler. */
const BACKGROUND_REFRESH_MS = 20_000;
const ROOT_BACK_EXIT_WINDOW_MS = 2_000;
const EMPTY_PROJECTS: ProjectView[] = [];
const EMPTY_CONVERSATIONS: ConversationView[] = [];
const EMPTY_SESSIONS: Record<string, SessionSummaryView> = {};
const EMPTY_NAMES: Record<string, string> = {};
const EMPTY_ACCOUNTS: AccountView[] = [];

export function App() {
  useEffect(() => {
    initTheme();
  }, []);

  const session = useMemo(
    () =>
      new AppSession({
        repository: createPairingRepository(createDeviceSecureStore()),
        clientName: 'Android telefon',
        platform: 'android',
      }),
    []
  );
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);

  useEffect(() => {
    void session.init();
    let hiddenAt: number | null = null;
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt !== null && Date.now() - hiddenAt > BACKGROUND_REFRESH_MS) {
        hiddenAt = null;
        session.refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [session]);

  if (state.phase === 'loading') {
    return (
      <div className="splash-boot">
        <OrkestraMark size={44} />
        <Loading label="Orkestra hazırlanıyor…" />
      </div>
    );
  }
  if (state.phase === 'unpaired') return <PairingScreen session={session} />;
  return <PairedWorkbench session={session} state={state} />;
}

/**
 * Masaüstünün `conversations.acp.sessions.list` canlı konusu `{ host, projectId }` anahtarı ister.
 * Her benzersiz host (yerel Mac + bağlı her SSH makinesi) için bir temsili proje üzerinden
 * abone olur ve tüm canlı ACP oturum özetlerini tek sözlükte birleştirir.
 */
function useAllHostSessions(
  api: RemoteApi,
  projects: readonly ProjectView[],
  connected: boolean
): Record<string, SessionSummaryView> {
  const [sessions, setSessions] = useState<Record<string, SessionSummaryView>>(EMPTY_SESSIONS);

  const hostKey = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of projects) {
      if (!seen.has(p.hostRef)) seen.set(p.hostRef, p.id);
    }
    return [...seen.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([host, projectId]) => `${host}\0${projectId}`)
      .join('\n');
  }, [projects]);

  useEffect(() => {
    if (!connected || !hostKey) {
      setSessions(EMPTY_SESSIONS);
      return;
    }

    const targets = hostKey.split('\n').map((entry) => {
      const [host, projectId] = entry.split('\0');
      return { host: host!, projectId: projectId! };
    });

    const byHost = new Map<string, Record<string, SessionSummaryView>>();
    const subs: LiveSubscription<unknown>[] = [];
    let active = true;

    const emitMerged = () => {
      if (!active) return;
      const merged: Record<string, SessionSummaryView> = {};
      for (const map of byHost.values()) {
        for (const [id, summary] of Object.entries(map)) {
          const prev = merged[id];
          if (!prev || summary.updatedAt >= prev.updatedAt) {
            merged[id] = summary;
          }
        }
      }
      setSessions(merged);
    };

    for (const target of targets) {
      const topic = topicOf(REMOTE_TOPICS.sessionsList, {
        host: target.host,
        projectId: target.projectId,
      });
      const sub = api.live<unknown>(topic, (raw) => {
        byHost.set(target.host, mapSessionSummaries(raw));
        emitMerged();
      });
      sub.ready.catch(() => {
        // SSH makinesi o an bağlı değilse sessizce atla; diğer host'lar çalışmaya devam eder.
      });
      subs.push(sub);
    }

    return () => {
      active = false;
      for (const sub of subs) sub.dispose();
    };
  }, [api, connected, hostKey]);

  return sessions;
}

function PairedWorkbench(props: {
  session: AppSession;
  state: Extract<ReturnType<AppSession['getState']>, { phase: 'paired' }>;
}) {
  const { session, state } = props;
  const { api, manager, record } = state;
  const status = useConnectionStatus(manager);
  const { route, push, replace, back, goBack } = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [backExitPrompt, setBackExitPrompt] = useState(false);
  const lastRootBackAt = useRef(0);
  const [createSheet, setCreateSheet] = useState<{
    open: boolean;
    mode: CreateMode;
    projectId?: string;
  }>({ open: false, mode: 'task' });

  // Android native geri tuşu/hareketi: önce modal/çekmece, sonra önceki ekran, en son çift-basış koruması
  useEffect(() => {
    let toastTimer: ReturnType<typeof setTimeout> | null = null;
    window.__orkestraHandleBack = () => {
      if (createSheet.open) {
        setCreateSheet((prev) => ({ ...prev, open: false }));
        return 'handled';
      }
      if (drawerOpen) {
        setDrawerOpen(false);
        return 'handled';
      }
      if (goBack()) {
        lastRootBackAt.current = 0;
        setBackExitPrompt(false);
        return 'handled';
      }
      const now = Date.now();
      if (now - lastRootBackAt.current <= ROOT_BACK_EXIT_WINDOW_MS) {
        lastRootBackAt.current = 0;
        setBackExitPrompt(false);
        return 'exit';
      }
      lastRootBackAt.current = now;
      setBackExitPrompt(true);
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => setBackExitPrompt(false), ROOT_BACK_EXIT_WINDOW_MS);
      return 'handled';
    };
    return () => {
      if (toastTimer) clearTimeout(toastTimer);
      delete window.__orkestraHandleBack;
    };
  }, [createSheet.open, drawerOpen, goBack]);

  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const projects = useLive(api, REMOTE_TOPICS.projects, mapProjects);
  const projectList = projects.data ?? EMPTY_PROJECTS;
  const sessions = useAllHostSessions(api, projectList, status.kind === 'connected');
  const accounts = useLive(api, topicOf(REMOTE_TOPICS.authList, { host: LOCAL_HOST }), mapAccounts);
  const allConversations = useQuery<ConversationView[]>(
    manager,
    async () =>
      mapConversations(unwrapResult(await api.call('conversations.getConversations', undefined))),
    'all-conversations',
    5_000
  );
  const agentMeta = useQuery<Record<string, string>>(
    manager,
    async () => mapAgentNames(unwrapResult(await api.call('agents.listMetadata', undefined))),
    'agent-metadata',
    0
  );

  // Canlı oturum kümesi değiştiğinde (yeni iş başladığında/bittiğinde) sohbet listesini anında yenile
  const liveSessionSignal = useMemo(
    () =>
      Object.values(sessions)
        .map(
          (s) =>
            `${s.conversationId}:${s.lifecycle}:${s.isGenerating ? 1 : 0}:${s.pendingPermissionCount}`
        )
        .sort()
        .join('|'),
    [sessions]
  );
  const lastSignalRef = useRef('');
  useEffect(() => {
    if (!liveSessionSignal || liveSessionSignal === lastSignalRef.current) return;
    lastSignalRef.current = liveSessionSignal;
    allConversations.reload();
  }, [liveSessionSignal, allConversations]);

  // Yapay zeka limitlerini tüm çekirdek sağlayıcılar + bağlı hesaplar için canlı sorgula
  const [usage, setUsage] = useState<Record<string, ProviderUsageView>>({});
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageTick, setUsageTick] = useState(0);

  const accountList = accounts.data ?? EMPTY_ACCOUNTS;
  const usageProviderKey = useMemo(() => {
    const ids = new Set<string>(CORE_USAGE_PROVIDERS);
    for (const acc of accountList) {
      if (acc.auth === 'authenticated') ids.add(acc.providerId);
    }
    return [...ids].slice(0, 12).join(',');
  }, [accountList]);

  useEffect(() => {
    if (status.kind !== 'connected' || !usageProviderKey) return;
    let active = true;
    setUsageLoading(true);
    api
      .call('usageLimits.get', {
        host: LOCAL_HOST,
        providerIds: usageProviderKey.split(','),
        ...(usageTick > 0 ? { force: true } : {}),
      })
      .then(
        (data) => {
          if (!active) return;
          setUsage(Object.fromEntries(mapUsage(data).map((entry) => [entry.providerId, entry])));
          setUsageError(null);
        },
        (error: unknown) => {
          if (active) setUsageError(describeCallError(error));
        }
      )
      .finally(() => {
        if (active) setUsageLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, status.kind, usageProviderKey, usageTick]);

  const conversations = allConversations.data ?? EMPTY_CONVERSATIONS;
  const agentNames = agentMeta.data ?? EMPTY_NAMES;

  const openCreate = useCallback((mode: CreateMode, projectId?: string) => {
    setCreateSheet({ open: true, mode, projectId });
  }, []);

  const openTaskDirectly = useCallback(
    (project: ProjectView, task: TaskView) => {
      const taskConvs = conversations.filter((c) => c.taskId === task.id && c.chatCapable);
      if (taskConvs.length > 0) {
        const preferred =
          taskConvs.find(
            (c) =>
              isConversationWorking(c, sessions[c.id]) ||
              isConversationAwaitingPermission(c, sessions[c.id])
          ) ?? taskConvs[0]!;
        push({
          name: 'chat',
          conversationId: preferred.id,
          title: preferred.title,
          providerId: preferred.providerId,
          projectId: project.id,
          projectName: project.name,
          taskId: task.id,
          taskName: task.name,
        });
      } else {
        push({
          name: 'conversations',
          projectId: project.id,
          projectName: project.name,
          taskId: task.id,
          taskName: task.name,
        });
      }
    },
    [conversations, sessions, push]
  );

  const handleDrawerNavigate = useCallback(
    (next: Route) => {
      push(next);
    },
    [push]
  );

  const siblingConversations = useMemo(() => {
    if (route.name !== 'chat' || !route.taskId) return [];
    return conversations.filter((c) => c.taskId === route.taskId);
  }, [route, conversations]);

  const showDock =
    route.name === 'home' ||
    route.name === 'projects' ||
    route.name === 'accounts' ||
    route.name === 'settings';

  return (
    <div
      className="app"
      onTouchStart={(event) => {
        const touch = event.touches[0];
        if (!touch) return;
        if (!drawerOpen && touch.clientX <= 26) {
          touchStart.current = { x: touch.clientX, y: touch.clientY };
        } else if (drawerOpen) {
          touchStart.current = { x: touch.clientX, y: touch.clientY };
        } else {
          touchStart.current = null;
        }
      }}
      onTouchEnd={(event) => {
        const start = touchStart.current;
        touchStart.current = null;
        const touch = event.changedTouches[0];
        if (!start || !touch) return;
        const dx = touch.clientX - start.x;
        const dy = Math.abs(touch.clientY - start.y);
        if (dy > 55) return;
        if (!drawerOpen && dx > 56) setDrawerOpen(true);
        if (drawerOpen && dx < -56) setDrawerOpen(false);
      }}
    >
      <ConnectionBanner status={status} session={session} />
      <div className="content">
        {route.name === 'home' ? (
          <HomeScreen
            projects={projectList}
            projectsLoading={projects.loading}
            projectsError={projects.error}
            conversations={conversations}
            conversationsLoading={allConversations.loading}
            sessions={sessions}
            usage={usage}
            agentNames={agentNames}
            hostName={record.hostName || 'Mac'}
            status={status}
            onOpenMenu={() => setDrawerOpen(true)}
            onOpenCreate={openCreate}
            push={push}
            replace={replace}
          />
        ) : null}

        {route.name === 'projects' ? (
          <ProjectsScreen
            projects={projectList}
            loading={projects.loading}
            error={projects.error}
            conversations={conversations}
            sessions={sessions}
            onOpenMenu={() => setDrawerOpen(true)}
            onOpenCreate={openCreate}
            push={push}
          />
        ) : null}

        {route.name === 'tasks' ? (
          <TasksScreen
            api={api}
            projectId={route.projectId}
            projectName={route.projectName}
            conversations={conversations}
            sessions={sessions}
            onOpenMenu={() => setDrawerOpen(true)}
            onOpenCreate={openCreate}
            push={push}
            back={back}
          />
        ) : null}

        {route.name === 'conversations' ? (
          <ConversationsScreen
            api={api}
            manager={manager}
            projectId={route.projectId}
            projectName={route.projectName}
            taskId={route.taskId}
            taskName={route.taskName}
            sessions={sessions}
            agentNames={agentNames}
            onOpenMenu={() => setDrawerOpen(true)}
            push={push}
            back={back}
          />
        ) : null}

        {route.name === 'chat' ? (
          <ChatScreen
            api={api}
            conversationId={route.conversationId}
            title={route.title}
            providerId={route.providerId}
            projectId={route.projectId}
            projectName={route.projectName}
            taskId={route.taskId}
            taskName={route.taskName}
            siblingConversations={siblingConversations}
            agentNames={agentNames}
            onOpenMenu={() => setDrawerOpen(true)}
            onSwitchConversation={replace}
            back={back}
          />
        ) : null}

        {route.name === 'accounts' ? (
          <AccountsScreen
            accounts={accountList}
            accountsLoading={accounts.loading}
            accountsError={accounts.error}
            usage={usage}
            usageLoading={usageLoading}
            usageError={usageError}
            agentNames={agentNames}
            onRefreshUsage={() => setUsageTick((v) => v + 1)}
            onOpenMenu={() => setDrawerOpen(true)}
          />
        ) : null}

        {route.name === 'settings' ? (
          <SettingsScreen
            session={session}
            record={record}
            manager={manager}
            onOpenMenu={() => setDrawerOpen(true)}
          />
        ) : null}
      </div>

      {backExitPrompt ? (
        <div className="back-exit-toast" role="status" aria-live="polite">
          Çıkmak için tekrar geri basın
        </div>
      ) : null}

      {showDock ? (
        <nav className="bottom-dock" aria-label="Ana gezinme">
          <button
            type="button"
            className={`dock-item ${route.name === 'home' ? 'is-active' : ''}`}
            onClick={() => push({ name: 'home' })}
          >
            <HomeIcon size={20} />
            <span>Ana ekran</span>
          </button>
          <button
            type="button"
            className={`dock-item ${route.name === 'projects' ? 'is-active' : ''}`}
            onClick={() => push({ name: 'projects' })}
          >
            <FolderIcon size={20} />
            <span>Projeler</span>
          </button>
          <button
            type="button"
            className="dock-fab"
            onClick={() => openCreate(route.name === 'projects' ? 'project' : 'task')}
            aria-label="Yeni proje veya görev başlat"
          >
            <PlusIcon size={22} />
          </button>
          <button
            type="button"
            className={`dock-item ${route.name === 'accounts' ? 'is-active' : ''}`}
            onClick={() => push({ name: 'accounts' })}
          >
            <GaugeIcon size={20} />
            <span>Limitler</span>
          </button>
          <button
            type="button"
            className={`dock-item ${route.name === 'settings' ? 'is-active' : ''}`}
            onClick={() => push({ name: 'settings' })}
          >
            <SettingsIcon size={20} />
            <span>Ayarlar</span>
          </button>
        </nav>
      ) : null}

      <SidebarDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        api={api}
        hostName={record.hostName || 'Mac'}
        status={status}
        projects={projectList}
        conversations={conversations}
        sessions={sessions}
        agentNames={agentNames}
        route={route}
        onNavigate={handleDrawerNavigate}
        onOpenTask={openTaskDirectly}
      />

      <CreateModal
        open={createSheet.open}
        initialMode={createSheet.mode}
        initialProjectId={createSheet.projectId}
        projects={projectList}
        usage={usage}
        agentNames={agentNames}
        api={api}
        onClose={() => setCreateSheet((prev) => ({ ...prev, open: false }))}
        onCreated={(nextRoute) => {
          setCreateSheet((prev) => ({ ...prev, open: false }));
          allConversations.reload();
          push(nextRoute);
        }}
      />
    </div>
  );
}
