import type { ConnectionManager } from '@/core/connection-manager';
import {
  isConversationAwaitingPermission,
  isConversationWorking,
  mapConversations,
  mapTasks,
  taskStatusLabel,
  type ConversationView,
  type SessionSummaryView,
} from '@/core/mappers';
import { REMOTE_TOPICS, topicOf, unwrapResult, type RemoteApi } from '@/core/wire-client';
import {
  Empty,
  ErrorNote,
  Loading,
  TaskStatusDot,
  WorkbenchHeader,
  providerDisplayName,
  relativeTime,
  shortTime,
} from '../components';
import type { CreateMode } from '../CreateModal';
import { useLive, useQuery } from '../hooks';
import {
  ChevronRightIcon,
  GitBranchIcon,
  MessageSquareIcon,
  PinIcon,
  PlusIcon,
  ShieldAlertIcon,
  SparklesIcon,
  TerminalIcon,
} from '../icons';
import { ProviderAvatar } from '../ProviderBrand';
import type { Route } from '../router';

export function TasksScreen(props: {
  api: RemoteApi;
  projectId: string;
  projectName: string;
  conversations: ConversationView[];
  sessions: Record<string, SessionSummaryView>;
  onOpenMenu: () => void;
  onOpenCreate: (mode: CreateMode, projectId?: string) => void;
  onQuickStartChat: (projectId: string) => void;
  push: (route: Route) => void;
  back: () => void;
}) {
  const tasks = useLive(
    props.api,
    topicOf(REMOTE_TOPICS.tasks, { projectId: props.projectId }),
    (data) => mapTasks(data, props.projectId)
  );

  return (
    <main className="screen">
      <WorkbenchHeader
        title={props.projectName}
        subtitle="Görevler"
        onBack={props.back}
        onMenu={props.onOpenMenu}
        trailing={
          <div className="chat-header-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => props.onQuickStartChat(props.projectId)}
              title="Hızlı sohbet başlat"
            >
              <SparklesIcon size={14} />
              <span>Sohbet</span>
            </button>
            <button
              type="button"
              className="wb-icon-btn sm"
              onClick={() => props.onOpenCreate('task', props.projectId)}
              aria-label="Özel görev oluştur"
              title="Özel görev oluştur"
            >
              <PlusIcon size={17} />
            </button>
          </div>
        }
      />
      <div className="screen-body">
        <ErrorNote message={tasks.error} />
        {tasks.loading ? <Loading label="Görevler yükleniyor…" /> : null}
        {tasks.data?.length === 0 ? (
          <Empty icon={<GitBranchIcon size={28} />} title="Görev yok">
            Bu projede henüz görev yok. Sağ üstten yeni bir görev ve ajan sohbeti başlatabilirsin.
          </Empty>
        ) : null}

        {tasks.data && tasks.data.length > 0 ? (
          <div className="chat-card-list">
            {tasks.data
              .slice()
              .sort((a, b) => {
                const aConvs = props.conversations.filter((c) => c.taskId === a.id);
                const bConvs = props.conversations.filter((c) => c.taskId === b.id);
                const aActive = aConvs.some(
                  (c) =>
                    isConversationWorking(c, props.sessions[c.id]) ||
                    isConversationAwaitingPermission(c, props.sessions[c.id])
                )
                  ? 1
                  : 0;
                const bActive = bConvs.some(
                  (c) =>
                    isConversationWorking(c, props.sessions[c.id]) ||
                    isConversationAwaitingPermission(c, props.sessions[c.id])
                )
                  ? 1
                  : 0;
                return bActive - aActive;
              })
              .map((task) => {
                const taskConvs = props.conversations.filter((c) => c.taskId === task.id);
                const working = taskConvs.some((c) =>
                  isConversationWorking(c, props.sessions[c.id])
                );
                const needsPerm = taskConvs.some((c) =>
                  isConversationAwaitingPermission(c, props.sessions[c.id])
                );
                return (
                  <button
                    key={task.id}
                    type="button"
                    className={`chat-item-card ${needsPerm ? 'is-alert' : working ? 'is-live' : ''}`}
                    onClick={() =>
                      props.push({
                        name: 'conversations',
                        projectId: task.projectId,
                        projectName: props.projectName,
                        taskId: task.id,
                        taskName: task.name,
                      })
                    }
                  >
                    <span className="row-leading">
                      {needsPerm ? (
                        <ShieldAlertIcon size={16} className="icon-warn" />
                      ) : (
                        <TaskStatusDot status={task.status} working={working} />
                      )}
                    </span>
                    <div className="chat-item-main">
                      <div className="chat-item-top">
                        <span className="row-title-line">
                          {task.pinned ? <PinIcon size={12} className="icon-muted" /> : null}
                          <span className="chat-item-title">{task.name}</span>
                        </span>
                        {task.activityAt ? (
                          <span className="meta-time">{relativeTime(task.activityAt)}</span>
                        ) : null}
                      </div>
                      <div className="chat-item-meta">
                        <span className={`status-tag is-${task.status}`}>
                          {working ? 'Çalışıyor' : taskStatusLabel(task.status)}
                        </span>
                        {taskConvs.length > 0 ? (
                          <span className="agent-sub-label">{taskConvs.length} sohbet</span>
                        ) : null}
                      </div>
                    </div>
                    <ChevronRightIcon size={16} className="row-chevron" />
                  </button>
                );
              })}
          </div>
        ) : null}
      </div>
    </main>
  );
}

