import { useMemo, useRef, useState } from 'react';
import type { ConnectionStatus } from '@/core/connection-state';
import {
  buildActiveWorkList,
  isConversationAwaitingPermission,
  isConversationWorking,
  type ConversationView,
  type ProjectView,
  type ProviderUsageView,
  type SessionSummaryView,
  type TaskStatView,
} from '@/core/mappers';
import { triggerHaptic } from '@/core/native-bridge';
import { getSnooze, type TaskSnoozes } from '@/core/task-snoozes';
import { isFreeChatProjectId } from '@/core/wire-client';
import {
  ConnectionPill,
  Empty,
  ErrorNote,
  Loading,
  SovraMark,
  WorkbenchHeader,
  providerDisplayName,
} from '../components';
import type { CreateMode } from '../CreateModal';
import {
  BellIcon,
  ClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  PinIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  ServerIcon,
  ShieldAlertIcon,
  SparklesIcon,
  XIcon,
} from '../icons';
import {
  CORE_USAGE_PROVIDERS,
  ProviderAvatar,
  primaryRemainingPercent,
  quotaTone,
} from '../ProviderBrand';
import type { Route } from '../router';
import { TaskSnoozeSheet } from '../TaskSnoozeSheet';

type TreeFilter = 'all' | 'active' | 'done';

const PROJECT_INITIAL_VISIBLE_TASKS = 5;
const PIN_FREE_SECTION_KEY = 'sovra:home:pin-free-section';
const PINNED_CHATS_KEY = 'sovra:home:pinned-chats';
const PINNED_PROJECTS_KEY = 'sovra:home:pinned-projects';

function readBoolPref(key: string): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeBoolPref(key: string, value: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Depo yazılamıyorsa sessizce geç.
  }
}

function readStringListPref(key: string): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeStringListPref(key: string, items: string[]): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // Depo yazılamıyorsa sessizce geç.
  }
}

type GroupedTaskRow = {
  key: string;
  taskId: string;
  projectId: string;
  projectName?: string;
  workspaceId?: string;
  title: string;
  conversations: ConversationView[];
  primaryConversation: ConversationView;
  providers: string[];
  working: boolean;
  awaitingPermission: boolean;
  lastAt: string;
  stat?: TaskStatView;
};

function formatCompactCount(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function formatMacShortTime(iso: string | null): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diffMin = Math.max(0, Math.floor((Date.now() - ts) / 60_000));
  if (diffMin < 1) return 'şimdi';
  if (diffMin < 60) return `${diffMin}dk`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}sa`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}g`;
  const diffMon = Math.floor(diffDay / 30);
  return `${diffMon}ay`;
}

