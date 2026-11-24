import { useMemo, useState } from 'react';
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
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
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

type TreeFilter = 'all' | 'active' | 'done';

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
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TreeFilter>('all');
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const q = search.trim().toLowerCase();

  const activeWork = useMemo(
    () => buildActiveWorkList(props.conversations, props.sessions),
    [props.conversations, props.sessions]
  );
  const alertCount = activeWork.reduce((sum, entry) => sum + (entry.awaitingInput ? 1 : 0), 0);

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
      if (filter === 'active' && !working && !awaitingPermission) continue;
      if (filter === 'done' && (working || awaitingPermission)) continue;

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
        const aScore = a.awaitingPermission ? 2 : a.working ? 1 : 0;
        const bScore = b.awaitingPermission ? 2 : b.working ? 1 : 0;
        if (aScore !== bScore) return bScore - aScore;
        return b.lastAt.localeCompare(a.lastAt);
      });

    sortRows(freeRows);
    for (const rows of byProject.values()) sortRows(rows);

    const visibleProjects = props.projects
      .filter((p) => !isFreeChatProjectId(p.id))
      .filter((p) => {
        const rows = byProject.get(p.id) ?? [];
        if (filter !== 'all') return rows.length > 0;
        if (q) return rows.length > 0 || p.name.toLowerCase().includes(q);
        return true;
      })
      .sort((a, b) => {
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

    return { freeRows, byProject, visibleProjects };
  }, [props.conversations, props.projects, props.sessions, props.taskStats, props.agentNames, projectById, filter, q]);

  const cleanHost = props.hostName.replace(/\.local$/i, '') || 'Bilgisayar';

  function openGroupedRow(row: GroupedTaskRow): void {
    triggerHaptic('light');
    const c = row.primaryConversation;
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

        {/* Projesiz Serbest Sohbetler Bölümü */}
        {(!q && filter === 'all') || groupedByProject.freeRows.length > 0 ? (
          <section className="mac-tree-section">
            <div className="mac-section-head">
              <span className="mac-section-label">
                <SparklesIcon size={13} className="icon-accent" />
                <span>Serbest Sohbetler</span>
              </span>
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
            {groupedByProject.freeRows.length === 0 ? (
              <button
                type="button"
                className="free-chat-cta-row"
                onClick={() => {
                  triggerHaptic('medium');
                  props.onStartFreeChat(props.selectedAgentId);
                }}
              >
                <SparklesIcon size={15} className="icon-accent" />
                <span>Proje seçmeden boş sohbet başlat ({providerDisplayName(props.selectedAgentId, props.agentNames)})</span>
                <ChevronRightIcon size={15} className="row-chevron" />
              </button>
            ) : (
              <div className="mac-task-list">
                {groupedByProject.freeRows.slice(0, 12).map((row) => (
                  <MacTaskRow
                    key={row.key}
                    row={row}
                    agentNames={props.agentNames}
                    onOpen={() => openGroupedRow(row)}
                  />
                ))}
              </div>
            )}
          </section>
        ) : null}

        {/* Mac Sidebar Projeler Ağacı */}
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
                  : 'Yukarıdaki serbest sohbet düğmesiyle veya yeni proje oluşturarak hemen başlayabilirsin.'}
            </Empty>
          ) : (
            <div className="mac-project-tree">
              {groupedByProject.visibleProjects.map((project) => {
                const rows = groupedByProject.byProject.get(project.id) ?? [];
                const hasLive = rows.some((r) => r.working || r.awaitingPermission);
                const collapsed = Boolean(collapsedProjects[project.id]);
                const shownRows = q ? rows : rows.slice(0, 8);
                return (
                  <div key={project.id} className="mac-project-group">
                    <div className="mac-project-head">
                      <button
                        type="button"
                        className="mac-project-toggle"
                        onClick={() => {
                          triggerHaptic('light');
                          setCollapsedProjects((prev) => ({
                            ...prev,
                            [project.id]: !prev[project.id],
                          }));
                        }}
                        aria-expanded={!collapsed}
                      >
                        {project.remote ? (
                          <ServerIcon size={15} className="mac-project-icon" />
                        ) : (
                          <FolderIcon size={15} className="mac-project-icon" />
                        )}
                        <span className="mac-project-name">{project.name}</span>
                        {hasLive ? <span className="mac-project-live-dot" aria-label="Aktif" /> : null}
                        {collapsed ? (
                          <ChevronRightIcon size={14} className="mac-project-caret" />
                        ) : (
                          <ChevronDownIcon size={14} className="mac-project-caret" />
                        )}
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
                              agentNames={props.agentNames}
                              onOpen={() => openGroupedRow(row)}
                            />
                          ))}
                          {rows.length > shownRows.length ? (
                            <button
                              type="button"
                              className="mac-project-more-btn"
                              onClick={() =>
                                props.push({
                                  name: 'tasks',
                                  projectId: project.id,
                                  projectName: project.name,
                                })
                              }
                            >
                              Tümünü gör ({rows.length}) ›
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
      </div>
    </main>
  );
}

function MacTaskRow(props: {
  row: GroupedTaskRow;
  agentNames: Record<string, string>;
  onOpen: () => void;
}) {
  const { row } = props;
  const stat = row.stat;
  return (
    <button
      type="button"
      className={`mac-task-row ${row.awaitingPermission ? 'is-alert' : row.working ? 'is-live' : ''}`}
      onClick={props.onOpen}
    >
      <span className="mac-task-title">{row.title}</span>

      {/* Üst üste binen çoklu yapay zeka ikon yığını (Mac görseliyle birebir!) */}
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
  );
}
