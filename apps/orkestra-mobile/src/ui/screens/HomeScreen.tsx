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
  SearchIcon,
  ShieldAlertIcon,
  SparklesIcon,
  XIcon,
} from '../icons';
import {
  CORE_USAGE_PROVIDERS,
  ProviderAvatar,
  QuotaRing,
  primaryRemainingPercent,
  quotaTone,
} from '../ProviderBrand';
import type { Route } from '../router';

type ChatFilter = 'all' | 'active' | 'approval';

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
  status: ConnectionStatus;
  unreadNotificationCount: number;
  lastAgentProviderId: string;
  onOpenNotifications: () => void;
  onOpenMenu: () => void;
  onOpenCreate: (mode: CreateMode, projectId?: string) => void;
  onQuickStartChat: (projectId?: string) => void;
  push: (route: Route) => void;
  replace: (route: Route) => void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ChatFilter>('all');
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

  const recentChats = useMemo(() => {
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

    if (!q) return byFilter.slice(0, 14);
    return byFilter
      .filter((c) => {
        const proj = projectById.get(c.projectId);
        return (
          c.title.toLowerCase().includes(q) ||
          (proj && proj.name.toLowerCase().includes(q)) ||
          providerDisplayName(c.providerId, props.agentNames).toLowerCase().includes(q)
        );
      })
      .slice(0, 20);
  }, [props.conversations, props.sessions, activeIds, filter, projectById, props.agentNames, q]);

  const quotaHighlights = useMemo(() => {
    return CORE_USAGE_PROVIDERS.map((id) => ({
      id,
      usage: props.usage[id],
      remaining: primaryRemainingPercent(props.usage[id]),
    })).filter((item) => item.remaining !== null);
  }, [props.usage]);

  const lastAgentName = providerDisplayName(props.lastAgentProviderId, props.agentNames);

  return (
    <main className="screen screen-home">
      <WorkbenchHeader
        title="Sovra"
        brandMark
        onMenu={props.onOpenMenu}
        badgeCount={alertCount}
        trailing={
          <div className="home-header-right">
            <ConnectionPill status={props.status} hostName={props.hostName} />
            <button
              type="button"
              className="wb-icon-btn sm"
              onClick={props.onOpenNotifications}
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

        {/* EN ÜST: Mac'te şu an aktif çalışan veya onay bekleyen işler */}
        {activeWork.length > 0 && !q ? (
          <section className="wb-section active-work-section">
            <div className="wb-section-head">
              <span className="wb-section-title is-live-title">
                <span className="status-dot is-working sm" />
                <span>Aktif çalışan işler</span>
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
                      props.push({
                        name: 'chat',
                        conversationId: item.conversationId,
                        title: item.title,
                        providerId: item.providerId,
                        projectId: item.projectId,
                        projectName: project?.name,
                        taskId: item.taskId,
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
                            Mac’te çalışıyor…
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

        {/* Sovra Komuta Merkezi Hero Kartı */}
        {!q ? (
          <section className="hero-card">
            <div className="hero-glow" aria-hidden="true" />
            <div className="hero-top">
              <div className="hero-brand-row">
                <SovraMark size={34} />
                <div className="hero-titles">
                  <h2 className="hero-title">Komuta Merkezi</h2>
                  <p className="hero-sub">
                    {activeWork.length > 0
                      ? `${activeWork.length} ajan görev başında`
                      : 'Tüm ajanlar yeni görev için hazır'}
                  </p>
                </div>
              </div>
              <div className="hero-metrics">
                <button
                  type="button"
                  className="hero-stat-pill"
                  onClick={() => props.push({ name: 'projects' })}
                >
                  <strong>{props.projects.length}</strong>
                  <span>proje</span>
                </button>
                <button
                  type="button"
                  className={`hero-stat-pill ${activeWork.length > 0 ? 'is-live' : ''}`}
                  onClick={() => setFilter(filter === 'active' ? 'all' : 'active')}
                >
                  <strong>{activeWork.length}</strong>
                  <span>aktif</span>
                </button>
                {alertCount > 0 ? (
                  <button
                    type="button"
                    className="hero-stat-pill is-warn"
                    onClick={() => setFilter(filter === 'approval' ? 'all' : 'approval')}
                  >
                    <strong>{alertCount}</strong>
                    <span>onay</span>
                  </button>
                ) : null}
              </div>
            </div>

            <div className="hero-actions-stack">
              <button
                type="button"
                className="btn btn-primary full hero-primary-cta"
                onClick={() => props.onQuickStartChat()}
              >
                <SparklesIcon size={16} />
                <span>Hızlı sohbet başlat</span>
                <span className="hero-cta-badge">{lastAgentName}</span>
              </button>
              <div className="hero-actions-secondary">
                <button
                  type="button"
                  className="btn btn-glass flex1"
                  onClick={() => props.onOpenCreate('task')}
                >
                  <MessageSquareIcon size={15} />
                  <span>Özel görev</span>
                </button>
                <button
                  type="button"
                  className="btn btn-glass flex1"
                  onClick={() => props.onOpenCreate('project')}
                >
                  <FolderPlusIcon size={15} />
                  <span>Yeni proje</span>
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {/* Canlı Yapay Zeka Limitleri Mini Şeridi */}
        {!q && quotaHighlights.length > 0 ? (
          <section className="wb-section">
            <div className="wb-section-head">
              <span className="wb-section-title">
                <GaugeIcon size={13} />
                <span>Yapay zeka limitleri</span>
              </span>
              <button
                type="button"
                className="section-link"
                onClick={() => props.push({ name: 'accounts' })}
              >
                Tümü ›
              </button>
            </div>
            <div className="quota-strip">
              {quotaHighlights.map(({ id, remaining }) => {
                const rem = remaining!;
                const tone = quotaTone(rem);
                return (
                  <button
                    key={id}
                    type="button"
                    className="quota-mini-card"
                    onClick={() => props.push({ name: 'accounts' })}
                  >
                    <div className="quota-mini-top">
                      <ProviderAvatar providerId={id} size="sm" names={props.agentNames} />
                      <QuotaRing remainingPercent={rem} size={34} stroke={3.5} />
                    </div>
                    <span className="quota-mini-name">
                      {providerDisplayName(id, props.agentNames)}
                    </span>
                    <div className="quota-mini-bar" aria-hidden="true">
                      <div className={`quota-mini-bar-fill is-${tone}`} style={{ width: `${rem}%` }} />
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
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
              Tümü
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
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'approval'}
              className={`filter-pill ${filter === 'approval' ? 'is-active' : ''}`}
              onClick={() => setFilter('approval')}
            >
              <span>Onay bekleyen ({alertCount})</span>
            </button>
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
            {recentChats.length > 0 ? <span className="wb-badge">{recentChats.length}</span> : null}
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
                  : 'Yukarıdaki "Hızlı sohbet başlat" düğmesiyle hemen ilk ajanınızı çalıştırabilirsiniz.'}
            </Empty>
          ) : (
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
                    onClick={() =>
                      props.push({
                        name: 'chat',
                        conversationId: conv.id,
                        title: conv.title,
                        providerId: conv.providerId,
                        projectId: conv.projectId,
                        projectName: project?.name,
                        taskId: conv.taskId,
                      })
                    }
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
          )}
        </section>
      </div>
    </main>
  );
}