export function ConversationsScreen(props: {
  api: RemoteApi;
  manager: ConnectionManager;
  projectId: string;
  projectName?: string;
  taskId: string;
  taskName: string;
  sessions: Record<string, SessionSummaryView>;
  agentNames: Record<string, string>;
  onOpenMenu: () => void;
  push: (route: Route) => void;
  back: () => void;
}) {
  const list = useQuery<ConversationView[]>(
    props.manager,
    async () =>
      mapConversations(
        unwrapResult(
          await props.api.call('conversations.getConversationsForTask', {
            projectId: props.projectId,
            taskId: props.taskId,
          })
        )
      ),
    `${props.projectId}/${props.taskId}`,
    15_000
  );

  return (
    <main className="screen">
      <WorkbenchHeader
        title={props.taskName}
        subtitle={props.projectName ? `${props.projectName} · Sohbetler` : 'Sohbetler'}
        onBack={props.back}
        onMenu={props.onOpenMenu}
      />
      <div className="screen-body">
        <ErrorNote message={list.error} />
        {list.loading && !list.data ? <Loading label="Sohbetler yükleniyor…" /> : null}
        {list.data?.length === 0 ? (
          <Empty icon={<MessageSquareIcon size={28} />} title="Sohbet yok">
            Bu görevde henüz sohbet başlatılmamış.
          </Empty>
        ) : null}
        {list.data && list.data.length > 0 ? (
          <div className="chat-card-list">
            {list.data
              .slice()
              .sort((a, b) => {
                const aActive =
                  isConversationWorking(a, props.sessions[a.id]) ||
                  isConversationAwaitingPermission(a, props.sessions[a.id])
                    ? 1
                    : 0;
                const bActive =
                  isConversationWorking(b, props.sessions[b.id]) ||
                  isConversationAwaitingPermission(b, props.sessions[b.id])
                    ? 1
                    : 0;
                return bActive - aActive;
              })
              .map((conversation) => {
                const live = props.sessions[conversation.id];
                const isWorking = isConversationWorking(conversation, live);
                const needsPerm = isConversationAwaitingPermission(conversation, live);
                return (
                  <button
                    key={conversation.id}
                    type="button"
                    className={`chat-item-card ${needsPerm ? 'is-alert' : isWorking ? 'is-live' : ''}`}
                    disabled={!conversation.chatCapable}
                    onClick={() =>
                      props.push({
                        name: 'chat',
                        conversationId: conversation.id,
                        title: conversation.title,
                        providerId: conversation.providerId,
                        projectId: props.projectId,
                        projectName: props.projectName,
                        taskId: props.taskId,
                        taskName: props.taskName,
                      })
                    }
                  >
                    {conversation.chatCapable ? (
                      <div className="chat-avatar-wrap">
                        <ProviderAvatar
                          providerId={conversation.providerId}
                          size="md"
                          names={props.agentNames}
                        />
                        {needsPerm ? (
                          <span className="avatar-status-badge is-warn" />
                        ) : isWorking ? (
                          <span className="avatar-status-badge is-working" />
                        ) : null}
                      </div>
                    ) : (
                      <span className="project-icon-tile">
                        <TerminalIcon size={16} />
                      </span>
                    )}
                    <div className="chat-item-main">
                      <span className="chat-item-title">{conversation.title}</span>
                      {conversation.chatCapable ? (
                        <div className="chat-item-meta">
                          <span className="agent-sub-label">
                            {providerDisplayName(conversation.providerId, props.agentNames)}
                          </span>
                          {isWorking ? (
                            <span className="text-accent small">Çalışıyor</span>
                          ) : conversation.lastInteractedAt ? (
                            <span className="meta-time">
                              {shortTime(conversation.lastInteractedAt)}
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <span className="row-sub">Terminal oturumu · yalnızca masaüstünde</span>
                      )}
                    </div>
                    {conversation.chatCapable ? (
                      <ChevronRightIcon size={16} className="row-chevron" />
                    ) : null}
                  </button>
                );
              })}
          </div>
        ) : null}
      </div>
    </main>
  );
}
