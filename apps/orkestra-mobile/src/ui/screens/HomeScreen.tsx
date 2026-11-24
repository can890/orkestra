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
} from '@/core/mappers';
import { triggerHaptic } from '@/core/native-bridge';
import {
  ConnectionPill,
  Empty,
  ErrorNote,
  Loading,
  SovraMark,
  WorkbenchHeader,
  providerDisplayName,
  relativeTime,
} from '../components';
import type { CreateMode } from '../CreateModal';
import {
  BellIcon,
  ChevronRightIcon,
  FolderPlusIcon,
  GaugeIcon,
  MessageSquareIcon,
  RefreshIcon,
  SearchIcon,
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

type ChatFilter = 'all' | 'active' | 'approval';
const INITIAL_CHAT_LIMIT = 18;

export function HomeScreen(props: {
  projects: ProjectView[];
  projectsLoading: boolean;
  projectsError: string | null;
  conversations: ConversationView[];
  conversationsLoading: boolean;
  sessions: Record<string, SessionSummaryView>;
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
  onQuickStartChat: (projectId?: string, providerId?: string) => void;
  push: (route: Route) => void;
  replace: (route: Route) => void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ChatFilter>('all');
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_CHAT_LIMIT);
  const q = search.trim().toLowerCase();

  const projectById = useMemo(
    () => new Map(props.projects.map((p) => [p.id, p])),
    [props.projects]
  );

  const activeWork = useMemo(
    () => buildActiveWorkList(props.conversations, props.sessions),
    [props.conversations, props.sessions]
  );

  const activeIds = useMemo(
    () => new Set(activeWork.map((item) => item.conversationId)),
    [activeWork]
  );

  const alertCount = activeWork.reduce((sum, entry) => sum + (entry.awaitingInput ? 1 : 0), 0);

  const filteredChats = useMemo(() => {
    const base = props.conversations
      .filter((c) => c.chatCapable)
      .slice()
      .sort((a, b) => {
        const aActive = activeIds.has(a.id) ? 1 : 0;
        const bActive = activeIds.has(b.id) ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return (b.lastInteractedAt ?? '').localeCompare(a.lastInteractedAt ?? '');
      });

    const byFilter = base.filter((c) => {
      if (filter === 'all') return true;
      const live = props.sessions[c.id];
      if (filter === 'active') {
        return isConversationWorking(c, live) || isConversationAwaitingPermission(c, live);
      }
      return isConversationAwaitingPermission(c, live);
    });

    if (!q) return byFilter;
    return byFilter.filter((c) => {
      const proj = projectById.get(c.projectId);
      return (
        c.title.toLowerCase().includes(q) ||
        (proj && proj.name.toLowerCase().includes(q)) ||
        providerDisplayName(c.providerId, props.agentNames).toLowerCase().includes(q)
      );
    });
  }, [props.conversations, props.sessions, activeIds, filter, projectById, props.agentNames, q]);

  const recentChats = q ? filteredChats.slice(0, 40) : filteredChats.slice(0, visibleLimit);
  const remainingCount = Math.max(0, filteredChats.length - recentChats.length);

  const quotaHighlights = useMemo(() => {
    return CORE_USAGE_PROVIDERS.map((id) => ({
      id,
      usage: props.usage[id],
      remaining: primaryRemainingPercent(props.usage[id]),
    })).filter((item) => item.remaining !== null);
  }, [props.usage]);

  const quickAgentChoices = useMemo(() => {
    const ids = new Set<string>(CORE_USAGE_PROVIDERS);
    if (props.selectedAgentId) ids.add(props.selectedAgentId);
    return [...ids];
  }, [props.selectedAgentId]);

  const selectedAgentName = providerDisplayName(props.selectedAgentId, props.agentNames);
  const cleanHost = props.hostName.replace(/\.local$/i, '') || 'Bilgisayar';

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

      <div className="screen-body with-dock">
        <ErrorNote message={props.projectsError} />

        {/* EN ÜST: Aktif çalışan veya onay bekleyen işler */}
        {activeWork.length > 0 && !q ? (
          <section className="wb-section active-work-section">
            <div className="wb-section-head">
              <span className="wb-section-title is-live-title">
                <span className="status-dot is-working sm" />
                <span>Şu an aktif ({cleanHost})</span>
              </span>
              <span className="wb-badge accent">{activeWork.length}</span>
            </div>
            <div className="chat-card-list">
              {activeWork.map((item) => {
                const project = item.projectId ? projectById.get(item.projectId) : undefined;
                const providerLabel = providerDisplayName(item.providerId, props.agentNames);
                const needsPerm = item.awaitingInput;
                return (
                  <button
                    key={item.conversationId}
                    type="button"
                    disabled={!item.chatCapable}
                    className={`chat-item-card ${needsPerm ? 'is-alert' : 'is-live'}`}
                    onClick={() => {
                      if (!item.chatCapable) return;
                      triggerHaptic('light');
                      props.push({
                        name: 'chat',
                        conversationId: item.conversationId,
                        title: item.title,
                        providerId: item.providerId,
                        projectId: item.projectId,
                        projectName: project?.name,
                        taskId: item.taskId,
                        workspaceId: project?.repositoryWorkspaceId ?? undefined,
                      });
                    }}
                  >
                    <div className="chat-avatar-wrap">
                      <ProviderAvatar
                        providerId={item.providerId}
                        size="md"
                        names={props.agentNames}
                      />
                      <span
                        className={`avatar-status-badge ${needsPerm ? 'is-warn' : 'is-working'}`}
                      />
                    </div>
                    <div className="chat-item-main">
                      <div className="chat-item-top">
                        <span className="chat-item-title">{item.title}</span>
                        <span className={`live-pill ${needsPerm ? 'is-warn' : 'is-working'}`}>
                          {needsPerm ? 'Onay' : 'Canlı'}
                        </span>
                      </div>
                      <span className="chat-item-meta">
                        {needsPerm ? (
                          <span className="text-warn meta-inline-icon">
                            <ShieldAlertIcon size={12} />
                            <span>
                              {item.pendingPermissionCount > 0
                                ? `${item.pendingPermissionCount} izin onayı bekliyor`
                                : 'Yanıt bekliyor'}
                            </span>
                          </span>
                        ) : (
                          <span className="text-accent">
                            {cleanHost} üzerinde çalışıyor…
                            {item.backgroundAgentCount > 0
                              ? ` · +${item.backgroundAgentCount} alt ajan`
                              : ''}
                          </span>
                        )}
                        {project ? <span className="proj-pill">{project.name}</span> : null}
                        <span className="agent-sub-label">{providerLabel}</span>
                      </span>
                    </div>
                    {item.chatCapable ? (
                      <ChevronRightIcon size={16} className="row-chevron" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* Kompakt Hızlı Başlat Kartı — 1 dokunuşla ajan seç ve sohbete gir */}
        {!q ? (
          <section className="quick-launch-card" aria-label="Hızlı başlat">
            <div className="quick-agent-rail" role="radiogroup" aria-label="Ajan seçimi">
              {quickAgentChoices.map((id) => {
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

            <div className="quick-launch-actions">
              <button
                type="button"
                className="btn btn-primary quick-launch-cta"
                onClick={() => {
                  triggerHaptic('medium');
                  props.onQuickStartChat(undefined, props.selectedAgentId);
                }}
              >
                <SparklesIcon size={15} />
                <span>{selectedAgentName} ile başlat</span>
              </button>
              <button
                type="button"
                className="btn btn-glass quick-launch-icon-btn"
                onClick={() => {
                  triggerHaptic('light');
                  props.onOpenCreate('task');
                }}
                title="Özel görev oluştur"
                aria-label="Özel görev oluştur"
              >
                <MessageSquareIcon size={15} />
                <span>Görev</span>
              </button>
              <button
                type="button"
                className="btn btn-glass quick-launch-icon-btn"
                onClick={() => {
                  triggerHaptic('light');
                  props.onOpenCreate('project');
                }}
                title="Yeni proje oluştur"
                aria-label="Yeni proje oluştur"
              >
                <FolderPlusIcon size={15} />
              </button>
            </div>
          </section>
        ) : null}

        {/* Kompakt Canlı Kota Şeridi */}
        {!q && quotaHighlights.length > 0 ? (
          <div className="quota-glance-row" aria-label="Kota özeti">
            {quotaHighlights.map(({ id, remaining }) => {
              const rem = remaining!;
              const tone = quotaTone(rem);
              return (
                <button
                  key={id}
                  type="button"
                  className="quota-glance-pill"
                  onClick={() => props.push({ name: 'accounts' })}
                >
                  <ProviderAvatar providerId={id} size="sm" names={props.agentNames} />
                  <span className="quota-glance-name">
                    {providerDisplayName(id, props.agentNames)}
                  </span>
                  <span className={`quota-glance-pct is-${tone}`}>%{rem}</span>
                </button>
              );
            })}
            <button
              type="button"
              className="quota-glance-more"
              onClick={() => props.push({ name: 'accounts' })}
              aria-label="Tüm limitler"
            >
              <GaugeIcon size={13} />
              <span>Tümü</span>
            </button>
          </div>
        ) : null}

        {/* Arama ve Hızlı Filtre */}
        <div className="search-filter-block">
          <div className="search-field">
            <SearchIcon size={15} className="search-field-icon" />
            <input
              type="search"
              className="search-field-input"
              value={search}
              placeholder="Sohbet, proje veya ajan ara…"
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

          <div className="filter-pills" role="tablist" aria-label="Sohbet filtresi">
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'all'}
              className={`filter-pill ${filter === 'all' ? 'is-active' : ''}`}
              onClick={() => setFilter('all')}
            >
              Tümü ({props.conversations.filter((c) => c.chatCapable).length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'active'}
              className={`filter-pill ${filter === 'active' ? 'is-active' : ''}`}
              onClick={() => setFilter('active')}
            >
              <span className="status-dot is-working sm" aria-hidden="true" />
              <span>Aktif ({activeWork.length})</span>
            </button>
            {alertCount > 0 || filter === 'approval' ? (
              <button
                type="button"
                role="tab"
                aria-selected={filter === 'approval'}
                className={`filter-pill ${filter === 'approval' ? 'is-active' : ''}`}
                onClick={() => setFilter('approval')}
              >
                <span>Onay ({alertCount})</span>
              </button>
            ) : null}
            {props.hostCount > 1 ? (
              <button
                type="button"
                className="filter-pill is-host-pill"
                onClick={() => {
                  triggerHaptic('light');
                  props.onOpenHostSwitcher();
                }}
              >
                <span>{cleanHost} ⇄</span>
              </button>
            ) : null}
          </div>
        </div>

        {/* Son Sohbetler */}
        <section className="wb-section">
          <div className="wb-section-head">
            <span className="wb-section-title">
              <MessageSquareIcon size={13} />
              <span>
                {filter === 'active'
                  ? 'Aktif sohbetler'
                  : filter === 'approval'
                    ? 'Onay bekleyen sohbetler'
                    : 'Son sohbetler'}
              </span>
            </span>
            {filteredChats.length > 0 ? (
              <span className="wb-badge">{filteredChats.length}</span>
            ) : null}
          </div>

          {props.conversationsLoading && recentChats.length === 0 ? (
            <Loading label="Sohbetler yükleniyor…" />
          ) : null}

          {!props.conversationsLoading && recentChats.length === 0 ? (
            <Empty
              icon={<SovraMark size={40} />}
              title={
                q
                  ? 'Eşleşen sohbet yok'
                  : filter !== 'all'
                    ? 'Bu filtrede sohbet yok'
                    : 'Henüz sohbet yok'
              }
            >
              {q
                ? 'Farklı bir arama terimi deneyin.'
                : filter !== 'all'
                  ? 'Tüm sohbetleri görmek için "Tümü" sekmesine geçebilirsiniz.'
                  : 'Yukarıdan bir yapay zeka seçip hemen ilk sohbetinizi başlatabilirsiniz.'}
            </Empty>
          ) : (
            <>
              <div className="chat-card-list">
                {recentChats.map((conv) => {
                  const project = projectById.get(conv.projectId);
                  const live = props.sessions[conv.id];
                  const isWorking = isConversationWorking(conv, live);
                  const needsPerm = isConversationAwaitingPermission(conv, live);
                  const providerLabel = providerDisplayName(conv.providerId, props.agentNames);
                  return (
                    <button
                      key={conv.id}
                      type="button"
                      className={`chat-item-card ${needsPerm ? 'is-alert' : isWorking ? 'is-live' : ''}`}
                      onClick={() => {
                        triggerHaptic('light');
                        props.push({
                          name: 'chat',
                          conversationId: conv.id,
                          title: conv.title,
                          providerId: conv.providerId,
                          projectId: conv.projectId,
                          projectName: project?.name,
                          taskId: conv.taskId,
                          workspaceId: project?.repositoryWorkspaceId ?? undefined,
                        });
                      }}
                    >
                      <div className="chat-avatar-wrap">
                        <ProviderAvatar
                          providerId={conv.providerId}
                          size="md"
                          names={props.agentNames}
                        />
                        {needsPerm ? (
                          <span className="avatar-status-badge is-warn" />
                        ) : isWorking ? (
                          <span className="avatar-status-badge is-working" />
                        ) : null}
                      </div>
                      <div className="chat-item-main">
                        <div className="chat-item-top">
                          <span className="chat-item-title">{conv.title}</span>
                          {isWorking ? (
                            <span className="live-pill is-working">Çalışıyor</span>
                          ) : needsPerm ? (
                            <span className="live-pill is-warn">Onay</span>
                          ) : conv.lastInteractedAt ? (
                            <span className="meta-time">{relativeTime(conv.lastInteractedAt)}</span>
                          ) : null}
                        </div>
                        <div className="chat-item-meta">
                          {project ? <span className="proj-pill">{project.name}</span> : null}
                          <span className="agent-sub-label">{providerLabel}</span>
                        </div>
                      </div>
                      <ChevronRightIcon size={15} className="row-chevron" />
                    </button>
                  );
                })}
              </div>

              {remainingCount > 0 && !q ? (
                <button
                  type="button"
                  className="btn btn-ghost full load-more-btn"
                  onClick={() => setVisibleLimit((prev) => prev + 20)}
                >
                  Daha fazla sohbet göster (+{remainingCount})
                </button>
              ) : null}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
