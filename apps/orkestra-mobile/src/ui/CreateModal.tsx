import { useEffect, useState } from 'react';
import type { ProjectView, ProviderUsageView } from '@/core/mappers';
import { describeCallError, unwrapResult, type RemoteApi } from '@/core/wire-client';
import { ErrorNote, providerDisplayName } from './components';
import { FolderPlusIcon, SparklesIcon, XIcon } from './icons';
import {
  CORE_USAGE_PROVIDERS,
  ProviderAvatar,
  primaryRemainingPercent,
  quotaTone,
} from './ProviderBrand';
import type { Route } from './router';

export type CreateMode = 'task' | 'project';

function newUuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function CreateModal(props: {
  open: boolean;
  initialMode: CreateMode;
  initialProjectId?: string;
  projects: ProjectView[];
  usage: Record<string, ProviderUsageView>;
  agentNames: Record<string, string>;
  api: RemoteApi;
  onClose: () => void;
  onCreated: (route: Route) => void;
}) {
  const [mode, setMode] = useState<CreateMode>(props.initialMode);
  const [projectId, setProjectId] = useState<string>(
    props.initialProjectId || props.projects[0]?.id || ''
  );
  const [provider, setProvider] = useState<string>(() => {
    try {
      return localStorage.getItem('orkestra:mobile:last-agent') || 'antigravity';
    } catch {
      return 'antigravity';
    }
  });
  const [workspaceMode, setWorkspaceMode] = useState<'repo' | 'worktree'>('repo');
  const [taskName, setTaskName] = useState('');
  const [prompt, setPrompt] = useState('');

  // Yeni proje alanları
  const [projectName, setProjectName] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  const [initGit, setInitGit] = useState(true);
  const [startWithAgent, setStartWithAgent] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setMode(props.projects.length === 0 ? 'project' : props.initialMode);
    setProjectId(props.initialProjectId || props.projects[0]?.id || '');
    setError(null);
    setBusy(false);
  }, [props.open, props.initialMode, props.initialProjectId, props.projects]);

  // Proje adı yazıldıkça Mac'teki varsayılan proje klasörünü otomatik çöz
  useEffect(() => {
    if (!props.open || mode !== 'project' || pathTouched) return;
    const clean = projectName.trim();
    if (!clean) {
      setProjectPath('');
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void props.api
        .call('projects.resolveRepositoryDestination', {
          host: { type: 'local' },
          name: clean,
        })
        .then((res) => {
          if (!active) return;
          const data = unwrapResult(res) as { targetPath?: string; path?: string } | string | null;
          if (typeof data === 'string') setProjectPath(data);
          else if (data && typeof data.targetPath === 'string') setProjectPath(data.targetPath);
          else if (data && typeof data.path === 'string') setProjectPath(data.path);
        })
        .catch(() => {
          // Eski masaüstü sürümüyse kullanıcı yolu elle yazabilir.
        });
    }, 260);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [props.open, mode, projectName, pathTouched, props.api]);

  if (!props.open) return null;

  async function submitTask(): Promise<void> {
    const project = props.projects.find((p) => p.id === projectId);
    if (!project) {
      setError('Lütfen bir proje seçin.');
      return;
    }
    const cleanPrompt = prompt.trim();
    const cleanTitle = taskName.trim() || (cleanPrompt ? cleanPrompt.slice(0, 48) : 'Yeni görev');
    setBusy(true);
    setError(null);
    try {
      const taskId = newUuid();
      const conversationId = newUuid();
      unwrapResult(
        await props.api.call('tasks.createTask', {
          id: taskId,
          projectId: project.id,
          taskConfig: {
            version: '1',
            name: cleanTitle,
            initialConversation: {
              id: conversationId,
              provider,
              title: cleanTitle,
              type: 'acp',
              ...(cleanPrompt ? { initialPrompt: cleanPrompt } : {}),
            },
          },
          workspaceConfig: {
            version: '2',
            git: { kind: 'none' },
            workspace:
              workspaceMode === 'repo' && project.repositoryWorkspaceId
                ? { kind: 'repository-instance', workspaceId: project.repositoryWorkspaceId }
                : { kind: 'new-worktree' },
          },
        })
      );
      setTaskName('');
      setPrompt('');
      try {
        localStorage.setItem('orkestra:mobile:last-agent', provider);
      } catch {
        // yoksay
      }
      props.onCreated({
        name: 'chat',
        conversationId,
        title: cleanTitle,
        providerId: provider,
        projectId: project.id,
        projectName: project.name,
        taskId,
        taskName: cleanTitle,
      });
    } catch (cause) {
      setError(describeCallError(cause));
      setBusy(false);
    }
  }

  async function submitProject(): Promise<void> {
    const cleanName = projectName.trim();
    const cleanPath = projectPath.trim();
    if (!cleanName) {
      setError('Proje adı girin.');
      return;
    }
    if (!cleanPath) {
      setError('Klasör yolu boş olamaz.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = unwrapResult(
        await props.api.call('projects.createProject', {
          type: 'local',
          name: cleanName,
          path: cleanPath,
          initGitRepository: initGit,
        })
      ) as { id?: string; name?: string; repositoryWorkspaceId?: string | null };

      const newProjectId = created?.id;
      const newProjectName = created?.name || cleanName;
      if (!newProjectId) {
        throw new Error('Proje kimliği alınamadı.');
      }

      if (startWithAgent) {
        const cleanPrompt = prompt.trim();
        const title = cleanPrompt ? cleanPrompt.slice(0, 48) : `${newProjectName} kurulumu`;
        const taskId = newUuid();
        const conversationId = newUuid();
        try {
          unwrapResult(
            await props.api.call('tasks.createTask', {
              id: taskId,
              projectId: newProjectId,
              taskConfig: {
                version: '1',
                name: title,
                initialConversation: {
                  id: conversationId,
                  provider,
                  title,
                  type: 'acp',
                  ...(cleanPrompt ? { initialPrompt: cleanPrompt } : {}),
                },
              },
              workspaceConfig: {
                version: '2',
                git: { kind: 'none' },
                workspace: created.repositoryWorkspaceId
                  ? { kind: 'repository-instance', workspaceId: created.repositoryWorkspaceId }
                  : { kind: 'new-worktree' },
              },
            })
          );
          setProjectName('');
          setProjectPath('');
          setPathTouched(false);
          setPrompt('');
          props.onCreated({
            name: 'chat',
            conversationId,
            title,
            providerId: provider,
            projectId: newProjectId,
            projectName: newProjectName,
            taskId,
            taskName: title,
          });
          return;
        } catch {
          // Proje oluşturuldu ama görev açılamadıysa doğrudan proje sayfasına git.
        }
      }

      setProjectName('');
      setProjectPath('');
      setPathTouched(false);
      setPrompt('');
      props.onCreated({
        name: 'tasks',
        projectId: newProjectId,
        projectName: newProjectName,
      });
    } catch (cause) {
      setError(describeCallError(cause));
      setBusy(false);
    }
  }

  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label="Yeni oluştur">
      <div className="sheet-backdrop" onClick={() => !busy && props.onClose()} />
      <div className="sheet-panel">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          <div className="segmented sheet-seg" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'task'}
              className={`segmented-btn ${mode === 'task' ? 'is-active' : ''}`}
              onClick={() => {
                setMode('task');
                setError(null);
              }}
            >
              <SparklesIcon size={14} />
              <span>Yeni görev</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'project'}
              className={`segmented-btn ${mode === 'project' ? 'is-active' : ''}`}
              onClick={() => {
                setMode('project');
                setError(null);
              }}
            >
              <FolderPlusIcon size={14} />
              <span>Yeni proje</span>
            </button>
          </div>
          <button
            type="button"
            className="wb-icon-btn sm"
            onClick={() => !busy && props.onClose()}
            aria-label="Kapat"
          >
            <XIcon size={17} />
          </button>
        </div>

        <div className="sheet-body">
          {mode === 'task' ? (
            <>
              <div className="form-group">
                <span className="field-label">Proje</span>
                <div className="chip-scroll">
                  {props.projects.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`select-chip ${projectId === p.id ? 'is-selected' : ''}`}
                      onClick={() => setProjectId(p.id)}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="form-group">
                <span className="field-label">Yapay zeka ajanı</span>
                <div className="agent-grid">
                  {CORE_USAGE_PROVIDERS.map((id) => {
                    const rem = primaryRemainingPercent(props.usage[id]);
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`agent-tile ${provider === id ? 'is-selected' : ''}`}
                        onClick={() => setProvider(id)}
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

              <div className="form-group">
                <span className="field-label">Çalışma alanı</span>
                <div className="segmented" role="radiogroup" aria-label="Çalışma alanı modu">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={workspaceMode === 'repo'}
                    className={`segmented-btn ${workspaceMode === 'repo' ? 'is-active' : ''}`}
                    onClick={() => setWorkspaceMode('repo')}
                  >
                    Mevcut repo
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={workspaceMode === 'worktree'}
                    className={`segmented-btn ${workspaceMode === 'worktree' ? 'is-active' : ''}`}
                    onClick={() => setWorkspaceMode('worktree')}
                  >
                    Yeni worktree
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="new-task-name" className="field-label">
                  Görev adı (isteğe bağlı)
                </label>
                <input
                  id="new-task-name"
                  type="text"
                  className="text-input"
                  value={taskName}
                  placeholder="Örn. Giriş ekranını yenile"
                  onChange={(e) => setTaskName(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="new-task-prompt" className="field-label">
                  İlk komut
                </label>
                <textarea
                  id="new-task-prompt"
                  className="text-area"
                  rows={3}
                  value={prompt}
                  placeholder="Ajana ne yapmasını istediğini yaz…"
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>

              <ErrorNote message={error} />

              <button
                type="button"
                className="btn btn-primary full lg"
                disabled={busy || !projectId}
                onClick={() => void submitTask()}
              >
                <SparklesIcon size={16} />
                <span>{busy ? 'Başlatılıyor…' : 'Görevi ve ajanı başlat'}</span>
              </button>
            </>
          ) : (
            <>
              <div className="form-group">
                <label htmlFor="new-proj-name" className="field-label">
                  Proje adı
                </label>
                <input
                  id="new-proj-name"
                  type="text"
                  className="text-input"
                  value={projectName}
                  placeholder="Örn. yeni-mobil-uygulama"
                  onChange={(e) => setProjectName(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="new-proj-path" className="field-label">
                  Mac klasör yolu
                </label>
                <input
                  id="new-proj-path"
                  type="text"
                  className="text-input mono"
                  value={projectPath}
                  placeholder="/Users/selim/Developer/yeni-proje"
                  onChange={(e) => {
                    setPathTouched(true);
                    setProjectPath(e.target.value);
                  }}
                />
              </div>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={initGit}
                  onChange={(e) => setInitGit(e.target.checked)}
                />
                <span>Git deposu başlat (git init)</span>
              </label>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={startWithAgent}
                  onChange={(e) => setStartWithAgent(e.target.checked)}
                />
                <span>Projeyi açar açmaz ilk ajan sohbetini başlat</span>
              </label>

              {startWithAgent ? (
                <>
                  <div className="form-group">
                    <span className="field-label">Başlangıç ajanı</span>
                    <div className="agent-grid">
                      {CORE_USAGE_PROVIDERS.map((id) => {
                        const rem = primaryRemainingPercent(props.usage[id]);
                        return (
                          <button
                            key={id}
                            type="button"
                            className={`agent-tile ${provider === id ? 'is-selected' : ''}`}
                            onClick={() => setProvider(id)}
                          >
                            <ProviderAvatar providerId={id} size="sm" names={props.agentNames} />
                            <span className="agent-tile-name">
                              {providerDisplayName(id, props.agentNames)}
                            </span>
                            {rem !== null ? (
                              <span className={`agent-tile-quota is-${quotaTone(rem)}`}>
                                %{rem}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="new-proj-prompt" className="field-label">
                      İlk komut (isteğe bağlı)
                    </label>
                    <textarea
                      id="new-proj-prompt"
                      className="text-area"
                      rows={2}
                      value={prompt}
                      placeholder="Örn. Next.js + Tailwind ile temiz bir başlangıç kur…"
                      onChange={(e) => setPrompt(e.target.value)}
                    />
                  </div>
                </>
              ) : null}

              <ErrorNote message={error} />

              <button
                type="button"
                className="btn btn-primary full lg"
                disabled={busy || !projectName.trim() || !projectPath.trim()}
                onClick={() => void submitProject()}
              >
                <FolderPlusIcon size={16} />
                <span>{busy ? 'Oluşturuluyor…' : 'Yeni proje başlat'}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
