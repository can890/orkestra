import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  parseLaunchTarget,
  type AgentNotificationTarget,
} from '@/core/agent-notifications/launch-target';
import {
  configureAgentNotifications,
  consumeLaunchTarget,
  isAgentNotificationBridgeAvailable,
  setVisibleConversation,
} from '@/core/agent-notifications/native';
import { agentNotificationPrefs } from '@/core/agent-notifications/preferences';
import { AgentNotificationSync } from '@/core/agent-notifications/sync';
import { AppSession } from '@/core/app-session';
import {
  getCachedWorkbenchSync,
  loadCachedWorkbench,
  saveCachedChat,
  saveCachedWorkbench,
  type CachedWorkbench,
} from '@/core/local-cache';
import {
  buildActiveWorkList,
  isConversationAwaitingPermission,
  isConversationWorking,
  mapAccounts,
  mapAgentNames,
  mapConversations,
  mapHandoffList,
  mapHandoffSuperseded,
  mapHistoryPage,
  mapNotifications,
  mapProjects,
  mapSessionSummaries,
  mapTaskStats,
  mapUsage,
  type AccountView,
  type ConversationView,
  type HandoffRecordView,
  type NotificationView,
  type ProjectView,
  type ProviderUsageView,
  type SessionSummaryView,
  type TaskStatView,
  type TaskView,
} from '@/core/mappers';
import { showNativeNotification, triggerHaptic } from '@/core/native-bridge';
import { createPairingRepository } from '@/core/pairing-store';
import { createDeviceSecureStore } from '@/core/secure-store';
import { initTheme } from '@/core/theme';
import { TranscriptStore } from '@/core/transcript-store';
import {
  FREE_CHAT_PROJECT_ID,
  LOCAL_HOST,
  REMOTE_TOPICS,
  describeCallError,
  isFreeChatProjectId,
  topicOf,
  unwrapResult,
  type LiveSubscription,
  type RemoteApi,
} from '@/core/wire-client';
import { ConnectionBanner, GlobalPermissionBanner, Loading, SovraMark } from './ui/components';
import { CreateModal, type CreateMode } from './ui/CreateModal';
import { useConnectionStatus, useLive, useQuery } from './ui/hooks';
import { FolderIcon, GaugeIcon, HomeIcon, PlusIcon, SettingsIcon } from './ui/icons';
import { NotificationsSheet } from './ui/NotificationsSheet';
import { closeTopOverlay } from './ui/overlay-back';
import { CORE_USAGE_PROVIDERS, primaryRemainingPercent } from './ui/ProviderBrand';
import { QuickHostSheet } from './ui/QuickHostSheet';
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

/** Arka plandan bu süreden uzun süre sonra dönünce soket canlılığı ping ile doğrulanır (kesilmez). */
const BACKGROUND_PROBE_MS = 2_000;
const ROOT_BACK_EXIT_WINDOW_MS = 2_000;
const MOBILE_LAST_AGENT_KEY = 'orkestra:mobile:last-agent';
const QUICK_CHAT_PROVIDERS = [
  'antigravity',
  'claude',
  'codex',
  'kimi',
  'glm',
  'grok',
  'gemini',
] as const;

function newMobileUuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const EMPTY_PROJECTS: ProjectView[] = [];
const EMPTY_CONVERSATIONS: ConversationView[] = [];
const EMPTY_SESSIONS: Record<string, SessionSummaryView> = {};
const EMPTY_NAMES: Record<string, string> = {};
const EMPTY_ACCOUNTS: AccountView[] = [];
const EMPTY_HANDOFFS: Record<string, HandoffRecordView> = {};
const EMPTY_SUPERSEDED: Record<string, string> = {};
const EMPTY_NOTIFICATIONS: NotificationView[] = [];
const EMPTY_TASK_STATS: Record<string, TaskStatView> = {};

