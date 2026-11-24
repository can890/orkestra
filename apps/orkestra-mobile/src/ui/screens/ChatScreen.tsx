import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { extractArtifactsFromText, uniqueArtifacts, type MediaArtifact } from '@/core/artifacts';
import {
  MAX_PROMPT_CHARS,
  openConversation,
  type ConversationHandle,
  type PromptPlacement,
} from '@/core/conversation-session';
import { getCachedChatSync, saveCachedChat } from '@/core/local-cache';
import {
  buildMobileHandoffContext,
  formatTranscriptMarkdown,
  mapSessionAgents,
  mapSessionConfig,
  mapSessionPlan,
  mapSessionUsage,
  mapTasks,
  type AccountView,
  type AgentActivityView,
  type ArtifactView,
  type ConversationView,
  type HandoffRecordView,
  type PermissionView,
  type PlanEntryView,
  type ProviderUsageView,
  type SessionConfigView,
  type SessionUsageView,
  type SubagentView,
  type TaskView,
  type ToolDiffPreview,
  type TranscriptEntry,
} from '@/core/mappers';
import { triggerHaptic } from '@/core/native-bridge';
import {
  REMOTE_TOPICS,
  describeCallError,
  topicOf,
  unwrapResult,
  type RemoteApi,
} from '@/core/wire-client';
import {
  ErrorNote,
  Loading,
  WorkbenchHeader,
  formatTokens,
  providerDisplayName,
} from '../components';
import { useLive } from '../hooks';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  FileCodeIcon,
  GaugeIcon,
  GitBranchIcon,
  GlobeIcon,
  ListChecksIcon,
  MicIcon,
  PaperclipIcon,
  PlusIcon,
  RefreshIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldAlertIcon,
  SlashIcon,
  SparklesIcon,
  SquareStopIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from '../icons';
import { MarkdownView } from '../MarkdownView';
import { MediaArtifactStrip } from '../MediaPreview';
import { MobileDiffSheet } from '../MobileDiffSheet';
import { ModelPickerSheet, type ConfigOptionKey } from '../ModelPickerSheet';
import {
  CORE_USAGE_PROVIDERS,
  ProviderAvatar,
  QuotaRing,
  formatResetCountdown,
  primaryRemainingPercent,
  quotaTone,
} from '../ProviderBrand';
import type { Route } from '../router';

type ActiveModal = 'subagents' | 'config' | 'handoff' | 'quota' | 'diff' | 'add-tab' | null;

const SLASH_COMMANDS: readonly { cmd: string; label: string; text: string }[] = [
  {
    cmd: '/plan',
    label: 'Önce adım adım plan çıkar',
    text: 'Önce uygulama adımlarını kısa ve net bir plan olarak çıkar, sonra başla: ',
  },
  {
    cmd: '/ozet',
    label: 'Mevcut durumu özetle',
    text: 'Şu ana kadar yapılanları ve kalan adımları maddeler halinde kısaca özetle.',
  },
  {
    cmd: '/diff',
    label: 'Son değişiklikleri incele',
    text: 'Çalışma alanındaki son kod değişikliklerini incele, olası hata veya eksikleri belirt.',
  },
  {
    cmd: '/test',
    label: 'Test ve tip denetimi çalıştır',
    text: 'İlgili testleri ve tip/lint kontrollerini çalıştır, sonucu raporla.',
  },
  {
    cmd: '/hata',
    label: 'Kök nedeni bul ve düzelt',
    text: 'Bu hatanın kök nedenini bul, en temiz düzeltmeyi uygula ve doğrula: ',
  },
  {
    cmd: '/devam',
    label: 'Kaldığın yerden devam et',
    text: 'Kaldığın yerden devam et ve işi tamamla.',
  },
];

const EMPTY_STARTERS: readonly { label: string; prompt: string }[] = [
  { label: 'Kod tabanını incele', prompt: 'Bu projenin yapısını ve aktif durumunu kısaca özetle.' },
  { label: 'Değişiklikleri gözden geçir', prompt: 'Çalışma alanındaki son değişiklikleri kontrol et ve özetle.' },
  { label: 'Testleri çalıştır', prompt: 'Projedeki test ve tip kontrollerini çalıştırıp sonucu bildir.' },
  { label: 'Hata ayıkla', prompt: 'Son karşılaşılan hatayı inceleyip kök nedenini bulalım: ' },
];

