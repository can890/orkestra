import { Button, MicroLabel, Tooltip, toast } from '@orkestra/ui/react/primitives';
import {
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  Folder,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { resolveDefaultPermissionForProvider } from '@core/features/conversations/api/default-permission-mode';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { useTaskSettings } from '@core/features/tasks/api/browser/hooks/useTaskSettings';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import type {
  ExternalSessionProviderId,
  ExternalSessionSummary,
} from '@core/primitives/conversations/api';
import { log } from '@core/primitives/logging/browser/logger';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { isFreeChatProjectId, type LocalProject } from '@core/primitives/projects/api';
import { cn } from '@core/primitives/styling/browser/cn';
import { SidebarGroup } from './sidebar-primitives';

const FOCUS_REFRESH_THROTTLE_MS = 30_000;

function formatCompactAgeTr(updatedAtMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000));
  if (diffSec < 60) return 'şimdi';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}d`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}s`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}g`;
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 5) return `${diffWeeks}h`;
  const diffMonths = Math.max(1, Math.floor(diffDays / 30));
  return `${diffMonths}ay`;
}

function providerDisplayName(providerId: ExternalSessionProviderId): string {
  switch (providerId) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'antigravity':
      return 'Antigravity';
    case 'gemini':
      return 'Gemini CLI';
  }
}

function normalizeFsPath(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '/') return '/';
  return trimmed.replace(/\/+$/, '');
}

function findMatchingLocalProject(cwd: string | null): LocalProject | null {
  if (!cwd) return null;
  const normalizedCwd = normalizeFsPath(cwd);
  if (!normalizedCwd) return null;

  let best: LocalProject | null = null;
  let bestLength = -1;

  for (const store of getProjectManagerStore().projects.values()) {
    const data = store.data;
    if (!data || data.type !== 'local') continue;
    if (isFreeChatProjectId(data.id) || !data.repositoryWorkspaceId) continue;
    const projectPath = normalizeFsPath(data.path);
    if (!projectPath) continue;
    const matches = normalizedCwd === projectPath || normalizedCwd.startsWith(`${projectPath}/`);
    if (matches && projectPath.length > bestLength) {
      best = data;
      bestLength = projectPath.length;
    }
  }

  return best;
}

/**
 * Bilgisayardaki harici AI CLI araçlarında (Claude Code, Codex, Antigravity, Gemini CLI)
 * başlamış eski konuşmaları tarayıp tek tıkla Orkestra içinde devam ettiren sol menü bölümü.
 */
export const SidebarExternalSessionsSection = observer(function SidebarExternalSessionsSection() {
  const { navigate } = useNavigate();
  const { defaultPermissionMode } = useTaskSettings();
  const [sessions, setSessions] = useState<ExternalSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const sidebarStore = getSidebarStore();
  const isOpen = sidebarStore.isSectionOpen('externalSessions');
  const lastFetchedAtRef = useRef<number>(0);

  const loadSessions = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const client = await getConversationsClient();
      const list = await client.listExternalSessions({ limit: 40 });
      setSessions(list);
      lastFetchedAtRef.current = Date.now();
    } catch (error) {
      log.warn('Harici AI geçmişi yüklenemedi', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
      if (isManual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions(false);
    const onFocus = () => {
      if (Date.now() - lastFetchedAtRef.current >= FOCUS_REFRESH_THROTTLE_MS) {
        void loadSessions(false);
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadSessions]);

  const toggleOpen = () => sidebarStore.toggleSectionOpen('externalSessions');

  const handleResume = async (session: ExternalSessionSummary) => {
    if (resumingId) return;
    setResumingId(session.id);
    try {
      const pm = getProjectManagerStore();
      const matched = findMatchingLocalProject(session.cwd);
      const project = matched ?? (await pm.ensureFreeChatProject());
      if (!project || !project.repositoryWorkspaceId) {
        toast.error('Oturum devam ettirilemedi', {
          description: 'Uygun çalışma alanı hazırlanırken sorun oluştu.',
        });
        return;
      }

      const taskManager = getTaskManagerStore(project.id);
      if (!taskManager) {
        toast.error('Görev yöneticisi hazır değil.');
        return;
      }

      const taskId = crypto.randomUUID();
      const defaultPermission = resolveDefaultPermissionForProvider(
        session.providerId,
        defaultPermissionMode
      );
      await taskManager.createTask({
        id: taskId,
        projectId: project.id,
        taskConfig: {
          version: '1',
          name: session.title,
          initialConversation: {
            id: crypto.randomUUID(),
            provider: session.providerId,
            title: session.title,
            type: 'acp',
            autoApprove: defaultPermission.autoApprove,
            ...(defaultPermission.modeId ? { modeId: defaultPermission.modeId } : {}),
            ...(session.model ? { model: session.model } : {}),
            providerSessionId: session.nativeSessionId,
            ...(session.cwd ? { sessionCwd: session.cwd } : {}),
          },
        },
        workspaceConfig: {
          version: '2',
          git: { kind: 'none' },
          workspace: {
            kind: 'repository-instance',
            workspaceId: project.repositoryWorkspaceId,
          },
        },
      });

      setSessions((prev) => prev.filter((item) => item.id !== session.id));
      navigate(taskViewDef({ projectId: project.id, taskId }));
    } catch (error) {
      log.error('Harici AI oturumuna devam edilemedi', error);
      toast.error('Oturuma devam edilemedi', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setResumingId(null);
    }
  };

  if (!loading && sessions.length === 0) {
    return null;
  }

  return (
    <SidebarGroup className="mb-0 flex shrink-0 flex-col border-t border-border/50 pt-1">
      <div className="group/ext-hdr flex h-[34px] items-center justify-between pr-2.5 pl-4">
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={isOpen}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-foreground-tertiary-passive transition-colors hover:text-foreground"
        >
          <MicroLabel className="truncate font-medium">Diğer AI Geçmişi</MicroLabel>
          {sessions.length > 0 && (
            <span className="shrink-0 text-[11px] font-medium text-foreground-tertiary-muted tabular-nums">
              {sessions.length}
            </span>
          )}
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
          )}
        </button>

        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                icon
                disabled={refreshing}
                aria-label="Harici AI geçmişini yenile"
                className="opacity-0 transition-opacity group-hover/ext-hdr:opacity-100 focus-visible:opacity-100"
                onClick={() => void loadSessions(true)}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
              </Button>
            }
          />
          <Tooltip.Content>Geçmişi yenile</Tooltip.Content>
        </Tooltip.Root>
      </div>

      {isOpen && (
        <div className="max-h-56 overflow-y-auto px-2 pb-2">
          {loading && sessions.length === 0 ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-foreground-tertiary-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Geçmiş taranıyor…</span>
            </div>
          ) : (
            <div className="grid gap-0.5">
              {sessions.map((session) => {
                const isResuming = resumingId === session.id;
                return (
                  <Tooltip.Root key={session.id}>
                    <Tooltip.Trigger
                      render={
                        <button
                          type="button"
                          disabled={resumingId !== null}
                          onClick={() => void handleResume(session)}
                          className={cn(
                            'group/ext flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg px-2 text-left text-foreground-tertiary-muted transition-colors',
                            'hover:bg-background-tertiary-1 hover:text-foreground-tertiary',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                            'disabled:pointer-events-none disabled:opacity-60'
                          )}
                        >
                          <AgentIcon
                            id={session.providerId}
                            size={15}
                            className="shrink-0 rounded-sm"
                          />
                          <span className="min-w-0 flex-1 truncate text-[13px]">
                            {session.title}
                          </span>
                          <span className="shrink-0 text-[11px] text-foreground-tertiary-passive tabular-nums">
                            {isResuming ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground" />
                            ) : (
                              <>
                                <span className="group-hover/ext:hidden group-focus-visible/ext:hidden">
                                  {formatCompactAgeTr(session.updatedAt)}
                                </span>
                                <span className="hidden items-center text-foreground group-hover/ext:inline-flex group-focus-visible/ext:inline-flex">
                                  <CornerDownLeft className="h-3.5 w-3.5" />
                                </span>
                              </>
                            )}
                          </span>
                        </button>
                      }
                    />
                    <Tooltip.Content side="right" sideOffset={8} className="max-w-72 p-2.5">
                      <div className="grid gap-1.5 text-xs">
                        <p className="leading-snug font-medium text-foreground">{session.title}</p>
                        <div className="flex items-center gap-1.5 text-foreground-secondary">
                          <Folder className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary-muted" />
                          <span className="truncate font-medium">{session.projectLabel}</span>
                        </div>
                        {session.cwd && (
                          <p className="truncate font-mono text-[11px] text-foreground-tertiary-muted">
                            {session.cwd}
                          </p>
                        )}
                        <div className="flex items-center gap-1.5 pt-0.5 text-foreground-tertiary-muted">
                          <AgentIcon
                            id={session.providerId}
                            size={13}
                            className="shrink-0 rounded-sm"
                          />
                          <span>{providerDisplayName(session.providerId)}</span>
                          {session.model && (
                            <>
                              <span>·</span>
                              <span className="truncate font-mono text-[11px]">
                                {session.model}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </Tooltip.Content>
                  </Tooltip.Root>
                );
              })}
            </div>
          )}
        </div>
      )}
    </SidebarGroup>
  );
});
