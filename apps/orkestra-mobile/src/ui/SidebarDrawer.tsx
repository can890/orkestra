import { useMemo, useState } from 'react';
import type { ConnectionStatus } from '@/core/connection-state';
import {
  buildActiveWorkList,
  isConversationAwaitingPermission,
  isConversationWorking,
  mapTasks,
  type ConversationView,
  type ProjectView,
  type SessionSummaryView,
  type TaskView,
} from '@/core/mappers';
import { REMOTE_TOPICS, topicOf, type RemoteApi } from '@/core/wire-client';
import {
  ConnectionPill,
  OrkestraMark,
  TaskStatusDot,
  providerDisplayName,
  relativeTime,
} from './components';
import { useLive } from './hooks';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  GaugeIcon,
  HomeIcon,
  PinIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  ShieldAlertIcon,
  XIcon,
} from './icons';
import type { Route } from './router';

export function SidebarDrawer(props: {
  open: boolean;
  onClose: () => void;
  api: RemoteApi;
  hostName: string;
  status: ConnectionStatus;
  projects: ProjectView[];
  conversations: ConversationView[];
  sessions: Record<string, SessionSummaryView>;
  agentNames: Record<string, string>;
  route: Route;
  onNavigate: (route: Route) => void;
  onOpenTask: (project: ProjectView, task: TaskView) => void;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const normalizedQuery = query.trim().toLowerCase();

  const filteredProjects = useMemo(() => {
    if (!normalizedQuery) return props.projects;
    return props.projects.filter(
      (project) =>
        project.name.toLowerCase().includes(normalizedQuery) ||
        project.path.toLowerCase().includes(normalizedQuery)
    );
  }, [props.projects, normalizedQuery]);

  // Çalışan veya izin bekleyen aktif oturumlar (canlı ACP + agentStatus)
  const activeSessions = useMemo(
    () => buildActiveWorkList(props.conversations, props.sessions),
    [props.conversations, props.sessions]
  );

  const workingTaskIds = useMemo(() => {
    const set = new Set<string>();
    for (const conv of props.conversations) {
      const s = props.sessions[conv.id];
      if (isConversationWorking(conv, s) || isConversationAwaitingPermission(conv, s)) {
        set.add(conv.taskId);
      }
    }
    return set;
  }, [props.conversations, props.sessions]);

  function toggleProject(projectId: string): void {
    setExpanded((prev) => ({ ...prev, [projectId]: !prev[projectId] }));
  }

  function go(next: Route): void {
    props.onNavigate(next);
    props.onClose();
  }

  const activeConvId = props.route.name === 'chat' ? props.route.conversationId : null;
  const activeTaskId =
    props.route.name === 'chat'
      ? props.route.taskId
      : props.route.name === 'conversations'
        ? props.route.taskId
        : null;

  return (
    <div className={`drawer-layer ${props.open ? 'is-open' : ''}`} aria-hidden={!props.open}>
      <div className="drawer-backdrop" onClick={props.onClose} />
      <aside className="drawer-panel" aria-label="Çalışma alanı kenar çubuğu">
        <div className="drawer-header">
          <div className="drawer-brand">
            <OrkestraMark size={22} />
            <span className="drawer-brand-name">Sovra</span>
          </div>
          <button
            type="button"
            className="wb-icon-btn sm"
            onClick={props.onClose}
            aria-label="Kenar çubuğunu kapat"
          >
            <XIcon size={17} />
          </button>
        </div>

        <div className="drawer-conn-row">
          <ConnectionPill status={props.status} hostName={props.hostName} />
        </div>

        <div className="drawer-search-wrap">
          <SearchIcon size={14} className="drawer-search-icon" />
          <input
            type="search"
            className="drawer-search"
            value={query}
            placeholder="Proje ara…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="drawer-scroll">
          {activeSessions.length > 0 ? (
            <div className="drawer-section">
              <div className="drawer-section-label">Aktif çalışan işler</div>
              <div className="drawer-list">
                {activeSessions.map((item) => {
                  const needsPerm = item.awaitingInput;
                  const isActive = activeConvId === item.conversationId;
                  return (
                    <button
                      key={item.conversationId}
                      type="button"
                      disabled={!item.chatCapable}
                      className={`drawer-item ${isActive ? 'is-active' : ''}`}
                      onClick={() => {
                        if (!item.chatCapable) return;
                        go({
                          name: 'chat',
                          conversationId: item.conversationId,
                          title: item.title,
                          providerId: item.providerId,
                          projectId: item.projectId,
                          taskId: item.taskId,
                        });
                      }}
                    >
                      {needsPerm ? (
                        <ShieldAlertIcon size={14} className="drawer-item-icon is-warn" />
                      ) : (
                        <span className="status-dot is-working" aria-hidden="true" />
                      )}
                      <span className="drawer-item-text">
                        <span className="drawer-item-title">{item.title}</span>
                        <span className="drawer-item-sub">
                          {needsPerm
                            ? item.pendingPermissionCount > 0
                              ? `${item.pendingPermissionCount} onay bekliyor`
                              : 'Yanıt bekliyor'
                            : `${providerDisplayName(item.providerId, props.agentNames)} · çalışıyor`}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="drawer-section">
            <div className="drawer-section-label">
              <span>Projeler</span>
              <span className="drawer-count">{filteredProjects.length}</span>
            </div>
            {filteredProjects.length === 0 ? (
              <p className="drawer-empty">
                {normalizedQuery ? 'Eşleşen proje yok.' : 'Henüz proje yok.'}
              </p>
            ) : (
              <div className="drawer-tree">
                {filteredProjects.map((project, index) => {
                  const isOpen =
                    expanded[project.id] ??
                    (index === 0 ||
                      (props.route.name === 'tasks' && props.route.projectId === project.id) ||
                      (props.route.name === 'conversations' &&
                        props.route.projectId === project.id) ||
                      (props.route.name === 'chat' && props.route.projectId === project.id));

                  return (
                    <div key={project.id} className="drawer-project">
                      <div className="drawer-project-row">
                        <button
                          type="button"
                          className="drawer-project-toggle"
                          onClick={() => toggleProject(project.id)}
                          aria-expanded={isOpen}
                        >
                          {isOpen ? (
                            <ChevronDownIcon size={14} className="drawer-chevron" />
                          ) : (
                            <ChevronRightIcon size={14} className="drawer-chevron" />
                          )}
                          {project.remote ? (
                            <ServerIcon size={14} className="drawer-item-icon" />
                          ) : (
                            <FolderIcon size={14} className="drawer-item-icon" />
                          )}
                          <span className="drawer-project-name">{project.name}</span>
                        </button>
                        <button
                          type="button"
                          className="drawer-project-more"
                          title="Tüm görevler"
                          aria-label={`${project.name} görevlerini aç`}
                          onClick={() =>
                            go({
                              name: 'tasks',
                              projectId: project.id,
                              projectName: project.name,
                            })
                          }
                        >
                          <ChevronRightIcon size={14} />
                        </button>
                      </div>

                      {isOpen && props.open ? (
                        <ProjectTaskTree
                          api={props.api}
                          project={project}
                          activeTaskId={activeTaskId}
                          workingTaskIds={workingTaskIds}
                          onSelectTask={(task) => {
                            props.onOpenTask(project, task);
                            props.onClose();
                          }}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <nav className="drawer-footer" aria-label="Alt gezinme">
          <button
            type="button"
            className={`drawer-nav-btn ${props.route.name === 'home' ? 'is-active' : ''}`}
            onClick={() => go({ name: 'home' })}
          >
            <HomeIcon size={16} />
            <span>Ana ekran</span>
          </button>
          <button
            type="button"
            className={`drawer-nav-btn ${props.route.name === 'accounts' ? 'is-active' : ''}`}
            onClick={() => go({ name: 'accounts' })}
          >
            <GaugeIcon size={16} />
            <span>Hesaplar ve limitler</span>
          </button>
          <button
            type="button"
            className={`drawer-nav-btn ${props.route.name === 'settings' ? 'is-active' : ''}`}
            onClick={() => go({ name: 'settings' })}
          >
            <SettingsIcon size={16} />
            <span>Ayarlar</span>
          </button>
        </nav>
      </aside>
    </div>
  );
}

function ProjectTaskTree(props: {
  api: RemoteApi;
  project: ProjectView;
  activeTaskId?: string | null;
  workingTaskIds: Set<string>;
  onSelectTask: (task: TaskView) => void;
}) {
  const tasks = useLive(
    props.api,
    topicOf(REMOTE_TOPICS.tasks, { projectId: props.project.id }),
    (data) => mapTasks(data, props.project.id)
  );

  if (tasks.loading && !tasks.data) {
    return <div className="drawer-tree-note">Görevler yükleniyor…</div>;
  }
  if (!tasks.data || tasks.data.length === 0) {
    return <div className="drawer-tree-note">Görev yok</div>;
  }

  return (
    <div className="drawer-task-list">
      {tasks.data.slice(0, 12).map((task) => {
        const isWorking = props.workingTaskIds.has(task.id);
        const isActive = props.activeTaskId === task.id;
        return (
          <button
            key={task.id}
            type="button"
            className={`drawer-task-item ${isActive ? 'is-active' : ''}`}
            onClick={() => props.onSelectTask(task)}
          >
            <TaskStatusDot status={task.status} working={isWorking} />
            <span className="drawer-task-name">{task.name}</span>
            {task.pinned ? <PinIcon size={11} className="drawer-pin" /> : null}
            {task.activityAt ? (
              <span className="drawer-task-time">{relativeTime(task.activityAt)}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
