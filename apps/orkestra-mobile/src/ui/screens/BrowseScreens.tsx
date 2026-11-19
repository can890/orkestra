import type { ConnectionManager } from '@/core/connection-manager';
import {
  mapConversations,
  mapProjects,
  mapTasks,
  taskStatusLabel,
  type ConversationView,
} from '@/core/mappers';
import { REMOTE_TOPICS, topicOf, unwrapResult, type RemoteApi } from '@/core/wire-client';
import { Empty, ErrorNote, Header, ListButton, Loading, shortTime } from '../components';
import { useLive, useQuery } from '../hooks';
import type { Route } from '../router';

export function ProjectsScreen(props: { api: RemoteApi; push: (route: Route) => void }) {
  const projects = useLive(props.api, REMOTE_TOPICS.projects, mapProjects);
  return (
    <main className="screen">
      <Header title="Projeler" />
      <ErrorNote message={projects.error} />
      {projects.loading ? <Loading /> : null}
      {projects.data?.length === 0 ? <Empty>Masaüstünde henüz proje yok.</Empty> : null}
      <div className="list">
        {projects.data?.map((project) => (
          <ListButton
            key={project.id}
            title={project.name}
            subtitle={project.remote ? 'Uzak makine' : project.path}
            trailing="›"
            onClick={() =>
              props.push({ name: 'tasks', projectId: project.id, projectName: project.name })
            }
          />
        ))}
      </div>
    </main>
  );
}

export function TasksScreen(props: {
  api: RemoteApi;
  projectId: string;
  projectName: string;
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
      <Header title={props.projectName} subtitle="Görevler" onBack={props.back} />
      <ErrorNote message={tasks.error} />
      {tasks.loading ? <Loading /> : null}
      {tasks.data?.length === 0 ? <Empty>Bu projede görev yok.</Empty> : null}
      <div className="list">
        {tasks.data?.map((task) => (
          <ListButton
            key={task.id}
            title={`${task.pinned ? '📌 ' : ''}${task.name}`}
            subtitle={`${taskStatusLabel(task.status)} · ${shortTime(task.activityAt)}`}
            trailing="›"
            onClick={() =>
              props.push({
                name: 'conversations',
                projectId: task.projectId,
                taskId: task.id,
                taskName: task.name,
              })
            }
          />
        ))}
      </div>
    </main>
  );
}

export function ConversationsScreen(props: {
  api: RemoteApi;
  manager: ConnectionManager;
  projectId: string;
  taskId: string;
  taskName: string;
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
      <Header title={props.taskName} subtitle="Sohbetler" onBack={props.back} />
      <ErrorNote message={list.error} />
      {list.loading && !list.data ? <Loading /> : null}
      {list.data?.length === 0 ? <Empty>Bu görevde sohbet yok.</Empty> : null}
      <div className="list">
        {list.data?.map((conversation) => (
          <ListButton
            key={conversation.id}
            title={conversation.title}
            subtitle={
              conversation.chatCapable
                ? `${conversation.providerId} · ${shortTime(conversation.lastInteractedAt)}`
                : 'Terminal oturumu: telefondan açılamaz'
            }
            trailing={conversation.chatCapable ? '›' : undefined}
            disabled={!conversation.chatCapable}
            onClick={() =>
              props.push({
                name: 'chat',
                conversationId: conversation.id,
                title: conversation.title,
                providerId: conversation.providerId,
              })
            }
          />
        ))}
      </div>
    </main>
  );
}
