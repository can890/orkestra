import type { AgentActivityEntry, AgentState } from '@orkestra/core/runtimes/acp/api/client';
import { DropdownMenu, Tooltip } from '@orkestra/ui/react/primitives';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff,
  Folder,
  GitBranch,
  GitMerge,
  Globe,
  Images,
  Laptop,
  Layers,
  Loader2,
  Play,
  Plus,
  RefreshCcw,
  Server,
  Terminal,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { browserRightPanelStore } from '@core/features/browser/api/browser/browser-right-panel-store';
import { isSupersededConversation } from '@core/features/conversations/api/browser/handoff-visibility';
import { getAcpChatResourceManager } from '@core/features/conversations/browser/acp/acp-chat-resource-manager';
import { AcpSubagentsPanel } from '@core/features/conversations/browser/acp/acp-subagents-panel';
import {
  findToolNode,
  nativeSubagentName,
  toolFeedEntries,
  transcriptTurns,
} from '@core/features/conversations/browser/acp/subagent-activity';
import {
  asAvailableProject,
  getProjectStore,
  projectDisplayName,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { OpenInMenu } from '@core/features/settings/contributions/browser/open-in-menu';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { useGitActions } from '@core/features/source-control/api/browser/use-git-actions';
import { gitCheckoutStoreToken } from '@core/features/source-control/contributions/browser/workspace-store-tokens';
import {
  getRegisteredTaskData,
  getTaskStore,
  taskDisplayName,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import {
  useConversations,
  usePreviewServers,
  useTaskComposition,
  useWorkspace,
} from '@core/features/workbench/api/browser/task-composition-context';
import { lifecycleScriptsStoreToken } from '@core/features/workspaces/contributions/browser/workspace-stores';
import {
  copyTextToClipboard,
  getHostClient,
  openExternal,
} from '@core/primitives/desktop-host/browser/host-client';
import { formatDiffLineCount } from '@core/primitives/formatting/browser/format-diff-line-count';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { previewServerUrl } from '@core/primitives/preview-servers/api';
import { isFreeChatProjectId } from '@core/primitives/projects/api';
import { cn } from '@core/primitives/styling/browser/cn';
import { LocalMergeDialog } from '../components/local-merge-dialog';
import { formatPreviewServerLabel } from '../components/preview-servers/preview-server-format';
import {
  collectTaskMedia,
  TaskMediaGalleryPanel,
  type TaskMediaItem,
} from './task-media-gallery';

/**
 * T3 Code tarzı sağ Görev Ayrıntıları kartı (Ortam, Editörle Aç, Proje Scriptleri,
 * Git & Değişiklikler, Çalışan Sunucular ve Alt Ajanlar).
 */
export const TaskDetailsPanel = observer(function TaskDetailsPanel() {
  const { projectId, taskId } = useTaskViewContext();
  const taskStore = getTaskStore(projectId, taskId);
  const taskPayload = getRegisteredTaskData(projectId, taskId);
  const workspace = useWorkspace();
  const taskView = useTaskComposition();
  const conversations = useConversations();
  const previews = usePreviewServers();
  const gitCheckout = workspace.get(gitCheckoutStoreToken);
  const lifecycleScriptsMgr = workspace.get(lifecycleScriptsStoreToken);
  const { navigate } = useNavigate();

  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [copiedBranch, setCopiedBranch] = useState(false);
  const [dockPanel, setDockPanel] = useState<'none' | 'history' | 'media'>('none');
  const [, setLiveTick] = useState(0);

  const isFreeChat = isFreeChatProjectId(projectId);
  const projectContext = asAvailableProject(getProjectStore(projectId));
  const isRemoteProject = projectContext?.project.type === 'ssh';
  const projectName = projectDisplayName(getProjectStore(projectId));

  const {
    isPublished,
    aheadCount,
    behindCount,
    fetch,
    pull,
    push,
    publish,
    isPublishing,
    isFetching,
    isPulling,
    isPushing,
  } = useGitActions(projectId, taskId);

  if (!taskStore || !taskPayload) return null;

  const workspacePath = workspace.path;
  const currentBranchName = gitCheckout.branchName;
  const repoStore = getGitRepositoryStore(projectId);
  const defaultBranchName = repoStore?.defaultBranchRef?.branch ?? null;
  const canShowLocalMerge = Boolean(
    currentBranchName && defaultBranchName && currentBranchName !== defaultBranchName
  );

  const linesAdded = gitCheckout.totalLinesAdded;
  const linesDeleted = gitCheckout.totalLinesDeleted;
  const hasChanges = linesAdded > 0 || linesDeleted > 0;

  const scriptTabs = lifecycleScriptsMgr?.tabs ?? [];
  const servers = previews.servers;
  const allConversations = Array.from(conversations.conversations.values()).filter(
    (c) => !isSupersededConversation(c.data.id)
  );

  // Görevdeki tüm ACP oturumlarından alt ajanları ve üretilen medyaları topla;
  // transkript düğümlerinden gerçek isim / canlı adım / prompt / yanıt bilgilerini zenginleştir.
  const acpManager = getAcpChatResourceManager(taskId, projectId);
  const subagents: AgentState[] = [];
  const cancelByAgentId = new Map<string, () => Promise<void> | void>();
  const allTurnGroups: Array<ReturnType<typeof transcriptTurns>> = [];
  for (const conv of allConversations) {
    const store = acpManager.get(conv.data.id);
    if (!store) continue;
    const turns = transcriptTurns(store.chatState.transcript.state);
    if (turns.length > 0) allTurnGroups.push(turns);
    if (store.agents.length === 0) continue;
    const parentEffort = store.effort ?? undefined;
    for (const agent of store.agents) {
      let node = agent.toolCallId ? findToolNode(turns, agent.toolCallId) : null;
      if (!node && agent.agentId) {
        for (const turn of turns) {
          for (const item of turn.items) {
            if (item.kind === 'spawn-subagent-tool-call' && item.agentId === agent.agentId) {
              node = item;
              break;
            }
          }
          if (node) break;
        }
      }
      let resolvedName = agent.name;
      let resolvedPrompt = agent.prompt?.trim() ? agent.prompt : undefined;
      let resolvedSummary = agent.summary?.trim() ? agent.summary : undefined;
      let resolvedActivities = agent.activities;
      const resolvedEffort = agent.effort?.trim() ? agent.effort : parentEffort;

      if (node && node.kind === 'spawn-subagent-tool-call') {
        if (!resolvedName || resolvedName.trim() === 'Agent') {
          resolvedName = nativeSubagentName(node);
        }
        if (!resolvedPrompt && node.inputSummary?.trim()) {
          resolvedPrompt = node.inputSummary.trim();
        }
        if (!resolvedSummary && node.outputText?.trim()) {
          resolvedSummary = node.outputText.trim();
        }
        if ((!resolvedActivities || resolvedActivities.length === 0) && node.children?.length) {
          resolvedActivities = toolFeedEntries(node.children)
            .filter((entry): entry is Extract<typeof entry, { kind: 'tool' }> => entry.kind === 'tool')
            .map<AgentActivityEntry>((entry) => ({
              id: entry.id,
              kind: entry.status === 'error' ? 'error' : 'tool',
              title: entry.title,
              ...(entry.detail ? { detail: entry.detail } : {}),
              status: entry.status,
            }));
        }
      }

      const enriched: AgentState = {
        ...agent,
        name: resolvedName,
        ...(resolvedEffort ? { effort: resolvedEffort } : {}),
        ...(resolvedPrompt ? { prompt: resolvedPrompt } : {}),
        ...(resolvedSummary ? { summary: resolvedSummary } : {}),
        ...(resolvedActivities ? { activities: resolvedActivities } : {}),
      };
      subagents.push(enriched);
      const cancelFn = () => store.cancelSubagent(agent.agentId);
      cancelByAgentId.set(agent.agentId, cancelFn);
      if (agent.toolCallId) cancelByAgentId.set(agent.toolCallId, cancelFn);
    }
  }
  const mediaItems = collectTaskMedia(allTurnGroups);
  const runningSubagents = subagents.filter((a) => a.status === 'running');
  const runningSubagentsCount = runningSubagents.length;
  useEffect(() => {
    if (runningSubagentsCount === 0) return;
    const timer = window.setInterval(() => setLiveTick((t) => (t + 1) % 100000), 1000);
    return () => window.clearInterval(timer);
  }, [runningSubagentsCount]);
  const handleCancelSubagent = (runId: string) => cancelByAgentId.get(runId)?.();

  const handleOpenFolder = () => {
    if (!workspacePath) return;
    void getHostClient().then((client) =>
      client.openIn({
        app: 'finder',
        path: workspacePath,
        isRemote: isRemoteProject,
        sshConnectionId: workspace.sshConnectionId ?? undefined,
      })
    );
  };

  const handleCopyBranch = () => {
    if (!currentBranchName) return;
    void copyTextToClipboard(currentBranchName);
    setCopiedBranch(true);
    window.setTimeout(() => setCopiedBranch(false), 1500);
  };

  const handleRunScript = (scriptId: string) => {
    lifecycleScriptsMgr?.setActiveTab(scriptId);
    taskView.chrome.commands.openTerminalDrawer();
  };

  const handleOpenServer = (url: string) => {
    browserRightPanelStore.openTab(
      {
        projectId,
        workspaceId: taskPayload.workspaceId ?? taskId,
        taskId,
      },
      { initialUrl: url }
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background px-3 py-3 text-sm text-foreground">
      <div className="shrink-0 divide-y divide-border/80 overflow-y-auto rounded-xl border border-border bg-background-1 max-h-[54%]">
        {/* Bölüm 1: Ortam, Editörle Aç ve Proje Scriptleri */}
        <div className="flex flex-col gap-0.5 p-2">
          <div className="flex h-8 items-center justify-between gap-2 rounded-lg px-2 text-xs text-foreground-muted">
            <span className="flex min-w-0 items-center gap-2.5">
              <Laptop className="size-4 shrink-0 text-foreground-passive" />
              <span className="truncate font-medium text-foreground">
                {isRemoteProject ? `${projectName} (SSH)` : 'Yerel Mac'}
              </span>
            </span>
            {workspacePath && !isFreeChat ? (
              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <button
                      type="button"
                      onClick={handleOpenFolder}
                      aria-label="Klasörü Finder ile aç"
                      className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-passive transition-colors hover:bg-background-2 hover:text-foreground"
                    >
                      <Folder className="size-3.5" />
                    </button>
                  }
                />
                <Tooltip.Content side="left">Klasörü aç</Tooltip.Content>
              </Tooltip.Root>
            ) : null}
          </div>

          {workspacePath && !isFreeChat ? (
            <div className="flex h-8 items-center rounded-lg px-0.5 transition-colors hover:bg-background-2/70">
              <OpenInMenu
                path={workspacePath}
                borderless
                showLabel
                isRemote={isRemoteProject}
                sshConnectionId={workspace.sshConnectionId ?? undefined}
                className="h-7 w-full justify-between text-xs text-foreground"
              />
            </div>
          ) : null}

          {!isFreeChat ? (
            <div className="flex flex-col gap-0.5">
              {scriptTabs.map((script) => (
                <button
                  key={script.data.id}
                  type="button"
                  onClick={() => handleRunScript(script.data.id)}
                  className="flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 text-left text-xs text-foreground transition-colors hover:bg-background-2"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Play className="size-3.5 shrink-0 text-foreground-passive" />
                    <span className="truncate">{script.data.label}</span>
                  </span>
                  <span className="text-[11px] text-foreground-passive">Çalıştır</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => navigate(projectViewDef({ projectId }))}
                className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-xs text-foreground-muted transition-colors hover:bg-background-2 hover:text-foreground"
              >
                <Plus className="size-3.5 shrink-0 text-foreground-passive" />
                <span>Proje script&apos;i ekle</span>
              </button>
            </div>
          ) : null}
        </div>

        {/* Bölüm 2: Git Branch, Durum ve Değişiklikler */}
        {!isFreeChat ? (
          <div className="flex flex-col gap-0.5 p-2">
            {/* Branch satırı */}
            <div className="flex h-8 items-center justify-between gap-2 rounded-lg px-2 text-xs transition-colors hover:bg-background-2/60">
              <span className="flex min-w-0 items-center gap-2.5">
                <GitBranch className="size-4 shrink-0 text-foreground-passive" />
                <span className="truncate font-mono text-[11px] text-foreground">
                  {currentBranchName ?? 'detached HEAD'}
                </span>
              </span>
              {currentBranchName ? (
                <Tooltip.Root>
                  <Tooltip.Trigger
                    render={
                      <button
                        type="button"
                        onClick={handleCopyBranch}
                        aria-label="Branch adını kopyala"
                        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-passive transition-colors hover:bg-background-3 hover:text-foreground"
                      >
                        {copiedBranch ? (
                          <Check className="size-3.5 text-foreground-success" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                      </button>
                    }
                  />
                  <Tooltip.Content side="left">
                    {copiedBranch ? 'Kopyalandı' : 'Branch adını kopyala'}
                  </Tooltip.Content>
                </Tooltip.Root>
              ) : null}
            </div>

            {/* Git Aksiyonları satırı */}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                render={
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-background-2"
                  >
                    <span className="flex min-w-0 items-start gap-2.5">
                      <Check
                        className={cn(
                          'mt-0.5 size-4 shrink-0',
                          hasChanges ? 'text-foreground-warning' : 'text-foreground-success'
                        )}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-xs font-medium text-foreground">
                          {hasChanges
                            ? 'Commit bekleyen değişiklikler'
                            : isPublished
                              ? 'Çalışma alanı temiz'
                              : 'Yerel branch (yayınlanmadı)'}
                        </span>
                        <span className="truncate text-[11px] text-foreground-passive">
                          {aheadCount > 0 || behindCount > 0
                            ? `${aheadCount > 0 ? `↑${aheadCount} gönderilecek` : ''}${aheadCount > 0 && behindCount > 0 ? ' · ' : ''}${behindCount > 0 ? `↓${behindCount} çekilecek` : ''}`
                            : isPublished
                              ? 'Uzak depo ile senkron'
                              : 'Yayınlamak için tıklayın'}
                        </span>
                      </span>
                    </span>
                    <ChevronDown className="size-3.5 shrink-0 text-foreground-passive" />
                  </button>
                }
              />
              <DropdownMenu.Content align="end" className="min-w-48">
                <DropdownMenu.Item onClick={() => taskView.chrome.commands.openSidebarTab('changes')}>
                  <FileDiff className="size-3.5" />
                  Değişiklikleri ve Commit panelini aç
                </DropdownMenu.Item>
                <DropdownMenu.Item disabled={isFetching} onClick={fetch}>
                  <RefreshCcw className="size-3.5" />
                  Fetch
                </DropdownMenu.Item>
                {isPublished ? (
                  <>
                    <DropdownMenu.Item disabled={isPulling} onClick={pull}>
                      <ArrowDown className="size-3.5" />
                      Pull {behindCount > 0 ? `(${behindCount})` : ''}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item disabled={isPushing} onClick={push}>
                      <ArrowUp className="size-3.5" />
                      Push {aheadCount > 0 ? `(${aheadCount})` : ''}
                    </DropdownMenu.Item>
                  </>
                ) : (
                  <DropdownMenu.Item disabled={isPublishing} onClick={publish}>
                    <ArrowUp className="size-3.5" />
                    Branch&apos;i Yayınla
                  </DropdownMenu.Item>
                )}
                {canShowLocalMerge ? (
                  <DropdownMenu.Item onClick={() => setMergeDialogOpen(true)}>
                    <GitMerge className="size-3.5" />
                    {defaultBranchName} ile birleştir…
                  </DropdownMenu.Item>
                ) : null}
              </DropdownMenu.Content>
            </DropdownMenu.Root>

            {/* Değişiklikler satırı */}
            <button
              type="button"
              onClick={() => taskView.chrome.commands.openSidebarTab('changes')}
              className="flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 text-left text-xs transition-colors hover:bg-background-2"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <FileDiff className="size-4 shrink-0 text-foreground-passive" />
                <span className="truncate font-medium text-foreground">Değişiklikler</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
                <span
                  className={cn(
                    linesAdded > 0 ? 'text-foreground-diff-added' : 'text-foreground-passive'
                  )}
                >
                  +{formatDiffLineCount(linesAdded)}
                </span>
                <span
                  className={cn(
                    linesDeleted > 0 ? 'text-foreground-diff-deleted' : 'text-foreground-passive'
                  )}
                >
                  -{formatDiffLineCount(linesDeleted)}
                </span>
              </span>
            </button>
          </div>
        ) : null}

        {/* Bölüm 3: Sunucular */}
        <div className="flex flex-col gap-1 p-2">
          <div className="px-2 pt-0.5 text-[11px] font-medium text-foreground-passive">
            Sunucular
          </div>
          {servers.length === 0 ? (
            <div className="flex h-7 items-center gap-2 px-2 text-xs text-foreground-passive">
              <Server className="size-3.5 shrink-0 opacity-60" />
              <span>Çalışan yerel sunucu yok</span>
            </div>
          ) : (
            servers.map((server) => {
              const url = previewServerUrl(server);
              return (
                <button
                  key={server.id}
                  type="button"
                  disabled={!url}
                  onClick={() => {
                    if (url) handleOpenServer(url);
                  }}
                  onAuxClick={() => {
                    if (url) void openExternal(url);
                  }}
                  className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-background-2 disabled:cursor-default disabled:opacity-60"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Globe className="size-4 shrink-0 text-foreground-passive" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-xs font-medium text-foreground">
                        {formatPreviewServerLabel(server)}
                      </span>
                      <span className="truncate text-[11px] text-foreground-passive">
                        {url ?? server.status.kind}
                      </span>
                    </span>
                  </span>
                  <ChevronRight className="size-3.5 shrink-0 text-foreground-passive" />
                </button>
              );
            })
          )}
        </div>

        {/* Üretilen medya ve alt ajan geçmişi (yalnızca ilgili içerik varsa görünür) */}
        {mediaItems.length > 0 || subagents.length > 0 ? (
          <div className="flex flex-col gap-0.5 p-2">
            {mediaItems.length > 0 ? (
              <button
                type="button"
                onClick={() => setDockPanel((prev) => (prev === 'media' ? 'none' : 'media'))}
                className={cn(
                  'flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 text-left text-xs transition-colors',
                  dockPanel === 'media' ? 'bg-background-2 text-foreground' : 'hover:bg-background-2'
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <Images className="size-4 shrink-0 text-foreground-passive" />
                  <span className="truncate font-medium text-foreground">Üretilen medya</span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-foreground-passive">
                  <span>{mediaItems.length}</span>
                  <ChevronRight
                    className={cn(
                      'size-3.5 transition-transform',
                      dockPanel === 'media' && 'rotate-90'
                    )}
                  />
                </span>
              </button>
            ) : null}

            {subagents.length > 0 ? (
              <button
                type="button"
                onClick={() => setDockPanel((prev) => (prev === 'history' ? 'none' : 'history'))}
                className={cn(
                  'flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 text-left text-xs transition-colors',
                  dockPanel === 'history'
                    ? 'bg-background-2 text-foreground'
                    : 'hover:bg-background-2'
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <Layers className="size-4 shrink-0 text-foreground-passive" />
                  <span className="truncate font-medium text-foreground">Alt ajan geçmişi</span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-foreground-passive">
                  {runningSubagents.length > 0 ? (
                    <span className="text-sky-400">{runningSubagents.length} aktif</span>
                  ) : (
                    <span>{subagents.length}</span>
                  )}
                  <ChevronRight
                    className={cn(
                      'size-3.5 transition-transform',
                      dockPanel === 'history' && 'rotate-90'
                    )}
                  />
                </span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Alt boşlukta yalnızca aktif çalışan işler görünür; geçmiş veya medya yalnızca kullanıcı açarsa görünür */}
      <LiveWorkDock
        projectId={projectId}
        taskId={taskId}
        subagents={subagents}
        mediaItems={mediaItems}
        runningSubagentsCount={runningSubagents.length}
        dockPanel={dockPanel}
        onCloseDockPanel={() => setDockPanel('none')}
        onCancelSubagent={handleCancelSubagent}
        runningScripts={scriptTabs.filter((s) => s.status === 'running')}
        onOpenScript={handleRunScript}
      />

      {canShowLocalMerge && currentBranchName && defaultBranchName ? (
        <LocalMergeDialog
          open={mergeDialogOpen}
          onOpenChange={setMergeDialogOpen}
          projectId={projectId}
          taskId={taskId}
          taskName={taskDisplayName(taskStore) ?? taskPayload.name}
          sourceBranch={currentBranchName}
          targetBranch={defaultBranchName}
          hasUncommittedChanges={gitCheckout.fileChanges.length > 0}
        />
      ) : null}
    </div>
  );
});

const LiveWorkDock = observer(function LiveWorkDock({
  projectId,
  taskId,
  subagents,
  mediaItems,
  runningSubagentsCount,
  dockPanel,
  onCloseDockPanel,
  onCancelSubagent,
  runningScripts,
  onOpenScript,
}: {
  projectId: string;
  taskId: string;
  subagents: AgentState[];
  mediaItems: TaskMediaItem[];
  runningSubagentsCount: number;
  dockPanel: 'none' | 'history' | 'media';
  onCloseDockPanel: () => void;
  onCancelSubagent: (runId: string) => Promise<void> | void;
  runningScripts: Array<{ data: { id: string; label: string; command: string }; status: string }>;
  onOpenScript: (scriptId: string) => void;
}) {
  const showMediaPanel = dockPanel === 'media' && mediaItems.length > 0;
  const showHistoryPanel = dockPanel === 'history' && subagents.length > 0;
  const showLiveAgents = !showMediaPanel && !showHistoryPanel && runningSubagentsCount > 0;

  if (!showLiveAgents && !showHistoryPanel && !showMediaPanel && runningScripts.length === 0) {
    return null;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {runningScripts.length > 0 ? (
        <div className="mt-2.5 shrink-0 divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-background-1 p-1.5">
          {runningScripts.map((script) => (
            <button
              key={`script-${script.data.id}`}
              type="button"
              onClick={() => onOpenScript(script.data.id)}
              className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-background-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Terminal className="size-3.5 shrink-0 text-foreground-info" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-xs font-medium text-foreground">
                    {script.data.label}
                  </span>
                  <span className="truncate font-mono text-[11px] text-foreground-passive">
                    {script.data.command}
                  </span>
                </span>
              </span>
              <Loader2 className="size-3.5 shrink-0 animate-spin text-foreground-info" />
            </button>
          ))}
        </div>
      ) : null}

      {showMediaPanel ? (
        <TaskMediaGalleryPanel
          items={mediaItems}
          projectId={projectId}
          taskId={taskId}
          onClose={onCloseDockPanel}
        />
      ) : showHistoryPanel ? (
        <AcpSubagentsPanel
          embedded
          mode="history"
          agents={subagents}
          onClose={onCloseDockPanel}
          onCancelSubagent={onCancelSubagent}
        />
      ) : showLiveAgents ? (
        <AcpSubagentsPanel
          embedded
          mode="live"
          agents={subagents}
          onCancelSubagent={onCancelSubagent}
        />
      ) : null}
    </div>
  );
});