type SpeechRecInstance = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecInstance) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecInstance;
    webkitSpeechRecognition?: new () => SpeechRecInstance;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function formatMessageTime(epochMs?: number): string | null {
  if (!epochMs || !Number.isFinite(epochMs)) return null;
  try {
    return new Date(epochMs).toLocaleTimeString('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

function formatDurationShort(durationMs?: number): string | null {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs < 500) return null;
  const sec = Math.round(durationMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min}dk ${rem}s` : `${min}dk`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTINUE_HANDOFF_PROMPT =
  'Önceki sohbette yarım kalan işe kaldığın yerden devam et; önce durumu kısaca özetle.';

function newUuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function formatEffortLabel(effort: string | null): string | null {
  if (!effort) return null;
  switch (effort.trim().toLowerCase()) {
    case 'low':
      return 'Düşük';
    case 'medium':
      return 'Orta';
    case 'high':
      return 'Yüksek';
    case 'xhigh':
      return 'Çok yüksek';
    case 'max':
    case 'ultra':
      return 'En yüksek';
    default:
      return effort;
  }
}

function formatElapsed(startedAt: number, completedAt: number | null, now: number): string {
  if (!startedAt) return '0s';
  const end = completedAt ?? now;
  const totalSec = Math.max(0, Math.floor((end - startedAt) / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `${secs}s`;
}

function formatActivityTime(timestamp: number | null): string | null {
  if (!timestamp) return null;
  try {
    return new Date(timestamp).toLocaleTimeString('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return null;
  }
}

function defaultHandoffTitle(sourceTitle: string, mode: 'handoff' | 'fork'): string {
  const suffix = mode === 'fork' ? ' (çatal)' : ' (devir)';
  const base = sourceTitle.trim() || 'Sohbet';
  return base.slice(0, Math.max(0, 200 - suffix.length)) + suffix;
}

function describeHandoffLineage(record: HandoffRecordView): string {
  const verb = record.mode === 'fork' ? 'çatallandı' : 'devredildi';
  return `"${record.sourceTitle}" sohbetinden ${verb}`;
}

function toStrictPutRecord(record: HandoffRecordView, contextDelivered: boolean) {
  return {
    version: 1 as const,
    mode: record.mode,
    sourceConversationId: record.sourceConversationId,
    sourceTitle: record.sourceTitle.slice(0, 300) || 'Sohbet',
    ...(record.sourceItemId ? { sourceItemId: record.sourceItemId } : {}),
    context: record.context.slice(0, 50_000),
    contextDelivered,
    createdAt: record.createdAt,
    ...(record.targetEffort ? { targetEffort: record.targetEffort } : {}),
    ...(record.chain.length > 0 ? { chain: record.chain.slice(0, 32) } : {}),
  };
}

function LayersIcon(props: { size?: number }) {
  const size = props.size ?? 14;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.85}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
      <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
    </svg>
  );
}

function SlidersIcon(props: { size?: number }) {
  const size = props.size ?? 13;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.85}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="21" x2="14" y1="4" y2="4" />
      <line x1="10" x2="3" y1="4" y2="4" />
      <line x1="21" x2="12" y1="12" y2="12" />
      <line x1="8" x2="3" y1="12" y2="12" />
      <line x1="21" x2="16" y1="20" y2="20" />
      <line x1="12" x2="3" y1="20" y2="20" />
      <line x1="14" x2="14" y1="2" y2="6" />
      <line x1="8" x2="8" y1="10" y2="14" />
      <line x1="16" x2="16" y1="18" y2="22" />
    </svg>
  );
}

export function ChatScreen(props: {
  api: RemoteApi;
  hostId?: string;
  conversationId: string;
  title: string;
  providerId: string;
  projectId?: string;
  projectName?: string;
  taskId?: string;
  taskName?: string;
  workspaceId?: string;
  siblingConversations: ConversationView[];
  agentNames: Record<string, string>;
  accounts: AccountView[];
  providerUsage: Record<string, ProviderUsageView>;
  usageLoading?: boolean;
  hostName?: string;
  handoffs?: Record<string, HandoffRecordView>;
  handoffRecord?: HandoffRecordView;
  onRefreshHandoffs?: () => void;
  onRefreshUsage?: () => void;
  onRegisterBackHandler?: (handler: (() => boolean) | null) => void;
  onOpenMenu: () => void;
  onSwitchConversation: (route: Route) => void;
  back: () => void;
}) {
  const [handle, setHandle] = useState<ConversationHandle | null>(null);
  useEffect(() => {
    const opened = openConversation(props.api, props.conversationId, { hostId: props.hostId });
    setHandle(opened);
    return () => {
      opened.dispose();
      setHandle(null);
    };
  }, [props.api, props.conversationId, props.hostId]);

  const config = useLive<SessionConfigView>(
    props.api,
    topicOf(REMOTE_TOPICS.sessionConfig, { conversationId: props.conversationId }),
    mapSessionConfig
  );
  useEffect(() => {
    if (props.hostId && config.data) {
      saveCachedChat(props.hostId, props.conversationId, { config: config.data });
    }
  }, [props.hostId, props.conversationId, config.data]);
  const cachedConfig = props.hostId
    ? getCachedChatSync(props.hostId, props.conversationId)?.config ?? null
    : null;
  const effectiveConfig = config.data ?? cachedConfig;
  const usage = useLive<SessionUsageView | null>(
    props.api,
    topicOf(REMOTE_TOPICS.sessionUsage, { conversationId: props.conversationId }),
    mapSessionUsage
  );
  const plan = useLive<PlanEntryView[]>(
    props.api,
    topicOf(REMOTE_TOPICS.sessionPlan, { conversationId: props.conversationId }),
    mapSessionPlan
  );
  const agents = useLive<SubagentView[]>(
    props.api,
    topicOf(REMOTE_TOPICS.sessionAgents, { conversationId: props.conversationId }),
    mapSessionAgents
  );
  const projectTasks = useLive<TaskView[]>(
    props.api,
    !props.workspaceId && props.projectId && props.taskId
      ? topicOf(REMOTE_TOPICS.tasks, { projectId: props.projectId })
      : null,
    (data) => mapTasks(data, props.projectId ?? '')
  );
  const resolvedWorkspaceId =
    props.workspaceId ??
    (props.taskId ? projectTasks.data?.find((t) => t.id === props.taskId)?.workspaceId : null) ??
    undefined;

  const providerLabel = providerDisplayName(props.providerId, props.agentNames);

  if (!handle) {
    return (
      <main className="screen chat-screen">
        <WorkbenchHeader
          title={props.title}
          subtitle={props.projectName ? `${props.projectName} · ${providerLabel}` : providerLabel}
          onBack={props.back}
        />
        <div className="chat-loading-wrap">
          <Loading label="Oturum açılıyor…" />
        </div>
      </main>
    );
  }

  return (
    <ChatView
      api={props.api}
      handle={handle}
      conversationId={props.conversationId}
      title={props.title}
      providerId={props.providerId}
      providerLabel={providerLabel}
      projectId={props.projectId}
      projectName={props.projectName}
      taskId={props.taskId}
      taskName={props.taskName}
      workspaceId={resolvedWorkspaceId}
      siblingConversations={props.siblingConversations}
      agentNames={props.agentNames}
      accounts={props.accounts}
      providerUsage={props.providerUsage}
      usageLoading={props.usageLoading}
      hostName={props.hostName}
      handoffs={props.handoffs}
      handoffRecord={props.handoffRecord}
      config={effectiveConfig}
      usage={usage.data}
      plan={plan.data ?? []}
      agents={agents.data ?? []}
      onRefreshHandoffs={props.onRefreshHandoffs}
      onRefreshUsage={props.onRefreshUsage}
      onRegisterBackHandler={props.onRegisterBackHandler}
      onOpenMenu={props.onOpenMenu}
      onSwitchConversation={props.onSwitchConversation}
      back={props.back}
    />
  );
}

function ChatView(props: {
  api: RemoteApi;
  handle: ConversationHandle;
  conversationId: string;
  title: string;
  providerId: string;
  providerLabel: string;
  projectId?: string;
  projectName?: string;
  taskId?: string;
  taskName?: string;
  workspaceId?: string;
  siblingConversations: ConversationView[];
  agentNames: Record<string, string>;
  accounts: AccountView[];
  providerUsage: Record<string, ProviderUsageView>;
  usageLoading?: boolean;
  hostName?: string;
  handoffs?: Record<string, HandoffRecordView>;
  handoffRecord?: HandoffRecordView;
  config: SessionConfigView | null;
  usage: SessionUsageView | null;
  plan: PlanEntryView[];
  agents: SubagentView[];
  onRefreshHandoffs?: () => void;
  onRefreshUsage?: () => void;
  onRegisterBackHandler?: (handler: (() => boolean) | null) => void;
  onOpenMenu: () => void;
  onSwitchConversation: (route: Route) => void;
  back: () => void;
}) {
  const { handle } = props;
  const view = useSyncExternalStore(handle.subscribe, handle.getState, handle.getState);

  const [draft, setDraft] = useState('');
  const [steeringMode, setSteeringMode] = useState<PromptPlacement>('auto');
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [forkOriginItemId, setForkOriginItemId] = useState<string | undefined>(undefined);
  const [handoffTargetProvider, setHandoffTargetProvider] = useState<string | undefined>(undefined);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [workingStartedAt, setWorkingStartedAt] = useState<number | null>(null);
  const [workingElapsedSec, setWorkingElapsedSec] = useState(0);
  const [optimisticConfig, setOptimisticConfig] = useState<
    Partial<Record<ConfigOptionKey, string>>
  >({});
  const [toastMsg, setToastMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [continuingHandoff, setContinuingHandoff] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const speechRef = useRef<SpeechRecInstance | null>(null);
  const stick = useRef(true);
  const speechAvailable = useMemo(() => getSpeechRecognitionCtor() !== null, []);

  useEffect(() => {
    setActiveModal(null);
    setForkOriginItemId(undefined);
    setSearchOpen(false);
    setSearchQuery('');
    setSlashMenuOpen(false);
    setOptimisticConfig({});
    setContinuingHandoff(false);
    setSteeringMode('auto');
  }, [props.conversationId]);

  useEffect(() => {
    return () => {
      try {
        speechRef.current?.stop();
      } catch {
        // yoksay
      }
      speechRef.current = null;
    };
  }, []);

  // Android geri tuşu: açık modal / arama / slash menüsü varsa önce onu kapat.
  const registerBack = props.onRegisterBackHandler;
  useEffect(() => {
    if (!registerBack) return;
    registerBack(() => {
      if (activeModal) {
        setActiveModal(null);
        setForkOriginItemId(undefined);
        return true;
      }
      if (slashMenuOpen) {
        setSlashMenuOpen(false);
        return true;
      }
      if (searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
        return true;
      }
      return false;
    });
    return () => registerBack(null);
  }, [registerBack, activeModal, slashMenuOpen, searchOpen]);

  useEffect(() => {
    if (!toastMsg) return;
    const timer = setTimeout(() => setToastMsg(null), 3200);
    return () => clearTimeout(timer);
  }, [toastMsg]);

  useEffect(() => {
    if (!activeModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveModal(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeModal]);

  // Canlı oturum yapılandırması güncel değeri yansıttığında iyimser seçimi temizle.
  useEffect(() => {
    if (!props.config) return;
    setOptimisticConfig((prev) => {
      let changed = false;
      const next = { ...prev };
      if (prev.model && props.config?.currentModel === prev.model) {
        delete next.model;
        changed = true;
      }
      if (prev.effort && props.config?.currentEffort === prev.effort) {
        delete next.effort;
        changed = true;
      }
      if (prev.mode && props.config?.currentModeId === prev.mode) {
        delete next.mode;
        changed = true;
      }
      if (
        prev.collaborationMode &&
        props.config?.currentCollaborationMode === prev.collaborationMode
      ) {
        delete next.collaborationMode;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [props.config]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [view.entries, view.pending, view.session?.permissions.length]);

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(144, Math.max(40, ta.scrollHeight))}px`;
  }, [draft]);

  const session = view.session;
  const isWorking = session?.lifecycle === 'working' || session?.isGenerating === true;
  const canCancel = session?.canCancel === true || session?.isGenerating === true;

  // Çalışma süresi canlı sayacı
  useEffect(() => {
    if (!isWorking) {
      setWorkingStartedAt(null);
      setWorkingElapsedSec(0);
      return;
    }
    const start = workingStartedAt ?? Date.now();
    if (workingStartedAt === null) setWorkingStartedAt(start);
    setWorkingElapsedSec(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    const timer = setInterval(() => {
      setWorkingElapsedSec(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [isWorking, workingStartedAt]);

  function toggleVoiceDictation(): void {
    if (listening) {
      try {
        speechRef.current?.stop();
      } catch {
        // yoksay
      }
      setListening(false);
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    try {
      const rec = new Ctor();
      rec.lang = 'tr-TR';
      rec.interimResults = false;
      rec.continuous = false;
      rec.onresult = (event) => {
        const parts: string[] = [];
        for (let i = 0; i < event.results.length; i += 1) {
          const t = event.results[i]?.[0]?.transcript;
          if (t) parts.push(t.trim());
        }
        const spoken = parts.join(' ').trim();
        if (spoken) {
          setDraft((prev) => (prev.trim() ? `${prev.trim()} ${spoken}` : spoken));
          triggerHaptic('success');
        }
      };
      rec.onerror = () => setListening(false);
      rec.onend = () => setListening(false);
      speechRef.current = rec;
      setListening(true);
      triggerHaptic('light');
      rec.start();
    } catch {
      setListening(false);
    }
  }

  function applySlashCommand(text: string): void {
    triggerHaptic('light');
    setDraft(text);
    setSlashMenuOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function shareTranscriptMarkdown(): Promise<void> {
    const md = formatTranscriptMarkdown(view.entries, props.title, props.providerLabel);
    if (!md) {
      setToastMsg({ tone: 'err', text: 'Paylaşılacak mesaj bulunamadı.' });
      return;
    }
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: props.title || 'Sovra Sohbeti', text: md });
        return;
      } catch {
        // İptal edildiyse veya desteklenmiyorsa panoya düş.
      }
    }
    await copyTranscriptMarkdown();
  }
  const runningSubagents = useMemo(
    () => props.agents.filter((a) => a.status === 'running'),
    [props.agents]
  );

  const activeProviderUsage = props.providerUsage[props.providerId];
  const providerRemaining = primaryRemainingPercent(activeProviderUsage);

  const subtitle = useMemo(() => {
    const parts: string[] = [];
    if (props.projectName) parts.push(props.projectName);
    if (isWorking) parts.push('Çalışıyor…');
    else if (session?.lifecycle === 'cancelling') parts.push('Durduruluyor…');
    else if (session?.lifecycle === 'closed') parts.push('Oturum kapalı');
    else if (session?.suspended) parts.push('Askıda');
    else parts.push(props.providerLabel);
    return parts.join(' · ');
  }, [props.projectName, props.providerLabel, isWorking, session?.lifecycle, session?.suspended]);

  const effectiveModelLabel = useMemo(() => {
    if (optimisticConfig.model) {
      return (
        props.config?.modelOptions.find((o) => o.id === optimisticConfig.model)?.name ??
        optimisticConfig.model
      );
    }
    return props.config?.modelLabel ?? null;
  }, [optimisticConfig.model, props.config]);

  const effectiveEffortLabel = useMemo(() => {
    if (optimisticConfig.effort) {
      return (
        props.config?.efforts.find((o) => o.id === optimisticConfig.effort)?.name ??
        formatEffortLabel(optimisticConfig.effort)
      );
    }
    return props.config?.effortLabel ? formatEffortLabel(props.config.effortLabel) : null;
  }, [optimisticConfig.effort, props.config]);

  const effectiveModeLabel = useMemo(() => {
    if (optimisticConfig.collaborationMode) {
      return (
        props.config?.collaborationModeOptions.find(
          (o) => o.id === optimisticConfig.collaborationMode
        )?.name ?? optimisticConfig.collaborationMode
      );
    }
    if (optimisticConfig.mode) {
      return (
        props.config?.modeOptions.find((o) => o.id === optimisticConfig.mode)?.name ??
        optimisticConfig.mode
      );
    }
    return props.config?.modeLabel ?? null;
  }, [optimisticConfig.collaborationMode, optimisticConfig.mode, props.config]);

  const hasConfigurableOptions = Boolean(
    props.config &&
    (props.config.modelOptions.length > 0 ||
      props.config.efforts.length > 0 ||
      props.config.modeOptions.length > 0 ||
      props.config.collaborationModeOptions.length > 0)
  );

  const pendingHandoffContext =
    props.handoffRecord &&
    !props.handoffRecord.contextDelivered &&
    props.handoffRecord.context.trim() !== '' &&
    view.entries.length === 0
      ? props.handoffRecord
      : null;

  async function sendWithOptionalHandoff(
    rawText: string,
    clearDraft: boolean,
    placement: PromptPlacement = 'auto'
  ): Promise<boolean> {
    const trimmed = rawText.trim();
    if (!trimmed) return false;
    if (clearDraft) setDraft('');
    stick.current = true;
    setShowScrollBtn(false);

    let payloadText = trimmed;
    if (pendingHandoffContext) {
      const separator = '\n\n';
      const maxCtx = Math.max(0, MAX_PROMPT_CHARS - trimmed.length - separator.length);
      const ctx = pendingHandoffContext.context.slice(0, maxCtx);
      payloadText = ctx ? `${ctx}${separator}${trimmed}` : trimmed;
    }

    const accepted = await handle.send(payloadText, placement);
    if (!accepted) {
      if (clearDraft) setDraft(rawText);
      return false;
    }

    if (pendingHandoffContext) {
      void props.api
        .call('conversations.handoff.put', {
          conversationId: props.conversationId,
          record: toStrictPutRecord(pendingHandoffContext, true),
        })
        .then(() => props.onRefreshHandoffs?.())
        .catch(() => {});
    }
    return true;
  }

  async function send(): Promise<void> {
    const placement: PromptPlacement = isWorking ? steeringMode : 'auto';
    triggerHaptic('medium');
    setSlashMenuOpen(false);
    await sendWithOptionalHandoff(draft, true, placement);
  }

  async function copyTranscriptMarkdown(): Promise<void> {
    const md = formatTranscriptMarkdown(view.entries, props.title, props.providerLabel);
    if (!md) {
      setToastMsg({ tone: 'err', text: 'Kopyalanacak mesaj bulunamadı.' });
      return;
    }
    try {
      await navigator.clipboard.writeText(md);
      setToastMsg({ tone: 'ok', text: 'Sohbet Markdown olarak kopyalandı.' });
    } catch {
      setToastMsg({ tone: 'err', text: 'Panoya kopyalama izin verilmedi.' });
    }
  }

  async function continueHandoff(): Promise<void> {
    if (continuingHandoff) return;
    setContinuingHandoff(true);
    try {
      await sendWithOptionalHandoff(CONTINUE_HANDOFF_PROMPT, false);
    } finally {
      setContinuingHandoff(false);
    }
  }

  function scrollToBottom(): void {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setShowScrollBtn(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  async function handleOptionChange(key: ConfigOptionKey, value: string): Promise<boolean> {
    const prevValue = optimisticConfig[key];
    setOptimisticConfig((prev) => ({ ...prev, [key]: value }));
    try {
      unwrapResult(
        await props.api.call('conversations.acp.setOption', {
          conversationId: props.conversationId,
          key,
          value,
        })
      );
      setToastMsg({ tone: 'ok', text: 'Oturum seçeneği güncellendi.' });
      return true;
    } catch (cause) {
      setOptimisticConfig((prev) => {
        const next = { ...prev };
        if (prevValue !== undefined) next[key] = prevValue;
        else delete next[key];
        return next;
      });
      setToastMsg({ tone: 'err', text: describeCallError(cause) });
      return false;
    }
  }

  const chatTabs = props.siblingConversations.filter((c) => c.chatCapable);
  const sourceSibling = props.handoffRecord
    ? props.siblingConversations.find(
        (c) => c.id === props.handoffRecord?.sourceConversationId && c.chatCapable
      )
    : undefined;
  const showContextStrip = props.agents.length > 0 || Boolean(props.handoffRecord);
  const cleanSearch = searchQuery.trim().toLowerCase();
  const visibleEntries = useMemo(() => {
    if (!cleanSearch) return view.entries;
    return view.entries.filter((entry) => {
      if (entry.kind === 'message') return entry.text.toLowerCase().includes(cleanSearch);
      if (entry.kind === 'thinking') return entry.text.toLowerCase().includes(cleanSearch);
      if (entry.kind === 'tool') {
        return (
          entry.title.toLowerCase().includes(cleanSearch) ||
          (entry.detail?.toLowerCase().includes(cleanSearch) ?? false) ||
          (entry.output?.toLowerCase().includes(cleanSearch) ?? false)
        );
      }
      return entry.text.toLowerCase().includes(cleanSearch);
    });
  }, [view.entries, cleanSearch]);

  const matchingSlashCommands = useMemo(() => {
    const trimmed = draft.trim().toLowerCase();
    if (!trimmed.startsWith('/')) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter(
      (item) => item.cmd.startsWith(trimmed) || item.label.toLowerCase().includes(trimmed.slice(1))
    );
  }, [draft]);

  const showSlashPopover =
    slashMenuOpen || (draft.startsWith('/') && !draft.includes(' ') && matchingSlashCommands.length > 0);

  return (
    <main className="screen chat-screen">
      <WorkbenchHeader
        title={props.title}
        subtitle={subtitle}
        onBack={props.back}
        trailing={
          <div className="chat-header-actions">
            <button
              type="button"
              className={`wb-icon-btn sm ${searchOpen ? 'is-active' : ''}`}
              onClick={() => {
                triggerHaptic('light');
                setSearchOpen((v) => {
                  if (v) setSearchQuery('');
                  return !v;
                });
              }}
              aria-label="Sohbette ara"
              title="Sohbette ara"
            >
              <SearchIcon size={16} />
            </button>
            <button
              type="button"
              className={`chat-quota-btn ${providerRemaining === null ? 'is-empty' : ''}`}
              onClick={() => {
                triggerHaptic('light');
                setActiveModal('quota');
              }}
              aria-label={`${props.providerLabel} kota durumu`}
              title={`${props.providerLabel} kota ayrıntıları`}
            >
              {providerRemaining !== null ? (
                <QuotaRing remainingPercent={providerRemaining} size={28} stroke={3} />
              ) : (
                <span className="chat-quota-fallback">
                  <GaugeIcon size={14} />
                </span>
              )}
            </button>
            {props.workspaceId ? (
              <button
                type="button"
                className="wb-icon-btn sm chat-header-icon-pill"
                onClick={() => {
                  triggerHaptic('light');
                  setActiveModal('diff');
                }}
                aria-label="Kod değişikliklerini incele"
                title="Değişen dosyalar ve diff önizlemesi"
              >
                <FileCodeIcon size={16} />
              </button>
            ) : null}
            <button
              type="button"
              className="wb-icon-btn sm chat-header-icon-pill"
              onClick={() => {
                triggerHaptic('light');
                setForkOriginItemId(undefined);
                setActiveModal('handoff');
              }}
              aria-label="Devret veya çatalla"
              title="Başka ajana devret veya çatalla"
            >
              <GitBranchIcon size={16} />
            </button>
          </div>
        }
      />

      {searchOpen ? (
        <div className="chat-search-bar">
          <SearchIcon size={14} className="chat-search-icon" />
          <input
            type="search"
            className="chat-search-input"
            value={searchQuery}
            autoFocus
            placeholder="Bu sohbette ara…"
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {cleanSearch ? (
            <span className="chat-search-count mono">{visibleEntries.length} sonuç</span>
          ) : null}
          <button
            type="button"
            className="wb-icon-btn sm"
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery('');
            }}
            aria-label="Aramayı kapat"
          >
            <XIcon size={15} />
          </button>
        </div>
      ) : null}

      {showContextStrip ? (
        <div className="chat-context-strip">
          {props.agents.length > 0 ? (
            <button
              type="button"
              className={`subagents-chip ${runningSubagents.length > 0 ? 'is-running' : ''}`}
              onClick={() => setActiveModal('subagents')}
            >
              {runningSubagents.length > 0 ? (
                <span className="spinner xs" aria-hidden="true" />
              ) : (
                <LayersIcon size={13} />
              )}
              <span>
                {runningSubagents.length > 0
                  ? `${runningSubagents.length} çalışıyor · ${props.agents.length} alt ajan`
                  : `${props.agents.length} alt ajan`}
              </span>
            </button>
          ) : null}

          {props.handoffRecord ? (
            sourceSibling ? (
              <button
                type="button"
                className="lineage-chip is-clickable"
                onClick={() =>
                  props.onSwitchConversation({
                    name: 'chat',
                    conversationId: sourceSibling.id,
                    title: sourceSibling.title,
                    providerId: sourceSibling.providerId,
                    projectId: props.projectId,
                    projectName: props.projectName,
                    taskId: props.taskId,
                    taskName: props.taskName,
                  })
                }
                title="Kaynak sohbete dön"
              >
                <GitBranchIcon size={12} />
                <span>{describeHandoffLineage(props.handoffRecord)}</span>
              </button>
            ) : (
              <span className="lineage-chip">
                <GitBranchIcon size={12} />
                <span>{describeHandoffLineage(props.handoffRecord)}</span>
              </span>
            )
          ) : null}
        </div>
      ) : null}

      {chatTabs.length > 1 ? (
        <div className="conv-tabs" role="tablist" aria-label="Görev sohbetleri">
          {chatTabs.map((conv) => {
            const active = conv.id === props.conversationId;
            const hasHandoff = Boolean(props.handoffs?.[conv.id]);
            return (
              <button
                key={conv.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`conv-tab ${active ? 'is-active' : ''}`}
                onClick={() => {
                  if (!active) {
                    triggerHaptic('light');
                    props.onSwitchConversation({
                      name: 'chat',
                      conversationId: conv.id,
                      title: conv.title,
                      providerId: conv.providerId,
                      projectId: props.projectId,
                      projectName: props.projectName,
                      taskId: props.taskId,
                      taskName: props.taskName,
                      workspaceId: props.workspaceId,
                    });
                  }
                }}
              >
                {hasHandoff ? <GitBranchIcon size={11} className="conv-tab-icon" /> : null}
                <span className="conv-tab-title">{conv.title}</span>
              </button>
            );
          })}
          {props.projectId && props.taskId ? (
            <button
              type="button"
              className="conv-tab conv-tab-add"
              onClick={() => {
                triggerHaptic('light');
                setActiveModal('add-tab');
              }}
              aria-label="Bu görevde yeni sohbet sekmesi aç"
              title="Yeni sohbet sekmesi"
            >
              <PlusIcon size={13} />
            </button>
          ) : null}
        </div>
      ) : null}

      {toastMsg ? (
        <div
          className={`chat-toast ${toastMsg.tone === 'err' ? 'is-err' : 'is-ok'}`}
          role="status"
          aria-live="polite"
        >
          <span>{toastMsg.text}</span>
          <button
            type="button"
            className="chat-toast-close"
            onClick={() => setToastMsg(null)}
            aria-label="Bildirimi kapat"
          >
            <XIcon size={13} />
          </button>
        </div>
      ) : null}

      <div className="chat-stage">
        <div
          className="transcript"
          ref={scroller}
          onScroll={(event) => {
            const el = event.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
            stick.current = atBottom;
            setShowScrollBtn(!atBottom);
          }}
        >
          {view.phase === 'loading' ? <Loading label="Sohbet yükleniyor…" /> : null}
          {view.phase === 'error' ? <ErrorNote message={view.error} /> : null}

          {view.phase === 'ready' && pendingHandoffContext ? (
            <div className="handoff-empty-card">
              <div className="handoff-empty-head">
                <GitBranchIcon size={15} className="icon-accent" />
                <strong>{describeHandoffLineage(pendingHandoffContext)}</strong>
              </div>
              <p className="handoff-empty-desc">
                Önceki konuşmanın özeti (
                {pendingHandoffContext.context.length.toLocaleString('tr-TR')} karakter) ilk
                mesajınızla birlikte gönderilecek.
              </p>
              {pendingHandoffContext.mode === 'handoff' ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={continuingHandoff}
                  onClick={() => void continueHandoff()}
                >
                  <SparklesIcon size={14} />
                  <span>{continuingHandoff ? 'Gönderiliyor…' : 'Kaldığı yerden devam et'}</span>
                </button>
              ) : null}
            </div>
          ) : null}

          {view.phase === 'ready' &&
          view.entries.length === 0 &&
          view.pending.length === 0 &&
          !pendingHandoffContext ? (
            <div className="chat-empty-starter">
              <ProviderAvatar providerId={props.providerId} size="lg" names={props.agentNames} />
              <h2 className="chat-empty-title">{props.providerLabel} hazır</h2>
              <p className="chat-empty-sub">
                {props.projectName
                  ? `${props.projectName} çalışma alanında doğrudan görev verebilirsin.`
                  : 'Ne üzerinde çalışmak istediğini yaz veya aşağıdan bir hızlı başlangıç seç.'}
              </p>
              <div className="starter-chip-grid">
                {EMPTY_STARTERS.map((starter) => (
                  <button
                    key={starter.label}
                    type="button"
                    className="starter-chip"
                    onClick={() => {
                      triggerHaptic('light');
                      if (starter.prompt.endsWith(': ')) {
                        setDraft(starter.prompt);
                        requestAnimationFrame(() => textareaRef.current?.focus());
                      } else {
                        void sendWithOptionalHandoff(starter.prompt, false, 'auto');
                      }
                    }}
                  >
                    <SparklesIcon size={13} className="icon-accent" />
                    <span>{starter.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {view.hasOlder && !cleanSearch ? (
            <button
              type="button"
              className="btn btn-ghost load-older-btn"
              disabled={view.loadingOlder}
              onClick={() => void handle.loadOlder()}
            >
              {view.loadingOlder ? 'Yükleniyor…' : 'Daha eski mesajları yükle'}
            </button>
          ) : null}

          {cleanSearch && visibleEntries.length === 0 ? (
            <p className="chat-notice is-info">"{searchQuery.trim()}" için eşleşen mesaj yok.</p>
          ) : null}

          {visibleEntries.map((entry) => (
            <Entry
              key={entry.id}
              api={props.api}
              conversationId={props.conversationId}
              entry={entry}
              onReusePrompt={(text) => {
                triggerHaptic('light');
                setDraft(text);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
              onForkFromHere={
                props.projectId && props.taskId
                  ? (itemId) => {
                      triggerHaptic('light');
                      setForkOriginItemId(itemId);
                      setHandoffTargetProvider(undefined);
                      setActiveModal('handoff');
                    }
                  : undefined
              }
            />
          ))}

          {view.pending.map((item) => (
            <div key={item.promptId} className="msg-user is-pending">
              <p className="msg-user-text">{item.text}</p>
              <div className="msg-user-meta">
                {item.state === 'failed' ? (
                  <>
                    <span className="text-err">{item.error ?? 'Gönderilemedi'}</span>
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => void handle.retry(item.promptId)}
                    >
                      Tekrar dene
                    </button>
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => handle.dismissPending(item.promptId)}
                    >
                      Sil
                    </button>
                  </>
                ) : item.state === 'queued' ? (
                  <span>Sıraya alındı</span>
                ) : (
                  <span>Gönderiliyor…</span>
                )}
              </div>
            </div>
          ))}

          {isWorking && view.entries.length > 0 ? (
            <div className="typing-indicator" aria-live="polite">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span>
                {props.providerLabel} yanıtlıyor
                {workingElapsedSec > 0 ? ` · ${workingElapsedSec}s` : '…'}
              </span>
            </div>
          ) : null}

          {session?.suspended ? (
            <p className="suspended-note">
              Oturum uyku modunda — mesaj gönderdiğinizde masaüstünde otomatik uyanır.
            </p>
          ) : null}
        </div>

        {showScrollBtn ? (
          <button
            type="button"
            className="scroll-bottom-btn"
            onClick={scrollToBottom}
            aria-label="En alta in"
          >
            <ArrowDownIcon size={16} />
          </button>
        ) : null}
      </div>

      {props.plan.length > 0 ? (
        <PlanStrip entries={props.plan} open={planOpen} onToggle={() => setPlanOpen((v) => !v)} />
      ) : null}

      {session?.permissions.map((permission) => (
        <PermissionCard
          key={permission.requestId}
          permission={permission}
          onChoose={(optionId) => {
            triggerHaptic('medium');
            void handle.resolvePermission(permission.requestId, optionId);
          }}
        />
      ))}

      {props.accounts.some(
        (a) => a.providerId === props.providerId && a.auth === 'unauthenticated'
      ) ? (
        <div className="banner banner-warn" role="status">
          <span className="banner-text">
            {props.providerLabel} oturumu {props.hostName || 'bilgisayar'} üzerinde kapalı görünüyor.
          </span>
          {props.projectId && props.taskId ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setForkOriginItemId(undefined);
                setHandoffTargetProvider(undefined);
                setActiveModal('handoff');
              }}
            >
              Ajan değiştir
            </button>
          ) : null}
        </div>
      ) : null}

      {view.actionError ? (
        <div className="banner banner-error" role="alert">
          <span className="banner-text">{view.actionError}</span>
          <button type="button" className="btn btn-sm" onClick={() => handle.dismissActionError()}>
            Tamam
          </button>
        </div>
      ) : null}

      <div className="composer-dock">
        {showSlashPopover ? (
          <div className="slash-popover" role="listbox" aria-label="Hızlı komutlar">
            {matchingSlashCommands.map((item) => (
              <button
                key={item.cmd}
                type="button"
                role="option"
                className="slash-item"
                onClick={() => applySlashCommand(item.text)}
              >
                <span className="slash-cmd mono">{item.cmd}</span>
                <span className="slash-label">{item.label}</span>
              </button>
            ))}
          </div>
        ) : null}

        {isWorking ? (
          <div className="steering-bar" role="radiogroup" aria-label="Çalışan turda gönderim modu">
            <span className="steering-label">Çalışıyor · Gönderim:</span>
            <div className="steering-pills">
              <button
                type="button"
                role="radio"
                aria-checked={steeringMode === 'auto'}
                className={`steering-pill ${steeringMode === 'auto' ? 'is-active' : ''}`}
                onClick={() => {
                  triggerHaptic('light');
                  setSteeringMode('auto');
                }}
              >
                <ZapIcon size={11} />
                <span>Araya gir</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={steeringMode === 'queue'}
                className={`steering-pill ${steeringMode === 'queue' ? 'is-active' : ''}`}
                onClick={() => {
                  triggerHaptic('light');
                  setSteeringMode('queue');
                }}
              >
                <ClockIcon size={11} />
                <span>Sıraya ekle</span>
              </button>
            </div>
          </div>
        ) : null}
        <div className="composer-card">
          <textarea
            ref={textareaRef}
            className="composer-input"
            rows={1}
            value={draft}
            placeholder={
              isWorking
                ? steeringMode === 'queue'
                  ? 'Bu tur bitince gönderilecek mesajı yazın…'
                  : 'Çalışan ajana araya girerek yön verin…'
                : session?.queuedCount
                  ? `${session.queuedCount} mesaj sırada · Yeni mesaj yazın…`
                  : `${props.providerLabel} ile devam et… (/ komutlar)`
            }
            onChange={(event) => {
              const next = event.target.value;
              setDraft(next);
              if (slashMenuOpen && next && !next.startsWith('/')) {
                setSlashMenuOpen(false);
              }
            }}
            aria-label="Mesaj"
          />
          <div className="composer-bar">
            <div className="composer-meta composer-meta-rail">
              <button
                type="button"
                className={`composer-chip is-interactive ${showSlashPopover ? 'is-active' : ''}`}
                onClick={() => {
                  triggerHaptic('light');
                  setSlashMenuOpen((v) => !v);
                }}
                title="Hızlı komutlar"
                aria-label="Hızlı komutlar"
              >
                <SlashIcon size={12} />
              </button>
              <button
                type="button"
                className={`composer-chip ${hasConfigurableOptions ? 'is-interactive' : ''}`}
                onClick={() => {
                  triggerHaptic('light');
                  setActiveModal('config');
                }}
                title="Model, efor ve izin modunu ayarla"
              >
                <SlidersIcon size={11} />
                <span>{effectiveModelLabel || props.providerLabel}</span>
              </button>
              {effectiveEffortLabel ? (
                <button
                  type="button"
                  className="composer-chip subtle is-interactive"
                  onClick={() => setActiveModal('config')}
                  title="Efor düzeyini değiştir"
                >
                  {effectiveEffortLabel}
                </button>
              ) : null}
              {effectiveModeLabel ? (
                <button
                  type="button"
                  className="composer-chip subtle is-interactive"
                  onClick={() => setActiveModal('config')}
                  title="İzin / çalışma modunu değiştir"
                >
                  {effectiveModeLabel}
                </button>
              ) : null}
              {props.usage ? (
                <span
                  className={`composer-chip mono ${props.usage.percent >= 85 ? 'warn' : 'subtle'}`}
                  title="Bağlam penceresi kullanımı"
                >
                  {formatTokens(props.usage.contextUsed)} / {formatTokens(props.usage.contextSize)}
                </span>
              ) : null}
              {session && session.queuedCount > 0 ? (
                <span className="composer-chip accent">+{session.queuedCount} sırada</span>
              ) : null}
            </div>
            <div className="composer-actions">
              {speechAvailable ? (
                <button
                  type="button"
                  className={`composer-mic-btn ${listening ? 'is-listening' : ''}`}
                  onClick={toggleVoiceDictation}
                  aria-label={listening ? 'Sesle yazmayı durdur' : 'Sesle yaz'}
                  title={listening ? 'Dinleniyor…' : 'Sesle yaz'}
                >
                  <MicIcon size={15} />
                </button>
              ) : null}
              {canCancel ? (
                <button
                  type="button"
                  className="composer-stop-btn"
                  onClick={() => {
                    triggerHaptic('warning');
                    void handle.cancel();
                  }}
                  aria-label="Durdur"
                  title="Turu durdur"
                >
                  <SquareStopIcon size={15} />
                </button>
              ) : null}
              <button
                type="button"
                className="composer-send-btn"
                disabled={draft.trim() === '' || view.phase !== 'ready'}
                onClick={() => void send()}
                aria-label="Gönder"
                title="Gönder"
              >
                <ArrowUpIcon size={17} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {activeModal === 'subagents' ? (
        <SubagentsSheet
          api={props.api}
          conversationId={props.conversationId}
          agents={props.agents}
          agentNames={props.agentNames}
          onClose={() => setActiveModal(null)}
        />
      ) : null}

      {activeModal === 'config' ? (
        <ModelPickerSheet
          activeProviderId={props.providerId}
          providerLabel={props.providerLabel}
          config={props.config}
          optimistic={optimisticConfig}
          accounts={props.accounts}
          agentNames={props.agentNames}
          providerUsage={props.providerUsage}
          canSwitchProvider={Boolean(props.projectId && props.taskId)}
          canExportMarkdown={view.entries.some((e) => e.kind === 'message' && e.text.trim() !== '')}
          onSelectOption={handleOptionChange}
          onHandoffToProvider={(targetPid) => {
            setForkOriginItemId(undefined);
            setHandoffTargetProvider(targetPid);
            setActiveModal('handoff');
          }}
          onOpenNewTabWithProvider={(targetPid) => {
            if (!props.projectId || !props.taskId) return;
            const id = newUuid();
            const label = providerDisplayName(targetPid, props.agentNames);
            const title = `${label} sohbeti`;
            setActiveModal(null);
            void props.api
              .call('conversations.createConversation', {
                id,
                projectId: props.projectId,
                taskId: props.taskId,
                provider: targetPid,
                title,
                type: 'acp',
              })
              .then((res) => {
                unwrapResult(res);
                props.onRefreshHandoffs?.();
                props.onSwitchConversation({
                  name: 'chat',
                  conversationId: id,
                  title,
                  providerId: targetPid,
                  projectId: props.projectId,
                  projectName: props.projectName,
                  taskId: props.taskId,
                  taskName: props.taskName,
                  workspaceId: props.workspaceId,
                });
              })
              .catch((cause) => setToastMsg({ tone: 'err', text: describeCallError(cause) }));
          }}
          onExportMarkdown={() => {
            setActiveModal(null);
            void copyTranscriptMarkdown();
          }}
          onShareMarkdown={() => {
            setActiveModal(null);
            void shareTranscriptMarkdown();
          }}
          onClose={() => setActiveModal(null)}
        />
      ) : null}

      {activeModal === 'handoff' ? (
        <HandoffSheet
          api={props.api}
          conversationId={props.conversationId}
          sourceTitle={props.title}
          sourceProviderId={props.providerId}
          sourceProviderLabel={props.providerLabel}
          projectId={props.projectId}
          projectName={props.projectName}
          taskId={props.taskId}
          taskName={props.taskName}
          workspaceId={props.workspaceId}
          initialMode={forkOriginItemId ? 'fork' : 'handoff'}
          initialTargetProvider={handoffTargetProvider}
          upToItemId={forkOriginItemId}
          entries={view.entries}
          accounts={props.accounts}
          agentNames={props.agentNames}
          providerUsage={props.providerUsage}
          onCreated={(nextRoute) => {
            setActiveModal(null);
            setForkOriginItemId(undefined);
            setHandoffTargetProvider(undefined);
            props.onRefreshHandoffs?.();
            props.onSwitchConversation(nextRoute);
          }}
          onClose={() => {
            setActiveModal(null);
            setForkOriginItemId(undefined);
            setHandoffTargetProvider(undefined);
          }}
        />
      ) : null}

      {activeModal === 'quota' ? (
        <QuotaBreakdownSheet
          providerId={props.providerId}
          hostName={props.hostName}
          agentNames={props.agentNames}
          usage={activeProviderUsage}
          loading={props.usageLoading ?? false}
          onRefresh={props.onRefreshUsage}
          onClose={() => setActiveModal(null)}
        />
      ) : null}

      {activeModal === 'diff' && props.workspaceId ? (
        <MobileDiffSheet
          api={props.api}
          workspaceId={props.workspaceId}
          onAskAboutFile={(filePath) => {
            setDraft(`\`${filePath}\` dosyasındaki değişiklikleri incele: `);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
          onClose={() => setActiveModal(null)}
        />
      ) : null}

      {activeModal === 'add-tab' && props.projectId && props.taskId ? (
        <AddChatTabSheet
          api={props.api}
          projectId={props.projectId}
          projectName={props.projectName}
          taskId={props.taskId}
          taskName={props.taskName}
          workspaceId={props.workspaceId}
          agentNames={props.agentNames}
          providerUsage={props.providerUsage}
          onCreated={(nextRoute) => {
            setActiveModal(null);
            props.onRefreshHandoffs?.();
            props.onSwitchConversation(nextRoute);
          }}
          onClose={() => setActiveModal(null)}
        />
      ) : null}
    </main>
  );
}

/* ── Alt Sayfa Çerçevesi ────────────────────────────────────────────────────────────────────── */

function BottomSheet(props: {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label={props.title}>
      <div className="sheet-backdrop" onClick={props.onClose} />
      <div className="sheet-panel">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          <div className="sheet-title-group">
            <h2 className="sheet-title">{props.title}</h2>
            {props.subtitle ? <p className="sheet-subtitle">{props.subtitle}</p> : null}
          </div>
          {props.trailing}
          <button
            type="button"
            className="wb-icon-btn sm"
            onClick={props.onClose}
            aria-label="Kapat"
          >
            <XIcon size={17} />
          </button>
        </div>
        <div className="sheet-body">{props.children}</div>
      </div>
    </div>
  );
}

/* ── Alt Ajanlar Paneli + Durdur ────────────────────────────────────────────────────────────── */

function SubagentsSheet(props: {
  api: RemoteApi;
  conversationId: string;
  agents: SubagentView[];
  agentNames: Record<string, string>;
  onClose: () => void;
}) {
  const runningCount = props.agents.filter((a) => a.status === 'running').length;
  const [now, setNow] = useState(() => Date.now());
  const [cancellingIds, setCancellingIds] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (runningCount === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [runningCount]);

  async function stopSubagent(agent: SubagentView): Promise<void> {
    if (!UUID_RE.test(agent.agentId) || cancellingIds[agent.agentId]) return;
    setError(null);
    setCancellingIds((prev) => ({ ...prev, [agent.agentId]: true }));
    try {
      unwrapResult(
        await props.api.call('conversations.acp.cancelSubagent', {
          conversationId: props.conversationId,
          runId: agent.agentId,
        })
      );
    } catch (cause) {
      setError(describeCallError(cause));
    } finally {
      setCancellingIds((prev) => {
        const next = { ...prev };
        delete next[agent.agentId];
        return next;
      });
    }
  }

  return (
    <BottomSheet
      title="Alt Ajanlar"
      subtitle={
        runningCount > 0
          ? `${runningCount} çalışıyor · toplam ${props.agents.length}`
          : `${props.agents.length} tamamlanan çalışma`
      }
      onClose={props.onClose}
    >
      <ErrorNote message={error} />
      {props.agents.length === 0 ? (
        <p className="muted-note">Bu oturumda henüz alt ajan çalıştırılmadı.</p>
      ) : (
        <div className="subagent-list">
          {props.agents.map((agent) => {
            const isRunning = agent.status === 'running';
            const isFailed = agent.status === 'failed';
            const canStop = isRunning && UUID_RE.test(agent.agentId);
            const stopping = Boolean(cancellingIds[agent.agentId]);
            const effortLabel = formatEffortLabel(agent.effort);
            const elapsed = formatElapsed(agent.startedAt, agent.completedAt, now);

            return (
              <article
                key={agent.toolCallId || agent.agentId}
                className={`subagent-card ${
                  isRunning ? 'is-running' : isFailed ? 'is-failed' : 'is-done'
                }`}
              >
                <div className="subagent-card-head">
                  <div className="subagent-card-title-wrap">
                    <span
                      className={`subagent-state-dot ${
                        isRunning ? 'is-running' : isFailed ? 'is-failed' : 'is-done'
                      }`}
                      aria-hidden="true"
                    >
                      {isRunning ? (
                        <span className="spinner xs" />
                      ) : isFailed ? (
                        <XIcon size={11} />
                      ) : (
                        <CheckIcon size={11} />
                      )}
                    </span>
                    <strong className="subagent-card-name">{agent.name}</strong>
                  </div>
                  <div className="subagent-card-right">
                    <span className="subagent-elapsed mono">{elapsed}</span>
                    {canStop ? (
                      <button
                        type="button"
                        className="btn btn-danger-outline btn-xs"
                        disabled={stopping}
                        onClick={() => void stopSubagent(agent)}
                      >
                        <SquareStopIcon size={11} />
                        <span>{stopping ? 'Durduruluyor…' : 'Durdur'}</span>
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="subagent-badges">
                  {agent.provider ? (
                    <span className="subagent-badge">
                      <ProviderAvatar
                        providerId={agent.provider}
                        size="sm"
                        names={props.agentNames}
                      />
                      <span>{providerDisplayName(agent.provider, props.agentNames)}</span>
                    </span>
                  ) : null}
                  {agent.model ? <span className="subagent-badge mono">{agent.model}</span> : null}
                  {effortLabel ? <span className="subagent-badge">{effortLabel} efor</span> : null}
                  {agent.role && !agent.model ? (
                    <span className="subagent-badge mono">{agent.role}</span>
                  ) : null}
                </div>

                {agent.prompt ? (
                  <div className="subagent-section">
                    <span className="subagent-section-label">Talimat</span>
                    <p className="subagent-prompt">{agent.prompt}</p>
                  </div>
                ) : null}

                {agent.activities.length > 0 ? (
                  <details className="subagent-activities" open={isRunning}>
                    <summary className="subagent-activities-summary">
                      <span>Aktivite adımları ({agent.activities.length})</span>
                    </summary>
                    <ul className="subagent-activity-list">
                      {agent.activities.map((step) => (
                        <SubagentActivityRow key={step.id} activity={step} />
                      ))}
                    </ul>
                  </details>
                ) : isRunning ? (
                  <p className="subagent-waiting">Alt ajan adımları bekleniyor…</p>
                ) : null}

                {agent.summary ? (
                  <div className="subagent-section">
                    <span className="subagent-section-label">
                      {isFailed ? 'Hata detayı' : 'Özet yanıt'}
                    </span>
                    <div className={`subagent-summary-box ${isFailed ? 'is-failed' : ''}`}>
                      <MarkdownView text={agent.summary} />
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </BottomSheet>
  );
}

function SubagentActivityRow(props: { activity: AgentActivityView }) {
  const { activity } = props;
  const timeStr = formatActivityTime(activity.timestamp);
  return (
    <li className={`subagent-activity-item is-${activity.status ?? 'done'}`}>
      <div className="subagent-activity-top">
        <span className="subagent-activity-title">{activity.title}</span>
        {timeStr ? <span className="subagent-activity-time mono">{timeStr}</span> : null}
      </div>
      {activity.detail ? <p className="subagent-activity-detail">{activity.detail}</p> : null}
    </li>
  );
}

/* ── Devret / Çatalla Modalı ────────────────────────────────────────────────────────────────── */

function HandoffSheet(props: {
  api: RemoteApi;
  conversationId: string;
  sourceTitle: string;
  sourceProviderId: string;
  sourceProviderLabel: string;
  projectId?: string;
  projectName?: string;
  taskId?: string;
  taskName?: string;
  workspaceId?: string;
  initialMode?: 'handoff' | 'fork';
  initialTargetProvider?: string;
  upToItemId?: string;
  entries: TranscriptEntry[];
  accounts: AccountView[];
  agentNames: Record<string, string>;
  providerUsage: Record<string, ProviderUsageView>;
  onCreated: (route: Route) => void;
  onClose: () => void;
}) {
  const providerChoices = useMemo(() => {
    const ids = new Set<string>(CORE_USAGE_PROVIDERS);
    for (const key of Object.keys(props.agentNames)) {
      if (key) ids.add(key);
    }
    for (const acc of props.accounts) {
      if (acc.auth === 'authenticated') ids.add(acc.providerId);
    }
    if (props.sourceProviderId) ids.add(props.sourceProviderId);
    return [...ids];
  }, [props.agentNames, props.accounts, props.sourceProviderId]);

  const defaultTarget = useMemo(() => {
    if (props.initialTargetProvider && providerChoices.includes(props.initialTargetProvider)) {
      return props.initialTargetProvider;
    }
    return (
      providerChoices.find((id) => id !== props.sourceProviderId) ??
      props.sourceProviderId ??
      'claude'
    );
  }, [props.initialTargetProvider, providerChoices, props.sourceProviderId]);

  const startMode = props.initialMode ?? 'handoff';
  const [mode, setMode] = useState<'handoff' | 'fork'>(startMode);
  const [targetProvider, setTargetProvider] = useState(defaultTarget);
  const [title, setTitle] = useState(() => defaultHandoffTitle(props.sourceTitle, startMode));
  const [titleTouched, setTitleTouched] = useState(false);
  const [markSuperseded, setMarkSuperseded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summaryPreview = useMemo(
    () =>
      buildMobileHandoffContext(props.entries, props.sourceTitle, {
        sourceProviderLabel: props.sourceProviderLabel,
        upToItemId: props.upToItemId,
      }),
    [props.entries, props.sourceTitle, props.sourceProviderLabel, props.upToItemId]
  );

  const messageCount = useMemo(
    () => props.entries.filter((e) => e.kind === 'message' && e.text.trim() !== '').length,
    [props.entries]
  );

  function switchMode(nextMode: 'handoff' | 'fork'): void {
    setMode(nextMode);
    setError(null);
    if (!titleTouched) {
      setTitle(defaultHandoffTitle(props.sourceTitle, nextMode));
    }
  }

  async function submit(): Promise<void> {
    if (!props.projectId || !props.taskId) {
      setError('Bu sohbetin proje veya görev bilgisi henüz yüklenmedi.');
      return;
    }
    if (!summaryPreview) {
      setError('Aktarılacak sohbet geçmişi yok.');
      return;
    }
    const provider = mode === 'fork' ? props.sourceProviderId : targetProvider;
    const cleanTitle = title.trim().slice(0, 200) || defaultHandoffTitle(props.sourceTitle, mode);
    const newConversationId = newUuid();

    setBusy(true);
    setError(null);
    try {
      unwrapResult(
        await props.api.call('conversations.createConversation', {
          id: newConversationId,
          projectId: props.projectId,
          taskId: props.taskId,
          provider,
          title: cleanTitle,
          type: 'acp',
        })
      );

      unwrapResult(
        await props.api.call('conversations.handoff.put', {
          conversationId: newConversationId,
          record: {
            version: 1,
            mode,
            sourceConversationId: props.conversationId,
            sourceTitle: props.sourceTitle.trim().slice(0, 300) || 'Sohbet',
            ...(props.upToItemId ? { sourceItemId: props.upToItemId } : {}),
            context: summaryPreview,
            contextDelivered: false,
            createdAt: Date.now(),
          },
        })
      );

      if (mode === 'handoff' && markSuperseded) {
        unwrapResult(
          await props.api.call('conversations.handoff.markSuperseded', {
            oldConversationId: props.conversationId,
            newConversationId,
          })
        );
      }

      props.onCreated({
        name: 'chat',
        conversationId: newConversationId,
        title: cleanTitle,
        providerId: provider,
        projectId: props.projectId,
        projectName: props.projectName,
        taskId: props.taskId,
        taskName: props.taskName,
        workspaceId: props.workspaceId,
      });
    } catch (cause) {
      setError(describeCallError(cause));
      setBusy(false);
    }
  }

  return (
    <BottomSheet
      title="Sohbeti Devret / Çatalla"
      subtitle={props.sourceTitle}
      onClose={() => !busy && props.onClose()}
    >
      <div className="segmented" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'handoff'}
          className={`segmented-btn ${mode === 'handoff' ? 'is-active' : ''}`}
          onClick={() => switchMode('handoff')}
        >
          <span>Devret</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'fork'}
          className={`segmented-btn ${mode === 'fork' ? 'is-active' : ''}`}
          onClick={() => switchMode('fork')}
        >
          <span>Çatalla</span>
        </button>
      </div>

      <p className="muted-note">
        {mode === 'handoff'
          ? 'Konuşma özeti seçilen başka bir yapay zeka ajanına yeni sohbet olarak aktarılır.'
          : `Aynı ajanla (${props.sourceProviderLabel}) paralel bir sohbet dalı açılır.`}
      </p>

      {mode === 'handoff' ? (
        <div className="form-group">
          <span className="field-label">Hedef yapay zeka ajanı</span>
          <div className="agent-grid">
            {providerChoices.map((id) => {
              const rem = primaryRemainingPercent(props.providerUsage[id]);
              return (
                <button
                  key={id}
                  type="button"
                  className={`agent-tile ${targetProvider === id ? 'is-selected' : ''}`}
                  onClick={() => setTargetProvider(id)}
                >
                  <ProviderAvatar providerId={id} size="sm" names={props.agentNames} />
                  <span className="agent-tile-name">
                    {providerDisplayName(id, props.agentNames)}
                  </span>
                  {rem !== null ? (
                    <span className={`agent-tile-quota is-${quotaTone(rem)}`}>%{rem}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="form-group">
        <label htmlFor="handoff-title-input" className="field-label">
          Yeni sohbet başlığı
        </label>
        <input
          id="handoff-title-input"
          type="text"
          className="text-input"
          value={title}
          onChange={(e) => {
            setTitleTouched(true);
            setTitle(e.target.value);
          }}
        />
      </div>

      <div className="handoff-summary-preview">
        {summaryPreview
          ? `${messageCount} mesaj özetlenecek (${summaryPreview.length.toLocaleString('tr-TR')} karakter).`
          : 'Bu sohbette henüz aktarılacak mesaj bulunmuyor.'}
      </div>

      {mode === 'handoff' ? (
        <label className="check-row">
          <input
            type="checkbox"
            checked={markSuperseded}
            onChange={(e) => setMarkSuperseded(e.target.checked)}
          />
          <span>Önceki sohbeti devredilmiş olarak işaretle</span>
        </label>
      ) : null}

      <ErrorNote message={error} />

      <button
        type="button"
        className="btn btn-primary full lg"
        disabled={busy || !summaryPreview || !props.projectId || !props.taskId}
        onClick={() => void submit()}
      >
        <GitBranchIcon size={16} />
        <span>
          {busy
            ? 'Oluşturuluyor…'
            : mode === 'handoff'
              ? 'Devret ve sohbete geç'
              : 'Çatalla ve sohbete geç'}
        </span>
      </button>
    </BottomSheet>
  );
}

/* ── Aktif Sağlayıcı Kota Ayrıntıları Modalı ────────────────────────────────────────────────── */

function QuotaBreakdownSheet(props: {
  providerId: string;
  hostName?: string;
  agentNames: Record<string, string>;
  usage: ProviderUsageView | undefined;
  loading: boolean;
  onRefresh?: () => void;
  onClose: () => void;
}) {
  const displayName = providerDisplayName(props.providerId, props.agentNames);
  const usage = props.usage;
  const remaining = primaryRemainingPercent(usage);

  return (
    <BottomSheet
      title={`${displayName} Kotası`}
      subtitle={usage?.account ?? undefined}
      trailing={
        props.onRefresh ? (
          <button
            type="button"
            className={`wb-icon-btn sm ${props.loading ? 'is-spinning' : ''}`}
            disabled={props.loading}
            onClick={props.onRefresh}
            aria-label="Kotayı yenile"
          >
            <RefreshIcon size={15} />
          </button>
        ) : null
      }
      onClose={props.onClose}
    >
      <div className="quota-modal-head">
        <div className="limit-card-id">
          <ProviderAvatar providerId={props.providerId} size="md" names={props.agentNames} />
          <div className="limit-card-titles">
            <div className="limit-name-row">
              <strong className="limit-name">{displayName}</strong>
              {usage?.plan ? <span className="plan-pill">{usage.plan}</span> : null}
            </div>
            <span className="limit-sub">{usage?.account || 'Yerel masaüstü oturumu'}</span>
          </div>
        </div>
        {remaining !== null ? (
          <QuotaRing remainingPercent={remaining} size={46} stroke={4} />
        ) : null}
      </div>

      {usage && usage.windows.length > 0 ? (
        <div className="limit-windows">
          {usage.windows.map((window, index) => {
            const rem = Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
            const tone = quotaTone(rem);
            const reset = formatResetCountdown(window.resetsAt);
            return (
              <div key={`${window.label}-${index}`} className="limit-window-row">
                <div className="limit-window-top">
                  <span className="limit-window-label">{window.label}</span>
                  <span className={`limit-window-pct is-${tone}`}>%{rem} kaldı</span>
                </div>
                <div
                  className="meter-track"
                  role="progressbar"
                  aria-label={`${displayName} ${window.label}`}
                  aria-valuenow={rem}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className={`meter-fill is-${tone}`} style={{ width: `${rem}%` }} />
                </div>
                <div className="limit-window-foot">
                  <span>%{Math.round(window.usedPercent)} kullanıldı</span>
                  {reset ? <span>Yenilenme: {reset}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted-note">
          {props.loading
            ? `Kota bilgileri ${props.hostName || 'bilgisayar'} üzerinden sorgulanıyor…`
            : usage?.message || 'Bu sağlayıcı için pencere kotası verisi alınamadı.'}
        </p>
      )}

      {usage && usage.balances.length > 0 ? (
        <div className="balance-chips">
          {usage.balances.map((b, idx) => (
            <span key={`${b.label}-${idx}`} className="balance-chip">
              <span className="balance-label">{b.label}</span>
              <strong className="balance-val mono">
                {b.value.toLocaleString('tr-TR', { maximumFractionDigits: 2 })} {b.unit}
              </strong>
            </span>
          ))}
        </div>
      ) : null}

      {usage && usage.windows.length > 0 && usage.message ? (
        <p className="muted-note">{usage.message}</p>
      ) : null}

      {usage?.source ? <div className="limit-source">{usage.source}</div> : null}
    </BottomSheet>
  );
}

/* ── Plan / Araç / İzin Kartları ────────────────────────────────────────────────────────────── */

function PlanStrip(props: { entries: PlanEntryView[]; open: boolean; onToggle: () => void }) {
  const doneCount = props.entries.filter((e) => e.status === 'completed').length;
  const activeStep = props.entries.find((e) => e.status === 'in_progress');
  return (
    <div className="plan-strip">
      <button type="button" className="plan-toggle" onClick={props.onToggle}>
        <ListChecksIcon size={14} className="icon-accent" />
        <span className="plan-summary">
          {activeStep
            ? activeStep.content
            : `Plan · ${doneCount}/${props.entries.length} tamamlandı`}
        </span>
        <span className="plan-count">
          {doneCount}/{props.entries.length}
        </span>
        {props.open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
      </button>
      {props.open ? (
        <ul className="plan-list">
          {props.entries.map((step) => (
            <li key={step.id} className={`plan-item is-${step.status}`}>
              <span className="plan-icon" aria-hidden="true">
                {step.status === 'completed' ? (
                  <CheckIcon size={12} />
                ) : step.status === 'in_progress' ? (
                  <span className="status-dot is-working sm" />
                ) : (
                  <span className="plan-bullet" />
                )}
              </span>
              <span>{step.content}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function toolCategoryIcon(title: string, detail: string | null) {
  const text = `${title} ${detail ?? ''}`.toLowerCase();
  if (/(bash|shell|cmd|command|run|terminal|exec|komut)/.test(text)) {
    return <TerminalIcon size={13} />;
  }
  if (/(read|write|edit|file|grep|glob|search|diff|patch|dosya)/.test(text)) {
    return <FileCodeIcon size={13} />;
  }
  if (/(chrome|web|http|url|fetch|browser|tab|navigate)/.test(text)) {
    return <GlobeIcon size={13} />;
  }
  return <WrenchIcon size={13} />;
}

function AddChatTabSheet(props: {
  api: RemoteApi;
  projectId: string;
  projectName?: string;
  taskId: string;
  taskName?: string;
  workspaceId?: string;
  agentNames: Record<string, string>;
  providerUsage: Record<string, ProviderUsageView>;
  onCreated: (route: Route) => void;
  onClose: () => void;
}) {
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pickProvider(providerId: string): Promise<void> {
    if (busyProvider) return;
    setBusyProvider(providerId);
    setError(null);
    const id = newUuid();
    const label = providerDisplayName(providerId, props.agentNames);
    const title = `${label} sohbeti`;
    try {
      unwrapResult(
        await props.api.call('conversations.createConversation', {
          id,
          projectId: props.projectId,
          taskId: props.taskId,
          provider: providerId,
          title,
          type: 'acp',
        })
      );
      triggerHaptic('success');
      props.onCreated({
        name: 'chat',
        conversationId: id,
        title,
        providerId,
        projectId: props.projectId,
        projectName: props.projectName,
        taskId: props.taskId,
        taskName: props.taskName,
        workspaceId: props.workspaceId,
      });
    } catch (cause) {
      setError(describeCallError(cause));
      setBusyProvider(null);
    }
  }

  return (
    <BottomSheet
      title="Yeni sohbet sekmesi"
      subtitle={props.taskName || props.projectName}
      onClose={() => !busyProvider && props.onClose()}
    >
      <p className="muted-note">
        Aynı görev ve çalışma alanı içinde paralel bir yapay zeka sekmesi açın.
      </p>
      <ErrorNote message={error} />
      <div className="agent-grid">
        {CORE_USAGE_PROVIDERS.map((id) => {
          const rem = primaryRemainingPercent(props.providerUsage[id]);
          return (
            <button
              key={id}
              type="button"
              className="agent-tile"
              disabled={Boolean(busyProvider)}
              onClick={() => void pickProvider(id)}
            >
              <ProviderAvatar providerId={id} size="sm" names={props.agentNames} />
              <span className="agent-tile-name">
                {busyProvider === id ? 'Açılıyor…' : providerDisplayName(id, props.agentNames)}
              </span>
              {rem !== null ? (
                <span className={`agent-tile-quota is-${quotaTone(rem)}`}>%{rem}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </BottomSheet>
  );
}

function InlineToolDiff(props: { diff: ToolDiffPreview }) {
  const removed = props.diff.oldText ? props.diff.oldText.split('\n').slice(0, 14) : [];
  const added = props.diff.newText ? props.diff.newText.split('\n').slice(0, 14) : [];
  return (
    <pre className="tool-diff-pre mono">
      {removed.map((line, i) => (
        <div key={`r-${i}`} className="mobile-diff-line is-del">
          - {line}
        </div>
      ))}
      {added.map((line, i) => (
        <div key={`a-${i}`} className="mobile-diff-line is-add">
          + {line}
        </div>
      ))}
    </pre>
  );
}

function UserMessage(props: {
  text: string;
  createdAt?: number;
  attachments?: { id: string; name: string }[];
  onReusePrompt?: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timeLabel = formatMessageTime(props.createdAt);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.text);
      triggerHaptic('light');
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // yoksay
    }
  }

  return (
    <div className="msg-user">
      {props.attachments && props.attachments.length > 0 ? (
        <div className="msg-attachments">
          {props.attachments.map((att) => (
            <span key={att.id} className="msg-attachment-chip mono">
              <PaperclipIcon size={11} />
              <span>{att.name}</span>
            </span>
          ))}
        </div>
      ) : null}
      <p className="msg-user-text">{props.text}</p>
      <div className="msg-user-foot">
        {timeLabel ? <span className="msg-time mono">{timeLabel}</span> : null}
        <button
          type="button"
          className={`msg-mini-btn ${copied ? 'is-copied' : ''}`}
          onClick={() => void handleCopy()}
          aria-label="Mesajı kopyala"
        >
          {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
        </button>
        {props.onReusePrompt ? (
          <button
            type="button"
            className="msg-mini-btn"
            onClick={() => props.onReusePrompt?.(props.text)}
            aria-label="Düzenle veya tekrar yaz"
            title="Yazı kutusuna aktar"
          >
            <RotateCcwIcon size={11} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function collectToolArtifacts(entry: Extract<TranscriptEntry, { kind: 'tool' }>): MediaArtifact[] {
  const found: MediaArtifact[] = [];
  if (entry.artifacts) found.push(...entry.artifacts);
  for (const child of entry.children) {
    if (child.kind === 'tool') found.push(...collectToolArtifacts(child));
  }
  return uniqueArtifacts(found);
}

function AssistantMessage(props: {
  api: RemoteApi;
  conversationId: string;
  id: string;
  text: string;
  createdAt?: number;
  artifacts?: ArtifactView[];
  onForkFromHere?: (itemId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timeLabel = formatMessageTime(props.createdAt);
  const mediaItems = useMemo(
    () =>
      uniqueArtifacts([
        ...(props.artifacts ?? []),
        ...extractArtifactsFromText(props.text),
      ]),
    [props.artifacts, props.text]
  );

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.text);
      triggerHaptic('light');
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Kopyalama izin verilmediyse sessizce geç.
    }
  }

  return (
    <div className="msg-assistant">
      {props.text.trim() !== '' ? <MarkdownView text={props.text} /> : null}
      {mediaItems.length > 0 ? (
        <MediaArtifactStrip
          api={props.api}
          conversationId={props.conversationId}
          artifacts={mediaItems}
        />
      ) : null}
      {props.text.trim() !== '' ? (
        <div className="msg-assistant-actions">
          <button
            type="button"
            className={`msg-action-btn ${copied ? 'is-copied' : ''}`}
            onClick={() => void handleCopy()}
            aria-label="Yanıtı kopyala"
          >
            {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            <span>{copied ? 'Kopyalandı' : 'Kopyala'}</span>
          </button>
          {props.onForkFromHere ? (
            <button
              type="button"
              className="msg-action-btn"
              onClick={() => props.onForkFromHere?.(props.id)}
              aria-label="Bu yanıttan çatalla"
            >
              <GitBranchIcon size={12} />
              <span>Çatalla</span>
            </button>
          ) : null}
          {timeLabel ? <span className="msg-time mono">{timeLabel}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function Entry(props: {
  api: RemoteApi;
  conversationId: string;
  entry: TranscriptEntry;
  onReusePrompt?: (text: string) => void;
  onForkFromHere?: (itemId: string) => void;
}) {
  const { entry } = props;
  switch (entry.kind) {
    case 'message':
      if (entry.role === 'user') {
        return (
          <UserMessage
            text={entry.text}
            createdAt={entry.createdAt}
            attachments={entry.attachments}
            onReusePrompt={props.onReusePrompt}
          />
        );
      }
      return (
        <AssistantMessage
          api={props.api}
          conversationId={props.conversationId}
          id={entry.id}
          text={entry.text}
          createdAt={entry.createdAt}
          artifacts={entry.artifacts}
          onForkFromHere={props.onForkFromHere}
        />
      );

    case 'thinking': {
      const dur = formatDurationShort(entry.durationMs);
      return entry.text ? (
        <details className={`thinking-card ${entry.active ? 'is-active' : ''}`}>
          <summary className="thinking-summary">
            <SparklesIcon size={13} className="thinking-icon" />
            <span>
              {entry.active ? 'Düşünüyor…' : dur ? `Düşünce süreci · ${dur}` : 'Düşünce süreci'}
            </span>
          </summary>
          <div className="thinking-body">{entry.text}</div>
        </details>
      ) : null;
    }

    case 'tool': {
      const preview = entry.detail ? entry.detail.split('\n')[0]?.slice(0, 72) : null;
      const clippedOutput =
        entry.output && entry.output.length > 3500
          ? `${entry.output.slice(0, 3500)}\n… (kırpıldı)`
          : entry.output;
      const toolMedia = collectToolArtifacts(entry);
      return (
        <div className="tool-entry-wrap">
          <details className={`tool-card is-${entry.status}`}>
            <summary className="tool-summary">
              <span className={`tool-state-icon is-${entry.status}`} aria-hidden="true">
                {entry.status === 'running' ? (
                  <span className="spinner xs" />
                ) : entry.status === 'done' ? (
                  <CheckIcon size={12} />
                ) : entry.status === 'failed' ? (
                  <XIcon size={12} />
                ) : (
                  toolCategoryIcon(entry.title, entry.detail)
                )}
              </span>
              <span className="tool-title">{entry.title}</span>
              {entry.badge ? <span className="tool-badge">{entry.badge}</span> : null}
              {preview ? <span className="tool-preview mono">{preview}</span> : null}
            </summary>
            <div className="tool-body">
              {entry.detail ? <pre className="tool-detail mono">{entry.detail}</pre> : null}
              {entry.locations && entry.locations.length > 1 ? (
                <div className="tool-locations mono">
                  {entry.locations.slice(0, 8).map((loc, idx) => (
                    <span key={idx} className="tool-location-chip">
                      {loc}
                    </span>
                  ))}
                </div>
              ) : null}
              {entry.diff ? <InlineToolDiff diff={entry.diff} /> : null}
              {clippedOutput ? <pre className="tool-output mono">{clippedOutput}</pre> : null}
              {entry.children.length > 0 ? (
                <div className="tool-children">
                  {entry.children.map((child) => (
                    <Entry
                      key={child.id}
                      api={props.api}
                      conversationId={props.conversationId}
                      entry={child}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </details>
          {/* Araç grubu kapalı olsa bile üretilen görsel/video/dosyalar Mac'teki gibi doğrudan görünür! */}
          {toolMedia.length > 0 ? (
            <MediaArtifactStrip
              api={props.api}
              conversationId={props.conversationId}
              artifacts={toolMedia}
            />
          ) : null}
        </div>
      );
    }

    case 'notice':
      return <p className={`chat-notice is-${entry.tone}`}>{entry.text}</p>;
  }
}

function PermissionCard(props: {
  permission: PermissionView;
  onChoose: (optionId: string) => void;
}) {
  const { permission } = props;
  return (
    <section className="permission-sheet" role="alertdialog" aria-label="İzin isteği">
      <div className="permission-head">
        <ShieldAlertIcon size={16} className="icon-warn" />
        <strong className="permission-title">{permission.title}</strong>
      </div>
      {permission.detail ? <pre className="permission-code mono">{permission.detail}</pre> : null}
      <div className="permission-actions">
        {permission.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className={option.allow ? 'btn btn-primary' : 'btn btn-danger-outline'}
            onClick={() => props.onChoose(option.optionId)}
          >
            {option.name}
          </button>
        ))}
      </div>
    </section>
  );
}