function useAllProjectTaskStats(
  api: RemoteApi,
  projects: readonly ProjectView[],
  connected: boolean
): Record<string, TaskStatView> {
  const [stats, setStats] = useState<Record<string, TaskStatView>>(EMPTY_TASK_STATS);

  const projectIdsKey = useMemo(
    () =>
      projects
        .filter((p) => !isFreeChatProjectId(p.id))
        .slice(0, 12)
        .map((p) => p.id)
        .sort()
        .join(','),
    [projects]
  );

  useEffect(() => {
    if (!connected || !projectIdsKey) return;
    const ids = projectIdsKey.split(',').filter(Boolean);
    const byProject = new Map<string, Record<string, TaskStatView>>();
    const subs: LiveSubscription<unknown>[] = [];
    let active = true;

    const emitMerged = () => {
      if (!active) return;
      const merged: Record<string, TaskStatView> = {};
      for (const map of byProject.values()) {
        Object.assign(merged, map);
      }
      setStats(merged);
    };

    for (const projectId of ids) {
      const sub = api.live<unknown>(topicOf(REMOTE_TOPICS.taskStats, { projectId }), (raw) => {
        byProject.set(projectId, mapTaskStats(raw));
        emitMerged();
      });
      sub.ready.catch(() => {});
      subs.push(sub);
    }

    return () => {
      active = false;
      for (const sub of subs) sub.dispose();
    };
  }, [api, connected, projectIdsKey]);

  return stats;
}

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
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else {
        const awayMs = hiddenAt !== null ? Date.now() - hiddenAt : BACKGROUND_PROBE_MS + 1;
        hiddenAt = null;
        if (awayMs > BACKGROUND_PROBE_MS) {
          session.verifyConnection();
        }
      }
    };
    const onOnline = (): void => {
      session.verifyConnection();
    };
    const onNativeResume = (): void => {
      session.verifyConnection();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('sovra:resume', onNativeResume);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('sovra:resume', onNativeResume);
    };
  }, [session]);

  if (state.phase === 'loading') {
    return (
      <div className="splash-boot">
        <div className="splash-boot-halo">
          <SovraMark size={54} />
        </div>
        <Loading label="Sovra hazırlanıyor…" />
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
    if (!hostKey) {
      setSessions(EMPTY_SESSIONS);
      return;
    }
    // Kısa 5G/Wi-Fi geçiş kopmalarında mevcut canlı oturum halkalarını silip titretme;
    // bağlantı geri gelince sessizce güncellensin.
    if (!connected) return;

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
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [hostSwitcherOpen, setHostSwitcherOpen] = useState(false);
  const [addingHost, setAddingHost] = useState(false);
  const [backExitPrompt, setBackExitPrompt] = useState(false);
  const lastRootBackAt = useRef(0);
  const childBackHandlerRef = useRef<(() => boolean) | null>(null);
  const registerChildBackHandler = useCallback((handler: (() => boolean) | null) => {
    childBackHandlerRef.current = handler;
  }, []);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(MOBILE_LAST_AGENT_KEY);
      if (
        stored &&
        QUICK_CHAT_PROVIDERS.includes(stored as (typeof QUICK_CHAT_PROVIDERS)[number])
      ) {
        return stored;
      }
    } catch {
      // yoksay
    }
    return 'antigravity';
  });
  const handleSelectAgent = useCallback((providerId: string) => {
    setSelectedAgentId(providerId);
    try {
      localStorage.setItem(MOBILE_LAST_AGENT_KEY, providerId);
    } catch {
      // yoksay
    }
  }, []);
  const [createSheet, setCreateSheet] = useState<{
    open: boolean;
    mode: CreateMode;
    projectId?: string;
  }>({ open: false, mode: 'task' });

  // Yeni bilgisayar eklendiğinde ekleme ekranını otomatik kapat.
  const activeHostIdRef = useRef(record.hostId);
  useEffect(() => {
    if (record.hostId !== activeHostIdRef.current) {
      activeHostIdRef.current = record.hostId;
      setAddingHost(false);
      setHostSwitcherOpen(false);
    }
  }, [record.hostId]);

  // Android native geri tuşu/hareketi: önce modal/çekmece, sonra aktif ekran modalı, sonra önceki ekran
  useEffect(() => {
    let toastTimer: ReturnType<typeof setTimeout> | null = null;
    window.__orkestraHandleBack = () => {
      if (closeTopOverlay()) return 'handled';
      if (addingHost) {
        setAddingHost(false);
        return 'handled';
      }
      if (hostSwitcherOpen) {
        setHostSwitcherOpen(false);
        return 'handled';
      }
      if (notificationsOpen) {
        setNotificationsOpen(false);
        return 'handled';
      }
      if (createSheet.open) {
        setCreateSheet((prev) => ({ ...prev, open: false }));
        return 'handled';
      }
      if (drawerOpen) {
        setDrawerOpen(false);
        return 'handled';
      }
      if (childBackHandlerRef.current?.()) {
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
  }, [addingHost, hostSwitcherOpen, notificationsOpen, createSheet.open, drawerOpen, goBack]);

  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const [cachedWb, setCachedWb] = useState<CachedWorkbench | null>(() =>
    getCachedWorkbenchSync(record.hostId)
  );
  useEffect(() => {
    let active = true;
    const sync = getCachedWorkbenchSync(record.hostId);
    setCachedWb(sync);
    void loadCachedWorkbench(record.hostId).then((loaded) => {
      if (active && loaded) setCachedWb(loaded);
    });
    return () => {
      active = false;
    };
  }, [record.hostId]);

  const projects = useLive(api, REMOTE_TOPICS.projects, mapProjects);
  const projectList = projects.data ?? cachedWb?.projects ?? EMPTY_PROJECTS;
  const sessions = useAllHostSessions(api, projectList, status.kind === 'connected');
  const liveTaskStats = useAllProjectTaskStats(api, projectList, status.kind === 'connected');
  const taskStats =
    Object.keys(liveTaskStats).length > 0
      ? liveTaskStats
      : (cachedWb?.taskStats ?? EMPTY_TASK_STATS);
  const accounts = useLive(api, topicOf(REMOTE_TOPICS.authList, { host: LOCAL_HOST }), mapAccounts);
  const notificationsLive = useLive(api, REMOTE_TOPICS.notificationsList, mapNotifications);
  const notificationList = notificationsLive.data ?? EMPTY_NOTIFICATIONS;
  const unreadNotificationCount = useMemo(
    () => notificationList.reduce((sum, n) => sum + (n.readAt === null ? 1 : 0), 0),
    [notificationList]
  );
  const allConversations = useQuery<ConversationView[]>(
    manager,
    async () =>
      mapConversations(unwrapResult(await api.call('conversations.getConversations', undefined))),
    'all-conversations',
    8_000
  );
  const agentMeta = useQuery<Record<string, string>>(
    manager,
    async () => mapAgentNames(unwrapResult(await api.call('agents.listMetadata', undefined))),
    'agent-metadata',
    0
  );
  const handoffQuery = useQuery<{
    records: Record<string, HandoffRecordView>;
    superseded: Record<string, string>;
  }>(
    manager,
    async () => {
      const raw = unwrapResult(await api.call('conversations.handoff.listAll', undefined));
      return {
        records: mapHandoffList(raw),
        superseded: mapHandoffSuperseded(raw),
      };
    },
    'handoff-list',
    15_000
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

  // Canlı sohbet olayları: yeni sohbet veya otomatik başlık değişince anında yenile
  useEffect(() => {
    if (status.kind !== 'connected') return;
    const sub = api.live<unknown>(REMOTE_TOPICS.conversationEvents, (_val, meta) => {
      if (!meta.seed) {
        allConversations.reload();
      }
    });
    sub.ready.catch(() => {});
    return () => sub.dispose();
  }, [api, status.kind, allConversations]);

  // Arka plan ajan bildirimleri: tercih ya da eşleşmiş bilgisayar listesi değişince yerel servisi
  // yapılandır (kapalıyken servise sır gönderilmez ve servis kendi kopyasını siler).
  const agentNotifyPrefs = useSyncExternalStore(
    agentNotificationPrefs.subscribe,
    agentNotificationPrefs.get,
    agentNotificationPrefs.get
  );
  const agentNotifySyncRef = useRef<AgentNotificationSync | null>(null);
  useEffect(() => {
    if (!isAgentNotificationBridgeAvailable()) return;
    agentNotifySyncRef.current ??= new AgentNotificationSync((json) => {
      configureAgentNotifications(json);
    });
    agentNotifySyncRef.current.sync(agentNotifyPrefs, state.hosts);
  }, [agentNotifyPrefs, state.hosts]);
  const nativeAgentAlerts = agentNotifyPrefs.enabled && isAgentNotificationBridgeAvailable();

  // Ön planda açık sohbet: yerel servis o sohbetin uyarısını göstermez.
  useEffect(() => {
    setVisibleConversation(
      route.name === 'chat' ? { hostId: record.hostId, conversationId: route.conversationId } : null
    );
  }, [route, record.hostId]);

  // Ajan bildirimine dokunma: gerekirse o bilgisayara geç, sonra sohbeti aç.
  const [launchTarget, setLaunchTarget] = useState<AgentNotificationTarget | null>(null);
  useEffect(() => {
    const take = (): void => {
      const target = parseLaunchTarget(consumeLaunchTarget());
      if (target) setLaunchTarget(target);
    };
    take();
    window.addEventListener('sovra:open-conversation', take);
    return () => window.removeEventListener('sovra:open-conversation', take);
  }, []);
  useEffect(() => {
    if (!launchTarget) return;
    if (launchTarget.hostId !== record.hostId) {
      if (state.hosts.some((host) => host.hostId === launchTarget.hostId)) {
        void session.switchHost(launchTarget.hostId);
      } else {
        setLaunchTarget(null);
      }
      return;
    }
    const conversation = (allConversations.data ?? []).find(
      (item) => item.id === launchTarget.conversationId
    );
    if (!conversation) {
      // Liste yüklendi ama sohbet yok (silinmiş/terminal oturumu): hedefi bırak.
      if (allConversations.data && !allConversations.loading) setLaunchTarget(null);
      return;
    }
    setLaunchTarget(null);
    setDrawerOpen(false);
    setNotificationsOpen(false);
    if (!conversation.chatCapable) return;
    push({
      name: 'chat',
      conversationId: conversation.id,
      title: conversation.title,
      providerId: conversation.providerId,
      projectId: conversation.projectId,
      projectName: projectList.find((p) => p.id === conversation.projectId)?.name,
      taskId: conversation.taskId,
    });
  }, [
    launchTarget,
    record.hostId,
    state.hosts,
    session,
    allConversations.data,
    allConversations.loading,
    projectList,
    push,
  ]);

  // Yeni gelen bildirimlerde Android sistem bildirimi ve titreşim ver
  const seenNotifIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (seenNotifIdsRef.current === null) {
      if (notificationList.length > 0 || !notificationsLive.loading) {
        seenNotifIdsRef.current = new Set(notificationList.map((n) => n.id));
      }
      return;
    }
    for (const item of notificationList) {
      if (seenNotifIdsRef.current.has(item.id)) continue;
      seenNotifIdsRef.current.add(item.id);
      if (item.readAt === null) {
        const urgent = /onay|izin|permission|hata|error/i.test(`${item.kind} ${item.title}`);
        triggerHaptic(urgent ? 'warning' : 'light');
        // Arka plan ajan bildirimleri açıksa ajan uyarılarını yerel servis (ayrı kanallar, sohbete
        // dokunarak geçiş) gösterir; burada ikinci kez gösterilmez.
        if (nativeAgentAlerts && item.kind.startsWith('agent-')) continue;
        showNativeNotification(item.title, item.body || `${record.hostName || 'Sovra'} bildirimi`, {
          urgent,
        });
      }
    }
  }, [notificationList, notificationsLive.loading, record.hostName, nativeAgentAlerts]);

  // Yapay zeka limitlerini tüm çekirdek sağlayıcılar + bağlı hesaplar için canlı sorgula
  const [usage, setUsage] = useState<Record<string, ProviderUsageView>>(
    () => cachedWb?.usage ?? {}
  );
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageTick, setUsageTick] = useState(0);

  const accountList = accounts.data ?? cachedWb?.accounts ?? EMPTY_ACCOUNTS;
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
          const mapped = Object.fromEntries(
            mapUsage(data).map((entry) => [entry.providerId, entry])
          );
          setUsage(mapped);
          saveCachedWorkbench(record.hostId, { usage: mapped });
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
  }, [api, record.hostId, status.kind, usageProviderKey, usageTick]);

  const conversations = allConversations.data ?? cachedWb?.conversations ?? EMPTY_CONVERSATIONS;
  const agentNames = agentMeta.data ?? cachedWb?.agentNames ?? EMPTY_NAMES;
  const handoffs = handoffQuery.data?.records ?? EMPTY_HANDOFFS;
  const superseded = handoffQuery.data?.superseded ?? EMPTY_SUPERSEDED;

  // Canlı verileri WhatsApp misali yerel önbelleğe sessizce yaz (sonraki açılış 0 ms!)
  useEffect(() => {
    if (projects.data) saveCachedWorkbench(record.hostId, { projects: projects.data });
  }, [record.hostId, projects.data]);
  useEffect(() => {
    if (allConversations.data) {
      saveCachedWorkbench(record.hostId, { conversations: allConversations.data });
    }
  }, [record.hostId, allConversations.data]);
  useEffect(() => {
    if (agentMeta.data) saveCachedWorkbench(record.hostId, { agentNames: agentMeta.data });
  }, [record.hostId, agentMeta.data]);
  useEffect(() => {
    if (accounts.data) saveCachedWorkbench(record.hostId, { accounts: accounts.data });
  }, [record.hostId, accounts.data]);
  useEffect(() => {
    if (Object.keys(liveTaskStats).length > 0) {
      saveCachedWorkbench(record.hostId, { taskStats: liveTaskStats });
    }
  }, [record.hostId, liveTaskStats]);

  // Arka planda en son 5 sohbetin geçmişini sessizce ısıt (tıklayınca anında açılsın!)
  const prefetchedKeyRef = useRef('');
  useEffect(() => {
    if (status.kind !== 'connected' || !allConversations.data) return;
    const topIds = allConversations.data
      .filter((c) => c.chatCapable)
      .slice(0, 5)
      .map((c) => c.id);
    const sig = `${record.hostId}:${topIds.join(',')}`;
    if (!topIds.length || sig === prefetchedKeyRef.current) return;
    prefetchedKeyRef.current = sig;

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        for (const id of topIds) {
          if (cancelled) break;
          try {
            const raw = unwrapResult(
              await api.call('conversations.acp.loadHistory', { conversationId: id, limit: 30 })
            );
            if (cancelled) break;
            const page = mapHistoryPage(raw);
            const store = new TranscriptStore();
            store.applyPage(page, true);
            const entries = store.entries();
            if (entries.length > 0) {
              saveCachedChat(record.hostId, id, { entries, hasOlder: store.hasOlder });
            }
          } catch {
            // Oturum henüz bağlı değilse sessizce geç; açılınca canlı yüklenir.
          }
        }
      })();
    }, 1200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, record.hostId, status.kind, allConversations.data]);

  const openCreate = useCallback((mode: CreateMode, projectId?: string) => {
    setCreateSheet({ open: true, mode, projectId });
  }, []);

  const quickCreateInFlight = useRef(false);
  const quickStartChat = useCallback(
    async (preferredProjectId?: string, preferredProviderId?: string) => {
      if (quickCreateInFlight.current) return;
      const project =
        (preferredProjectId ? projectList.find((p) => p.id === preferredProjectId) : undefined) ??
        projectList.find((p) => conversations.some((c) => c.projectId === p.id)) ??
        projectList[0];

      if (!project) {
        openCreate('project');
        return;
      }

      const providerId =
        preferredProviderId ??
        selectedAgentId ??
        conversations.find((c) => c.chatCapable && c.providerId)?.providerId ??
        QUICK_CHAT_PROVIDERS.find((id) => Boolean(agentNames[id])) ??
        'antigravity';

      // Aynı proje + aynı ajanla açılmış boş bir "Yeni sohbet" varsa gereksiz worktree yaratma.
      const untouched = conversations.find(
        (c) =>
          c.projectId === project.id &&
          c.providerId === providerId &&
          c.chatCapable &&
          !c.hasSession &&
          /^yeni\s+sohbet(?:\s*\(\d+\))?$/i.test(c.title.trim())
      );
      if (untouched) {
        push({
          name: 'chat',
          conversationId: untouched.id,
          title: untouched.title,
          providerId: untouched.providerId,
          projectId: project.id,
          projectName: project.name,
          taskId: untouched.taskId,
          taskName: untouched.title,
          workspaceId: project.repositoryWorkspaceId ?? undefined,
        });
        return;
      }

      quickCreateInFlight.current = true;
      const taskId = newMobileUuid();
      const conversationId = newMobileUuid();
      try {
        unwrapResult(
          await api.call('tasks.createTask', {
            id: taskId,
            projectId: project.id,
            taskConfig: {
              version: '1',
              name: 'Yeni sohbet',
              initialConversation: {
                id: conversationId,
                provider: providerId,
                title: 'Yeni sohbet',
                type: 'acp',
              },
            },
            workspaceConfig: {
              version: '2',
              git: { kind: 'none' },
              workspace: project.repositoryWorkspaceId
                ? { kind: 'repository-instance', workspaceId: project.repositoryWorkspaceId }
                : { kind: 'new-worktree' },
            },
          })
        );
        handleSelectAgent(providerId);
        allConversations.reload();
        push({
          name: 'chat',
          conversationId,
          title: 'Yeni sohbet',
          providerId,
          projectId: project.id,
          projectName: project.name,
          taskId,
          taskName: 'Yeni sohbet',
          workspaceId: project.repositoryWorkspaceId ?? undefined,
        });
      } catch {
        openCreate('task', project.id);
      } finally {
        quickCreateInFlight.current = false;
      }
    },
    [
      api,
      projectList,
      conversations,
      agentNames,
      selectedAgentId,
      handleSelectAgent,
      allConversations,
      openCreate,
      push,
    ]
  );

  const startFreeChat = useCallback(
    async (preferredProviderId?: string) => {
      if (quickCreateInFlight.current) return;
      const providerId = preferredProviderId ?? selectedAgentId ?? 'antigravity';
      quickCreateInFlight.current = true;
      try {
        let freeProject: { id: string; repositoryWorkspaceId?: string | null } | null = null;
        try {
          const ensured = unwrapResult(
            await api.call('projects.ensureFreeChatProject', undefined)
          ) as { id?: string; repositoryWorkspaceId?: string | null } | null;
          if (ensured?.id) {
            freeProject = {
              id: ensured.id,
              repositoryWorkspaceId: ensured.repositoryWorkspaceId ?? null,
            };
          }
        } catch {
          // Eski masaüstü sürümüyse listedeki serbest sohbet projesine düş.
          const existing = projectList.find((p) => p.id === FREE_CHAT_PROJECT_ID);
          if (existing) {
            freeProject = {
              id: existing.id,
              repositoryWorkspaceId: existing.repositoryWorkspaceId,
            };
          }
        }

        if (!freeProject) {
          // Hiç serbest sohbet projesi yoksa ilk uygun projede başlat.
          quickCreateInFlight.current = false;
          await quickStartChat(undefined, providerId);
          return;
        }

        const untouched = conversations.find(
          (c) =>
            c.projectId === freeProject!.id &&
            c.providerId === providerId &&
            c.chatCapable &&
            !c.hasSession &&
            /^yeni\s+sohbet(?:\s*\(\d+\))?$/i.test(c.title.trim())
        );
        if (untouched) {
          push({
            name: 'chat',
            conversationId: untouched.id,
            title: untouched.title,
            providerId: untouched.providerId,
            projectId: freeProject.id,
            taskId: untouched.taskId,
            taskName: untouched.title,
            workspaceId: freeProject.repositoryWorkspaceId ?? undefined,
          });
          return;
        }

        const taskId = newMobileUuid();
        const conversationId = newMobileUuid();
        unwrapResult(
          await api.call('tasks.createTask', {
            id: taskId,
            projectId: freeProject.id,
            taskConfig: {
              version: '1',
              name: 'Yeni sohbet',
              initialConversation: {
                id: conversationId,
                provider: providerId,
                title: 'Yeni sohbet',
                type: 'acp',
              },
            },
            workspaceConfig: {
              version: '2',
              git: { kind: 'none' },
              workspace: freeProject.repositoryWorkspaceId
                ? { kind: 'repository-instance', workspaceId: freeProject.repositoryWorkspaceId }
                : { kind: 'new-worktree' },
            },
          })
        );
        handleSelectAgent(providerId);
        allConversations.reload();
        push({
          name: 'chat',
          conversationId,
          title: 'Yeni sohbet',
          providerId,
          projectId: freeProject.id,
          taskId,
          taskName: 'Yeni sohbet',
          workspaceId: freeProject.repositoryWorkspaceId ?? undefined,
        });
      } catch {
        openCreate('task');
      } finally {
        quickCreateInFlight.current = false;
      }
    },
    [
      api,
      projectList,
      conversations,
      selectedAgentId,
      handleSelectAgent,
      allConversations,
      openCreate,
      push,
      quickStartChat,
    ]
  );

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
          workspaceId: task.workspaceId ?? undefined,
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

  const activeChatRoute = useMemo(() => {
    if (route.name !== 'chat') return null;
    const conv = conversations.find((c) => c.id === route.conversationId);
    const projectId = route.projectId ?? conv?.projectId;
    const taskId = route.taskId ?? conv?.taskId;
    const project = projectId ? projectList.find((p) => p.id === projectId) : undefined;
    const projectName = route.projectName ?? project?.name;
    const workspaceId = route.workspaceId ?? project?.repositoryWorkspaceId ?? undefined;
    const liveTitle = conv?.title && conv.title.trim() !== '' ? conv.title : route.title;
    return {
      ...route,
      title: liveTitle,
      projectId,
      projectName,
      taskId,
      workspaceId,
    };
  }, [route, conversations, projectList]);

  const activeHostName = (record.hostName || 'Bilgisayar').replace(/\.local$/i, '');

  const pendingPermissionItems = useMemo(() => {
    const active = buildActiveWorkList(conversations, sessions);
    return active.filter(
      (item) =>
        item.awaitingInput &&
        item.chatCapable &&
        (route.name !== 'chat' || route.conversationId !== item.conversationId)
    );
  }, [conversations, sessions, route]);

  const lowQuotaAlert = useMemo(() => {
    return CORE_USAGE_PROVIDERS.some((id) => {
      const rem = primaryRemainingPercent(usage[id]);
      return rem !== null && rem <= 15;
    });
  }, [usage]);

  const refreshAllData = useCallback(() => {
    allConversations.reload();
    handoffQuery.reload();
    setUsageTick((v) => v + 1);
  }, [allConversations, handoffQuery]);

  const handleOpenNotification = useCallback(
    (item: NotificationView) => {
      if (item.readAt === null) {
        void api
          .call('notifications.feed.markRead', { ids: [item.id], at: Date.now() })
          .catch(() => {});
      }
      setNotificationsOpen(false);
      const target = item.target;
      if (target.kind !== 'task') return;
      const project = projectList.find((p) => p.id === target.projectId);
      if (target.conversationId) {
        const conv = conversations.find((c) => c.id === target.conversationId);
        if (conv && conv.chatCapable) {
          push({
            name: 'chat',
            conversationId: conv.id,
            title: conv.title,
            providerId: conv.providerId,
            projectId: conv.projectId,
            projectName: project?.name,
            taskId: conv.taskId,
          });
          return;
        }
      }
      const taskConvs = conversations.filter((c) => c.taskId === target.taskId && c.chatCapable);
      if (taskConvs.length > 0) {
        const preferred = taskConvs[0]!;
        push({
          name: 'chat',
          conversationId: preferred.id,
          title: preferred.title,
          providerId: preferred.providerId,
          projectId: preferred.projectId,
          projectName: project?.name,
          taskId: preferred.taskId,
        });
      } else if (project) {
        push({
          name: 'tasks',
          projectId: project.id,
          projectName: project.name,
        });
      }
    },
    [api, projectList, conversations, push]
  );

  const handleMarkAllNotificationsRead = useCallback(() => {
    void api.call('notifications.feed.markAllRead', { at: Date.now() }).catch(() => {});
  }, [api]);

  const handleDismissNotification = useCallback(
    (id: string) => {
      void api.call('notifications.feed.dismiss', { ids: [id] }).catch(() => {});
    },
    [api]
  );

  const siblingConversations = useMemo(() => {
    if (!activeChatRoute?.taskId) return [];
    return conversations.filter(
      (c) =>
        c.taskId === activeChatRoute.taskId &&
        (c.id === activeChatRoute.conversationId || !superseded[c.id])
    );
  }, [activeChatRoute, conversations, superseded]);

  const refreshHandoffsAndConversations = useCallback(() => {
    handoffQuery.reload();
    allConversations.reload();
  }, [handoffQuery, allConversations]);

  const showDock =
    route.name === 'home' ||
    route.name === 'projects' ||
    route.name === 'accounts' ||
    route.name === 'settings';

  const firstPermItem = pendingPermissionItems[0];

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
      {firstPermItem ? (
        <GlobalPermissionBanner
          count={pendingPermissionItems.length}
          title={firstPermItem.title}
          onOpen={() => {
            triggerHaptic('medium');
            const proj = firstPermItem.projectId
              ? projectList.find((p) => p.id === firstPermItem.projectId)
              : undefined;
            push({
              name: 'chat',
              conversationId: firstPermItem.conversationId,
              title: firstPermItem.title,
              providerId: firstPermItem.providerId,
              projectId: firstPermItem.projectId,
              projectName: proj?.name,
              taskId: firstPermItem.taskId,
              workspaceId: proj?.repositoryWorkspaceId ?? undefined,
            });
          }}
        />
      ) : null}
      <div className="content">
        {route.name === 'home' ? (
          <HomeScreen
            projects={projectList}
            projectsLoading={projects.loading && projectList.length === 0}
            projectsError={projects.error}
            conversations={conversations}
            conversationsLoading={allConversations.loading && conversations.length === 0}
            sessions={sessions}
            taskStats={taskStats}
            usage={usage}
            agentNames={agentNames}
            hostName={activeHostName}
            hostCount={state.hosts.length}
            status={status}
            unreadNotificationCount={unreadNotificationCount}
            selectedAgentId={selectedAgentId}
            onSelectAgent={handleSelectAgent}
            onOpenHostSwitcher={() => setHostSwitcherOpen(true)}
            onRefreshAll={refreshAllData}
            onOpenNotifications={() => setNotificationsOpen(true)}
            onOpenMenu={() => setDrawerOpen(true)}
            onOpenCreate={openCreate}
            onStartFreeChat={(providerId) => void startFreeChat(providerId)}
            onQuickStartChat={(projectId, providerId) => void quickStartChat(projectId, providerId)}
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
            onQuickStartChat={(projectId) => void quickStartChat(projectId)}
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
            onQuickStartChat={(projectId) => void quickStartChat(projectId)}
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

        {activeChatRoute ? (
          <ChatScreen
            api={api}
            hostId={record.hostId}
            conversationId={activeChatRoute.conversationId}
            title={activeChatRoute.title}
            providerId={activeChatRoute.providerId}
            projectId={activeChatRoute.projectId}
            projectName={activeChatRoute.projectName}
            taskId={activeChatRoute.taskId}
            taskName={activeChatRoute.taskName}
            workspaceId={activeChatRoute.workspaceId}
            siblingConversations={siblingConversations}
            agentNames={agentNames}
            accounts={accountList}
            providerUsage={usage}
            usageLoading={usageLoading}
            hostName={activeHostName}
            handoffs={handoffs}
            handoffRecord={handoffs[activeChatRoute.conversationId]}
            onRefreshHandoffs={refreshHandoffsAndConversations}
            onRefreshUsage={() => setUsageTick((v) => v + 1)}
            onRegisterBackHandler={registerChildBackHandler}
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
            hostName={activeHostName}
            onRefreshUsage={() => setUsageTick((v) => v + 1)}
            onOpenMenu={() => setDrawerOpen(true)}
          />
        ) : null}

        {route.name === 'settings' ? (
          <SettingsScreen
            session={session}
            record={record}
            hosts={state.hosts}
            manager={manager}
            onAddHost={() => setAddingHost(true)}
            onOpenMenu={() => setDrawerOpen(true)}
          />
        ) : null}
      </div>

      {addingHost ? (
        <div className="add-host-overlay">
          <PairingScreen
            session={session}
            onCancel={() => setAddingHost(false)}
            onPaired={() => setAddingHost(false)}
          />
        </div>
      ) : null}

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
            onClick={() => {
              triggerHaptic('light');
              push({ name: 'home' });
            }}
          >
            <span className="dock-icon-wrap">
              <HomeIcon size={20} />
              {pendingPermissionItems.length > 0 ? <span className="dock-dot is-warn" /> : null}
            </span>
            <span>Ana ekran</span>
          </button>
          <button
            type="button"
            className={`dock-item ${route.name === 'projects' ? 'is-active' : ''}`}
            onClick={() => {
              triggerHaptic('light');
              push({ name: 'projects' });
            }}
          >
            <FolderIcon size={20} />
            <span>Projeler</span>
          </button>
          <button
            type="button"
            className="dock-fab"
            onClick={() => {
              triggerHaptic('medium');
              if (route.name === 'projects') openCreate('project');
              else void startFreeChat(selectedAgentId);
            }}
            aria-label={route.name === 'projects' ? 'Yeni proje başlat' : 'Serbest sohbet başlat'}
          >
            <PlusIcon size={22} />
          </button>
          <button
            type="button"
            className={`dock-item ${route.name === 'accounts' ? 'is-active' : ''}`}
            onClick={() => {
              triggerHaptic('light');
              push({ name: 'accounts' });
            }}
          >
            <span className="dock-icon-wrap">
              <GaugeIcon size={20} />
              {lowQuotaAlert ? <span className="dock-dot is-danger" /> : null}
            </span>
            <span>Limitler</span>
          </button>
          <button
            type="button"
            className={`dock-item ${route.name === 'settings' ? 'is-active' : ''}`}
            onClick={() => {
              triggerHaptic('light');
              push({ name: 'settings' });
            }}
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
        hostName={activeHostName}
        status={status}
        projects={projectList}
        conversations={conversations}
        sessions={sessions}
        agentNames={agentNames}
        route={route}
        onNavigate={handleDrawerNavigate}
        onOpenTask={openTaskDirectly}
        onOpenHostSwitcher={() => setHostSwitcherOpen(true)}
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

      <NotificationsSheet
        open={notificationsOpen}
        hostName={activeHostName}
        notifications={notificationList}
        onOpenNotification={handleOpenNotification}
        onMarkAllRead={handleMarkAllNotificationsRead}
        onDismiss={handleDismissNotification}
        onClose={() => setNotificationsOpen(false)}
      />

      <QuickHostSheet
        open={hostSwitcherOpen}
        session={session}
        activeRecord={record}
        hosts={state.hosts}
        status={status}
        onAddHost={() => setAddingHost(true)}
        onClose={() => setHostSwitcherOpen(false)}
      />
    </div>
  );
}