export function HomeScreen(props: {
  projects: ProjectView[];
  projectsLoading: boolean;
  projectsError: string | null;
  conversations: ConversationView[];
  conversationsLoading: boolean;
  sessions: Record<string, SessionSummaryView>;
  taskStats: Record<string, TaskStatView>;
  snoozes: TaskSnoozes;
  snoozeError: string | null;
  onUpdateSnooze: (
    projectId: string,
    taskId: string,
    durationMs: number | null
  ) => Promise<boolean>;
  usage: Record<string, ProviderUsageView>;
  agentNames: Record<string, string>;
  hostName: string;
  hostCount: number;
  status: ConnectionStatus;
  unreadNotificationCount: number;
  selectedAgentId: string;
  onSelectAgent: (providerId: string) => void;
  onOpenHostSwitcher: () => void;
  onRefreshAll: () => void;
  onOpenNotifications: () => void;
  onOpenMenu: () => void;
  onOpenCreate: (mode: CreateMode, projectId?: string) => void;
  onStartFreeChat: (providerId?: string) => void;
  onQuickStartChat: (projectId?: string, providerId?: string) => void;
  push: (route: Route) => void;
  replace: (route: Route) => void;
}) {
  const [snoozeMenu, setSnoozeMenu] = useState<GroupedTaskRow | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TreeFilter>('all');
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [expandedProjectLists, setExpandedProjectLists] = useState<Record<string, boolean>>({});
  const [freeChatsExpanded, setFreeChatsExpanded] = useState(false);
  const [freeChatsPinned, setFreeChatsPinned] = useState<boolean>(() =>
    readBoolPref(PIN_FREE_SECTION_KEY)
  );
  const [pinnedChatKeys, setPinnedChatKeys] = useState<string[]>(() =>
    readStringListPref(PINNED_CHATS_KEY)
  );
  const [pinnedProjectIds, setPinnedProjectIds] = useState<string[]>(() =>
    readStringListPref(PINNED_PROJECTS_KEY)
  );
  const q = search.trim().toLowerCase();

  const pinnedChatSet = useMemo(() => new Set(pinnedChatKeys), [pinnedChatKeys]);
  const pinnedProjectSet = useMemo(() => new Set(pinnedProjectIds), [pinnedProjectIds]);

  function toggleFreeChatsPin(): void {
    triggerHaptic('medium');
    setFreeChatsPinned((prev) => {
      const next = !prev;
      writeBoolPref(PIN_FREE_SECTION_KEY, next);
      return next;
    });
  }

  function toggleChatPin(rowKey: string): void {
    triggerHaptic('medium');
    setPinnedChatKeys((prev) => {
      const next = prev.includes(rowKey)
        ? prev.filter((k) => k !== rowKey)
        : [rowKey, ...prev].slice(0, 30);
      writeStringListPref(PINNED_CHATS_KEY, next);
      return next;
    });
  }

  function toggleProjectPin(projectId: string): void {
    triggerHaptic('medium');
    setPinnedProjectIds((prev) => {
      const next = prev.includes(projectId)
        ? prev.filter((id) => id !== projectId)
        : [projectId, ...prev].slice(0, 20);
      writeStringListPref(PINNED_PROJECTS_KEY, next);
      return next;
    });
  }

  const activeWork = useMemo(
    () => buildActiveWorkList(props.conversations, props.sessions),
    [props.conversations, props.sessions]
  );
  const alertCount = activeWork.filter(
    (entry) =>
      entry.awaitingInput &&
      !(entry.projectId && entry.taskId && getSnooze(props.snoozes, entry.projectId, entry.taskId))
  ).length;

  const projectById = useMemo(
    () => new Map(props.projects.map((p) => [p.id, p])),
    [props.projects]
  );

  // Sohbetleri Mac sidebar mantığıyla görev (taskId) bazında grupla: üst üste binen çoklu ajan ikonları!
  const groupedByProject = useMemo(() => {
    const taskBuckets = new Map<string, ConversationView[]>();
    for (const conv of props.conversations) {
      if (!conv.chatCapable) continue;
      const bucketKey = `${conv.projectId || '__free__'}::${conv.taskId || conv.id}`;
      const list = taskBuckets.get(bucketKey);
      if (list) list.push(conv);
      else taskBuckets.set(bucketKey, [conv]);
    }

    const freeRows: GroupedTaskRow[] = [];
    const snoozedRows: { row: GroupedTaskRow; until: number }[] = [];
    const waitingRows: { row: GroupedTaskRow; conversation: ConversationView }[] = [];
    const byProject = new Map<string, GroupedTaskRow[]>();

    for (const [key, convs] of taskBuckets.entries()) {
      convs.sort((a, b) => {
        const aAct =
          isConversationAwaitingPermission(a, props.sessions[a.id]) ||
          isConversationWorking(a, props.sessions[a.id])
            ? 1
            : 0;
        const bAct =
          isConversationAwaitingPermission(b, props.sessions[b.id]) ||
          isConversationWorking(b, props.sessions[b.id])
            ? 1
            : 0;
        if (aAct !== bAct) return bAct - aAct;
        return (b.lastInteractedAt ?? '').localeCompare(a.lastInteractedAt ?? '');
      });

      const primary = convs[0]!;
      const working = convs.some((c) => isConversationWorking(c, props.sessions[c.id]));
      const awaitingPermission = convs.some((c) =>
        isConversationAwaitingPermission(c, props.sessions[c.id])
      );
      const providers = [...new Set(convs.map((c) => c.providerId).filter(Boolean))].slice(0, 4);
      const project = projectById.get(primary.projectId);
      const stat = project?.repositoryWorkspaceId
        ? props.taskStats[project.repositoryWorkspaceId]
        : undefined;

      // Filtre uygula

      if (q) {
        const matchesTitle = convs.some((c) => c.title.toLowerCase().includes(q));
        const matchesProj = project?.name.toLowerCase().includes(q) ?? false;
        const matchesAgent = providers.some((id) =>
          providerDisplayName(id, props.agentNames).toLowerCase().includes(q)
        );
        if (!matchesTitle && !matchesProj && !matchesAgent) continue;
      }

      const row: GroupedTaskRow = {
        key,
        taskId: primary.taskId,
        projectId: primary.projectId,
        projectName: isFreeChatProjectId(primary.projectId) ? undefined : project?.name,
        workspaceId: project?.repositoryWorkspaceId ?? undefined,
        title: primary.title,
        conversations: convs,
        primaryConversation: primary,
        providers,
        working,
        awaitingPermission,
        lastAt: primary.lastInteractedAt ?? '',
        stat,
      };

      const snooze = getSnooze(props.snoozes, row.projectId, row.taskId);
      if (snooze) {
        snoozedRows.push({ row, until: snooze.until });
        continue;
      }
      if (filter !== 'done') {
        for (const conversation of convs) {
          if (
            (props.sessions[conversation.id]?.pendingPermissionCount ?? 0) > 0 ||
            (!conversation.agentStatusSeen &&
              (conversation.agentStatus === 'awaiting-input' ||
                conversation.agentStatus === 'error'))
          ) {
            waitingRows.push({ row, conversation });
          }
        }
      }
      if (filter === 'active' && !working && !awaitingPermission) continue;
      if (filter === 'done' && (working || awaitingPermission)) continue;
      if (isFreeChatProjectId(primary.projectId) || !project) {
        freeRows.push(row);
      } else {
        const arr = byProject.get(project.id);
        if (arr) arr.push(row);
        else byProject.set(project.id, [row]);
      }
    }

    const sortRows = (rows: GroupedTaskRow[]) =>
      rows.sort((a, b) => {
        const aPin = pinnedChatSet.has(a.key) ? 1 : 0;
        const bPin = pinnedChatSet.has(b.key) ? 1 : 0;
        if (aPin !== bPin) return bPin - aPin;
        const aScore = a.awaitingPermission ? 2 : a.working ? 1 : 0;
        const bScore = b.awaitingPermission ? 2 : b.working ? 1 : 0;
        if (aScore !== bScore) return bScore - aScore;
        return b.lastAt.localeCompare(a.lastAt);
      });

    sortRows(freeRows);
    for (const rows of byProject.values()) sortRows(rows);

    const pinnedRows: GroupedTaskRow[] = [];
    for (const r of freeRows) {
      if (pinnedChatSet.has(r.key)) pinnedRows.push(r);
    }
    for (const rows of byProject.values()) {
      for (const r of rows) {
        if (pinnedChatSet.has(r.key)) pinnedRows.push(r);
      }
    }
    pinnedRows.sort((a, b) => {
      const ai = pinnedChatKeys.indexOf(a.key);
      const bi = pinnedChatKeys.indexOf(b.key);
      return ai - bi;
    });

    const visibleProjects = props.projects
      .filter((p) => !isFreeChatProjectId(p.id))
      .filter((p) => {
        const rows = byProject.get(p.id) ?? [];
        if (filter !== 'all') return rows.length > 0;
        if (q) return rows.length > 0 || p.name.toLowerCase().includes(q);
        return true;
      })
      .sort((a, b) => {
        const aPin = pinnedProjectSet.has(a.id) ? 1 : 0;
        const bPin = pinnedProjectSet.has(b.id) ? 1 : 0;
        if (aPin !== bPin) return bPin - aPin;
        const aRows = byProject.get(a.id) ?? [];
        const bRows = byProject.get(b.id) ?? [];
        const aLive = aRows.some((r) => r.working || r.awaitingPermission) ? 1 : 0;
        const bLive = bRows.some((r) => r.working || r.awaitingPermission) ? 1 : 0;
        if (aLive !== bLive) return bLive - aLive;
        const aLatest = aRows[0]?.lastAt ?? '';
        const bLatest = bRows[0]?.lastAt ?? '';
        if (aLatest !== bLatest) return bLatest.localeCompare(aLatest);
        return a.name.localeCompare(b.name, 'tr');
      });

    return {
      freeRows,
      pinnedRows,
      byProject,
      visibleProjects,
      waitingRows,
      snoozedRows: snoozedRows.sort((a, b) => a.until - b.until),
    };
  }, [
    props.conversations,
    props.projects,
    props.sessions,
    props.taskStats,
    props.snoozes,
    props.agentNames,
    projectById,
    pinnedChatSet,
    pinnedChatKeys,
    pinnedProjectSet,
    filter,
    q,
  ]);

  const cleanHost = props.hostName.replace(/\.local$/i, '') || 'Bilgisayar';

  function openGroupedRow(row: GroupedTaskRow, conversation = row.primaryConversation): void {
    triggerHaptic('light');
    const c = conversation;
    props.push({
      name: 'chat',
      conversationId: c.id,
      title: c.title,
      providerId: c.providerId,
      projectId: row.projectId,
      projectName: row.projectName,
      taskId: row.taskId,
      taskName: row.title,
      workspaceId: row.workspaceId,
    });
  }

  const showAllForFilter = Boolean(q) || filter !== 'all';
  const hiddenFreeCount = Math.max(0, groupedByProject.freeRows.length - PROJECT_INITIAL_VISIBLE_TASKS);
  const shownFreeRows =
    showAllForFilter || freeChatsExpanded
      ? groupedByProject.freeRows
      : groupedByProject.freeRows.slice(0, PROJECT_INITIAL_VISIBLE_TASKS);

  const freeChatsSection =
    (!q && filter === 'all') || groupedByProject.freeRows.length > 0 ? (
      <section className={`mac-tree-section${freeChatsPinned ? ' is-pinned-section' : ''}`}>
        <div className="mac-section-head">
          <span className="mac-section-label">
            <SparklesIcon size={13} className="icon-accent" />
            <span>Serbest Sohbetler</span>
            {freeChatsPinned ? <span className="mac-pinned-chip">Sabit</span> : null}
          </span>
          <div className="mac-section-actions">
            <button
              type="button"
              className={`mac-section-icon-btn${freeChatsPinned ? ' is-pinned' : ''}`}
              onClick={toggleFreeChatsPin}
              aria-label={
                freeChatsPinned
                  ? 'Serbest sohbet sabitlemesini kaldır'
                  : 'Serbest sohbetleri başa sabitle'
              }
              title={freeChatsPinned ? 'Sabitlemeyi kaldır (alta al)' : 'Başa sabitle'}
            >
              <PinIcon size={14} />
            </button>
            <button
              type="button"
              className="mac-section-icon-btn"
              onClick={() => {
                triggerHaptic('medium');
                props.onStartFreeChat(props.selectedAgentId);
              }}
              aria-label="Yeni serbest sohbet"
              title="Yeni serbest sohbet"
            >
              <PlusIcon size={15} />
            </button>
          </div>
        </div>
        <button
          type="button"
          className="free-chat-cta-row"
          onClick={() => {
            triggerHaptic('medium');
            props.onStartFreeChat(props.selectedAgentId);
          }}
        >
          <SparklesIcon size={15} className="icon-accent" />
          <span>
            Yeni serbest sohbet başlat (
            {providerDisplayName(props.selectedAgentId, props.agentNames)})
          </span>
          <ChevronRightIcon size={15} className="row-chevron" />
        </button>
        {groupedByProject.freeRows.length > 0 ? (
          <div className="mac-task-list">
            {shownFreeRows.map((row) => (
              <MacTaskRow
                key={row.key}
                row={row}
                pinned={pinnedChatSet.has(row.key)}
                agentNames={props.agentNames}
                onOpen={() => openGroupedRow(row)}
                onTogglePin={() => toggleChatPin(row.key)}
                onSnooze={row.taskId ? () => setSnoozeMenu(row) : undefined}
              />
            ))}
            {!showAllForFilter && hiddenFreeCount > 0 ? (
              <button
                type="button"
                className="mac-project-more-btn"
                onClick={() => {
                  triggerHaptic('light');
                  setFreeChatsExpanded((prev) => !prev);
                }}
              >
                {freeChatsExpanded ? 'Daha az göster' : `Daha fazla göster (${hiddenFreeCount})`}
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    ) : null;

  return (
    <main className="screen screen-home">
      <WorkbenchHeader
        title="Sovra"
        brandMark
        onMenu={props.onOpenMenu}
        badgeCount={alertCount}
        trailing={
          <div className="home-header-right">
            <ConnectionPill
              status={props.status}
              hostName={cleanHost}
              showChevron
              onClick={() => {
                triggerHaptic('light');
                props.onOpenHostSwitcher();
              }}
            />
            <button
              type="button"
              className="wb-icon-btn sm"
              onClick={() => {
                triggerHaptic('light');
                props.onRefreshAll();
              }}
              aria-label="Yenile"
              title="Verileri yenile"
            >
              <RefreshIcon size={16} />
            </button>
            <button
              type="button"
              className="wb-icon-btn sm"
              onClick={() => {
                triggerHaptic('light');
                props.onOpenNotifications();
              }}
              aria-label="Bildirimler"
              title="Bildirimler"
            >
              <BellIcon size={18} />
              {props.unreadNotificationCount > 0 ? (
                <span className="wb-icon-badge is-accent" aria-hidden="true">
                  {props.unreadNotificationCount > 9 ? '9+' : props.unreadNotificationCount}
                </span>
              ) : null}
            </button>
          </div>
        }
      />

      <div className="screen-body with-dock mac-home-body">
        <ErrorNote message={props.projectsError} />

        {/* Mac Sidebar Üst Satırı: Arama + Projesiz Serbest Sohbet Düğmesi */}
        <div className="mac-search-row">
          <div className="search-field flex1">
            <SearchIcon size={15} className="search-field-icon" />
            <input
              type="search"
              className="search-field-input mac-search-input"
              value={search}
              placeholder="Sohbet veya proje filtrele…"
              onChange={(event) => setSearch(event.target.value)}
            />
            {search ? (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => setSearch('')}
                aria-label="Aramayı temizle"
              >
                <XIcon size={14} />
              </button>
            ) : null}
          </div>
          <button
            type="button"
            className="mac-new-free-btn"
            onClick={() => {
              triggerHaptic('medium');
              props.onStartFreeChat(props.selectedAgentId);
            }}
            aria-label="Projesiz serbest sohbet başlat"
            title="Projesiz serbest sohbet başlat"
          >
            <MessageSquareIcon size={17} />
          </button>
        </div>

        {/* Mac 3'lü Segmented Filtre: Tümü | Aktif | Tamamlandı */}
        <div className="segmented mac-filter-seg" role="tablist" aria-label="Sohbet filtresi">
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'all'}
            className={`segmented-btn ${filter === 'all' ? 'is-active' : ''}`}
            onClick={() => setFilter('all')}
          >
            Tümü
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'active'}
            className={`segmented-btn ${filter === 'active' ? 'is-active' : ''}`}
            onClick={() => setFilter('active')}
          >
            Aktif{activeWork.length > 0 ? ` (${activeWork.length})` : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'done'}
            className={`segmented-btn ${filter === 'done' ? 'is-active' : ''}`}
            onClick={() => setFilter('done')}
          >
            Tamamlandı
          </button>
        </div>

        {/* Tek Satır Hızlı Ajan & Kota Şeridi */}
        {!q ? (
          <div className="quick-agent-rail" role="radiogroup" aria-label="Varsayılan ajan">
            {CORE_USAGE_PROVIDERS.map((id) => {
              const selected = props.selectedAgentId === id;
              const rem = primaryRemainingPercent(props.usage[id]);
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`quick-agent-chip ${selected ? 'is-selected' : ''}`}
                  onClick={() => {
                    triggerHaptic('light');
                    props.onSelectAgent(id);
                  }}
                >
                  <ProviderAvatar providerId={id} size="sm" names={props.agentNames} />
                  <span>{providerDisplayName(id, props.agentNames)}</span>
                  {rem !== null ? (
                    <span className={`quick-agent-pct is-${quotaTone(rem)}`}>%{rem}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}

        {props.snoozeError ? <ErrorNote message={props.snoozeError} /> : null}
        {groupedByProject.waitingRows.length ? (
          <section className="mac-tree-section">
            <div className="mac-section-head">
              <span className="mac-section-label">
                <BellIcon size={14} /> Seni bekleyenler
              </span>
            </div>
            <div className="mac-task-list">
              {groupedByProject.waitingRows.map(({ row, conversation }) => (
                <MacTaskRow
                  key={conversation.id}
                  row={{ ...row, title: conversation.title, providers: [conversation.providerId] }}
                  showProjectBadge
                  agentNames={props.agentNames}
                  onOpen={() => openGroupedRow(row, conversation)}
                  onTogglePin={() => toggleChatPin(row.key)}
                  onSnooze={row.taskId ? () => setSnoozeMenu(row) : undefined}
                />
              ))}
            </div>
          </section>
        ) : null}
        {groupedByProject.snoozedRows.length ? (
          <section className="mac-tree-section">
            <div className="mac-section-head">
              <span className="mac-section-label">
                <ClockIcon size={14} /> Ertelenenler
              </span>
            </div>
            <div className="mac-task-list">
              {groupedByProject.snoozedRows.map(({ row, until }) => (
                <div key={row.key} className="mac-tree-section">
                  <MacTaskRow
                    row={row}
                    showProjectBadge
                    agentNames={props.agentNames}
                    onOpen={() => openGroupedRow(row)}
                    onTogglePin={() => toggleChatPin(row.key)}
                  />
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => void props.onUpdateSnooze(row.projectId, row.taskId, null)}
                  >
                    Uyandır ·{' '}
                    {new Date(until).toLocaleString('tr-TR', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {snoozeMenu ? (
          <TaskSnoozeSheet
            title={snoozeMenu.title}
            error={props.snoozeError}
            onSelect={(durationMs) =>
              props.onUpdateSnooze(snoozeMenu.projectId, snoozeMenu.taskId, durationMs)
            }
            onClose={() => setSnoozeMenu(null)}
          />
        ) : null}
        {/* Sabitlenmiş Sohbetler (yalnızca sabitlediğinde en üstte çıkar) */}
        {groupedByProject.pinnedRows.length > 0 ? (
          <section className="mac-tree-section is-pinned-section">
            <div className="mac-section-head">
              <span className="mac-section-label">
                <PinIcon size={13} className="icon-accent" />
                <span>Sabitlenenler</span>
              </span>
            </div>
            <div className="mac-task-list">
              {groupedByProject.pinnedRows.map((row) => (
                <MacTaskRow
                  key={`pin:${row.key}`}
                  row={row}
                  pinned
                  showProjectBadge
                  agentNames={props.agentNames}
                  onOpen={() => openGroupedRow(row)}
                  onTogglePin={() => toggleChatPin(row.key)}
                  onSnooze={row.taskId ? () => setSnoozeMenu(row) : undefined}
                />
              ))}
            </div>
          </section>
        ) : null}

        {/* Serbest Sohbetler yalnızca başa sabitlendiyse Projeler'den önce gösterilir */}
        {freeChatsPinned ? freeChatsSection : null}

        {/* Mac Sidebar Projeler Ağacı (Varsayılan olarak EN BAŞTA!) */}
        <section className="mac-tree-section">
          <div className="mac-section-head">
            <span className="mac-section-label">Projeler</span>
            <div className="mac-section-actions">
              <button
                type="button"
                className="mac-section-icon-btn"
                onClick={() => {
                  triggerHaptic('light');
                  props.onOpenCreate('project');
                }}
                aria-label="Yeni proje"
                title="Yeni proje"
              >
                <FolderPlusIcon size={16} />
              </button>
            </div>
          </div>

          {props.projectsLoading && groupedByProject.visibleProjects.length === 0 ? (
            <Loading label="Projeler yükleniyor…" />
          ) : null}

          {!props.projectsLoading &&
          groupedByProject.visibleProjects.length === 0 &&
          groupedByProject.freeRows.length === 0 ? (
            <Empty
              icon={<SovraMark size={38} />}
              title={q ? 'Eşleşen sohbet yok' : 'Gösterilecek sohbet yok'}
            >
              {q
                ? 'Farklı bir arama terimi deneyin.'
                : filter === 'active'
                  ? 'Şu anda aktif çalışan bir ajan bulunmuyor.'
                  : 'Aşağıdaki serbest sohbet düğmesiyle veya yeni proje oluşturarak hemen başlayabilirsin.'}
            </Empty>
          ) : (
            <div className="mac-project-tree">
              {groupedByProject.visibleProjects.map((project) => {
                const rows = groupedByProject.byProject.get(project.id) ?? [];
                const hasLive = rows.some((r) => r.working || r.awaitingPermission);
                const collapsed = Boolean(collapsedProjects[project.id]);
                const projectPinned = pinnedProjectSet.has(project.id);
                const listExpanded = showAllForFilter || Boolean(expandedProjectLists[project.id]);
                const hiddenCount = Math.max(0, rows.length - PROJECT_INITIAL_VISIBLE_TASKS);
                const shownRows = listExpanded
                  ? rows
                  : rows.slice(0, PROJECT_INITIAL_VISIBLE_TASKS);
                return (
                  <div key={project.id} className="mac-project-group">
                    <div className="mac-project-head">
                      <button
                        type="button"
                        className="mac-project-toggle"
                        onClick={() => {
                          triggerHaptic('light');
                          const nextCollapsed = !collapsed;
                          setCollapsedProjects((prev) => ({
                            ...prev,
                            [project.id]: nextCollapsed,
                          }));
                          if (nextCollapsed) {
                            setExpandedProjectLists((prev) => {
                              if (!prev[project.id]) return prev;
                              const next = { ...prev };
                              delete next[project.id];
                              return next;
                            });
                          }
                        }}
                        aria-expanded={!collapsed}
                      >
                        {project.remote ? (
                          <ServerIcon size={15} className="mac-project-icon" />
                        ) : (
                          <FolderIcon size={15} className="mac-project-icon" />
                        )}
                        <span className="mac-project-name">{project.name}</span>
                        {projectPinned ? (
                          <PinIcon size={11} className="mac-project-pin-mark" />
                        ) : null}
                        {hasLive ? (
                          <span className="mac-project-live-dot" aria-label="Aktif" />
                        ) : null}
                        {collapsed ? (
                          <ChevronRightIcon size={14} className="mac-project-caret" />
                        ) : (
                          <ChevronDownIcon size={14} className="mac-project-caret" />
                        )}
                      </button>
                      <button
                        type="button"
                        className={`mac-project-pin-btn${projectPinned ? ' is-pinned' : ''}`}
                        onClick={() => toggleProjectPin(project.id)}
                        aria-label={
                          projectPinned
                            ? `${project.name} sabitlemesini kaldır`
                            : `${project.name} projesini başa sabitle`
                        }
                        title={projectPinned ? 'Sabitlemeyi kaldır' : 'Başa sabitle'}
                      >
                        <PinIcon size={13} />
                      </button>
                      <button
                        type="button"
                        className="mac-project-add-btn"
                        onClick={() => {
                          triggerHaptic('medium');
                          props.onQuickStartChat(project.id, props.selectedAgentId);
                        }}
                        aria-label={`${project.name} içinde yeni sohbet`}
                        title={`${project.name} içinde yeni sohbet`}
                      >
                        <PlusIcon size={14} />
                      </button>
                    </div>

                    {!collapsed ? (
                      rows.length === 0 ? (
                        <button
                          type="button"
                          className="mac-project-empty-btn"
                          onClick={() => props.onQuickStartChat(project.id, props.selectedAgentId)}
                        >
                          + İlk sohbeti başlat
                        </button>
                      ) : (
                        <div className="mac-task-list is-indented">
                          {shownRows.map((row) => (
                            <MacTaskRow
                              key={row.key}
                              row={row}
                              pinned={pinnedChatSet.has(row.key)}
                              agentNames={props.agentNames}
                              onOpen={() => openGroupedRow(row)}
                              onTogglePin={() => toggleChatPin(row.key)}
                              onSnooze={row.taskId ? () => setSnoozeMenu(row) : undefined}
                            />
                          ))}
                          {!showAllForFilter && hiddenCount > 0 ? (
                            <button
                              type="button"
                              className="mac-project-more-btn"
                              onClick={() => {
                                triggerHaptic('light');
                                setExpandedProjectLists((prev) => ({
                                  ...prev,
                                  [project.id]: !prev[project.id],
                                }));
                              }}
                            >
                              {expandedProjectLists[project.id]
                                ? 'Daha az göster'
                                : `Daha fazla göster (${hiddenCount})`}
                            </button>
                          ) : null}
                        </div>
                      )
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Varsayılan konum: Projeler bittikten hemen sonra EN ALTTA Serbest Sohbetler */}
        {!freeChatsPinned ? freeChatsSection : null}
      </div>
    </main>
  );
}

function MacTaskRow(props: {
  row: GroupedTaskRow;
  pinned?: boolean;
  showProjectBadge?: boolean;
  agentNames: Record<string, string>;
  onOpen: () => void;
  onTogglePin: () => void;
  onSnooze?: () => void;
}) {
  const { row } = props;
  const stat = row.stat;
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);

  function startHold(): void {
    longPressed.current = false;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      longPressed.current = true;
      props.onTogglePin();
    }, 450);
  }

  function cancelHold(): void {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }

  return (
    <div className={`mac-task-row-wrap${props.pinned ? ' is-pinned' : ''}`}>
      <button
        type="button"
        className={`mac-task-row ${row.awaitingPermission ? 'is-alert' : row.working ? 'is-live' : ''}`}
        onPointerDown={startHold}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onPointerCancel={cancelHold}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onTogglePin();
        }}
        onClick={() => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          props.onOpen();
        }}
      >
        <span className="mac-task-title-wrap">
          <span className="mac-task-title">{row.title}</span>
          {props.showProjectBadge && row.projectName ? (
            <span className="mac-task-proj-sub">{row.projectName}</span>
          ) : null}
        </span>

        {/* Üst üste binen çoklu yapay zeka ikon yığını */}
        <span className="mac-avatar-stack" aria-hidden="true">
          {row.providers.map((pid) => (
            <span key={pid} className="mac-avatar-stack-item">
              <ProviderAvatar providerId={pid} size="sm" names={props.agentNames} />
            </span>
          ))}
        </span>

        {/* Canlı Git diff istatistikleri (+14k -1k) */}
        {stat && (stat.additions > 0 || stat.deletions > 0) ? (
          <span className="mac-task-diff mono">
            {stat.additions > 0 ? (
              <span className="is-add">+{formatCompactCount(stat.additions)}</span>
            ) : null}
            {stat.deletions > 0 ? (
              <span className="is-del">-{formatCompactCount(stat.deletions)}</span>
            ) : null}
          </span>
        ) : null}

        {/* Sağ durum yuvası: onay uyarısı / yeşil halka / kısa zaman */}
        <span className="mac-task-tail">
          {row.awaitingPermission ? (
            <span className="mac-status-stop" title="Onay bekliyor">
              <ShieldAlertIcon size={12} />
            </span>
          ) : row.working ? (
            <span className="mac-status-ring" title="Çalışıyor" />
          ) : (
            <span className="mac-task-time">{formatMacShortTime(row.lastAt)}</span>
          )}
        </span>
      </button>
      {props.onSnooze ? (
        <button
          type="button"
          className="mac-section-icon-btn"
          onClick={props.onSnooze}
          aria-label={`${row.title} görevini ertele`}
          title="Ertele"
        >
          <ClockIcon size={15} />
        </button>
      ) : null}
      {props.pinned ? (
        <button
          type="button"
          className="mac-task-pin-btn is-pinned"
          onClick={props.onTogglePin}
          aria-label="Sabitlemeyi kaldır"
          title="Sabitlemeyi kaldır"
        >
          <PinIcon size={12} />
        </button>
      ) : null}
    </div>
  );
}
