import { useMemo, useState } from 'react';
import {
  isConversationAwaitingPermission,
  isConversationWorking,
  type ConversationView,
  type ProjectView,
  type SessionSummaryView,
} from '@/core/mappers';
import { Empty, ErrorNote, Loading, WorkbenchHeader } from '../components';
import type { CreateMode } from '../CreateModal';
import {
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
} from '../icons';
import type { Route } from '../router';

function compactPath(fullPath: string): string {
  if (!fullPath) return '';
  return fullPath.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

export function ProjectsScreen(props: {
  projects: ProjectView[];
  loading: boolean;
  error: string | null;
  conversations: ConversationView[];
  sessions: Record<string, SessionSummaryView>;
  onOpenMenu: () => void;
  onOpenCreate: (mode: CreateMode, projectId?: string) => void;
  push: (route: Route) => void;
}) {
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();

  const statsByProject = useMemo(() => {
    const map = new Map<string, { chats: number; working: number }>();
    for (const c of props.conversations) {
      const cur = map.get(c.projectId) ?? { chats: 0, working: 0 };
      if (c.chatCapable) cur.chats += 1;
      const live = props.sessions[c.id];
      if (isConversationWorking(c, live) || isConversationAwaitingPermission(c, live)) {
        cur.working += 1;
      }
      map.set(c.projectId, cur);
    }
    return map;
  }, [props.conversations, props.sessions]);

  const filtered = useMemo(() => {
    const base = !q
      ? props.projects
      : props.projects.filter(
          (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
        );
    return base.slice().sort((a, b) => {
      const aWork = statsByProject.get(a.id)?.working ?? 0;
      const bWork = statsByProject.get(b.id)?.working ?? 0;
      if (aWork !== bWork) return bWork - aWork;
      return a.name.localeCompare(b.name, 'tr');
    });
  }, [props.projects, statsByProject, q]);

  return (
    <main className="screen">
      <WorkbenchHeader
        title="Projeler"
        subtitle={`${props.projects.length} çalışma alanı`}
        onMenu={props.onOpenMenu}
        trailing={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => props.onOpenCreate('project')}
          >
            <FolderPlusIcon size={14} />
            <span>Yeni proje</span>
          </button>
        }
      />

      <div className="screen-body with-dock">
        <div className="search-field">
          <SearchIcon size={15} className="search-field-icon" />
          <input
            type="search"
            className="search-field-input"
            value={search}
            placeholder="Proje veya yol ara…"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <ErrorNote message={props.error} />
        {props.loading && props.projects.length === 0 ? (
          <Loading label="Projeler yükleniyor…" />
        ) : null}

        {!props.loading && filtered.length === 0 ? (
          <Empty icon={<FolderIcon size={32} />} title={q ? 'Sonuç yok' : 'Henüz proje yok'}>
            {q
              ? 'Aramanızla eşleşen proje bulunamadı.'
              : 'Sağ üstteki "Yeni proje" düğmesiyle hemen yeni bir proje oluşturabilirsin.'}
          </Empty>
        ) : (
          <div className="project-card-list">
            {filtered.map((project) => {
              const stat = statsByProject.get(project.id) ?? { chats: 0, working: 0 };
              return (
                <div key={project.id} className="project-card">
                  <button
                    type="button"
                    className="project-card-main"
                    onClick={() =>
                      props.push({
                        name: 'tasks',
                        projectId: project.id,
                        projectName: project.name,
                      })
                    }
                  >
                    <span className={`project-icon-tile ${project.remote ? 'is-ssh' : ''}`}>
                      {project.remote ? <ServerIcon size={18} /> : <FolderIcon size={18} />}
                    </span>
                    <div className="project-card-text">
                      <div className="project-card-top">
                        <span className="project-card-name">{project.name}</span>
                        {stat.working > 0 ? (
                          <span className="working-dot-pill">
                            <span className="status-dot is-working sm" /> {stat.working} aktif
                          </span>
                        ) : null}
                      </div>
                      <span className="project-card-path mono">
                        {project.remote ? 'Uzak SSH makinesi' : compactPath(project.path)}
                      </span>
                      <span className="project-card-meta">
                        {stat.chats > 0 ? `${stat.chats} sohbet` : 'Sohbet başlatmaya hazır'}
                      </span>
                    </div>
                    <ChevronRightIcon size={16} className="row-chevron" />
                  </button>
                  <button
                    type="button"
                    className="project-quick-add"
                    title={`${project.name} içinde yeni görev başlat`}
                    aria-label={`${project.name} içinde yeni görev başlat`}
                    onClick={() => props.onOpenCreate('task', project.id)}
                  >
                    <PlusIcon size={16} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
